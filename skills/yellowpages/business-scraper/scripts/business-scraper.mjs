#!/usr/bin/env node
/**
 * Yellowpages Business Scraper
 *
 * Scrapes Yellowpages.com for local business listings, business details,
 * contact info, categories, ratings, and hours.
 *
 * WAF: Cloudflare — bypassed using curl_cffi with Firefox TLS fingerprint.
 * Requires: Python 3 + curl_cffi (pip install curl-cffi)
 *
 * Usage:
 *   node business-scraper.mjs search <query> <location> [options]
 *   node business-scraper.mjs detail <url-or-path>
 *
 * Examples:
 *   node business-scraper.mjs search "pizza" "New York, NY"
 *   node business-scraper.mjs search "plumber" "Los Angeles, CA" --pages=3
 *   node business-scraper.mjs detail "/new-york-ny/mip/famous-original-rays-pizza-459218516"
 *   node business-scraper.mjs detail "https://www.yellowpages.com/new-york-ny/mip/..."
 *
 * Options:
 *   --pages=N       Pages to scrape (default: 1, 30 results/page)
 *   --delay=MS      Delay between pages in ms (default: 1500)
 *   --output=FILE   Save JSON output to file
 *   --verbose       Enable verbose logging
 *
 * Exit codes:
 *   0  Success
 *   1  Usage / config error
 *   2  No results found
 *   3  Network / HTTP error
 *   4  WAF / bot block detected (Cloudflare)
 *   5  Rate limited
 */

