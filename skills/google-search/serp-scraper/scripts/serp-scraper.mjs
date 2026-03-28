#!/usr/bin/env node
/**
 * Google Search SERP Scraper
 *
 * Scrapes Google Search results pages (SERPs) without an API key:
 *   - Organic web results (title, URL, description, position)
 *   - People Also Ask (PAA) questions
 *   - News results (title, source, time, URL) — via tbm=nws
 *   - Image results (URLs) — via tbm=isch
 *   - Related searches
 *   - Result count / stats
 *
 * Strategy:
 *   Uses Playwright with real Chrome binary to avoid bot detection.
 *   Google's GDPR consent page is auto-accepted on first visit.
 *   No API key or Google account required.
 *
 * Pagination:
 *   Via `start` parameter — increment by `num` per page.
 *   Google limits organic to ~100 results (start > 100 → empty).
 *
 * Bot detection:
 *   Google fingerprints headless browsers. This script:
 *   - Uses a real Chrome binary (not Playwright's bundled Chromium)
 *   - Disables AutomationControlled flag
 *   - Adds realistic request delays (1-3 seconds between pages)
 *   - Detects CAPTCHA and exits with code 4
 *
 * Usage:
 *   node serp-scraper.mjs search <query> [options]
 *   node serp-scraper.mjs news <query> [options]
 *   node serp-scraper.mjs images <query> [options]
 *
 * Options:
 *   --pages=N         Number of pages to fetch (default: 1)
 *   --num=N           Results per page (default: 10, max: 100)
 *   --hl=LANG         Language code (default: en)
 *   --gl=COUNTRY      Country code (default: us)
 *   --tbs=FILTER      Time filter: qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)
 *   --output=FILE     Save JSON output to file
 *   --headed          Show browser window
 *   --cdp-url=URL     Connect to existing Chrome via CDP
 *   --delay=MS        Delay between page requests in ms (default: 2000)
 *   --timeout=MS      Page load timeout in ms (default: 30000)
 *
 * Exit codes:
 *   0  Success
 *   1  Usage / configuration error
 *   2  No results found (empty SERP)
 *   4  CAPTCHA / bot detection triggered
 *   5  Rate limit (too many requests)
 *
 * Requires:
 *   - Node.js 22+
 *   - playwright npm package: `npm install playwright` (or global: `sudo npm install -g playwright`)
 *   - Google Chrome or Chromium at /usr/bin/google-chrome-stable (or set CHROME_EXECUTABLE)
 */

import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/google-search');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const CHROME_EXECUTABLES = [
  process.env.CHROME_EXECUTABLE,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge-stable',
].filter(Boolean);

const DEFAULT_CDP_URLS = [
  process.env.CHROME_CDP_URL,
  'http://localhost:9333',
  'http://localhost:9222',
].filter(Boolean);

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const GOOGLE_SEARCH_BASE = 'https://www.google.com/search';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  if (!process.env.QUIET) console.error('[serp]', ...args);
}
function warn(...args) { console.error('[serp:warn]', ...args); }
function bail(msg, code = 1) { console.error(`[serp:error] ${msg}`); process.exit(code); }

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function saveJson(file, data) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(data, null, 2));
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cacheKey(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
}

function findChrome() {
  for (const p of CHROME_EXECUTABLES) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Playwright browser launcher
// ---------------------------------------------------------------------------

async function launchBrowser(opts = {}) {
  let chromium;
  try {
    ({ chromium } = require('/usr/lib/node_modules/playwright'));
  } catch {
    try {
      ({ chromium } = require('playwright'));
    } catch {
      bail(
        'playwright not installed.\n' +
        'Run one of:\n' +
        '  npm install playwright            (local, in skill dir)\n' +
        '  sudo npm install -g playwright    (global)\n',
        1
      );
    }
  }

  // CDP attach mode
  if (opts.cdpUrl) {
    log(`Connecting to existing Chrome at ${opts.cdpUrl}`);
    try {
      const browser = await chromium.connectOverCDP(opts.cdpUrl, { timeout: 10000 });
      return { browser, close: () => {} }; // don't close externally-owned browser
    } catch (e) {
      warn(`CDP connect failed: ${e.message}. Falling back to local launch.`);
    }
  }

  const chromePath = findChrome();
  if (!chromePath) {
    bail(
      'Google Chrome not found. Install it or set CHROME_EXECUTABLE env var.\n' +
      'Tried: ' + CHROME_EXECUTABLES.join(', '),
      1
    );
  }

  log(`Launching Chrome: ${chromePath}`);
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: opts.headed ? false : true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      '--disable-extensions',
      '--disable-plugins',
    ],
  });

  return { browser, close: () => browser.close() };
}

