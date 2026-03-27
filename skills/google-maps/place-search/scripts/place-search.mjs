#!/usr/bin/env node
/**
 * Google Maps Place Search
 *
 * Searches Google Maps for businesses/places and optionally fetches detailed
 * information (address, phone, rating, reviews, hours, website) for each result.
 *
 * Strategy: Playwright browser automation (headless Chrome).
 * - No auth or API key required.
 * - Handles Google GDPR consent page automatically.
 * - Forces English locale via hl=en&gl=us URL parameters.
 * - Extracts data from rendered DOM (place cards + detail panels).
 * - Pagination via scrolling the results feed.
 *
 * Usage:
 *   node place-search.mjs search <query> [options]
 *   node place-search.mjs details <place-url> [options]
 *
 * See help output for full options.
 */

import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/google-maps');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const CHROME_EXECUTABLE =
  process.env.CHROME_EXECUTABLE ||
  (() => {
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
  })();

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function saveJson(file, data) { ensureDir(dirname(file)); writeFileSync(file, JSON.stringify(data, null, 2)); }
function cacheKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80); }
function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function log(...args) { if (!process.env.QUIET) console.error('[gmaps]', ...args); }
function warn(...args) { console.error('[gmaps:warn]', ...args); }
function bail(msg, code = 1) { console.error(`[gmaps:error] ${msg}`); process.exit(code); }

// ---------------------------------------------------------------------------
// Playwright launcher
// ---------------------------------------------------------------------------
async function launchBrowser(opts = {}) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    bail(
      'playwright not installed. Run: npm install playwright\n' +
      '  in the skill directory, or globally: npm install -g playwright'
    );
  }

  if (!CHROME_EXECUTABLE) {
    bail(
      'Chrome/Chromium not found. Install google-chrome-stable or set CHROME_EXECUTABLE env var.\n' +
      '  Linux: sudo apt install google-chrome-stable  OR  sudo pacman -S google-chrome'
    );
  }

  log(`Using Chrome: ${CHROME_EXECUTABLE}`);

  const cdpUrl = opts.cdpUrl || process.env.CHROME_CDP_URL;
  let browser;

  if (cdpUrl) {
    log(`Connecting to existing Chrome via CDP: ${cdpUrl}`);
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (e) {
      bail(`CDP connection failed: ${e.message}\nMake sure Chrome is running with --remote-debugging-port=9222`);
    }
  } else {
    browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE,
      headless: opts.headed ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
      ],
    });
  }

  return browser;
}

async function newPage(browser) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();
  return page;
}

// ---------------------------------------------------------------------------
// GDPR Consent bypass
// ---------------------------------------------------------------------------
async function handleConsent(page) {
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes('consent.google.com')) return false;

    log('Google consent page detected — attempting bypass...');
    const selectors = [
      'form[action*="consent"] button[value="1"]',
      'form[action*="consent"] button:first-of-type',
      'button[aria-label*="Accept all"]',
      'button:has-text("Accept all")',
      'button:has-text("I agree")',
      'button:has-text("Accept")',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          await page.waitForTimeout(2000);
          log('Consent accepted');
          return true;
        }
      } catch { /* try next */ }
    }
    warn('Could not auto-accept consent. Results may be limited.');
  } catch { /* silent */ }
  return false;
}

async function navigate(page, url, opts = {}) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 25000 });
      await page.waitForTimeout(1500);

      // Check for consent redirect
      if (page.url().includes('consent.google.com')) {
        await handleConsent(page);
        await page.waitForTimeout(500);
        if (page.url().includes('consent.google.com')) {
          // Try navigating again
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);
        }
      }

      return true;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      log(`Navigation attempt ${attempt + 1} failed, retrying: ${e.message}`);
      await page.waitForTimeout(2000);
    }
  }
}

