#!/usr/bin/env node
/**
 * Etsy Listing Scraper
 *
 * Scrapes Etsy product listings, shop profiles, listing details, and reviews.
 * Uses Camoufox (stealth Firefox) to bypass DataDome bot protection.
 *
 * Usage:
 *   node listing-scraper.mjs search <query> [options]
 *   node listing-scraper.mjs listing <url-or-id> [options]
 *   node listing-scraper.mjs shop <shop-name> [options]
 *   node listing-scraper.mjs reviews <url-or-id> [options]
 *
 * Options:
 *   --pages=N           Number of pages to scrape (default: 1, max: 50)
 *   --min-price=N       Minimum price filter (USD)
 *   --max-price=N       Maximum price filter (USD)
 *   --sort=SORT         Sort order: relevancy | newest | price_asc | price_desc | highest_reviews
 *   --category=SLUG     Category filter (e.g. jewelry, clothing, home-living)
 *   --output=FILE       Write JSON output to file
 *   --headed            Show browser (for debugging)
 *   --timeout=MS        Page load timeout in ms (default: 30000)
 *   --delay=MS          Delay between pages in ms (default: 2000)
 *   --camoufox-path=P   Path to camoufox-js module (auto-detected if not set)
 *
 * Exit codes:
 *   0  Success
 *   1  Usage / config error
 *   2  No results found
 *   4  Bot detection / WAF block (DataDome CAPTCHA)
 *   5  Rate limit / too many requests
 *
 * Requires:
 *   - Node.js v22+
 *   - camoufox-js package (auto-detected from known install paths)
 *
 * Data sources used:
 *   1. DOM scraping — listing cards (id, title, price, image, URL, shop)
 *   2. JSON-LD (application/ld+json) — full product schema on listing pages
 *   3. Search URL parameters for pagination/filtering
 *   4. DOM selectors for reviews, shop stats, listing details
 *
 * Bot detection notes:
 *   - Etsy uses DataDome with fingerprinting
 *   - Plain Playwright (Chromium headless) is blocked
 *   - Camoufox (Firefox-based anti-detect) bypasses detection
 *   - If DataDome block detected, exit code 4 with clear message
 */

import { createRequire } from 'module';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/etsy');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const CAMOUFOX_SEARCH_PATHS = [
  // From environment
  process.env.CAMOUFOX_PATH,
  // From known showrun data directories
  resolve(homedir(), '.local/share/showrun/data/pitchbook/node_modules/camoufox-js'),
  resolve(homedir(), '.local/share/showrun/data/etsy/node_modules/camoufox-js'),
  // Relative from skill dir
  resolve(new URL('.', import.meta.url).pathname, '../../node_modules/camoufox-js'),
  // Global npm
  '/usr/lib/node_modules/camoufox-js',
  '/usr/local/lib/node_modules/camoufox-js',
].filter(Boolean);

const ETSY_BASE = 'https://www.etsy.com';

const SORT_MAP = {
  relevancy: 'most_relevant',
  newest: 'date_desc',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
  highest_reviews: 'highest_reviews',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  if (!process.env.QUIET) console.error('[etsy]', ...args);
}
function warn(...args) { console.error('[etsy:warn]', ...args); }
function bail(msg, code = 1) {
  console.error(`[etsy:error] ${msg}`);
  process.exit(code);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function saveJson(file, data) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(data, null, 2));
  log(`Saved to ${file}`);
}