// ---------------------------------------------------------------------------
// Bot detection checks
// ---------------------------------------------------------------------------

function detectCaptcha(html, url) {
  if (!html) return false;
  // Small page = redirect to CAPTCHA
  if (html.length < 30000) return true;
  // Explicit CAPTCHA markers
  if (html.includes('captcha-form') || html.includes('g-recaptcha')) return true;
  // Sorry page
  if (url && url.includes('google.com/sorry')) return true;
  // "unusual traffic" text
  if (html.includes('unusual traffic') || html.includes('not a robot')) return true;
  // Empty body
  if (!html.includes('id="search"') && !html.includes('id="rso"') && !html.includes('tbm=nws')) {
    // May also be consent page — don't flag that
    if (!html.includes('consent') && !html.includes('L2AGLb')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Consent page handler
// ---------------------------------------------------------------------------

async function handleConsent(page) {
  // Check for GDPR consent button
  const consentSelectors = [
    'button#L2AGLb',               // "Accept all" (English)
    'button[id="L2AGLb"]',
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'form[action*="consent.google"] button',
  ];

  for (const sel of consentSelectors) {
    try {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 2000 });
      if (visible) {
        log(`Accepting consent (${sel})`);
        await btn.click();
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await sleep(1000);
        return true;
      }
    } catch {}
  }
  return false;
}

// ---------------------------------------------------------------------------
// Organic result extractor
// ---------------------------------------------------------------------------

async function extractOrganicResults(page) {
  return page.evaluate(() => {
    const results = [];

    // Strategy: find all h3.LC20lb titles, then walk up to find their containers
    const allH3 = Array.from(document.querySelectorAll('h3.LC20lb'));

    for (let i = 0; i < allH3.length; i++) {
      const h3 = allH3[i];
      const titleText = h3.textContent.trim();
      if (!titleText) continue;

      // Find actual URL — the nearest <a> ancestor
      const anchor = h3.closest('a') || h3.querySelector('a');
      let href = anchor?.href || null;
      // Clean up Google redirect URLs
      if (href && href.startsWith('/url?')) {
        try {
          const u = new URL('https://www.google.com' + href);
          href = u.searchParams.get('q') || href;
        } catch {}
      }
      // Strip fragment anchors added by Google (e.g. #:~:text=)
      if (href && href.includes('#:~:text=')) {
        href = href.split('#:~:text=')[0];
      }

      // Find container (walk up to data-hveid or data-sokoban-container)
      let container = h3.parentElement;
      let el = h3;
      for (let depth = 0; depth < 12; depth++) {
        if (!el.parentElement) break;
        el = el.parentElement;
        if (
          el.hasAttribute('data-hveid') ||
          el.hasAttribute('data-sokoban-container') ||
          el.tagName === 'LI'
        ) {
          container = el;
          break;
        }
      }

      // Extract display URL (cite element)
      const citeEl = container.querySelector('cite');
      const displayUrl = citeEl?.textContent?.trim() || null;

      // Extract description
      const descEl =
        container.querySelector('.VwiC3b') ||
        container.querySelector('[data-sncf="1"]') ||
        container.querySelector('.s3v9rd');
      const description = descEl?.textContent?.trim() || null;

      // Extract favicon / site name
      const faviconImg = container.querySelector('img[src*="favicon"], img[alt]');
      const siteName = faviconImg?.alt?.trim() || null;

      // Extract date (if present in snippet)
      const dateMatch = description?.match(/^(\w{3} \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}|\d+ \w+ ago)\s*[—–-]/);
      const publishedDate = dateMatch?.[1] || null;

      results.push({
        position: i + 1,
        type: 'organic',
        title: titleText,
        url: href,
        displayUrl,
        description,
        siteName,
        publishedDate,
      });
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// PAA (People Also Ask) extractor
// ---------------------------------------------------------------------------

async function extractPAA(page) {
  return page.evaluate(() => {
    // PAA items have data-q attribute with the question text
    const paaEls = Array.from(document.querySelectorAll('[data-q]'));
    const questions = paaEls
      .map(el => el.getAttribute('data-q'))
      .filter(q => q && q.trim().length > 5);
    
    // Filter to actual questions (contain '?' or are long question-like phrases)
    // Also deduplicate
    const seen = new Set();
    return questions.filter(q => {
      const clean = q.trim();
      if (seen.has(clean)) return false;
      seen.add(clean);
      // Must look like a question (contains '?') or be a PAA-style phrase
      return clean.includes('?');
    });
  });
}

// ---------------------------------------------------------------------------
// News results extractor (from regular SERP or tbm=nws)
// ---------------------------------------------------------------------------

async function extractNewsResults(page) {
  return page.evaluate(() => {
    const results = [];

    // Approach 1: .WlydOe anchors (individual news items)
    const newsAnchors = Array.from(document.querySelectorAll('a.WlydOe'));
    for (const a of newsAnchors) {
      const container = a.closest('.SoaBEf') || a.parentElement;
      const titleEl = a.querySelector('.nDgy9d, .MBeuO, [role="heading"]') || a;
      const title = titleEl.textContent.trim();
      if (!title) continue;

      const sourceEl = container?.querySelector('.CEMjEf, .NUnG9d, .oovtQ, .wY6C8d');
      const timeEl = container?.querySelector('.OSrXXb, .ZE0LJd, time, .hvbAAd');
      const thumbEl = container?.querySelector('img');

      results.push({
        type: 'news',
        title,
        url: a.href,
        source: sourceEl?.textContent?.trim() || null,
        publishedTime: timeEl?.textContent?.trim() || null,
        thumbnail: thumbEl?.src || null,
      });
    }

    // Approach 2: .SoaBEf containers (if above failed)
    if (results.length === 0) {
      const newsContainers = Array.from(document.querySelectorAll('.SoaBEf'));
      for (const container of newsContainers) {
        const link = container.querySelector('a[href]');
        if (!link) continue;
        const title = link.textContent.trim();
        const sourceEl = container.querySelector('.CEMjEf, .NUnG9d');
        const timeEl = container.querySelector('.OSrXXb, time');
        results.push({
          type: 'news',
          title,
          url: link.href,
          source: sourceEl?.textContent?.trim() || null,
          publishedTime: timeEl?.textContent?.trim() || null,
        });
      }
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Image results extractor (tbm=isch)
// ---------------------------------------------------------------------------

async function extractImageResults(page) {
  return page.evaluate(() => {
    const results = [];
    const containers = Array.from(document.querySelectorAll('.H8Rx8c, .ivg-i, [jsname="dTDiAc"]'));
    for (const el of containers) {
      const img = el.querySelector('img');
      const link = el.querySelector('a[href]') || el.closest('a');
      const titleEl = el.querySelector('[aria-label], [title]');
      if (!img) continue;
      results.push({
        type: 'image',
        url: link?.href || null,
        thumbnailUrl: img.src || null,
        alt: img.alt || titleEl?.getAttribute('aria-label') || titleEl?.getAttribute('title') || null,
      });
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Related searches extractor
// ---------------------------------------------------------------------------

async function extractRelatedSearches(page) {
  return page.evaluate(() => {
    const related = [];
    const seen = new Set();

    // Related searches appear at the bottom in various containers
    // They are typically short keyword phrases, NOT long sentences or URLs
    const selectors = [
      '.k8XOCe .s75CSd',   // "People also search for" chips
      '.Q71vJc',           // Related search chips
      '.oatEtb .s75CSd',
      '.brs_col a',
      '.dg6jd',            // Another related search container
    ];

    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const text = el.textContent.trim();
        // Filter: must be short (< 80 chars), no URLs, no special chars
        if (
          text &&
          text.length > 2 &&
          text.length < 80 &&
          !text.includes('http') &&
          !text.includes('›') &&
          !text.includes('\n') &&
          !seen.has(text)
        ) {
          seen.add(text);
          related.push(text);
        }
      }
    }

    return related.slice(0, 10);
  });
}

// ---------------------------------------------------------------------------
// Result stats extractor
// ---------------------------------------------------------------------------

async function extractStats(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#result-stats');
    if (!el) return null;
    const text = el.textContent.trim();
    // Parse "About 315,000,000 results (0.34 seconds)" or "(0.34s)"
    const countMatch = text.match(/about\s+([\d,]+)\s+results/i);
    const timeMatch = text.match(/\(([\d.]+)\s*s(?:econds?)?\)/i);
    return {
      raw: text,
      count: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
      timeSeconds: timeMatch ? parseFloat(timeMatch[1]) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Single page fetch
// ---------------------------------------------------------------------------

async function fetchPage(page, url, opts = {}) {
  log(`Fetching: ${url}`);

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeout || 30000,
    });

    const currentUrl = page.url();
    const html = await page.content();

    // Check for CAPTCHA
    if (detectCaptcha(html, currentUrl)) {
      warn('CAPTCHA / bot detection triggered!');
      warn(`URL: ${currentUrl}`);
      warn('Try: --headed mode or --cdp-url to use your real Chrome browser.');
      process.exit(4);
    }

    // Handle consent page (first visit)
    const didConsent = await handleConsent(page);
    if (didConsent) {
      // Re-fetch after consent
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 30000 });
    }

    return true;
  } catch (e) {
    if (e.message.includes('net::ERR_') || e.message.includes('Timeout')) {
      warn(`Network error: ${e.message}`);
      return false;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

async function doSearch(query, opts = {}) {
  const {
    pages = 1,
    num = 10,
    hl = 'en',
    gl = 'us',
    tbm = null,         // null=web, 'nws'=news, 'isch'=images
    tbs = null,         // time filter
    headless = true,
    cdpUrl = null,
    delayMs = 2000,
    timeout = 30000,
  } = opts;

  log(`Searching for: "${query}" (${pages} page(s), ${num} per page)`);

  const { browser, close } = await launchBrowser({
    headed: !headless,
    cdpUrl,
  });

  try {
    const context = cdpUrl
      ? browser.contexts()[0] || await browser.newContext()
      : await browser.newContext({
          userAgent: DEFAULT_USER_AGENT,
          viewport: { width: 1280, height: 900 },
          locale: 'en-US',
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

    const page = await context.newPage();

    const allResults = [];
    let allPAA = [];
    let allRelated = [];
    let firstStats = null;

    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const start = (pageNum - 1) * num;
      const params = new URLSearchParams({ q: query, hl, gl, num: String(num) });
      if (start > 0) params.set('start', String(start));
      if (tbm) params.set('tbm', tbm);
      if (tbs) params.set('tbs', tbs);
      const url = `${GOOGLE_SEARCH_BASE}?${params.toString()}`;

      const ok = await fetchPage(page, url, { timeout });
      if (!ok) {
        warn(`Failed to load page ${pageNum}, stopping.`);
        break;
      }

      // Wait for results to render
      try {
        if (tbm === 'isch') {
          await page.waitForSelector('.H8Rx8c, .ivg-i', { timeout: 10000 });
        } else if (tbm === 'nws') {
          await page.waitForSelector('.SoaBEf, .WlydOe, h3', { timeout: 10000 });
        } else {
          await page.waitForSelector('h3.LC20lb, #rso, #search', { timeout: 10000 });
        }
      } catch {
        // Selector may not appear if page is empty
        warn(`Results selector not found on page ${pageNum} — page may be empty`);
      }

      // Extract based on type
      let pageResults = [];
      if (tbm === 'isch') {
        pageResults = await extractImageResults(page);
      } else if (tbm === 'nws') {
        pageResults = await extractNewsResults(page);
        // News pages also show organic results — grab them too
        const organic = await extractOrganicResults(page);
        for (const r of organic) {
          if (!pageResults.find(n => n.url === r.url)) {
            pageResults.push(r);
          }
        }
      } else {
        // Web/organic search
        pageResults = await extractOrganicResults(page);

        // Also extract PAA and related on web search
        if (pageNum === 1) {
          const paa = await extractPAA(page);
          allPAA = paa;

          const related = await extractRelatedSearches(page);
          allRelated = related;
        }
      }

      // Add position offsets for multi-page
      for (const r of pageResults) {
        if (r.position) r.position += (pageNum - 1) * num;
      }

      log(`Page ${pageNum}: ${pageResults.length} results`);

      if (pageResults.length === 0 && pageNum > 1) {
        log('Empty page — stopping pagination');
        break;
      }

      allResults.push(...pageResults);

      // Collect stats from first page
      if (pageNum === 1) {
        firstStats = await extractStats(page);
      }

      // Delay between pages to avoid rate limiting
      if (pageNum < pages) {
        log(`Waiting ${delayMs}ms before next page...`);
        await sleep(delayMs);
      }
    }

    await page.close();
    return {
      query,
      type: tbm || 'web',
      stats: firstStats,
      results: allResults,
      paa: allPAA,
      relatedSearches: allRelated,
      fetchedAt: new Date().toISOString(),
      pagination: {
        pages,
        num,
        totalFetched: allResults.length,
      },
    };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function buildOutput(data, query, outputFile) {
  const output = {
    source: 'google-search',
    fetchedAt: data.fetchedAt,
    query,
    type: data.type,
    stats: data.stats,
    pagination: data.pagination,
    results: data.results,
    paa: data.paa || [],
    relatedSearches: data.relatedSearches || [],
  };

  const json = JSON.stringify(output, null, 2);

  if (outputFile) {
    ensureDir(dirname(outputFile));
    writeFileSync(outputFile, json);
    log(`Saved to: ${outputFile}`);
  } else {
    process.stdout.write(json + '\n');
  }

  // Also cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `${cacheKey(query)}-${data.type}.json`);
  saveJson(cacheFile, output);
  log(`Cached to: ${cacheFile}`);

  return output;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp() {
  console.log(`
google-search SERP Scraper

Usage:
  node serp-scraper.mjs search <query> [options]   # Web/organic results
  node serp-scraper.mjs news <query> [options]      # News results
  node serp-scraper.mjs images <query> [options]    # Image results

Options:
  --pages=N         Pages to fetch (default: 1)
  --num=N           Results per page (default: 10, max: 100)
  --hl=LANG         Language code (default: en)
  --gl=COUNTRY      Country code (default: us)
  --tbs=FILTER      Time: qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)
  --output=FILE     Save JSON to file (default: stdout)
  --headed          Show browser window
  --cdp-url=URL     Connect to existing Chrome (e.g. http://localhost:9222)
  --delay=MS        Delay between pages (default: 2000)
  --timeout=MS      Page load timeout (default: 30000)

Examples:
  node serp-scraper.mjs search "python programming" --pages=3
  node serp-scraper.mjs news "openai" --pages=2 --output=/tmp/news.json
  node serp-scraper.mjs search "best laptops 2024" --tbs=qdr:m --num=20
  node serp-scraper.mjs images "cats" --output=/tmp/cats.json
  node serp-scraper.mjs search "site:example.com" --cdp-url=http://localhost:9222

Exit codes:
  0  Success
  1  Usage / config error
  2  No results
  4  CAPTCHA / bot detection
  5  Rate limit
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const { flags, positional } = parseFlags(args);
  const command = positional[0];
  const query = positional.slice(1).join(' ');

  if (!command || !['search', 'news', 'images'].includes(command)) {
    bail(`Unknown command: "${command}". Use: search, news, images`);
  }

  if (!query) {
    bail('Query is required. Example: node serp-scraper.mjs search "python programming"');
  }

  // Map command to tbm
  const tbmMap = { search: null, news: 'nws', images: 'isch' };
  const tbm = tbmMap[command];

  const opts = {
    pages: parseInt(flags.pages || '1', 10),
    num: parseInt(flags.num || '10', 10),
    hl: flags.hl || 'en',
    gl: flags.gl || 'us',
    tbm,
    tbs: flags.tbs || null,
    headless: !flags.headed,
    cdpUrl: flags['cdp-url'] || DEFAULT_CDP_URLS.find(u => u) || null,
    delayMs: parseInt(flags.delay || '2000', 10),
    timeout: parseInt(flags.timeout || '30000', 10),
  };

  // Validate
  if (opts.pages < 1 || opts.pages > 20) bail('--pages must be 1-20');
  if (opts.num < 1 || opts.num > 100) bail('--num must be 1-100');

  try {
    const data = await doSearch(query, opts);

    if (data.results.length === 0) {
      warn('No results found. Possible causes: CAPTCHA, empty query, or Google returned no results.');
      warn('Try: --headed flag to see what the browser shows.');
      process.exit(2);
    }

    buildOutput(data, query, flags.output || null);

    log(`Done: ${data.results.length} results for "${query}"`);
    process.exit(0);
  } catch (e) {
    console.error('[serp:fatal]', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