// ---------------------------------------------------------------------------
// WAF / Bot detection check
// ---------------------------------------------------------------------------
function checkWAF(html) {
  const wafMarkers = [
    'captcha', 'recaptcha', 'g-recaptcha', 'bot detection',
    'unusual traffic', 'automated queries', '429 Too Many',
    'Access Denied', 'blocked', 'cf-browser-verification',
    'challenge-platform',
  ];
  const lower = html.toLowerCase();
  return wafMarkers.some(m => lower.includes(m.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Search results extraction
// ---------------------------------------------------------------------------
async function extractSearchResults(page) {
  // Wait for results to appear
  const feedSel = '[role="feed"]';
  try {
    await page.waitForSelector(feedSel, { timeout: 10000 });
  } catch {
    log('No results feed found — trying fallback selectors');
  }

  // Check for WAF/bot detection
  const bodyHtml = await page.content();
  if (checkWAF(bodyHtml)) {
    return { error: 'WAF_BLOCKED', message: 'Google Maps detected automation. Try with --headed or --cdp-url.' };
  }

  const results = await page.evaluate(() => {
    const items = [];
    // Google Maps places appear as article elements inside the feed
    const cards = document.querySelectorAll('[role="feed"] [jsaction][jscontroller], [role="feed"] .Nv2PK');
    
    for (const card of Array.from(cards).slice(0, 50)) {
      // Skip non-place elements (ads, headers, etc.)
      if (!card.querySelector('a[href*="/maps/place/"]')) continue;

      const result = {};

      // Name — usually in the heading or aria-label
      const nameEl = card.querySelector('.qBF1Pd, .fontHeadlineSmall, [aria-label]');
      result.name = nameEl?.textContent?.trim() ||
                    card.getAttribute('aria-label')?.split('\n')[0]?.trim();

      // Rating
      const ratingEl = card.querySelector('.MW4etd');
      if (ratingEl) result.rating = parseFloat(ratingEl.textContent) || null;

      // Review count
      const reviewEl = card.querySelector('.UY7F9');
      if (reviewEl) {
        const m = reviewEl.textContent.match(/\(?([\d,]+)\)?/);
        result.reviewCount = m ? parseInt(m[1].replace(/,/g, '')) : null;
      }

      // Extract specific data using targeted selectors.
      // Google Maps card structure:
      //   .fontBodyMedium .W4Efsd — info container
      //     First child: type · price · (optional description)
      //     Second child: address · open status

      // Type — the category label (e.g., "Coffee shop", "Pizza")
      // Usually in the first span of the first .W4Efsd row, before any · separator
      const typeEl = card.querySelector('.W4Efsd .W4Efsd span:not(.UsdlK):first-child, .W4Efsd > span:first-child');
      const rawType = typeEl?.textContent?.trim();
      result.type = (rawType && !rawType.match(/^\d/) && !rawType.match(/^\$/) && rawType.length < 50)
        ? rawType : null;

      // Price level — the $/$$ rating
      const allSpans = Array.from(card.querySelectorAll('span[aria-label], .W4Efsd span'));
      const priceSpan = allSpans.find(s => s.textContent?.match(/^\$+$/));
      result.priceLevel = priceSpan?.textContent?.trim() || null;

      // Address — use aria-label on the address button, or span with street-like content
      const addrSpan = allSpans.find(s => {
        const t = s.textContent?.trim();
        return t && (
          t.match(/^\d+\s+\w/) || // "123 Main St..."
          t.match(/\b(St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct|Road|Street|Avenue|Boulevard)\b/i)
        ) && !t.match(/^Open|^Closed/) && t.length < 100;
      });
      result.address = addrSpan?.textContent?.trim()?.replace(/^[·•\s]+/, '').trim() || null;

      // Place URL
      const linkEl = card.querySelector('a[href*="/maps/place/"]');
      if (linkEl) {
        const href = linkEl.getAttribute('href');
        result.url = href.startsWith('http') ? href : `https://www.google.com${href}`;
        // Extract CID from URL if present
        const cidMatch = result.url.match(/0x[\da-f]+:0x[\da-f]+/i);
        result.cid = cidMatch?.[0] || null;
      }

      // Thumbnail image
      const imgEl = card.querySelector('img[src*="googleusercontent"], img[src*="lh3."], img[src*="lh4."], img[src*="lh5."], img[src*="lh6."]');
      result.thumbnail = imgEl?.getAttribute('src') || null;

      // Business status (open/closed)
      // Look for span with "Open" or "Closed" text
      const statusSpan = Array.from(card.querySelectorAll('span')).find(s => {
        const t = s.textContent?.trim();
        return t && t.match(/^(Open|Closed|Opens|Temporarily)/i) && t.length < 60;
      });
      result.openStatus = statusSpan?.textContent?.trim() || null;

      if (result.name) items.push(result);
    }
    return items;
  });

  return results;
}

// ---------------------------------------------------------------------------
// Scroll to load more results
// ---------------------------------------------------------------------------
async function scrollFeed(page, targetCount = 20) {
  const feedSel = '[role="feed"]';
  let lastCount = 0;
  let stallCount = 0;

  for (let i = 0; i < 10; i++) {
    const currentCount = await page.$$eval('[role="feed"] a[href*="/maps/place/"]', els => els.length);
    log(`Feed has ${currentCount} place links (iteration ${i + 1})`);

    if (currentCount >= targetCount) break;
    if (currentCount === lastCount) {
      stallCount++;
      if (stallCount >= 3) { log('Feed not growing — end of results reached'); break; }
    } else {
      stallCount = 0;
    }
    lastCount = currentCount;

    try {
      // Scroll the feed container
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTo(0, el.scrollHeight);
        else window.scrollTo(0, document.body.scrollHeight);
      }, feedSel);
    } catch { /* ignore */ }

    await page.waitForTimeout(1500);
  }
}

// ---------------------------------------------------------------------------
// Place detail extraction
// ---------------------------------------------------------------------------
async function extractPlaceDetails(page) {
  await page.waitForTimeout(3000);

  const bodyHtml = await page.content();
  if (checkWAF(bodyHtml)) {
    return { error: 'WAF_BLOCKED', message: 'Google Maps WAF block detected' };
  }

  return await page.evaluate(() => {
    const detail = {};

    // Name from h1 or page title
    const h1 = document.querySelector('h1');
    detail.name = h1?.textContent?.trim() || document.title.split(' - ')[0];

    // Rating — look in the text content of rating displays, not just aria-label
    const ratingEl = document.querySelector('[aria-label*="stars"], [aria-label*="star"], .ceNzKf');
    if (ratingEl) {
      const labelText = ratingEl.getAttribute('aria-label') || ratingEl.textContent;
      const m = labelText?.match(/[\d.]+/);
      detail.rating = m ? parseFloat(m[0]) : null;
    }

    // Also try numeric rating from visible span (must be in 0-5 range)
    if (!detail.rating) {
      const ratingNum = document.querySelector('.Aq14fc');
      const numText = ratingNum?.textContent?.trim();
      const numVal = parseFloat(numText);
      if (numText && !isNaN(numVal) && numVal >= 0 && numVal <= 5) {
        detail.rating = numVal;
      }
    }

    // Review count
    const reviewEl = document.querySelector('[aria-label*="reviews"], [aria-label*="review"]');
    if (reviewEl) {
      const m = reviewEl.getAttribute('aria-label')?.match(/[\d,]+/);
      detail.reviewCount = m ? parseInt(m[0].replace(/,/g, '')) : null;
    }
    // Also try the visible review count in the page
    if (!detail.reviewCount) {
      const reviewCount = document.querySelector('[class*="fontBodySmall"] button span, .UY7F9');
      const countText = reviewCount?.textContent?.trim();
      if (countText) {
        const m = countText.match(/[\d,]+/);
        detail.reviewCount = m ? parseInt(m[0].replace(/,/g, '')) : null;
      }
    }

    // Helper to strip Google Material icon Unicode chars (Private Use Area: E000-F8FF)
    function stripIcons(s) {
      return s ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : null;
    }

    // Address
    const addrEl = document.querySelector('button[data-item-id*="address"], [data-item-id="address"]');
    detail.address = stripIcons(addrEl?.textContent?.trim()) || null;

    // If not found via data-item-id, try aria-label pattern
    if (!detail.address) {
      const addrBtn = Array.from(document.querySelectorAll('button[aria-label]'))
        .find(btn => btn.getAttribute('aria-label')?.toLowerCase().includes('address'));
      detail.address = addrBtn?.getAttribute('aria-label')?.replace(/^Address: ?/i, '').trim() || null;
    }

    // Phone
    const phoneEl = document.querySelector('button[data-item-id*="phone"], [data-item-id="phone:tel"]');
    detail.phone = stripIcons(phoneEl?.textContent?.trim()) || null;

    if (!detail.phone) {
      const phoneBtn = Array.from(document.querySelectorAll('button[aria-label]'))
        .find(btn => btn.getAttribute('aria-label')?.match(/^\+?[\d\s().-]{7,}$/));
      detail.phone = phoneBtn?.textContent?.trim() || null;
    }

    // Website
    const websiteEl = document.querySelector('a[data-item-id*="authority"], a[href*="website"], button[data-item-id*="website"]');
    detail.website = websiteEl?.getAttribute('href') || websiteEl?.textContent?.trim() || null;

    // Category / type
    const typeEl = document.querySelector('[jsaction*="category"] button, .DkEaL');
    detail.type = typeEl?.textContent?.trim() || null;

    // Opening hours
    const hoursEl = document.querySelector('[data-item-id*="oh"], [aria-label*="hours"], .t39EBf');
    const rawStatus = hoursEl?.textContent?.trim()?.split('\n')?.[0];
    detail.openStatus = rawStatus ? stripIcons(rawStatus) : null;

    // All hours (if panel open)
    const hoursRows = document.querySelectorAll('table.WgFkxc tr, [jsaction*="pane.openhours"] tr');
    if (hoursRows.length > 0) {
      detail.hours = {};
      for (const row of hoursRows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const day = cells[0]?.textContent?.trim();
          const time = cells[1]?.textContent?.trim();
          if (day && time) detail.hours[day] = time;
        }
      }
    }

    // Price level
    const priceEl = document.querySelector('[aria-label*="price level"], [aria-label*="Price level"]');
    detail.priceLevel = priceEl?.getAttribute('aria-label')?.replace(/Price level: ?/i, '') || null;

    // Coordinates from URL
    const urlMatch = window.location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (urlMatch) {
      detail.latitude = parseFloat(urlMatch[1]);
      detail.longitude = parseFloat(urlMatch[2]);
    }

    // Google Maps URL (canonical)
    detail.url = window.location.href;

    // Place ID / CID from URL
    const cidMatch = detail.url.match(/0x[\da-f]+:0x[\da-f]+/i);
    detail.cid = cidMatch?.[0] || null;

    // Photos count
    const photoEl = document.querySelector('[aria-label*="photo"], [aria-label*="Photo"]');
    const photoMatch = photoEl?.getAttribute('aria-label')?.match(/[\d,]+/);
    detail.photoCount = photoMatch ? parseInt(photoMatch[0].replace(/,/g, '')) : null;

    return detail;
  });
}