function cacheKey(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
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

function extractListingId(urlOrId) {
  if (!isNaN(urlOrId)) return urlOrId;
  const m = urlOrId.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function buildSearchUrl(query, opts = {}) {
  const params = new URLSearchParams({ q: query });
  if (opts.page > 1) params.set('page', String(opts.page));
  if (opts.minPrice) params.set('min', String(opts.minPrice));
  if (opts.maxPrice) params.set('max', String(opts.maxPrice));
  if (opts.sort && SORT_MAP[opts.sort]) params.set('order', SORT_MAP[opts.sort]);
  if (opts.category) params.set('facet', opts.category);
  return `${ETSY_BASE}/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Camoufox loader
// ---------------------------------------------------------------------------

function loadCamoufox(customPath) {
  const paths = customPath ? [customPath, ...CAMOUFOX_SEARCH_PATHS] : CAMOUFOX_SEARCH_PATHS;
  for (const p of paths) {
    if (p && existsSync(p)) {
      log(`Loading camoufox from: ${p}`);
      try {
        return require(p);
      } catch (e) {
        warn(`Failed to load camoufox from ${p}: ${e.message}`);
      }
    }
  }
  bail(
    'camoufox-js not found. Install it:\n\n' +
    `  mkdir -p ${DATA_DIR} && cd ${DATA_DIR}\n` +
    '  npm init -y && npm install camoufox-js\n\n' +
    'Or set CAMOUFOX_PATH env var to the camoufox-js directory.\n\n' +
    'If you have the pitchbook skill installed, camoufox is already available:\n' +
    `  export CAMOUFOX_PATH=${CAMOUFOX_SEARCH_PATHS[1]}`
  );
}

// ---------------------------------------------------------------------------
// Browser launcher
// ---------------------------------------------------------------------------

async function launchBrowser(opts = {}) {
  const { Camoufox } = loadCamoufox(opts.camoufoxPath);

  // headless mode:
  //   - opts.headed=true  → full visible browser (non-headless)
  //   - default           → true (headless with camoufox anti-detect fingerprint)
  //
  // IMPORTANT: Do NOT call browser.newContext() — it strips camoufox anti-detect
  // settings. Use browser.newPage() directly to get the default camoufox context.
  const headlessMode = opts.headed ? false : true;

  log(`Launching Camoufox browser (headless=${headlessMode})...`);
  // Pass minimal options — camoufox generates its own anti-detect fingerprint.
  // Do NOT pass locale/viewport here as they may interfere with fingerprint generation.
  const launchConfig = { headless: headlessMode };

  // Optional proxy support (useful for residential IPs to avoid DataDome IP blocks)
  const proxyUrl = opts.proxy || process.env.ETSY_PROXY;
  if (proxyUrl) {
    launchConfig.proxy = proxyUrl;
    log(`Using proxy: ${proxyUrl.replace(/:[^@]*@/, ':***@')}`);
  }

  const browser = await Camoufox(launchConfig);

  // Use default camoufox context page
  // IMPORTANT: Do NOT call browser.newContext() — it creates a vanilla playwright
  // context that strips camoufox anti-detect fingerprint settings.
  // Call browser.newPage() directly to use the built-in anti-detect context.
  const page = await browser.newPage();
  return { browser, page };
}

// ---------------------------------------------------------------------------
// Bot detection
// ---------------------------------------------------------------------------

function detectWafBlock(title, content) {
  if (title === 'etsy.com' && content.includes('captcha-delivery.com')) return 'DataDome CAPTCHA';
  if (title.toLowerCase().includes('captcha')) return 'CAPTCHA page';
  if (content.includes('datadome') && content.includes('blocked')) return 'DataDome block';
  if (title === 'Access Denied') return 'Access Denied';
  if (title === 'Just a moment...') return 'Cloudflare challenge';
  return null;
}

// ---------------------------------------------------------------------------
// DOM scrapers
// ---------------------------------------------------------------------------

/**
 * Extract listing cards from a search results page.
 * Uses data attributes + fallback selectors for robustness.
 */
async function scrapeSearchListings(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll('[data-listing-id]').forEach(el => {
      const listingId = el.dataset.listingId;
      if (!listingId || seen.has(listingId)) return;
      seen.add(listingId);

      const shopId = el.dataset.shopId;
      const linkEl = el.querySelector('a[href*="/listing/"]');
      const imgEl = el.querySelector('img[src*="etsystatic"]');
      const titleEl = el.querySelector('[aria-label]') || el.querySelector('h3') || el.querySelector('.v2-listing-card__info a');
      const priceEl = el.querySelector('.currency-value') || el.querySelector('[data-price]');
      const priceSymbolEl = el.querySelector('.currency-symbol');
      const ratingEl = el.querySelector('[aria-label*="star"], [title*="star"]');
      const reviewCountEl = el.querySelector('[data-reviews-count], .wt-nudge-label--star-seller');

      // Clean URL (remove tracking params)
      const rawUrl = linkEl?.href || '';
      const cleanUrl = rawUrl.split('?')[0];
      const listingSlug = cleanUrl.replace(/.*\/listing\/\d+\//, '').replace(/-/g, ' ');

      // Parse price
      const priceText = el.querySelector('.wt-text-title-01, .lc-price')?.textContent?.trim() || '';
      const priceValue = priceEl?.textContent?.trim();
      const currencySymbol = priceSymbolEl?.textContent?.trim();

      // Check badges
      const isBestseller = !!el.querySelector('[data-wt-badge-bestseller], .wt-badge--bestseller');
      const isStarSeller = !!el.querySelector('[data-wt-star-seller], .star-seller-badge');
      const hasFreeShipping = !!el.querySelector('[data-free-shipping], .wt-badge--free-shipping');

      results.push({
        listingId,
        shopId,
        title: titleEl?.getAttribute('aria-label') || titleEl?.textContent?.trim() || listingSlug,
        priceText: priceText || priceValue || '',
        currency: currencySymbol || null,
        imageUrl: imgEl?.src || '',
        url: cleanUrl || `https://www.etsy.com/listing/${listingId}`,
        badges: {
          bestseller: isBestseller,
          starSeller: isStarSeller,
          freeShipping: hasFreeShipping,
        },
      });
    });

    return results;
  });
}

