#!/usr/bin/env node

/**
 * zoopla-property-search
 *
 * Search Zoopla for UK property listings (for sale, to rent, sold prices).
 * Handles Cloudflare Turnstile WAF automatically via Playwright + real Chrome.
 *
 * Usage:
 *   node property-search.mjs sale <location> [options]
 *   node property-search.mjs rent <location> [options]
 *   node property-search.mjs sold <location> [options]
 *
 * Options:
 *   --page=N           Page number (default: 1)
 *   --page-size=N      Results per page (default: 25)
 *   --beds-min=N       Minimum bedrooms
 *   --beds-max=N       Maximum bedrooms
 *   --price-min=N      Minimum price (£)
 *   --price-max=N      Maximum price (£)
 *   --type=TYPE        Property type: house|flat|bungalow|land|commercial
 *   --sort=SORT        Sort: newest|price-asc|price-desc
 *   --radius=R         Search radius in miles
 *   --output=FILE      Save JSON to file
 *   --cdp-url=URL      Connect to existing Chrome via CDP
 *   --timeout=MS       Browser timeout (default: 45000)
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/zoopla');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const MAX_CF_WAIT_MS = 30_000;  // Max time to wait for Cloudflare to clear

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function log(msg) {
  process.stderr.write(`[zoopla] ${msg}\n`);
}

function exitError(code, message, detail = '') {
  const err = { error: { code, message, detail } };
  process.stderr.write(`[zoopla] ERROR ${code}: ${message}${detail ? ' — ' + detail : ''}\n`);
  console.log(JSON.stringify(err, null, 2));
  process.exit(code === 'WAF_BLOCKED' ? 2 : 1);
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

const SORT_MAP = {
  newest: 'newest_listings',
  'price-asc': 'lowest_price',
  'price-desc': 'highest_price',
  relevance: 'relevance',
};

const TYPE_MAP = {
  house: 'house',
  flat: 'flat',
  bungalow: 'bungalow',
  land: 'land',
  commercial: 'commercial',
  other: 'other',
};

function buildUrl(type, location, flags) {
  const page = parseInt(flags.page || '1', 10);
  const pageSize = Math.min(parseInt(flags['page-size'] || '25', 10), 25);
  const sortKey = flags.sort || 'newest';
  const sort = SORT_MAP[sortKey] || 'newest_listings';

  // Encode location for URL path
  const loc = encodeURIComponent(location.toLowerCase().replace(/\s+/g, '-'));

  if (type === 'sold') {
    return `https://www.zoopla.co.uk/sold-house-prices/${loc}/`;
  }

  const base = type === 'rent'
    ? `https://www.zoopla.co.uk/to-rent/property/${loc}/`
    : `https://www.zoopla.co.uk/for-sale/property/${loc}/`;

  const params = new URLSearchParams({
    q: location,
    search_source: 'home',
    page_size: String(pageSize),
    pn: String(page),
    results_sort: sort,
  });

  if (flags['beds-min']) params.set('beds_min', flags['beds-min']);
  if (flags['beds-max']) params.set('beds_max', flags['beds-max']);
  if (flags['price-min']) params.set('price_min', flags['price-min']);
  if (flags['price-max']) params.set('price_max', flags['price-max']);
  if (flags.type && TYPE_MAP[flags.type]) params.set('property_type', TYPE_MAP[flags.type]);
  if (flags.radius) params.set('radius', flags.radius);

  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Browser management
// ---------------------------------------------------------------------------

async function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    process.env.CHROME_PATH,
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function findPlaywrightChromium() {
  // Check Playwright's bundled Chromium
  const candidates = [
    resolve(homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'),
    resolve(homedir(), '.cache/ms-playwright/chromium-1161/chrome-linux64/chrome'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Try glob-style search
  try {
    const result = execSync(
      `find ${homedir()}/.cache/ms-playwright/ -name 'chrome' -path '*/chrome-linux*' 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (result && existsSync(result)) return result;
  } catch {}
  return null;
}