import { execFileSync, spawnSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YP_BASE = 'https://www.yellowpages.com';
const IMPERSONATE = 'firefox133';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let verbose = false;
function log(...args) {
  if (verbose) console.error('[yellowpages]', ...args);
}
function warn(...args) {
  console.error('[yellowpages:warn]', ...args);
}
function bail(msg, code = 1) {
  console.error(`[yellowpages:error] ${msg}`);
  process.exit(code);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Python curl_cffi fetcher
// ---------------------------------------------------------------------------

/**
 * Find the best Python executable that has curl_cffi.
 */
function findPython() {
  // Try venv first (openclaw venv), then system
  const candidates = [
    '/home/' + (process.env.USER || 'karacasoft') + '/.openclaw/.venv/bin/python3',
    process.env.PYTHON_BIN,
    'python3',
    'python',
  ].filter(Boolean);

  for (const py of candidates) {
    try {
      const result = spawnSync(py, ['-c', 'import curl_cffi; print("ok")'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.stdout && result.stdout.trim() === 'ok') {
        log(`Using Python: ${py}`);
        return py;
      }
    } catch (_) {}
  }
  return null;
}

let _pythonBin = null;

function getPython() {
  if (!_pythonBin) {
    _pythonBin = findPython();
    if (!_pythonBin) {
      bail(
        'curl_cffi not found. Install it: pip install curl-cffi\n' +
          'Or set PYTHON_BIN env var to a Python with curl_cffi installed.',
        1,
      );
    }
  }
  return _pythonBin;
}

/**
 * Fetch multiple URLs using a single Python process with a persistent curl_cffi session.
 * This maintains cookies across requests (important for Cloudflare).
 * Returns array of { status, body } objects.
 */
function fetchUrls(urls, delayMs = 1500) {
  const py = getPython();

  const pyCode = `
import sys, json, time
from curl_cffi import requests as cffi_requests

session = cffi_requests.Session()
urls = json.loads(sys.argv[1])
delay_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 1500

results = []
for i, url in enumerate(urls):
    if i > 0:
        time.sleep(delay_ms / 1000.0)
    try:
        resp = session.get(
            url,
            impersonate=${JSON.stringify(IMPERSONATE)},
            timeout=30,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.yellowpages.com/",
            }
        )
        results.append({"status": resp.status_code, "body": resp.text})
        print(f"FETCHED:{i}:{resp.status_code}:{len(resp.text)}", file=sys.stderr)
    except Exception as e:
        print(f"ERROR:{i}:{e}", file=sys.stderr)
        results.append({"status": 0, "error": str(e)})

print(json.dumps(results))
`;

  log(`Fetching ${urls.length} URL(s) in single Python session...`);

  const result = spawnSync(py, ['-c', pyCode, JSON.stringify(urls), String(delayMs)], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Fetch failed: ${result.error.message}`);
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  // Log stderr for verbose mode
  if (stderr) {
    for (const line of stderr.trim().split('\n')) {
      if (line.startsWith('FETCHED:')) {
        const [, idx, status, size] = line.split(':');
        log(`  [${idx}] HTTP ${status}, size=${size}`);
      } else if (line.startsWith('ERROR:')) {
        warn(`  ${line}`);
      } else if (line.trim()) {
        log(`  ${line}`);
      }
    }
  }

  if (result.status !== 0 && !stdout.trim()) {
    throw new Error(`Python exited ${result.status}: ${stderr.trim()}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(`Failed to parse Python output: ${e.message}\nStdout: ${stdout.slice(0, 500)}`);
  }

  return parsed;
}

/**
 * Fetch a single URL. Wrapper around fetchUrls.
 */
function fetchUrl(url, delayMs = 0) {
  const results = fetchUrls([url], delayMs);
  const r = results[0];

  if (r.error) {
    throw new Error(`HTTP error: ${r.error}`);
  }

  const httpStatus = r.status;
  const body = r.body || '';

  log(`Response: HTTP ${httpStatus}, size=${body.length}`);

  log(`Response: HTTP ${httpStatus}, size=${body.length}`);

  // WAF detection
  if (httpStatus === 403 || httpStatus === 429) {
    if (body.includes('cloudflare') || body.includes('Cloudflare') || body.includes('cf-wrapper')) {
      const err = new Error('Cloudflare WAF block detected');
      err.code = httpStatus === 429 ? 5 : 4;
      throw err;
    }
  }

  if (httpStatus === 404) {
    const err = new Error(`Not found: ${url}`);
    err.code = 2;
    throw err;
  }

  if (httpStatus >= 500) {
    const err = new Error(`Server error ${httpStatus}: ${url}`);
    err.code = 3;
    throw err;
  }

  return { status: httpStatus, body };
}

// ---------------------------------------------------------------------------
// HTML Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text between two patterns.
 */
function extractBetween(html, start, end, defaultVal = '') {
  const si = html.indexOf(start);
  if (si === -1) return defaultVal;
  const ei = html.indexOf(end, si + start.length);
  if (ei === -1) return defaultVal;
  return html.slice(si + start.length, ei);
}

/**
 * Extract all matches of a regex pattern.
 */
function extractAll(html, pattern) {
  return [...html.matchAll(pattern)].map((m) => m[1] || m[0]);
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * Decode HTML entities.
 */
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract JSON-LD data from HTML.
 */
function extractJsonLd(html) {
  const results = [];
  const pattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      results.push(JSON.parse(match[1].trim()));
    } catch (_) {}
  }
  return results;
}

/**
 * Parse rating from CSS class (e.g., "result-rating four  " → 4)
 */
function parseRatingClass(classStr) {
  const map = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  for (const [word, val] of Object.entries(map)) {
    if (classStr.includes(word)) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search Result Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single listing <div class="result"> block.
 */
function parseListing(html) {
  const listing = {};

  // Business ID from data-ypid
  const ypidMatch = html.match(/data-ypid="([^"]+)"/);
  listing.ypid = ypidMatch ? ypidMatch[1] : '';

  // Listing type from data-analytics
  try {
    const analyticsMatch = html.match(/class="result"[^>]*data-analytics='([^']+)'/);
    if (analyticsMatch) {
      const analytics = JSON.parse(analyticsMatch[1]);
      listing.listingType = analytics.listing_type || '';
      listing.tier = analytics.tier || null;
    }
  } catch (_) {}

  // Business name and URL
  const nameMatch = html.match(/class="business-name"[^>]*href="([^"]+)"[^>]*><span>([^<]+)<\/span>/);
  if (nameMatch) {
    listing.name = decodeHtml(nameMatch[2].trim());
    listing.url = nameMatch[1].startsWith('http') ? nameMatch[1] : YP_BASE + nameMatch[1];
    listing.path = nameMatch[1];
  } else {
    listing.name = '';
    listing.url = '';
    listing.path = '';
  }

  // Phone
  const phoneMatch = html.match(/class="phones[^"]*">([^<]+)<\/div>/);
  listing.phone = phoneMatch ? phoneMatch[1].trim() : '';

  // Street address
  const streetMatch = html.match(/class="street-address">([^<]+)<\/div>/);
  listing.streetAddress = streetMatch ? decodeHtml(streetMatch[1].trim()) : '';

  // Locality (city, state, zip)
  const localityMatch = html.match(/class="locality">([^<]+)<\/div>/);
  listing.locality = localityMatch ? decodeHtml(localityMatch[1].trim()) : '';

  // Full address
  listing.address = [listing.streetAddress, listing.locality].filter(Boolean).join(', ');

  // Categories
  listing.categories = extractAll(
    extractBetween(html, 'class="categories"', '</div>'),
    />([^<]+)</g,
  )
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.includes('{'));

  // Rating
  const ratingClassMatch = html.match(/class="result-rating ([^"]+)"/);
  listing.rating = ratingClassMatch ? parseRatingClass(ratingClassMatch[1]) : null;

  // Review count
  const countMatch = html.match(/class="count">\((\d+)\)<\/span>/);
  listing.reviewCount = countMatch ? parseInt(countMatch[1]) : 0;

  // TripAdvisor rating
  const taMatch = html.match(/data-tripadvisor='{"rating":"([^"]+)","count":"([^"]+)"}/);
  if (taMatch) {
    listing.tripAdvisorRating = parseFloat(taMatch[1]);
    listing.tripAdvisorCount = parseInt(taMatch[2]);
  }

  // Website
  const websiteMatch = html.match(/class="track-visit-website"[^>]*href="([^"]+)"/);
  listing.website = websiteMatch ? websiteMatch[1] : '';

  // Image
  const imgMatch = html.match(/class="media-thumbnail-wrapper[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
  listing.imageUrl = imgMatch ? imgMatch[1].trim() : '';

  // Price range
  const priceMatch = html.match(/class="price-range">([^<]+)<\/div>/);
  listing.priceRange = priceMatch ? priceMatch[1].trim() : '';

  // Open status
  const openMatch = html.match(/class="open-status[^"]*">[\s\S]*?<\/[^>]+>([^<]+)<\/div>/);
  listing.openStatus = openMatch ? openMatch[1].trim() : '';

  return listing;
}