// ---------------------------------------------------------------------------
// Reviews extraction (via listugcposts endpoint or DOM)
// ---------------------------------------------------------------------------
async function extractReviews(page) {
  // Click reviews tab if available
  try {
    const reviewTabSel = 'button[aria-label*="Reviews"], button[data-tab-index="1"]';
    const tab = page.locator(reviewTabSel).first();
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click();
      await page.waitForTimeout(2000);
    }
  } catch { /* no reviews tab */ }

  return await page.evaluate(() => {
    const reviews = [];
    const cards = document.querySelectorAll('.jftiEf, [data-review-id], .MyEned');

    for (const card of Array.from(cards).slice(0, 20)) {
      const review = {};

      // Reviewer name
      review.author = card.querySelector('.d4r55')?.textContent?.trim() ||
                      card.querySelector('[class*="author"]')?.textContent?.trim();

      // Rating (count of filled stars)
      const starsEl = card.querySelector('[aria-label*="stars"], [aria-label*="star"]');
      const starMatch = starsEl?.getAttribute('aria-label')?.match(/\d+/);
      review.rating = starMatch ? parseInt(starMatch[0]) : null;

      // Date
      review.date = card.querySelector('.rsqaWe')?.textContent?.trim() ||
                    card.querySelector('[class*="date"]')?.textContent?.trim();

      // Text
      const textEl = card.querySelector('.MyEned span, .wiI7pd, [jsaction*="expandText"]');
      review.text = textEl?.textContent?.trim();

      // Response from owner
      const responseEl = card.querySelector('.CDe7pd');
      review.ownerResponse = responseEl?.textContent?.trim() || null;

      if (review.author || review.text) reviews.push(review);
    }
    return reviews;
  });
}