function isXvfbAvailable() {
  try {
    execSync('which Xvfb 2>/dev/null', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

let xvfbProcess = null;

function startXvfb() {
  if (!isXvfbAvailable()) return null;
  try {
    const proc = execSync('Xvfb :98 -screen 0 1280x800x24 -nolisten tcp 2>/dev/null &; echo $!', {
      encoding: 'utf8',
      timeout: 5000,
      shell: true,
    });
    log('Started Xvfb on :98');
    return proc.trim();
  } catch (e) {
    log(`Xvfb start warning: ${e.message}`);
    return null;
  }
}

async function launchBrowser(options = {}) {
  const { cdpUrl, timeout = 45000 } = options;

  // Option 1: Connect to existing Chrome via CDP
  if (cdpUrl) {
    log(`Connecting to existing Chrome at ${cdpUrl}...`);
    try {
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10000 });
      log('Connected to existing Chrome');
      return { browser, ownsProcess: false };
    } catch (e) {
      exitError('CDP_CONNECT_FAILED', `Cannot connect to Chrome at ${cdpUrl}`, e.message);
    }
  }

  // Option 2: Launch real Chrome (for CF bypass) with Xvfb
  const chromePath = await findChrome();
  if (chromePath) {
    log(`Launching real Chrome at ${chromePath}...`);

    // Start Xvfb if needed and not already running
    const hasDisplay = process.env.DISPLAY;
    if (!hasDisplay && isXvfbAvailable()) {
      log('Starting Xvfb virtual display...');
      startXvfb();
      // Give Xvfb time to start
      await new Promise(r => setTimeout(r, 2000));
      process.env.DISPLAY = ':98';
    }

    try {
      const browser = await chromium.launch({
        executablePath: chromePath,
        headless: false,  // CRITICAL: Real (non-headless) for CF bypass
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--remote-allow-origins=*',
        ],
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':98',
        },
        timeout,
      });
      log('Real Chrome launched');
      return { browser, ownsProcess: true };
    } catch (e) {
      log(`Real Chrome failed: ${e.message}, trying Playwright Chromium...`);
    }
  }

  // Option 3: Playwright's bundled Chromium (less likely to bypass CF, but try)
  const pwPath = await findPlaywrightChromium();
  if (pwPath) {
    log(`Launching Playwright Chromium at ${pwPath} (WARNING: may be blocked by Cloudflare)...`);
    const browser = await chromium.launch({
      executablePath: pwPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      timeout,
    });
    return { browser, ownsProcess: true };
  }

  exitError('NO_CHROME', 'No Chrome/Chromium found', 'Install google-chrome-stable or set CHROME_PATH env var');
}

// ---------------------------------------------------------------------------
// Cloudflare detection & waiting
// ---------------------------------------------------------------------------

async function waitForCloudflare(page, maxWaitMs = MAX_CF_WAIT_MS) {
  const start = Date.now();
  let lastTitle = '';

  while (Date.now() - start < maxWaitMs) {
    const title = await page.title().catch(() => '');

    if (title !== lastTitle) {
      log(`Title: "${title}"`);
      lastTitle = title;
    }

    if (
      !title.includes('Just a moment') &&
      !title.includes('Cloudflare') &&
      !title.includes('Please Wait') &&
      title !== ''
    ) {
      return { passed: true, title };
    }

    // Check for hard block (botnet overlay)
    const isHardBlock = await page.evaluate(() => {
      return document.querySelector('.botnet-overlay') !== null;
    }).catch(() => false);

    if (isHardBlock) {
      return { passed: false, reason: 'HARD_BLOCK', title };
    }

    await page.waitForTimeout(1000);
  }

  return { passed: false, reason: 'TIMEOUT', title: lastTitle };
}