/**
 * Extract search pagination info.
 */
async function scrapeSearchMeta(page) {
  return page.evaluate(() => {
    const nextEl = document.querySelector('[data-page="next"] a, a[aria-label="Next page"], nav a[rel="next"]');
    const pageEl = document.querySelector('.search-pagination-page.active, [aria-current="page"]');
    const countEl = document.querySelector('[data-count], .wt-text-caption');

    return {
      currentPage: parseInt(pageEl?.textContent?.trim() || '1', 10),
      hasNextPage: !!nextEl,
      nextPageUrl: nextEl?.href,
      url: window.location.href,
      title: document.title,
    };
  });
}

/**
 * Extract full listing detail from a product page.
 * Uses JSON-LD (structured data) as primary source, DOM as fallback.
 */
async function scrapeListingDetail(page) {
  return page.evaluate(() => {
    // ---------- JSON-LD structured data (most reliable) ----------
    const ldJsonEls = document.querySelectorAll('script[type="application/ld+json"]');
    const ldJsonData = [];
    ldJsonEls.forEach(el => {
      try { ldJsonData.push(JSON.parse(el.textContent)); } catch {}
    });

    const product = ldJsonData.find(d => d['@type'] === 'Product');
    const breadcrumb = ldJsonData.find(d => d['@type'] === 'BreadcrumbList');

    // ---------- DOM fallbacks ----------
    const title = product?.name || document.querySelector('h1')?.textContent?.trim();
    const description = product?.description || document.querySelector('#listing-page-description-component, [data-id="description-text"], .wt-content-toggle')?.textContent?.trim();

    // Price from JSON-LD
    let priceData = null;
    if (product?.offers) {
      const o = product.offers;
      priceData = {
        currency: o.priceCurrency,
        lowPrice: o.lowPrice,
        highPrice: o.highPrice,
        availability: o.availability?.replace('https://schema.org/', '') || null,
        shippingFrom: o.shippingDetails?.shippingOrigin?.addressCountry || null,
      };
    }

    // Images from JSON-LD
    const images = (product?.image || []).map(img =>
      typeof img === 'string' ? img : (img.contentURL || img.url || '')
    ).filter(Boolean);

    // Shop/brand info
    const shopName = product?.brand?.name || document.querySelector('.shop-name-and-title-container a, [data-shop-name]')?.textContent?.trim();

    // Rating/reviews from JSON-LD
    const aggregateRating = product?.aggregateRating;
    const ratingValue = aggregateRating?.ratingValue || null;
    const reviewCount = aggregateRating?.reviewCount || null;

    // Breadcrumb categories
    const categories = breadcrumb?.itemListElement?.map(i => ({
      name: i.name,
      url: i.item,
      position: i.position,
    })) || [];

    // DOM-based review extraction
    const reviewEls = document.querySelectorAll('[data-review-region] .wt-body-text, .review-text, [class*="review"] p');
    const reviews = Array.from(reviewEls).slice(0, 10).map(el => {
      const text = el.textContent?.trim();
      const parent = el.closest('[data-review-region], [class*="review-item"]');
      const ratingEl = parent?.querySelector('[aria-label*="star"], [title*="star"], [class*="rating"]');
      const dateEl = parent?.querySelector('time, [class*="date"]');
      const authorEl = parent?.querySelector('[class*="author"], [class*="buyer"]');
      return {
        text,
        rating: ratingEl?.getAttribute('aria-label')?.match(/(\d)/)?.[1] || null,
        date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || null,
        author: authorEl?.textContent?.trim() || null,
      };
    }).filter(r => r.text && r.text.length > 3);

    // Tags
    const tags = Array.from(document.querySelectorAll('[class*="tag-item"], .wt-tag, a[href*="search?q="]'))
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length < 50)
      .slice(0, 20);

    // Listing ID from URL
    const listingId = window.location.href.match(/\/listing\/(\d+)/)?.[1];

    return {
      listingId,
      url: window.location.href.split('?')[0],
      title,
      description: description?.substring(0, 2000),
      price: priceData,
      shopName,
      rating: ratingValue ? parseFloat(ratingValue) : null,
      reviewCount: reviewCount ? parseInt(reviewCount, 10) : null,
      images,
      categories,
      reviews,
      tags,
    };
  });
}