/**
 * Parse all listings from a search results page.
 */
function parseSearchPage(html) {
  // Extract total count
  let totalCount = 0;
  const showingMatch = html.match(/Showing \d+-\d+ of ([\d,]+)/);
  if (showingMatch) {
    totalCount = parseInt(showingMatch[1].replace(/,/g, ''));
  }

  // Extract organic results section
  const organicStart = html.indexOf('class="search-results organic"');
  if (organicStart === -1) {
    log('No organic results section found');
    return { listings: [], totalCount };
  }

  // Extract each result div
  const listings = [];
  let searchPos = organicStart;

  while (true) {
    const resultStart = html.indexOf('class="result"', searchPos);
    if (resultStart === -1) break;

    // Find the opening <div before class="result"
    const divStart = html.lastIndexOf('<div', resultStart);
    if (divStart === -1) break;

    // Find matching closing </div> — count nesting
    let depth = 1;
    let pos = divStart + 4;
    while (depth > 0 && pos < html.length) {
      const nextOpen = html.indexOf('<div', pos);
      const nextClose = html.indexOf('</div>', pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + 4;
      } else {
        depth--;
        pos = nextClose + 6;
      }
    }

    const resultHtml = html.slice(divStart, pos);
    const parsed = parseListing(resultHtml);
    if (parsed.name) {
      listings.push(parsed);
    }

    searchPos = pos;
  }

  return { listings, totalCount };
}

// ---------------------------------------------------------------------------
// Detail Page Parser
// ---------------------------------------------------------------------------

/**
 * Parse a business detail (MIP) page.
 */