// ---------------------------------------------------------------------------
// Main: Search
// ---------------------------------------------------------------------------
async function doSearch(query, opts) {
  ensureDir(CACHE_DIR);

  const limit = parseInt(opts.limit || '20', 10);
  const page = parseInt(opts.page || '1', 10);
  const output = opts.output || null;
  const fetchDetails = opts.details === true || opts.details === 'true';
  const headed = opts.headed === true;
  const cdpUrl = opts.cdpUrl;
  const timeout = parseInt(opts.timeout || '30000', 10);

  log(`Searching Google Maps for: "${query}" (limit=${limit}, page=${page}, details=${fetchDetails})`);

  const browser = await launchBrowser({ headed, cdpUrl });
  const p = await newPage(browser);

  try {
    // Build search URL with English locale
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://www.google.com/maps/search/${encodedQuery}/?hl=en&gl=us`;

    log(`URL: ${searchUrl}`);
    await navigate(p, searchUrl, { timeout });

    // Scroll to load enough results
    await scrollFeed(p, limit);

    // Extract
    const rawResults = await extractSearchResults(p);
    if (rawResults.error) {
      console.error(`\n[gmaps:error] ${rawResults.error}: ${rawResults.message}`);
      process.exit(2);
    }

    log(`Extracted ${rawResults.length} raw results`);
    const results = rawResults.slice(0, limit);

    // Optionally fetch details for each
    if (fetchDetails && results.length > 0) {
      log(`Fetching details for ${results.length} places...`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.url) continue;
        log(`  [${i + 1}/${results.length}] ${r.name}`);
        try {
          await navigate(p, r.url + '&hl=en&gl=us', { timeout });
          const detail = await extractPlaceDetails(p);
          // Merge: don't overwrite search-card fields with nulls/empty values from detail page
          for (const [k, v] of Object.entries(detail)) {
            if (v !== null && v !== undefined && v !== '') r[k] = v;
          }
          await p.waitForTimeout(1000); // Rate limit
        } catch (e) {
          warn(`Failed to get details for "${r.name}": ${e.message}`);
        }
      }
    }

    const out = {
      source: 'google-maps',
      fetchedAt: new Date().toISOString(),
      query,
      pagination: { page, limit, returned: results.length },
      results,
    };

    const cacheFile = resolve(CACHE_DIR, `search-${cacheKey(query)}.json`);
    saveJson(cacheFile, out);
    log(`Saved to: ${cacheFile}`);

    if (output) {
      saveJson(output, out);
      log(`Also saved to: ${output}`);
    } else {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    }

    // Summary to stderr
    console.error(`\nFound ${results.length} result(s) for "${query}":`);
    for (const r of results.slice(0, 5)) {
      console.error(`  ${r.name || '(unnamed)'} — ${r.rating ? `${r.rating}★` : 'no rating'} (${r.address || 'no address'})`);
    }
    if (results.length > 5) console.error(`  ...and ${results.length - 5} more`);

  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main: Place Details
// ---------------------------------------------------------------------------
async function doDetails(placeUrl, opts) {
  ensureDir(CACHE_DIR);

  const output = opts.output || null;
  const headed = opts.headed === true;
  const cdpUrl = opts.cdpUrl;
  const timeout = parseInt(opts.timeout || '30000', 10);
  const includeReviews = opts.reviews === true || opts.reviews === 'true';

  log(`Fetching details for: ${placeUrl}`);

  const browser = await launchBrowser({ headed, cdpUrl });
  const p = await newPage(browser);

  try {
    const url = placeUrl.includes('hl=en') ? placeUrl : `${placeUrl}${placeUrl.includes('?') ? '&' : '?'}hl=en&gl=us`;
    await navigate(p, url, { timeout });

    const detail = await extractPlaceDetails(p);
    if (detail.error) {
      console.error(`\n[gmaps:error] ${detail.error}: ${detail.message}`);
      process.exit(2);
    }

    if (includeReviews) {
      log('Fetching reviews...');
      detail.reviews = await extractReviews(p);
    }

    const out = {
      source: 'google-maps',
      fetchedAt: new Date().toISOString(),
      ...detail,
    };

    const key = detail.cid || detail.name || 'place';
    const cacheFile = resolve(CACHE_DIR, `place-${cacheKey(key)}.json`);
    saveJson(cacheFile, out);
    log(`Saved to: ${cacheFile}`);

    if (output) {
      saveJson(output, out);
      log(`Also saved to: ${output}`);
    } else {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    }

  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

switch (command) {
  case 'search': {
    const query = positional.join(' ');
    if (!query) bail('Usage: node place-search.mjs search <query> [options]');
    await doSearch(query, {
      limit: flags.limit,
      page: flags.page,
      output: flags.output,
      details: flags.details,
      headed: flags.headed,
      cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
      timeout: flags.timeout,
    });
    break;
  }

  case 'details': {
    const url = positional[0];
    if (!url) bail('Usage: node place-search.mjs details <google-maps-url> [options]');
    await doDetails(url, {
      output: flags.output,
      reviews: flags.reviews,
      headed: flags.headed,
      cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
      timeout: flags.timeout,
    });
    break;
  }

  default:
    console.log(`google-maps-place-search

Search Google Maps for businesses and extract structured data.

Commands:
  search <query> [options]     Search for businesses/places
  details <url> [options]      Get details for a specific place URL

Search options:
  --limit=N          Max results to return (default: 20)
  --page=N           Page number (default: 1, uses scroll-based pagination)
  --details          Also fetch full details for each result (slower)
  --output=FILE      Save JSON output to file (default: stdout)
  --headed           Run browser in headed mode (visible window)
  --cdp-url=URL      Use existing Chrome via CDP (e.g. http://localhost:9222)
  --timeout=MS       Navigation timeout in ms (default: 30000)

Details options:
  --reviews          Also extract reviews from the place page
  --output=FILE      Save JSON output to file
  --headed           Run browser in headed mode
  --cdp-url=URL      Use existing Chrome via CDP
  --timeout=MS       Navigation timeout in ms

Examples:
  node place-search.mjs search "pizza restaurants New York"
  node place-search.mjs search "coffee shops London" --limit=10
  node place-search.mjs search "dentists Austin TX" --details --output=/tmp/dentists.json
  node place-search.mjs details "https://www.google.com/maps/place/..." --reviews
  node place-search.mjs search "restaurants Manhattan" --cdp-url=http://localhost:9222

Data storage:
  ~/.local/share/showrun/data/google-maps/cache/
`);
}
