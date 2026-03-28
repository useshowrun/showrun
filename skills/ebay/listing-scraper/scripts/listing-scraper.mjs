#!/usr/bin/env node
/**
 * eBay Listing Scraper
 *
 * Scrapes eBay product listings, listing details, seller profiles,
 * and sold/completed listings.
 *
 * No auth, no API key, no browser required — plain HTTP requests work.
 * eBay uses server-side rendering; listing data is embedded in HTML.
 *
 * Usage:
 *   node listing-scraper.mjs search <query> [options]
 *   node listing-scraper.mjs listing <id-or-url>
 *   node listing-scraper.mjs seller <username>
 *   node listing-scraper.mjs sold <query> [options]
 *
 * Options:
 *   --pages=N           Number of pages to scrape (default: 1)
 *   --category=ID       eBay category ID (default: 0 = all)
 *   --min-price=N       Minimum price filter (USD)
 *   --max-price=N       Maximum price filter (USD)
 *   --condition=COND    Condition: new | used | refurbished | parts
 *   --sort=SORT         Sort: best-match | ending-soon | newest | price-asc | price-desc
 *   --type=TYPE         Listing type: all | buy-now | auction
 *   --ipg=N             Items per page (default: 50, max: 100)
 *   --delay=MS          Delay between requests in ms (default: 1500)
 *   --output=FILE       Write JSON output to file
 *   --verbose           Enable verbose logging
 *
 * Exit codes:
 *   0  Success
 *   1  Usage / config error
 *   2  No results found
 *   3  Network / HTTP error
 *   4  Bot detection / WAF block
 *   5  Rate limit
 *
 * Data sources used:
 *   1. HTML scraping — s-card li elements (data-listingid, img alt, price)
 *   2. Page title — listing title
 *   3. Inline JSON blobs — price, condition, seller, schema.org data
 *   4. Feedback profile page — seller score, positive %, star rating
 *
 * Bot detection notes:
 *   - eBay does NOT use Cloudflare or DataDome
 *   - Plain HTTP requests with standard browser UA work fine
 *   - No CAPTCHA detected from datacenter/Turkish IPs
 *   - If unexpected blocks occur, enable --camoufox flag (camoufox fallback)
 */

import { execFileSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/ebay');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const COOKIE_FILE = resolve(DATA_DIR, 'cookies.txt');

const EBAY_BASE = 'https://www.ebay.com';

const SORT_MAP = {
  'best-match': '12',
  'ending-soon': '15',
  newest: '1',
  'price-asc': '3',
  'price-desc': '2',
};

const CONDITION_MAP = {
  new: '1000',
  used: '3000',
  refurbished: '2500',
  parts: '7000',
};

const CONDITION_SCHEMA_MAP = {
  NewCondition: 'New',
  UsedCondition: 'Used',
  RefurbishedCondition: 'Refurbished',
  DamagedCondition: 'For parts or not working',
  UnspecifiedCondition: 'Not specified',
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let verbose = false;
function log(...args) {
  if (verbose) console.error('[ebay]', ...args);
}
function warn(...args) {
  console.error('[ebay:warn]', ...args);
}
function bail(msg, code = 1) {
  console.error(`[ebay:error] ${msg}`);
  process.exit(code);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveJson(filePath, data) {
  ensureDir(resolve(filePath, '..'));
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function unescapeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ---------------------------------------------------------------------------
// HTTP fetch (using curl with session cookies)
// ---------------------------------------------------------------------------

// Session state: after first search, cookies are saved for subsequent requests
let _sessionInitialized = false;

/**
 * Initialize session by visiting eBay homepage to get session cookies.
 * This bypasses the "Pardon Our Interruption" / browser challenge on item pages.
 */
function initSession() {
  if (_sessionInitialized) return;
  _sessionInitialized = true;

  ensureDir(DATA_DIR);

  // Check if we have recent cookies (< 4 hours old)
  if (existsSync(COOKIE_FILE)) {
    try {
      const stat = statSync(COOKIE_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 4 * 60 * 60 * 1000) {
        log('Using existing session cookies');
        return;
      }
    } catch (_) {}
  }

  log('Initializing eBay session (fetching search page for cookies)...');
  const curlBin = process.env.CURL_BINARY || 'curl';
  try {
    execFileSync(
      curlBin,
      [
        '-s', '-o', '/dev/null',
        '-c', COOKIE_FILE,
        '-A', DEFAULT_UA,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: en-US,en;q=0.5',
        '-H', 'Accept-Encoding: gzip, deflate, br',
        '--compressed', '-L',
        `${EBAY_BASE}/sch/i.html?_nkw=electronics&_ipg=1`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    log('Session cookies saved');
  } catch (err) {
    warn(`Session init failed (will try without cookies): ${err.message}`);
  }
}

function fetchUrl(url, { followRedirects = true, timeout = 30, referer = EBAY_BASE, useCookies = true } = {}) {
  const curlBin = process.env.CURL_BINARY || 'curl';

  const args = [
    '-s',
    '-A', DEFAULT_UA,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.5',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', `Referer: ${referer}`,
    '--compressed',
    '--max-time', String(timeout),
    '-w', '\n---HTTP_STATUS:%{http_code}---',
  ];

  if (followRedirects) {
    args.push('-L', '--max-redirs', '5');
  }

  // Use session cookies to bypass browser challenge on item/feedback pages
  if (useCookies && existsSync(COOKIE_FILE)) {
    args.push('-b', COOKIE_FILE, '-c', COOKIE_FILE);
  }

  args.push(url);

  log(`GET ${url}`);

  let output;
  try {
    output = execFileSync(curlBin, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`curl failed: ${err.message}`);
  }

  // Extract HTTP status from the appended marker
  const statusMatch = output.match(/\n---HTTP_STATUS:(\d+)---\s*$/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const body = statusMatch ? output.slice(0, output.lastIndexOf('\n---HTTP_STATUS:')) : output;

  return { status, body, url };
}

function checkWaf(body, url) {
  const bodyLower = body.toLowerCase();
  if (
    bodyLower.includes('pardon our interruption') ||
    bodyLower.includes('checking your browser before you access') ||
    bodyLower.includes('please verify yourself to continue') ||
    bodyLower.includes('access denied') ||
    bodyLower.includes('bot detection') ||
    (bodyLower.includes('captcha') && bodyLower.includes('verify')) ||
    body.length < 500
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Search parsing
// ---------------------------------------------------------------------------

function parseSearchPage(html) {
  const items = [];

  // Match s-card listing items
  // Each listing: <li ... data-listingid=XXXXX ... class="s-card ...">
  const cardPattern =
    /<li[^>]+data-listingid=([0-9]+)[^>]+class="[^"]*s-card[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]+data-viewport|<\/ul>|<\/ol>)/g;

  let match;
  while ((match = cardPattern.exec(html)) !== null) {
    const listingId = match[1];
    const cardHtml = match[2];

    // Skip promotional/sponsored items with non-real IDs
    // Real listing IDs are typically 12 digits, promo IDs start with 25002...
    if (listingId.startsWith('250021') && listingId.length > 13) continue;

    const item = { listingId };

    // URL
    const urlMatch = cardHtml.match(
      /href=(https:\/\/www\.ebay\.com\/itm\/([0-9]+)[^\s"<]*)/,
    );
    if (urlMatch) {
      item.url = `https://www.ebay.com/itm/${urlMatch[2]}`;
      item.listingId = urlMatch[2]; // Use canonical ID from URL
    }

    // Title from img alt attribute (first substantial alt in the card)
    // eBay renders the product title as the img alt text
    const altMatch = cardHtml.match(/alt="([^"]{10,})"/);
    if (altMatch) {
      item.title = unescapeHtml(altMatch[1]);
    }
    // Fallback: watch aria-label="watch TITLE"
    if (!item.title) {
      const watchMatch = cardHtml.match(/aria-label="watch ([^"]{10,})"/i);
      if (watchMatch) item.title = unescapeHtml(watchMatch[1]);
    }

    // Image URL
    const imgMatch = cardHtml.match(/src=(https:\/\/i\.ebayimg\.com\/[^\s"<>]+)/);
    if (imgMatch) item.imageUrl = imgMatch[1].replace(/[>&]+$/, '');

    // Price patterns: $179.78, $1,234.00
    const priceMatch = cardHtml.match(/\$([\d,]+\.?\d*)/);
    if (priceMatch) {
      item.price = parseFloat(priceMatch[1].replace(/,/g, ''));
      item.priceText = `$${priceMatch[1]}`;
    }

    // Shipping
    if (/free\s+shipping/i.test(cardHtml)) {
      item.freeShipping = true;
    }

    // Sponsored/ad marker
    if (/sponsored|promoted/i.test(cardHtml.substring(0, 500))) {
      item.sponsored = true;
    }

    // Only add items with meaningful data
    if (item.url || item.title) {
      items.push(item);
    }
  }

  return items;
}

function parseTotalResults(html) {
  // eBay doesn't always show total in SSR, check pagination for clues
  const pageMatch = html.match(/Results Pagination - Page (\d+)/);
  return pageMatch ? parseInt(pageMatch[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function doSearch(query, options = {}) {
  const {
    pages = 1,
    category = '0',
    minPrice,
    maxPrice,
    condition,
    sort,
    type,
    ipg = 50,
    delay = 1500,
    sold = false,
    output,
  } = options;

  // Initialize session cookies on first run
  initSession();

  const allListings = [];
  let errors = 0;

  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({
      _nkw: query,
      _sacat: category,
      _pgn: String(page),
      _ipg: String(Math.min(ipg, 100)),
    });

    if (sort && SORT_MAP[sort]) params.set('_sop', SORT_MAP[sort]);
    if (minPrice) params.set('_udlo', String(minPrice));
    if (maxPrice) params.set('_udhi', String(maxPrice));
    if (condition && CONDITION_MAP[condition]) {
      params.set('LH_ItemCondition', CONDITION_MAP[condition]);
    }
    if (type === 'buy-now') params.set('LH_BIN', '1');
    if (type === 'auction') params.set('LH_Auction', '1');
    if (sold) {
      params.set('LH_Sold', '1');
      params.set('LH_Complete', '1');
    }

    const url = `${EBAY_BASE}/sch/i.html?${params}`;
    log(`Fetching page ${page}: ${url}`);

    let response;
    try {
      response = fetchUrl(url, { referer: `${EBAY_BASE}/` });
    } catch (err) {
      warn(`Page ${page} fetch error: ${err.message}`);
      errors++;
      if (errors >= 3) bail(`Too many fetch errors. Last error: ${err.message}`, 3);
      break;
    }

    if (response.status !== 200) {
      if (response.status === 429) bail('Rate limited by eBay (HTTP 429)', 5);
      warn(`HTTP ${response.status} for page ${page}`);
      errors++;
      break;
    }

    if (checkWaf(response.body, url)) {
      bail(
        `WAF/bot block detected on page ${page}.\n` +
          'eBay normally does not block plain HTTP requests.\n' +
          'Try: (1) reduce request rate with --delay=5000, (2) use a residential proxy.',
        4,
      );
    }

    const items = parseSearchPage(response.body);
    log(`Page ${page}: found ${items.length} items`);

    if (items.length === 0) {
      log(`No items on page ${page}, stopping pagination`);
      break;
    }

    allListings.push(...items);

    if (page < pages) {
      await sleep(delay);
    }
  }

  const result = {
    query,
    pages: Math.min(pages, Math.ceil(allListings.length / ipg) + 1),
    totalScraped: allListings.length,
    sold,
    options: {
      category: category !== '0' ? category : undefined,
      sort,
      condition,
      minPrice,
      maxPrice,
      type,
    },
    listings: allListings,
    scrapedAt: new Date().toISOString(),
  };

  if (output) {
    saveJson(output, result);
    console.error(`[ebay] Saved to: ${output}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Listing detail
// ---------------------------------------------------------------------------

function parseListingDetail(html, itemId) {
  const item = { itemId };

  // Title from page title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) {
    item.title = unescapeHtml(titleMatch[1].replace(/\s*\|\s*eBay\s*$/, '').trim());
  }

  // Price
  const priceMatch = html.match(/"price":\s*"?([\d.]+)"?/);
  if (priceMatch) {
    item.price = parseFloat(priceMatch[1]);
    item.priceText = `$${priceMatch[1]}`;
  }

  // Price range (auction / variant)
  const priceRangeMatch = html.match(/"priceLow":\s*"?([\d.]+)"?[^}]*"priceHigh":\s*"?([\d.]+)"?/);
  if (priceRangeMatch) {
    item.priceRange = {
      low: parseFloat(priceRangeMatch[1]),
      high: parseFloat(priceRangeMatch[2]),
    };
  }

  // Condition from schema.org
  const condMatch = html.match(/"itemCondition":\s*"(https?:\/\/schema\.org\/[^"]+)"/);
  if (condMatch) {
    const condUrl = condMatch[1];
    const condKey = condUrl.split('/').pop();
    item.condition = CONDITION_SCHEMA_MAP[condKey] || condKey;
    item.conditionUrl = condUrl;
  }

  // Condition display name fallback
  if (!item.condition) {
    const condDisplay = html.match(/"conditionDisplayName":\s*"([^"]+)"/);
    if (condDisplay) item.condition = condDisplay[1];
  }

  // Seller username
  const sellerMatch = html.match(/"sellerUserName":\s*"([^"]+)"/);
  if (sellerMatch) item.sellerUsername = sellerMatch[1];

  // Seller display name from store link
  const sellerNameMatch = html.match(/"_ssn":\s*"([^"]+)"/);
  if (sellerNameMatch) item.sellerDisplayName = unescapeHtml(sellerNameMatch[1]);

  // Seller feedback score
  const fbScoreMatch = html.match(/"feedbackScore":\s*([0-9]+)/);
  if (fbScoreMatch) item.sellerFeedbackScore = parseInt(fbScoreMatch[1], 10);

  // Seller feedback percentage
  const fbPctMatch = html.match(/"feedbackPercentage":\s*"?([0-9.]+)"?/);
  if (fbPctMatch) item.sellerFeedbackPercentage = parseFloat(fbPctMatch[1]);

  // Free shipping
  item.freeShipping = /free\s+shipping/i.test(html);

  // Sold count
  const soldMatch = html.match(/([0-9,]+)\+?\s+sold/i);
  if (soldMatch) item.soldCount = parseInt(soldMatch[1].replace(/,/g, ''), 10);

  // Item URL
  item.url = `${EBAY_BASE}/itm/${itemId}`;

  // Category
  const catIdMatch = html.match(/"primaryCategoryId":\s*"?([0-9]+)"?/);
  if (catIdMatch) item.categoryId = catIdMatch[1];

  const catNameMatch = html.match(/"categoryName":\s*"([^"]+)"/);
  if (catNameMatch) item.categoryName = catNameMatch[1];

  // Images (clean trailing > or & from unquoted attribute values)
  const imgMatches = [...html.matchAll(/src=(https:\/\/i\.ebayimg\.com\/images\/g\/[^\s"<>]+)/g)];
  const uniqueImages = [...new Set(imgMatches.map((m) => m[1].replace(/[>&]+$/, '')))];
  if (uniqueImages.length > 0) {
    item.imageUrl = uniqueImages[0];
    if (uniqueImages.length > 1) item.images = uniqueImages.slice(0, 10);
  }

  // Item location
  const locationMatch = html.match(/"itemLocation":\s*"([^"]+)"/);
  if (locationMatch) item.itemLocation = locationMatch[1];

  // Currency
  const currencyMatch = html.match(/"priceCurrency":\s*"([A-Z]{3})"/);
  if (currencyMatch) item.currency = currencyMatch[1];

  // Shipping type
  const shipTypeMatch = html.match(/"shippingType":\s*"([^"]+)"/);
  if (shipTypeMatch) item.shippingType = shipTypeMatch[1];

  return item;
}

async function doListing(idOrUrl, options = {}) {
  let itemId;

  // Parse ID or URL
  if (/^[0-9]+$/.test(idOrUrl)) {
    itemId = idOrUrl;
  } else {
    const urlMatch = idOrUrl.match(/\/itm\/([0-9]+)/);
    if (urlMatch) {
      itemId = urlMatch[1];
    } else {
      bail(`Invalid listing ID or URL: ${idOrUrl}`);
    }
  }

  // Ensure session cookies are set (needed to bypass browser challenge on item pages)
  initSession();

  const url = `${EBAY_BASE}/itm/${itemId}`;
  log(`Fetching listing: ${url}`);

  let response;
  try {
    response = fetchUrl(url, { referer: `${EBAY_BASE}/sch/i.html?_nkw=search` });
  } catch (err) {
    bail(`Fetch error: ${err.message}`, 3);
  }

  if (response.status === 404) bail(`Listing ${itemId} not found (404)`, 2);
  if (response.status !== 200) bail(`HTTP ${response.status} for listing ${itemId}`, 3);

  if (checkWaf(response.body, url)) {
    bail('WAF/bot block detected.', 4);
  }

  const item = parseListingDetail(response.body, itemId);
  item.scrapedAt = new Date().toISOString();

  if (options.output) {
    saveJson(options.output, item);
    console.error(`[ebay] Saved to: ${options.output}`);
  }

  return item;
}

// ---------------------------------------------------------------------------
// Seller feedback
// ---------------------------------------------------------------------------

function parseSellerProfile(html, username) {
  const profile = { username };

  // Feedback score: "170,099 feedback" pattern
  const fbScoreMatch = html.match(/([0-9,]+)\s+feedback/i);
  if (fbScoreMatch) {
    profile.feedbackScore = parseInt(fbScoreMatch[1].replace(/,/g, ''), 10);
  }

  // Positive feedback percentage
  const fbPctMatch = html.match(/Positive Feedback[^:]*:\s*([0-9.]+)%/i);
  if (fbPctMatch) {
    profile.positiveFeedbackPercent = parseFloat(fbPctMatch[1]);
  }

  // Star rating JSON
  const starMatch = html.match(/"averageRating":\s*\{[^}]*"value":\s*([0-9.]+)/);
  if (starMatch) {
    profile.averageRating = parseFloat(starMatch[1]);
  }

  // Rating count
  const ratingCountMatch = html.match(/"ratingCount"[^:]*:\s*\{[^}]*"value":\s*([0-9]+)/);
  if (ratingCountMatch) {
    profile.ratingCount = parseInt(ratingCountMatch[1], 10);
  }

  // Store name
  const storeMatch = html.match(/"storeName":\s*"([^"]+)"/);
  if (storeMatch) profile.storeName = storeMatch[1];

  // Member since
  const memberMatch = html.match(/[Mm]ember\s+since[^>]*>([^<]+)/);
  if (memberMatch) profile.memberSince = memberMatch[1].trim();

  profile.profileUrl = `${EBAY_BASE}/usr/${username}`;
  profile.feedbackUrl = `${EBAY_BASE}/fdbk/feedback_profile/${username}`;

  return profile;
}

async function doSeller(username, options = {}) {
  // Ensure session cookies are set
  initSession();

  const url = `${EBAY_BASE}/fdbk/feedback_profile/${username}`;
  log(`Fetching seller feedback: ${url}`);

  let response;
  try {
    response = fetchUrl(url, { referer: `${EBAY_BASE}/` });
  } catch (err) {
    bail(`Fetch error: ${err.message}`, 3);
  }

  if (response.status === 404) bail(`Seller ${username} not found (404)`, 2);
  if (response.status !== 200) bail(`HTTP ${response.status} for seller ${username}`, 3);

  if (checkWaf(response.body, url)) bail('WAF/bot block detected.', 4);

  const profile = parseSellerProfile(response.body, username);
  profile.scrapedAt = new Date().toISOString();

  if (options.output) {
    saveJson(options.output, profile);
    console.error(`[ebay] Saved to: ${options.output}`);
  }

  return profile;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const positional = [];

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

const [, , command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

verbose = !!flags.verbose || !!flags.v;

const outputFile = flags.output ? resolve(process.cwd(), flags.output) : null;

switch (command) {
  case 'search': {
    const query = positional[0];
    if (!query) {
      console.error('Usage: node listing-scraper.mjs search <query> [options]');
      process.exit(1);
    }

    const options = {
      pages: parseInt(flags.pages || '1', 10),
      category: flags.category || '0',
      minPrice: flags['min-price'] ? parseFloat(flags['min-price']) : undefined,
      maxPrice: flags['max-price'] ? parseFloat(flags['max-price']) : undefined,
      condition: flags.condition,
      sort: flags.sort,
      type: flags.type,
      ipg: parseInt(flags.ipg || '50', 10),
      delay: parseInt(flags.delay || '1500', 10),
      output: outputFile,
    };

    const result = await doSearch(query, options);

    if (result.listings.length === 0) {
      console.error(`[ebay] No listings found for: ${query}`);
      process.exit(2);
    }

    console.log(JSON.stringify(result, null, 2));
    console.error(`\n[ebay] Found ${result.listings.length} listings across ${result.pages} page(s)`);
    break;
  }

  case 'sold': {
    const query = positional[0];
    if (!query) {
      console.error('Usage: node listing-scraper.mjs sold <query> [options]');
      process.exit(1);
    }

    const options = {
      pages: parseInt(flags.pages || '1', 10),
      category: flags.category || '0',
      minPrice: flags['min-price'] ? parseFloat(flags['min-price']) : undefined,
      maxPrice: flags['max-price'] ? parseFloat(flags['max-price']) : undefined,
      condition: flags.condition,
      sort: flags.sort,
      ipg: parseInt(flags.ipg || '50', 10),
      delay: parseInt(flags.delay || '1500', 10),
      sold: true,
      output: outputFile,
    };

    const result = await doSearch(query, options);

    if (result.listings.length === 0) {
      console.error(`[ebay] No sold listings found for: ${query}`);
      process.exit(2);
    }

    console.log(JSON.stringify(result, null, 2));
    console.error(`\n[ebay] Found ${result.listings.length} sold listings`);
    break;
  }

  case 'listing': {
    const idOrUrl = positional[0];
    if (!idOrUrl) {
      console.error('Usage: node listing-scraper.mjs listing <id-or-url>');
      process.exit(1);
    }

    const item = await doListing(idOrUrl, { output: outputFile });
    console.log(JSON.stringify(item, null, 2));
    console.error(`\n[ebay] Listing: ${item.title || item.itemId}`);
    break;
  }

  case 'seller': {
    const username = positional[0];
    if (!username) {
      console.error('Usage: node listing-scraper.mjs seller <username>');
      process.exit(1);
    }

    const profile = await doSeller(username, { output: outputFile });
    console.log(JSON.stringify(profile, null, 2));
    console.error(
      `\n[ebay] Seller: ${profile.username} — Score: ${profile.feedbackScore}, Positive: ${profile.positiveFeedbackPercent}%`,
    );
    break;
  }

  default: {
    console.log(`ebay-listing-scraper

Scrape eBay product listings, details, seller profiles, and sold listings.
No API key or authentication required.

Commands:
  search <query> [options]    Search active listings
  sold <query> [options]      Search completed/sold listings
  listing <id-or-url>         Get listing detail
  seller <username>           Get seller profile & feedback

Search/Sold Options:
  --pages=N                   Pages to scrape (default: 1)
  --category=ID               eBay category ID (0=all, 58058=computers)
  --min-price=N               Minimum price USD
  --max-price=N               Maximum price USD
  --condition=COND            new | used | refurbished | parts
  --sort=SORT                 best-match | ending-soon | newest | price-asc | price-desc
  --type=TYPE                 all | buy-now | auction
  --ipg=N                     Items per page (default: 50)
  --delay=MS                  Delay between pages ms (default: 1500)
  --output=FILE               Save JSON output to file
  --verbose                   Verbose logging

Examples:
  node listing-scraper.mjs search "laptop" --pages=3
  node listing-scraper.mjs search "iphone 14" --condition=used --sort=price-asc
  node listing-scraper.mjs search "vintage camera" --min-price=50 --max-price=500
  node listing-scraper.mjs sold "macbook pro" --pages=2
  node listing-scraper.mjs listing 256687932761
  node listing-scraper.mjs listing https://www.ebay.com/itm/256687932761
  node listing-scraper.mjs seller discountcomputerdepot
  node listing-scraper.mjs search "gpu" --output=/tmp/gpus.json --pages=5

Common Category IDs:
  0        All categories
  58058    Computers/Tablets
  9355     Cell Phones & Smartphones
  11450    Clothing, Shoes & Accessories
  1249     Video Games & Consoles
  293      Consumer Electronics
  11233    DVDs & Movies
  267      Books
  12576    Business & Industrial

Exit codes:
  0  Success
  1  Usage error
  2  No results found
  3  Network error
  4  WAF/bot block detected
  5  Rate limited`);
    process.exit(0);
  }
}