function parseDetailPage(html, url) {
  const detail = { url };

  // Try JSON-LD first (most reliable)
  const jsonLds = extractJsonLd(html);
  const businessLd = jsonLds.find(
    (ld) =>
      ld['@type'] &&
      (ld['@type'].includes('LocalBusiness') ||
        ld['@type'].includes('Restaurant') ||
        ld['@type'].includes('schema.org')),
  );

  if (businessLd) {
    detail.name = businessLd.name || '';
    detail.phone = businessLd.telephone || '';
    detail.priceRange = businessLd.priceRange || '';
    detail.menuUrl = businessLd.menu ? YP_BASE + businessLd.menu : '';
    detail.openingHours = businessLd.openingHours || [];

    if (businessLd.address) {
      detail.streetAddress = businessLd.address.streetAddress || '';
      detail.city = businessLd.address.addressLocality || '';
      detail.state = businessLd.address.addressRegion || '';
      detail.zip = businessLd.address.postalCode || '';
      detail.country = businessLd.address.addressCountry || '';
      detail.address = [detail.streetAddress, detail.city, detail.state, detail.zip]
        .filter(Boolean)
        .join(', ');
    }

    if (businessLd.aggregateRating) {
      detail.rating = businessLd.aggregateRating.ratingValue || null;
      detail.reviewCount = businessLd.aggregateRating.reviewCount || 0;
    }

    if (businessLd.geo) {
      detail.latitude = businessLd.geo.latitude || null;
      detail.longitude = businessLd.geo.longitude || null;
    }

    if (businessLd.image) {
      detail.imageUrl = businessLd.image.url || businessLd.image.contentUrl || '';
      detail.imageThumbnailUrl = businessLd.image.thumbnailUrl || '';
    }
  }

  // Fill in from HTML for fields not in JSON-LD

  // Business name fallback
  if (!detail.name) {
    const nameMatch = html.match(/<h1[^>]*class="business-name"[^>]*>([^<]+)<\/h1>/);
    if (nameMatch) detail.name = decodeHtml(nameMatch[1].trim());
  }

  // Phone from HTML
  if (!detail.phone) {
    const phoneMatch = html.match(/class="(?:phone|phones)[^"]*">([^<]+)<\/(?:a|p|div)>/);
    if (phoneMatch) detail.phone = phoneMatch[1].trim();
  }

  // Extra phones
  const extraPhonesMatch = html.match(/class="extra-phones"[\s\S]*?<dd[^>]*class="extra-phones"[^>]*>([^<]+)<\/dd>/);
  if (extraPhonesMatch) {
    detail.extraPhones = decodeHtml(extraPhonesMatch[1].trim());
  }

  // Website
  const websiteMatch = html.match(/class="track-visit-website"[^>]*href="([^"]+)"/);
  if (websiteMatch) detail.website = websiteMatch[1];

  // Categories
  const catsSection = extractBetween(html, 'class="categories"', '</div>');
  const cats = extractAll(catsSection, /<a[^>]*>([^<]+)<\/a>/g);
  detail.categories = cats.map(decodeHtml).filter(Boolean);

  // Hours from HTML table (more detailed)
  const hoursTable = [];
  const hourPattern = /<td[^>]*class="day-hours"[^>]*>([\s\S]*?)<\/td>/g;
  for (const match of html.matchAll(hourPattern)) {
    hoursTable.push(stripTags(match[1]).trim());
  }
  if (hoursTable.length > 0) {
    detail.hoursRaw = hoursTable.join(' | ');
  }

  // Other information (cuisine, price range description, etc.)
  const otherInfoMatch = html.match(/class="other-information"[\s\S]*?<dd[^>]*class="other-information"[^>]*>([\s\S]*?)<\/dd>/);
  if (otherInfoMatch) {
    detail.otherInfo = decodeHtml(stripTags(otherInfoMatch[1]).trim());
  }

  // Years in business
  const yearsMatch = html.match(/class="years-in-business"[\s\S]*?<strong>(\d+) Years<\/strong>/);
  if (yearsMatch) {
    detail.yearsInBusiness = parseInt(yearsMatch[1]);
  }

  // YPID from URL or data
  const ypidMatch = (url || '').match(/-(\d+)(?:\?|$)/);
  if (ypidMatch) detail.ypid = ypidMatch[1];

  // Extract reviews
  const reviews = [];
  const reviewPattern = /<div[^>]*class="review-info"[\s\S]*?<a[^>]*class="author"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<\/div>/g;
  for (const match of html.matchAll(reviewPattern)) {
    reviews.push({
      authorUrl: match[1],
      author: match[2].trim(),
      datePosted: match[3].trim(),
    });
  }
  if (reviews.length > 0) {
    detail.recentReviews = reviews.slice(0, 5);
  }

  return detail;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Search for businesses.
 */