/**
 * Extract shop profile data.
 */
async function scrapeShop(page, shopName) {
  return page.evaluate((shopName) => {
    // Shop header info
    const name = document.querySelector('h1.wt-text-heading-01, .shop-name-and-title-container h1')?.textContent?.trim()
      || shopName;

    const announceEl = document.querySelector('.shop-home-description, [data-about-section]');
    const announcement = announceEl?.textContent?.trim()?.substring(0, 500);

    // Sales count
    const salesEl = Array.from(document.querySelectorAll('[class*="sales"], [class*="Sales"]'))
      .find(el => el.textContent?.match(/\d.*sale/i));
    const salesText = salesEl?.textContent?.trim();

    // Admirers/favorites
    const favEl = Array.from(document.querySelectorAll('[class*="admirers"], [class*="Admirers"], [class*="favorite"]'))
      .find(el => el.textContent?.match(/\d/));
    const admirersText = favEl?.textContent?.trim();

    // Star seller badge
    const isStarSeller = !!document.querySelector('[data-star-seller-badge], .star-seller-icon, [class*="star-seller"]');

    // Shop ratings
    const ratingEl = document.querySelector('[class*="shop-rating"], [aria-label*="star"]');
    const rating = ratingEl?.getAttribute('aria-label')?.match(/(\d+\.?\d*)/)?.[1]
      || ratingEl?.textContent?.match(/(\d+\.?\d*)/)?.[1];

    const reviewCountEl = document.querySelector('[class*="review-count"], a[href*="#reviews"]');
    const reviewCount = reviewCountEl?.textContent?.match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, '');

    // Owner info
    const ownerEl = document.querySelector('[class*="owner"], .shop-owner-name');
    const owner = ownerEl?.textContent?.trim();
    const locationEl = document.querySelector('[class*="location"], [class*="Location"]');
    const location = locationEl?.textContent?.trim();

    // Listings in DOM
    const listings = [];
    const seen = new Set();
    document.querySelectorAll('[data-listing-id]').forEach(el => {
      const id = el.dataset.listingId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const linkEl = el.querySelector('a[href*="/listing/"]');
      const imgEl = el.querySelector('img[src*="etsystatic"]');
      const titleEl = el.querySelector('[aria-label]') || el.querySelector('h3, h2');
      const priceEl = el.querySelector('.wt-text-title-01, .currency-value, [data-price]');
      listings.push({
        listingId: id,
        title: titleEl?.getAttribute('aria-label') || titleEl?.textContent?.trim() || '',
        priceText: priceEl?.textContent?.trim() || '',
        url: linkEl?.href?.split('?')[0] || `https://www.etsy.com/listing/${id}`,
        imageUrl: imgEl?.src || '',
      });
    });

    // Section names
    const sections = Array.from(document.querySelectorAll('[class*="section"] a, nav [class*="tab"]'))
      .map(el => ({ name: el.textContent?.trim(), url: el.href }))
      .filter(s => s.name && s.name.length < 100 && s.name.length > 1);

    return {
      name,
      url: window.location.href.split('?')[0],
      announcement,
      salesText,
      admirersText,
      isStarSeller,
      rating: rating ? parseFloat(rating) : null,
      reviewCount: reviewCount ? parseInt(reviewCount, 10) : null,
      owner,
      location,
      listings: listings.slice(0, 48),
      listingCount: listings.length,
      sections: sections.slice(0, 20),
    };
  }, shopName);
}

