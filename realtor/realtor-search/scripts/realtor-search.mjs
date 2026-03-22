#!/usr/bin/env node
/**
 * realtor-search — Search Realtor.com US real estate listings by location.
 *
 * USAGE (CLI args):
 *   node realtor-search.mjs <location> [options]
 *
 * ARGS:
 *   location          City+state ("Austin, TX" or "Austin_TX") or zip code
 *
 * OPTIONS:
 *   --min-price N     Minimum list price
 *   --max-price N     Maximum list price
 *   --beds N          Minimum number of bedrooms
 *   --baths N         Minimum number of bathrooms
 *   --type TYPE       Property type: house|condo|townhome|land
 *   --max N           Maximum number of results (default: 42 / one page)
 *   --pages N         Max pages to scrape (default: 1)
 *
 * ALSO ACCEPTS JSON via stdin or first arg:
 *   node realtor-search.mjs '{"location":"Austin, TX","maxPrice":500000}'
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "location": string,
 *     "normalizedLocation": string,
 *     "searchUrl": string,
 *     "totalCount": number|null,
 *     "pagesScraped": number,
 *     "hasMore": boolean,
 *     "blocked": boolean,
 *     "listings": [
 *       {
 *         "listingId": string,
 *         "propertyId": string,
 *         "price": number|null,
 *         "beds": number|null,
 *         "baths": number|null,
 *         "sqft": number|null,
 *         "address": { street, city, state, zip },
 *         "propertyType": string|null,
 *         "listingStatus": string|null,
 *         "daysOnMarket": number|null,
 *         "url": string|null,
 *         "thumbnailUrl": string|null,
 *         "lat": number|null,
 *         "lng": number|null,
 *         "listingDate": string|null,
 *       }
 *     ]
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (e.g. "127.0.0.1:11090")
 */