function isWafBlocked(title, content) {
  return (
    title.includes('Just a moment') ||
    title.includes('Checking your browser') ||
    content.includes('"cf-challenge-running"') ||
    content.includes('cf-turnstile-response')
  );
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function normaliseProperty(raw, type) {
  if (!raw) return null;

  // Handle different possible field names from __NEXT_DATA__
  const id = String(raw.listingId || raw.id || raw.listing_id || '');
  if (!id) return null;

  const price = raw.price || raw.listingPrice?.amount || 0;
  const priceLabel = raw.priceLabel || raw.displayPrice || raw.listingPrice?.displayText || `£${price.toLocaleString()}`;

  const address = raw.address || raw.displayAddress || '';
  const postcode = raw.postcode || extractPostcode(address);

  const lat = raw.latitude || raw.location?.coordinates?.latitude || null;
  const lon = raw.longitude || raw.location?.coordinates?.longitude || null;

  const beds = raw.numBedrooms ?? raw.bedroomsCount ?? null;
  const baths = raw.numBathrooms ?? raw.bathroomsCount ?? null;

  const propType = raw.propertyType || raw.propertySubType || '';

  // Detail URL
  const detailPath = raw.listingUris?.detail || raw.detailUrl || '';
  const url = detailPath
    ? (detailPath.startsWith('http') ? detailPath : `https://www.zoopla.co.uk${detailPath}`)
    : `https://www.zoopla.co.uk/${type === 'rent' ? 'to-rent' : 'for-sale'}/details/${id}/`;

  // Images
  const images = [];
  if (raw.image?.src) images.push(raw.image.src);
  if (raw.images) {
    for (const img of raw.images) {
      const src = img.src || img.url || img;
      if (typeof src === 'string' && src.startsWith('http')) images.push(src);
    }
  }

  // Agent
  const agent = {
    name: raw.branch?.name || raw.agent?.name || raw.agentName || null,
    phone: raw.branch?.phone || raw.agent?.phone || raw.phone || null,
    brandingName: raw.branch?.brandingName || null,
  };

  // Features
  const features = raw.features || raw.keyFeatures || [];

  return {
    id,
    status: type,
    url,
    price: typeof price === 'number' ? price : parseInt(String(price).replace(/[^0-9]/g, ''), 10) || 0,
    priceLabel,
    address,
    postcode,
    latitude: lat,
    longitude: lon,
    bedrooms: beds,
    bathrooms: baths,
    propertyType: propType,
    tenure: raw.tenure || null,
    description: raw.description || raw.summary || null,
    features: Array.isArray(features) ? features.slice(0, 20) : [],
    images: [...new Set(images)],
    agent,
    dateAdded: raw.dateAdded || raw.firstPublishedAt || null,
    dateReduced: raw.dateReduced || null,
    isReduced: raw.isPriceReduced || raw.isReduced || false,
    soldPrice: raw.price || null,
    soldDate: raw.dateSold || null,
  };
}

function extractPostcode(address) {
  const m = address.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function extractFromNextData(nextData, type) {
  if (!nextData) return null;

  try {
    const props = nextData.props?.pageProps;
    if (!props) return null;

    // Search results pages
    const searchResults = props.listingsSearchResults || props.searchResults || props.listings;
    if (searchResults) {
      const listings = searchResults.listings?.regular || searchResults.listings || searchResults || [];
      const featured = searchResults.listings?.featured || [];
      const pagination = searchResults.pagination || {};

      const allListings = [...(Array.isArray(featured) ? featured : []), ...(Array.isArray(listings) ? listings : [])];

      return {
        properties: allListings.map(l => normaliseProperty(l, type)).filter(Boolean),
        pagination: {
          currentPage: pagination.pageNumber || pagination.page || 1,
          pageSize: pagination.pageSize || 25,
          totalResults: pagination.totalResults || pagination.total || allListings.length,
          totalPages: Math.ceil((pagination.totalResults || allListings.length) / (pagination.pageSize || 25)),
        },
      };
    }

    // Listing detail page
    const listing = props.listing || props.property || props.listingDetails;
    if (listing) {
      const prop = normaliseProperty(listing, type);
      if (prop) {
        return {
          properties: [prop],
          pagination: { currentPage: 1, pageSize: 1, totalResults: 1, totalPages: 1 },
        };
      }
    }
  } catch (e) {
    log(`Error parsing __NEXT_DATA__: ${e.message}`);
  }

  return null;
}

async function extractFromDom(page, type) {
  log('Falling back to DOM extraction...');

  const properties = await page.evaluate((listingType) => {
    const results = [];
    const rows = document.querySelectorAll('[id^="listing_"]');

    for (const row of rows) {
      const id = row.id.replace('listing_', '');
      if (!id) continue;

      // Address
      const addressEl = row.querySelector('address, [class*="address"], [class*="Address"]');
      let address = addressEl?.textContent?.trim() || '';
      if (!address) {
        const linkEl = row.querySelector('a[aria-label]');
        address = linkEl?.getAttribute('aria-label') || '';
      }

      // Price
      const priceEl = row.querySelector('[class*="price"], [class*="Price"]');
      const priceRaw = (priceEl?.textContent || '').replace(/See monthly cost.*/g, '').trim();
      const priceNum = parseInt((priceRaw.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''), 10);

      // Beds/Baths
      const txt = row.textContent;
      const bedsM = txt.match(/(\d+)\s*bed/i);
      const bathsM = txt.match(/(\d+)\s*bath/i);

      // URL
      const detailSelector = listingType === 'rent' ? 'a[href*="/to-rent/details/"]' : 'a[href*="/for-sale/details/"]';
      const linkEl = row.querySelector(detailSelector + ', a[href*="/details/"]');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? `https://www.zoopla.co.uk${href}` : '';

      // Images
      const images = [];
      const sources = row.querySelectorAll('source[srcset*="zoocdn"], img[src*="zoocdn"]');
      for (const s of sources) {
        const srcset = s.getAttribute('srcset') || s.getAttribute('src') || '';
        const m = srcset.match(/https:\/\/[^"':,\s]+zoocdn[^"':,\s]+\.(?:jpg|jpeg|png)/i);
        if (m && !images.includes(m[0])) images.push(m[0]);
      }

      results.push({
        id,
        status: listingType,
        url,
        price: priceNum,
        priceLabel: priceRaw,
        address,
        postcode: (address.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i) || [])[1]?.toUpperCase() || null,
        bedrooms: bedsM ? parseInt(bedsM[1], 10) : null,
        bathrooms: bathsM ? parseInt(bathsM[1], 10) : null,
        images,
      });
    }

    // Dedup by ID
    const seen = new Set();
    return results.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, type);

  // Get pagination from DOM
  const totalText = await page.$eval(
    '[class*="result"] [class*="count"], [data-testid*="result"], h1',
    el => el.textContent
  ).catch(() => '');

  const totalMatch = totalText.match(/(\d[\d,]+)/);
  const totalResults = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : properties.length;

  return {
    properties,
    pagination: {
      currentPage: 1,
      pageSize: properties.length,
      totalResults,
      totalPages: Math.ceil(totalResults / 25),
    },
  };
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

async function doSearch(type, location, flags) {
  const timeout = parseInt(flags.timeout || '45000', 10);
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const page_ = parseInt(flags.page || '1', 10);
  const pageSize_ = Math.min(parseInt(flags['page-size'] || '25', 10), 25);

  const url = buildUrl(type, location, flags);
  log(`Searching: ${url}`);

  // Cache check
  const cacheKey = `${type}-${location.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-p${page_}`;
  const cacheFile = resolve(CACHE_DIR, `${cacheKey}.json`);

  let browser, page;
  let ownsProcess = false;

  try {
    const launched = await launchBrowser({ cdpUrl, timeout });
    browser = launched.browser;
    ownsProcess = launched.ownsProcess;

    const context = browser.contexts()[0] || await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-GB',
      viewport: { width: 1280, height: 800 },
    });

    page = await context.newPage();

    // Stealth — remove automation markers
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    });

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-GB,en;q=0.9',
    });

    // Navigate with generous timeout for CF
    log(`Navigating (waitUntil: domcontentloaded)...`);
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    }).catch(e => {
      log(`Navigation error: ${e.message}`);
      return null;
    });

    const httpStatus = resp?.status();
    log(`HTTP status: ${httpStatus}`);

    // Wait for Cloudflare to clear
    const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);

    if (!cfResult.passed) {
      exitError(
        'WAF_BLOCKED',
        'Cloudflare Turnstile challenge not resolved',
        `Reason: ${cfResult.reason}. Title: "${cfResult.title}". ` +
        'Try using --cdp-url to connect to an existing Chrome session with a valid CF cookie. ' +
        'Or wait a few minutes and retry — the challenge may clear automatically.'
      );
    }

    // Wait a bit more for any AJAX/lazy content
    await page.waitForTimeout(3000);

    // Extract __NEXT_DATA__
    log('Extracting __NEXT_DATA__...');
    const nextDataRaw = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    let result = null;

    if (nextDataRaw) {
      try {
        const nextData = JSON.parse(nextDataRaw);
        result = extractFromNextData(nextData, type);
        if (result) log(`Extracted ${result.properties.length} properties from __NEXT_DATA__`);
      } catch (e) {
        log(`__NEXT_DATA__ parse error: ${e.message}`);
      }
    }

    // DOM fallback
    if (!result || result.properties.length === 0) {
      log('No __NEXT_DATA__ results, trying DOM extraction...');
      result = await extractFromDom(page, type);
      log(`Extracted ${result.properties.length} properties from DOM`);
    }

    // Scroll to trigger lazy loading if no results
    if (result.properties.length === 0) {
      log('No results found. Trying scroll to load content...');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(2000);

      const nd2 = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? el.textContent : null;
      });
      if (nd2) {
        try {
          result = extractFromNextData(JSON.parse(nd2), type) || result;
        } catch {}
      }
    }

    // Build output
    const output = {
      source: 'zoopla',
      fetchedAt: new Date().toISOString(),
      query: {
        type,
        location,
        page: page_,
        pageSize: pageSize_,
        url,
        filters: {
          bedsMin: flags['beds-min'] ? parseInt(flags['beds-min'], 10) : null,
          bedsMax: flags['beds-max'] ? parseInt(flags['beds-max'], 10) : null,
          priceMin: flags['price-min'] ? parseInt(flags['price-min'], 10) : null,
          priceMax: flags['price-max'] ? parseInt(flags['price-max'], 10) : null,
          propertyType: flags.type || null,
          sort: flags.sort || 'newest',
          radius: flags.radius ? parseFloat(flags.radius) : null,
        },
      },
      pagination: result.pagination,
      count: result.properties.length,
      properties: result.properties,
    };

    // Save cache
    ensureDir(CACHE_DIR);
    writeFileSync(cacheFile, JSON.stringify(output, null, 2));
    log(`Cached to: ${cacheFile}`);

    return output;

  } finally {
    if (page) await page.close().catch(() => {});
    if (browser && ownsProcess) await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`zoopla-property-search

Search Zoopla for UK property listings (for sale, to rent, sold prices).
Handles Cloudflare WAF automatically via Playwright + real Chrome.

Commands:
  sale <location> [options]     Search for-sale listings
  rent <location> [options]     Search to-rent listings
  sold <location> [options]     Fetch sold house prices

Options:
  --page=N           Page number (default: 1)
  --page-size=N      Results per page (default: 25)
  --beds-min=N       Minimum bedrooms
  --beds-max=N       Maximum bedrooms
  --price-min=N      Minimum price (£)
  --price-max=N      Maximum price (£)
  --type=TYPE        Property type: house|flat|bungalow|land|commercial
  --sort=SORT        Sort: newest|price-asc|price-desc
  --radius=R         Search radius in miles
  --output=FILE      Save JSON to file (default: stdout)
  --cdp-url=URL      Use existing Chrome via CDP (e.g. http://localhost:9222)
  --timeout=MS       Browser timeout (default: 45000)

Examples:
  node property-search.mjs sale London --beds-min=2 --price-max=500000
  node property-search.mjs rent Manchester --page=2
  node property-search.mjs sold SW1A
  node property-search.mjs sale London --output=/tmp/results.json
  node property-search.mjs sale London --cdp-url=http://localhost:9222

⚠️  Zoopla is Cloudflare-protected. This script requires:
  - google-chrome-stable (real browser, not headless)
  - Xvfb (virtual display) OR a real display environment
  - playwright npm package

Exit codes:
  0  Success
  1  General error
  2  WAF block (Cloudflare not bypassed)
`);
}

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const VALID_TYPES = ['sale', 'rent', 'sold'];
if (!VALID_TYPES.includes(command)) {
  console.error(`Unknown command: ${command}. Valid commands: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

const location = positional[0];
if (!location) {
  console.error(`Usage: node property-search.mjs ${command} <location> [options]`);
  console.error('Example: node property-search.mjs sale London');
  process.exit(1);
}

try {
  const result = await doSearch(command, location, flags);

  const outputFile = flags.output;
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    log(`Output saved to: ${outputFile}`);
    console.log(`${result.count} properties saved to ${outputFile}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  // Summary to stderr
  process.stderr.write(`\n[zoopla] Summary: ${result.count} properties found`);
  process.stderr.write(` | Page ${result.pagination.currentPage}/${result.pagination.totalPages}`);
  process.stderr.write(` | Total: ${result.pagination.totalResults}\n`);

  if (result.properties.length > 0) {
    process.stderr.write(`[zoopla] Sample: ${result.properties.slice(0, 3).map(p =>
      `${p.address || 'Unknown'} — ${p.priceLabel || '?'}`
    ).join('; ')}\n`);
  }

} catch (e) {
  if (e.message?.includes('ERR_ABORTED') || e.message?.includes('net::')) {
    exitError('NETWORK_ERROR', 'Network error navigating to Zoopla', e.message);
  }
  exitError('UNKNOWN_ERROR', e.message, e.stack?.split('\n')[1] || '');
}
