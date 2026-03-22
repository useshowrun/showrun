#!/usr/bin/env node
/**
 * realtor-listing — Get full property details from Realtor.com.
 *
 * USAGE:
 *   node realtor-listing.mjs <listing-url>
 *   node realtor-listing.mjs '{"url":"https://www.realtor.com/realestateandhomes-detail/..."}'
 *
 * ARGS:
 *   listing-url   Full Realtor.com listing URL
 *
 * ALSO ACCEPTS JSON via stdin or first arg.
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "listingId": string,
 *     "propertyId": string,
 *     "price": number|null,
 *     "address": { street, city, state, zip },
 *     "beds": number|null,
 *     "baths": number|null,
 *     "sqft": number|null,
 *     "lotSize": number|null,
 *     "yearBuilt": number|null,
 *     "propertyType": string|null,
 *     "listingStatus": string|null,
 *     "daysOnMarket": number|null,
 *     "listingDate": string|null,
 *     "url": string,
 *     "thumbnailUrl": string|null,
 *     "lat": number|null,
 *     "lng": number|null,
 *     "description": string|null,
 *     "images": string[],
 *     "features": { [category]: string[] },
 *     "agentName": string|null,
 *     "agentPhone": string|null,
 *     "agentBrokerage": string|null,
 *     "hoaFee": number|null,
 *     "taxHistory": object[]|null,
 *     "priceHistory": object[],
 *     "nearbySchools": object[],
 *     "blocked": boolean,
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
  parseDetailProperty,
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

function parseInput() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;

  // JSON input
  if (args[0].startsWith('{')) {
    try {
      return JSON.parse(args[0]);
    } catch (e) { /* fall through */ }
  }

  // Plain URL
  if (args[0].startsWith('http')) {
    return { url: args[0] };
  }

  return null;
}

async function readInput() {
  const cliInput = parseInput();
  if (cliInput) return cliInput;

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
 * Try to extract a single property from __NEXT_DATA__.
 * Realtor.com listing pages store property data in several possible paths.
 */
function extractProperty(nextData) {
  if (!nextData) return null;
  const pp = nextData?.props?.pageProps;
  if (!pp) return null;

  // Common path
  if (pp.property) return pp.property;

  // Redux SSR state path (noted in utils.mjs comments)
  const reduxState = pp.initialReduxState;
  if (reduxState?.propertyDetails) return reduxState.propertyDetails;

  // Alternative paths
  if (pp.initialData?.property) return pp.initialData.property;
  if (pp.listing) return pp.listing;
  if (pp.initialData?.listing) return pp.initialData.listing;

  return null;
}

/**
 * Parse JSON-LD schema as fallback — extracts minimal info from structured data.
 */
function extractJsonLdFromHtml(html) {
  const matches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      const t = data['@type'];
      if (
        t === 'SingleFamilyResidence' ||
        t === 'Apartment' ||
        t === 'House' ||
        t === 'RealEstateListing' ||
        t === 'Product' ||
        t === 'Place'
      ) {
        return data;
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * Parse JSON-LD fallback into a minimal property object.
 */
function parseJsonLdProperty(ld, url) {
  if (!ld) return null;
  const addr = ld.address || {};
  return {
    listingId: null,
    propertyId: null,
    price: ld.offers?.price ?? ld.price ?? null,
    address: {
      street: addr.streetAddress ?? null,
      city: addr.addressLocality ?? null,
      state: addr.addressRegion ?? null,
      zip: addr.postalCode ?? null,
    },
    beds: ld.numberOfRooms ?? null,
    baths: null,
    sqft: ld.floorSize?.value ?? null,
    lotSize: null,
    yearBuilt: ld.yearBuilt ?? null,
    propertyType: ld['@type'] ?? null,
    listingStatus: null,
    daysOnMarket: null,
    listingDate: ld.datePosted ?? null,
    url,
    thumbnailUrl: Array.isArray(ld.image) ? ld.image[0] : (ld.image ?? null),
    lat: ld.geo?.latitude ?? null,
    lng: ld.geo?.longitude ?? null,
    description: ld.description ?? null,
    images: Array.isArray(ld.image) ? ld.image : (ld.image ? [ld.image] : []),
    features: {},
    agentName: ld.agent?.name ?? null,
    agentPhone: ld.agent?.telephone ?? null,
    agentBrokerage: null,
    hoaFee: null,
    taxHistory: null,
    priceHistory: [],
    nearbySchools: [],
  };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function validateUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes('realtor.com');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

async function scrapeListing(url) {
  log(`Fetching: ${url}`);

  const { status, body } = await fetchUrl(url);
  log(`Response status: ${status}, body length: ${body?.length ?? 0}`);

  // Check for bot block
  const botSignal = checkBotBlock(body, status);
  if (botSignal) {
    return { blocked: true, reason: botSignal };
  }

  // Try __NEXT_DATA__ first
  const nextData = extractNextDataFromHtml(body);
  log(`__NEXT_DATA__ found: ${!!nextData}`);

  if (nextData) {
    const prop = extractProperty(nextData);
    if (prop) {
      log('Extracted property from __NEXT_DATA__');
      return { ...parseDetailProperty(prop), blocked: false };
    }
    log('__NEXT_DATA__ present but no property found, checking paths...');
    // Debug: log top-level keys
    const pp = nextData?.props?.pageProps;
    if (pp) {
      log(`pageProps keys: ${Object.keys(pp).join(', ')}`);
    }
  }

  // Fallback: JSON-LD
  const ld = extractJsonLdFromHtml(body);
  if (ld) {
    log('Extracted property from JSON-LD fallback');
    return { ...parseJsonLdProperty(ld, url), blocked: false };
  }

  // Log snippet for debugging
  const snippet = body?.substring(0, 500) ?? '';
  log(`HTML snippet: ${snippet}`);

  return null;
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

  const { url } = input || {};

  if (!url) {
    emitError('MISSING_PARAM', 'url is required — pass a Realtor.com listing URL');
  }

  if (!validateUrl(url)) {
    emitError('INVALID_URL', `URL must be a valid realtor.com listing URL, got: ${url}`);
  }

  log(`[realtor-listing] Fetching: ${url}`);

  let result = null;
  let retries = 0;

  while (retries < 3 && !result) {
    try {
      result = await scrapeListing(url);
    } catch (e) {
      retries++;
      log(`Attempt ${retries} failed: ${e.message}`);
      if (retries < 3) await delay(3000 * retries);
    }
  }

  if (!result) {
    emitError('NO_DATA', `Could not extract property details from: ${url}`);
  }

  // Add the source URL
  result.url = url;

  emitResult(result);
}

main().catch(e => {
  log(`[realtor-listing] Fatal error: ${e.message}`);
  log(e.stack);
  emitError('UNEXPECTED_ERROR', e.message);
});