import {
  emitResult,
  emitError,
  log,
  delay,
  fetchUrl,
  extractNextDataFromHtml,
  buildSearchUrl,
  normalizeLocation,
  parseSearchProperty,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Bot-block detection
// ---------------------------------------------------------------------------

/**
 * Check if the HTML response indicates bot-blocking (CAPTCHA, Cloudflare, etc.).
 * Returns a descriptive string if blocked, or null if clean.
 */
function checkBotBlock(html, status) {
  if (!html) return 'Empty response body';

  // HTTP-level signals
  if (status === 403) return `HTTP 403 Forbidden`;
  if (status === 429) return `HTTP 429 Too Many Requests`;
  if (status === 503) return `HTTP 503 Service Unavailable`;

  const lower = html.toLowerCase();

  // Kasada (realtor.com's primary protection)
  if (lower.includes('kasada') || lower.includes('kpsdk')) return 'Kasada bot protection detected';

  // Cloudflare
  if (lower.includes('cloudflare') && (lower.includes('challenge') || lower.includes('ray id'))) {
    return 'Cloudflare challenge detected';
  }

  // Generic CAPTCHA / access denied
  if (lower.includes('captcha')) return 'CAPTCHA challenge detected';
  if (lower.includes('access denied')) return 'Access Denied response';
  if (lower.includes('robot') && lower.includes('verify')) return 'Robot verification page';

  // Realtor.com specific bot page
  if (lower.includes('your access to this site has been blocked')) return 'Realtor.com access blocked';
  if (lower.includes('unusual traffic') || lower.includes('automated request')) {
    return 'Automated traffic detection';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;

  // Try JSON first
  if (args[0].startsWith('{')) {
    try {
      return JSON.parse(args[0]);
    } catch (e) { /* fall through */ }
  }

  // CLI-style: <location> [--key value ...]
  const parsed = {};
  let i = 0;

  // First positional arg = location
  if (args[0] && !args[0].startsWith('--')) {
    parsed.location = args[0];
    i = 1;
  }

  while (i < args.length) {
    const flag = args[i];
    const val = args[i + 1];
    switch (flag) {
      case '--min-price': parsed.minPrice = parseInt(val, 10); i += 2; break;
      case '--max-price': parsed.maxPrice = parseInt(val, 10); i += 2; break;
      case '--beds':      parsed.beds = parseInt(val, 10); i += 2; break;
      case '--baths':     parsed.baths = parseInt(val, 10); i += 2; break;
      case '--type':      parsed.type = val; i += 2; break;
      case '--max':       parsed.max = parseInt(val, 10); i += 2; break;
      case '--pages':     parsed.pages = parseInt(val, 10); i += 2; break;
      default: i++;
    }
  }

  return parsed;
}

async function readInput() {
  const cliInput = parseCliArgs();
  if (cliInput && Object.keys(cliInput).length > 0) return cliInput;

  // Try stdin
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      if (!buf.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error(`Failed to parse stdin JSON: ${e.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract properties from __NEXT_DATA__.
 * Realtor.com nests data differently per page variant, so we check several paths.
 */
function extractProperties(nextData) {
  if (!nextData) return null;

  const pp = nextData?.props?.pageProps;
  if (!pp) return null;

  // Most common path
  if (Array.isArray(pp.properties)) {
    return {
      listings: pp.properties,
      totalCount: pp.totalCount ?? pp.total ?? pp.count ?? null,
    };
  }

  // Alternative: nested under searchResults
  if (pp.searchResults?.properties) {
    return {
      listings: pp.searchResults.properties,
      totalCount: pp.searchResults.totalCount ?? pp.searchResults.total ?? null,
    };
  }

  // Some variants embed in initialData
  if (pp.initialData?.properties) {
    return {
      listings: pp.initialData.properties,
      totalCount: pp.initialData.totalCount ?? null,
    };
  }

  // Check for initialProps
  if (pp.initialProps?.properties) {
    return {
      listings: pp.initialProps.properties,
      totalCount: pp.initialProps.totalCount ?? null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

async function scrapePage(url) {
  log(`Fetching: ${url}`);

  const { status, body } = await fetchUrl(url);
  log(`Response status: ${status}, body length: ${body?.length ?? 0}`);

  // Check for bot block
  const botSignal = checkBotBlock(body, status);
  if (botSignal) {
    return { blocked: true, reason: botSignal };
  }

  // Extract __NEXT_DATA__
  const nextData = extractNextDataFromHtml(body);
  if (!nextData) {
    log('No __NEXT_DATA__ found in response HTML');
    // Log a snippet for debugging
    const snippet = body?.substring(0, 500) ?? '';
    log(`HTML snippet: ${snippet}`);
    return null;
  }

  const extracted = extractProperties(nextData);
  if (extracted && extracted.listings.length > 0) {
    log(`Found ${extracted.listings.length} listings via __NEXT_DATA__`);
    return extracted;
  }

  // Log page props keys for debugging
  const pp = nextData?.props?.pageProps;
  if (pp) {
    log(`pageProps keys: ${Object.keys(pp).join(', ')}`);
  }

  // No listings but no error — could be zero results
  const totalCount = pp?.totalCount ?? pp?.total ?? pp?.count ?? null;
  return { listings: [], totalCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    input = await readInput();
  } catch (e) {
    emitError('INVALID_INPUT', e.message);
  }

  const {
    location = '',
    minPrice,
    maxPrice,
    beds,
    baths,
    type,
    max = 42,
    pages = 1,
  } = input;

  if (!location) {
    emitError('MISSING_PARAM', 'location is required (e.g. "Austin, TX" or "90210")');
  }

  log(`[realtor-search] Searching: ${location}`);
  if (minPrice || maxPrice) log(`  price: ${minPrice ?? '*'} - ${maxPrice ?? '*'}`);
  if (beds) log(`  beds: ${beds}+`);
  if (baths) log(`  baths: ${baths}+`);
  if (type) log(`  type: ${type}`);
  log(`  max: ${max}, pages: ${pages}`);

  const allListings = [];
  let totalCount = null;
  let pagesScraped = 0;
  let firstSearchUrl = null;
  let blocked = false;
  let blockReason = null;

  for (let pageNum = 1; pageNum <= pages; pageNum++) {
    if (allListings.length >= max) break;

    const url = buildSearchUrl({
      location,
      minPrice,
      maxPrice,
      beds,
      baths,
      type,
      page: pageNum,
    });
    if (pageNum === 1) firstSearchUrl = url;

    let result = null;
    let retries = 0;

    while (retries < 3 && !result) {
      try {
        result = await scrapePage(url);
      } catch (e) {
        retries++;
        log(`Attempt ${retries} failed: ${e.message}`);
        if (retries < 3) await delay(3000 * retries);
      }
    }

    if (!result) {
      if (pageNum === 1) {
        emitError('NO_DATA', `Could not extract listings from Realtor.com for: ${location}`);
      }
      break;
    }

    // Bot block detected
    if (result.blocked) {
      blocked = true;
      blockReason = result.reason;
      log(`Bot block detected: ${result.reason}`);
      break;
    }

    if (totalCount === null && result.totalCount != null) {
      totalCount = result.totalCount;
    }

    const parsed = (result.listings || []).map(parseSearchProperty).filter(Boolean);
    log(`Page ${pageNum}: parsed ${parsed.length} listings`);
    allListings.push(...parsed);
    pagesScraped++;

    if (result.listings.length === 0) break;
    if (pageNum < pages) await delay(2000);
  }

  const trimmed = allListings.slice(0, max);

  emitResult({
    location,
    normalizedLocation: normalizeLocation(location),
    searchUrl: firstSearchUrl,
    totalCount,
    pagesScraped,
    hasMore: totalCount !== null ? trimmed.length < totalCount : pagesScraped >= pages,
    blocked,
    blockReason: blocked ? blockReason : undefined,
    listings: trimmed,
  });
}

main().catch(e => {
  log(`[realtor-search] Fatal error: ${e.message}`);
  log(e.stack);
  emitError('UNEXPECTED_ERROR', e.message);
});