/**
 * Extract reviews from a listing page.
 * Etsy loads reviews inline — pagination via /reviews section.
 */
async function scrapeReviews(page) {
  return page.evaluate(() => {
    const reviews = [];
    const reviewContainers = document.querySelectorAll(
      '[data-review-region], [class*="ReviewItem"], [class*="review-item"], .wt-review'
    );

    reviewContainers.forEach(container => {
      const textEl = container.querySelector('.wt-body-text, [class*="review-text"], p');
      const text = textEl?.textContent?.trim();
      if (!text || text.length < 3) return;

      const ratingEl = container.querySelector('[aria-label*="star"], [title*="out of 5"], [class*="rating"]');
      const ratingText = ratingEl?.getAttribute('aria-label') || ratingEl?.getAttribute('title') || '';
      const rating = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/)?.[1]
        || ratingText.match(/^(\d+)\s*star/i)?.[1]
        || null;

      const dateEl = container.querySelector('time, [class*="date"], [class*="time"]');
      const date = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim();

      const authorEl = container.querySelector('[class*="username"], [class*="author"], [class*="buyer"], [class*="Username"]');
      const author = authorEl?.textContent?.trim();

      const imgEls = container.querySelectorAll('img[src*="etsystatic"]');
      const images = Array.from(imgEls).map(img => img.src);

      reviews.push({ text, rating: rating ? parseInt(rating, 10) : null, date, author, images });
    });

    return reviews;
  });
}

// ---------------------------------------------------------------------------
// Main commands
// ---------------------------------------------------------------------------