async function cmdSearch(query, location, opts) {
  const { pages = 1, delay = 1500, output } = opts;

  console.error(`[yellowpages] Searching: "${query}" in "${location}" (${pages} page(s))`);

  // Build all URLs upfront
  const urls = [];
  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({
      search_terms: query,
      geo_location_terms: location,
    });
    if (page > 1) params.set('page', String(page));
    urls.push(`${YP_BASE}/search?${params}`);
  }

  // Fetch all pages in a single Python session (maintains cookies across requests)
  let responses;
  try {
    responses = fetchUrls(urls, delay);
  } catch (err) {
    bail(`Failed to fetch search pages: ${err.message}`, 3);
  }

  const allListings = [];
  let totalCount = 0;

  for (let i = 0; i < responses.length; i++) {
    const page = i + 1;
    const r = responses[i];

    if (r.status === 403 || r.status === 429) {
      const isRateLimit = r.status === 429;
      const isWAF = r.body && (r.body.includes('cloudflare') || r.body.includes('Cloudflare'));
      if (isWAF || r.status === 403) {
        console.error('[yellowpages:error] WAF/Cloudflare block detected on page', page);
        if (allListings.length === 0) process.exit(4);
        console.error('[yellowpages:warn] Partial results returned (blocked mid-scrape)');
        break;
      }
      if (isRateLimit) {
        console.error('[yellowpages:error] Rate limited (HTTP 429) on page', page);
        if (allListings.length === 0) process.exit(5);
        break;
      }
    }

    if (r.error || !r.body) {
      bail(`Failed to fetch page ${page}: ${r.error || 'empty response'}`, 3);
    }

    const parsed = parseSearchPage(r.body);

    if (page === 1) {
      totalCount = parsed.totalCount;
      console.error(`[yellowpages] Found ${totalCount} total results`);
    }

    console.error(`[yellowpages] Page ${page}: ${parsed.listings.length} listings`);
    allListings.push(...parsed.listings);

    // Stop if we got fewer results than expected (last page)
    if (parsed.listings.length < 30) break;
  }

  if (allListings.length === 0) {
    console.error('[yellowpages:warn] No listings found');
    process.exit(2);
  }

  const result = {
    query,
    location,
    totalCount,
    pagesScraped: pages,
    totalScraped: allListings.length,
    listings: allListings,
    scrapedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(result, null, 2);

  if (output) {
    writeFileSync(output, json);
    console.error(`[yellowpages] Saved to ${output}`);
  }

  console.log(json);
}

/**
 * Get business detail page.
 */
async function cmdDetail(urlOrPath, opts) {
  const { output } = opts;

  // Normalize URL
  let url = urlOrPath;
  if (!url.startsWith('http')) {
    url = YP_BASE + (url.startsWith('/') ? url : '/' + url);
  }

  console.error(`[yellowpages] Fetching detail: ${url}`);

  let response;
  try {
    response = fetchUrl(url);
  } catch (err) {
    if (err.code === 4) {
      console.error('[yellowpages:error] WAF/Cloudflare block detected.');
      process.exit(4);
    }
    if (err.code === 2) {
      console.error('[yellowpages:error] Business not found (404).');
      process.exit(2);
    }
    bail(`Failed to fetch detail: ${err.message}`, 3);
  }

  const detail = parseDetailPage(response.body, url);
  detail.scrapedAt = new Date().toISOString();

  const json = JSON.stringify(detail, null, 2);

  if (output) {
    writeFileSync(output, json);
    console.error(`[yellowpages] Saved to ${output}`);
  }

  console.log(json);
}

// ---------------------------------------------------------------------------
// CLI Entrypoint
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const positional = [];

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      if (key === 'verbose') {
        opts.verbose = true;
      } else if (key === 'pages') {
        opts.pages = parseInt(val);
      } else if (key === 'delay') {
        opts.delay = parseInt(val);
      } else if (key === 'output') {
        opts.output = val;
      }
    } else {
      positional.push(arg);
    }
  }

  return { opts, positional };
}

const USAGE = `
Usage:
  node business-scraper.mjs search <query> <location> [options]
  node business-scraper.mjs detail <url-or-path>

Commands:
  search    Search for businesses by type/name and location
  detail    Fetch full details for a specific business page

Options:
  --pages=N      Number of search pages to scrape (default: 1, 30/page)
  --delay=MS     Delay between pages in ms (default: 1500)
  --output=FILE  Save JSON output to file
  --verbose      Enable verbose logging

Examples:
  node business-scraper.mjs search "pizza" "New York, NY"
  node business-scraper.mjs search "plumber" "Los Angeles, CA" --pages=3
  node business-scraper.mjs detail "/new-york-ny/mip/business-name-123456"
  node business-scraper.mjs detail "https://www.yellowpages.com/new-york-ny/mip/..."
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const { opts, positional } = parseArgs(args);

  if (opts.verbose) {
    verbose = true;
  }

  const command = positional[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === 'search') {
    const query = positional[1];
    const location = positional[2];

    if (!query) bail('Missing required argument: <query>\n\n' + USAGE);
    if (!location) bail('Missing required argument: <location>\n\n' + USAGE);

    await cmdSearch(query, location, opts);
  } else if (command === 'detail') {
    const urlOrPath = positional[1];
    if (!urlOrPath) bail('Missing required argument: <url-or-path>\n\n' + USAGE);
    await cmdDetail(urlOrPath, opts);
  } else {
    bail(`Unknown command: ${command}\n\n` + USAGE);
  }
}

main().catch((err) => {
  console.error('[yellowpages:fatal]', err.message);
  process.exit(1);
});