async function cmdSearch(query, flags) {
  const pages = parseInt(flags.pages || '1', 10);
  const minPrice = flags['min-price'] ? parseFloat(flags['min-price']) : undefined;
  const maxPrice = flags['max-price'] ? parseFloat(flags['max-price']) : undefined;
  const sort = flags.sort;
  const delay = parseInt(flags.delay || '2000', 10);
  const timeout = parseInt(flags.timeout || '30000', 10);
  const headed = !!flags.headed;
  const camoufoxPath = flags['camoufox-path'];
  const proxy = flags.proxy;

  log(`Searching Etsy for: "${query}" (${pages} page${pages > 1 ? 's' : ''})`);

  const { browser, page } = await launchBrowser({ headed, camoufoxPath, proxy });
  page.setDefaultTimeout(timeout);

  const allListings = [];

  try {
    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const url = buildSearchUrl(query, { page: pageNum, minPrice, maxPrice, sort });
      log(`Page ${pageNum}/${pages}: ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(2000);

      const title = await page.title();
      const content = await page.content();

      const block = detectWafBlock(title, content);
      if (block) {
        console.error(`[etsy] ⛔ WAF/Bot block detected: ${block}`);
        console.error(`[etsy] Camoufox is required to bypass DataDome.`);
        console.error(`[etsy] If this persists, try --headed flag to debug.`);
        process.exit(4);
      }

      const listings = await scrapeSearchListings(page);
      log(`  Found ${listings.length} listings on page ${pageNum}`);
      allListings.push(...listings);

      if (pageNum < pages) {
        const meta = await scrapeSearchMeta(page);
        if (!meta.hasNextPage) {
          log(`  No more pages after page ${pageNum}`);
          break;
        }
        await sleep(delay + Math.random() * 1000);
      }
    }
  } finally {
    await browser.close();
  }

  if (allListings.length === 0) {
    log('No listings found');
    process.exit(2);
  }

  const result = {
    query,
    pages,
    totalScraped: allListings.length,
    filters: { minPrice, maxPrice, sort },
    listings: allListings,
    scrapedAt: new Date().toISOString(),
  };

  if (flags.output) {
    saveJson(flags.output, result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  const key = cacheKey(`search-${query}`);
  saveJson(resolve(CACHE_DIR, `${key}.json`), result);
  return result;
}

async function cmdListing(urlOrId, flags) {
  const listingId = extractListingId(urlOrId);
  if (!listingId) bail(`Invalid listing URL or ID: ${urlOrId}`);

  const timeout = parseInt(flags.timeout || '30000', 10);
  const headed = !!flags.headed;
  const camoufoxPath = flags['camoufox-path'];

  log(`Fetching listing: ${listingId}`);

  const proxy = flags.proxy;
  const { browser, page } = await launchBrowser({ headed, camoufoxPath, proxy });
  page.setDefaultTimeout(timeout);

  let result;
  try {
    const url = urlOrId.startsWith('http') ? urlOrId : `${ETSY_BASE}/listing/${listingId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    const title = await page.title();
    const content = await page.content();
    const block = detectWafBlock(title, content);
    if (block) {
      console.error(`[etsy] ⛔ WAF block: ${block}`);
      process.exit(4);
    }

    result = await scrapeListingDetail(page);
    result.scrapedAt = new Date().toISOString();
  } finally {
    await browser.close();
  }

  if (flags.output) {
    saveJson(flags.output, result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  saveJson(resolve(CACHE_DIR, `listing-${listingId}.json`), result);
  return result;
}

async function cmdShop(shopName, flags) {
  const pages = parseInt(flags.pages || '1', 10);
  const timeout = parseInt(flags.timeout || '30000', 10);
  const delay = parseInt(flags.delay || '2000', 10);
  const headed = !!flags.headed;
  const camoufoxPath = flags['camoufox-path'];

  log(`Fetching shop: ${shopName}`);

  const proxy = flags.proxy;
  const { browser, page } = await launchBrowser({ headed, camoufoxPath, proxy });
  page.setDefaultTimeout(timeout);

  let result;
  try {
    const url = `${ETSY_BASE}/shop/${encodeURIComponent(shopName)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    const title = await page.title();
    const content = await page.content();
    const block = detectWafBlock(title, content);
    if (block) {
      console.error(`[etsy] ⛔ WAF block: ${block}`);
      process.exit(4);
    }

    result = await scrapeShop(page, shopName);
    result.scrapedAt = new Date().toISOString();

    // Paginate shop listings if requested
    if (pages > 1 && result.listings.length > 0) {
      for (let p = 2; p <= pages; p++) {
        const pageUrl = `${ETSY_BASE}/shop/${encodeURIComponent(shopName)}?page=${p}`;
        log(`Shop page ${p}/${pages}: ${pageUrl}`);
        await sleep(delay);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(2000);

        const newListings = await page.evaluate(() => {
          const items = [];
          const seen = new Set(window._seenIds || []);
          document.querySelectorAll('[data-listing-id]').forEach(el => {
            const id = el.dataset.listingId;
            if (!id || seen.has(id)) return;
            seen.add(id);
            const linkEl = el.querySelector('a[href*="/listing/"]');
            const imgEl = el.querySelector('img[src*="etsystatic"]');
            const titleEl = el.querySelector('[aria-label]') || el.querySelector('h3,h2');
            const priceEl = el.querySelector('.wt-text-title-01,.currency-value,[data-price]');
            items.push({
              listingId: id,
              title: titleEl?.getAttribute('aria-label') || titleEl?.textContent?.trim() || '',
              priceText: priceEl?.textContent?.trim() || '',
              url: linkEl?.href?.split('?')[0] || `https://www.etsy.com/listing/${id}`,
              imageUrl: imgEl?.src || '',
            });
          });
          return items;
        });

        if (newListings.length === 0) { log(`No more shop listings at page ${p}`); break; }
        result.listings.push(...newListings);
        result.listingCount = result.listings.length;
      }
    }
  } finally {
    await browser.close();
  }

  if (flags.output) {
    saveJson(flags.output, result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  saveJson(resolve(CACHE_DIR, `shop-${cacheKey(shopName)}.json`), result);
  return result;
}

async function cmdReviews(urlOrId, flags) {
  const listingId = extractListingId(urlOrId);
  if (!listingId) bail(`Invalid listing URL or ID: ${urlOrId}`);

  const timeout = parseInt(flags.timeout || '30000', 10);
  const headed = !!flags.headed;
  const camoufoxPath = flags['camoufox-path'];

  log(`Fetching reviews for listing: ${listingId}`);

  const proxy = flags.proxy;
  const { browser, page } = await launchBrowser({ headed, camoufoxPath, proxy });
  page.setDefaultTimeout(timeout);

  let result;
  try {
    const url = urlOrId.startsWith('http') ? urlOrId : `${ETSY_BASE}/listing/${listingId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    const title = await page.title();
    const content = await page.content();
    const block = detectWafBlock(title, content);
    if (block) {
      console.error(`[etsy] ⛔ WAF block: ${block}`);
      process.exit(4);
    }

    // Scroll to reviews section to trigger lazy loading
    await page.evaluate(() => {
      const reviewSection = document.querySelector('[id*="review"], [data-review], .wt-review, section[class*="review"]');
      if (reviewSection) reviewSection.scrollIntoView({ behavior: 'smooth' });
      else window.scrollTo(0, document.body.scrollHeight * 0.7);
    });
    await page.waitForTimeout(2000);

    const reviews = await scrapeReviews(page);

    // Get listing meta
    const listingMeta = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent?.trim(),
      url: window.location.href.split('?')[0],
    }));

    result = {
      listingId,
      title: listingMeta.title,
      url: listingMeta.url,
      reviewCount: reviews.length,
      reviews,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }

  if (flags.output) {
    saveJson(flags.output, result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  saveJson(resolve(CACHE_DIR, `reviews-${listingId}.json`), result);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
etsy-listing-scraper — Etsy product listings, shops, and reviews

Commands:
  search <query>           Search listings by keyword
  listing <url-or-id>      Scrape a single listing page
  shop <shop-name>         Scrape a shop profile + listings
  reviews <url-or-id>      Scrape reviews from a listing page

Options:
  --pages=N           Pages to scrape (default: 1)
  --min-price=N       Minimum price filter
  --max-price=N       Maximum price filter
  --sort=SORT         Sort: relevancy | newest | price_asc | price_desc | highest_reviews
  --output=FILE       Save JSON output to file
  --headed            Show browser window (debug)
  --timeout=MS        Page load timeout (default: 30000)
  --delay=MS          Delay between pages (default: 2000)
  --camoufox-path=P   Path to camoufox-js module
  --proxy=URL         Proxy URL for residential IP (e.g. socks5://user:pass@host:port)

Examples:
  node listing-scraper.mjs search "handmade ring" --pages=3
  node listing-scraper.mjs search "vintage lamp" --min-price=50 --max-price=500 --sort=price_asc
  node listing-scraper.mjs listing 1234567890
  node listing-scraper.mjs listing https://www.etsy.com/listing/1234567890/product-name
  node listing-scraper.mjs shop CaitlynMinimalist --pages=2
  node listing-scraper.mjs reviews 1234567890

Setup (camoufox):
  mkdir -p ~/.local/share/showrun/data/etsy
  cd ~/.local/share/showrun/data/etsy
  npm init -y && npm install camoufox-js

Exit codes:
  0  Success
  1  Usage / config error
  2  No results found
  4  DataDome CAPTCHA / WAF block
  5  Rate limit
`;

const [, , command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

switch (command) {
  case 'search': {
    const query = positional.join(' ');
    if (!query) bail('Usage: node listing-scraper.mjs search <query>');
    await cmdSearch(query, flags);
    break;
  }
  case 'listing': {
    const urlOrId = positional[0];
    if (!urlOrId) bail('Usage: node listing-scraper.mjs listing <url-or-id>');
    await cmdListing(urlOrId, flags);
    break;
  }
  case 'shop': {
    const shopName = positional[0];
    if (!shopName) bail('Usage: node listing-scraper.mjs shop <shop-name>');
    await cmdShop(shopName, flags);
    break;
  }
  case 'reviews': {
    const urlOrId = positional[0];
    if (!urlOrId) bail('Usage: node listing-scraper.mjs reviews <url-or-id>');
    await cmdReviews(urlOrId, flags);
    break;
  }
  default:
    console.log(HELP);
    if (command && command !== '--help' && command !== 'help') process.exit(1);
}
