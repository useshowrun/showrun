#!/usr/bin/env node
// review-scraper.mjs — Trustpilot business search & review scraper
//
// Dual-mode: Public REST API (preferred) or CDP browser session (fallback)
//
// ─── API MODE (requires API key) ─────────────────────────────────────────────
// Get a free API key at: https://developers.trustpilot.com/
// Set env var: TRUSTPILOT_API_KEY=your_key
//
// ─── CDP MODE (browser session, no API key required) ─────────────────────────
// Requires Chrome with remote debugging, accessible from an unblocked IP.
// WARNING: Trustpilot aggressively blocks data-center / Turkish IPs.
//
// Usage:
//   node review-scraper.mjs search <domain>                  # find a business
//   node review-scraper.mjs reviews <domain> [options]       # fetch reviews
//   node review-scraper.mjs reviews <domain> --stars=1,2    # filter by stars
//   node review-scraper.mjs reviews <domain> --lang=en       # filter by language
//   node review-scraper.mjs reviews <domain> --pages=5       # paginate
//   node review-scraper.mjs auth                             # (CDP mode) capture session
//   node review-scraper.mjs check                            # check API key / session
//
// Node 22+ required (built-in fetch).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/trustpilot');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const API_BASE = 'https://api.trustpilot.com/v1';
const WEB_BASE = 'https://www.trustpilot.com';
const CDP_PORTS = [9333, 9222];

// Default API key from env
const ENV_API_KEY = process.env.TRUSTPILOT_API_KEY || '';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function log(...args) { if (!process.env.QUIET) console.error('[tp]', ...args); }
function warn(...args) { console.error('[tp:warn]', ...args); }
function bail(msg, code = 1) { console.error(`[tp:error] ${msg}`); process.exit(code); }
function saveJson(file, data) { ensureDir(dirname(file)); writeFileSync(file, JSON.stringify(data, null, 2)); }
function loadJson(file) { if (!existsSync(file)) return null; return JSON.parse(readFileSync(file, 'utf8')); }
function cacheKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

// ─────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────

function loadSession() {
  const s = loadJson(SESSION_FILE);
  return s || {};
}

function saveSession(data) {
  ensureDir(DATA_DIR);
  writeFileSync(SESSION_FILE, JSON.stringify({ ...loadSession(), ...data, extractedAt: new Date().toISOString() }, null, 2));
}

function getApiKey() {
  if (ENV_API_KEY) return ENV_API_KEY;
  const session = loadSession();
  if (session.apiKey) return session.apiKey;
  return null;
}

// ─────────────────────────────────────────────────────────
// CDP connection (for browser mode)
// ─────────────────────────────────────────────────────────

async function findChromePort() {
  for (const port of CDP_PORTS) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const tabs = await resp.json();
        if (Array.isArray(tabs)) return port;
      }
    } catch {}
  }
  return null;
}

async function getCdpTabs(port) {
  const resp = await fetch(`http://127.0.0.1:${port}/json`);
  return resp.json();
}

class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.callbacks = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    // Try ws package first (more reliable), fall back to native WebSocket
    let WS;
    let useNative = false;
    try {
      const wsModule = await import('ws');
      WS = wsModule.default;
    } catch {
      if (typeof WebSocket !== 'undefined') {
        WS = WebSocket;
        useNative = true;
      } else {
        bail('WebSocket not available. Run: npm install ws  in the scripts/ directory');
      }
    }

    return new Promise((resolve, reject) => {
      this.ws = new WS(this.wsUrl);
      if (useNative) {
        // Native WebSocket (Node 22+) uses addEventListener
        this.ws.addEventListener('open', resolve);
        this.ws.addEventListener('error', (e) => reject(e.error || new Error('WebSocket error')));
        this.ws.addEventListener('message', (e) => {
          try { this._handleMessage(JSON.parse(e.data)); } catch {}
        });
      } else {
        // ws package uses .on()
        this.ws.on('open', resolve);
        this.ws.on('error', reject);
        this.ws.on('message', (data) => {
          try { this._handleMessage(JSON.parse(data.toString())); } catch {}
        });
      }
    });
  }

  _handleMessage(msg) {
    if (msg.id && this.callbacks.has(msg.id)) {
      const { resolve, reject } = this.callbacks.get(msg.id);
      this.callbacks.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method) || [];
      handlers.forEach(h => h(msg.params));
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(handler);
  }

  close() { try { this.ws?.close(); } catch {} }
}

// ─────────────────────────────────────────────────────────
// API-based scraping (requires API key)
// ─────────────────────────────────────────────────────────

async function apiRequest(path, params = {}, apiKey) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers = {
    'apikey': apiKey,
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; TrustpilotScraper/1.0)',
  };

  log(`API: GET ${url.toString()}`);

  let retries = 3;
  while (retries > 0) {
    const resp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15000) });

    if (resp.status === 429) {
      const resetHeader = resp.headers.get('x-ratelimit-reset');
      const waitMs = resetHeader ? (Number(resetHeader) * 1000 - Date.now() + 2000) : 60000;
      warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(Math.max(waitMs, 5000));
      retries--;
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text();
      // CloudFront WAF block returns HTML 403 with "Request blocked" or "cloudfront" in body
      if (body.includes('cloudfront') || body.includes('CloudFront') ||
          body.includes('Request blocked') || body.includes('bot') || body.includes('blocked')) {
        const err = new Error('WAF_BLOCKED: Trustpilot is blocking requests from this IP/network (CloudFront WAF).\n' +
          'This is an IP-level block affecting both API and browser access.\n' +
          'Solutions:\n' +
          '  1. Use a residential proxy (set HTTP_PROXY or HTTPS_PROXY env var)\n' +
          '  2. Run this script from a residential/unblocked IP\n' +
          '  3. Contact Trustpilot if you have a legitimate API key: https://developers.trustpilot.com/');
        err.code = 'WAF_BLOCKED';
        throw err;
      }
      if (resp.status === 401) {
        const err = new Error('API_KEY_INVALID: 401 Unauthorized — Check your API key at https://developers.trustpilot.com/');
        err.code = 'API_KEY_INVALID';
        throw err;
      }
      const err = new Error(`API_ERROR: HTTP ${resp.status} — ${body.substring(0, 200)}`);
      err.code = 'API_ERROR';
      throw err;
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body.substring(0, 200)}`);
    }

    return resp.json();
  }

  throw new Error('Max retries exceeded (rate limit)');
}

async function findBusinessUnit(domain, apiKey) {
  // Normalize domain
  const normalizedDomain = domain.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const cacheFile = resolve(CACHE_DIR, `business-${cacheKey(normalizedDomain)}.json`);

  // Check cache (1 hour TTL)
  const cached = loadJson(cacheFile);
  if (cached && Date.now() - new Date(cached._cachedAt || 0).getTime() < 3600000) {
    log(`Using cached business unit for ${normalizedDomain}`);
    return cached;
  }

  const data = await apiRequest('/business-units/find', { name: normalizedDomain }, apiKey);
  saveJson(cacheFile, { ...data, _cachedAt: new Date().toISOString() });
  return data;
}

async function getReviewsApi(businessUnitId, opts, apiKey) {
  const params = {
    page: opts.page || 1,
    perPage: opts.perPage || 20,
  };

  if (opts.stars) params.stars = opts.stars;
  if (opts.language) params.language = opts.language;
  if (opts.orderBy) params.orderBy = opts.orderBy;

  return apiRequest(`/business-units/${businessUnitId}/reviews`, params, apiKey);
}

// ─────────────────────────────────────────────────────────
// CDP-based scraping (no API key, requires browser)
// ─────────────────────────────────────────────────────────

async function scrapeNextData(cdp, url) {
  log(`CDP: Navigating to ${url}`);
  await cdp.send('Page.navigate', { url });
  await sleep(8000);

  // Check for bot block
  const contentResult = await cdp.send('Runtime.evaluate', {
    expression: 'document.body?.innerText?.substring(0, 300) || ""',
    returnByValue: true,
  });
  const content = contentResult.result?.value || '';

  if (content.includes('bot') && content.includes('blocked')) {
    throw new Error('WAF_BLOCKED: Trustpilot blocked the browser request. ' +
      'This IP/network appears to be blocked by Trustpilot WAF (CloudFront). ' +
      'Use a residential IP or set TRUSTPILOT_API_KEY to use the API mode.');
  }

  // Extract __NEXT_DATA__
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent); }
        catch(e) { return null; }
      })()
    `,
    returnByValue: true,
  });

  const nextData = result.result?.value;
  if (!nextData) {
    throw new Error('NO_NEXT_DATA: Could not extract page data. Page may be blocked or structured differently.');
  }

  return nextData;
}

async function searchViaCdp(domain) {
  const port = await findChromePort();
  if (!port) {
    bail('Chrome not found. Start Chrome with:\n  google-chrome --remote-debugging-port=9333\nOr use API mode with TRUSTPILOT_API_KEY env var.');
  }

  const tabs = await getCdpTabs(port);
  const tab = tabs.find(t => t.type === 'page' && !t.url.startsWith('chrome'));
  if (!tab) bail('No suitable Chrome tab found. Make sure Chrome has at least one tab open.');

  log(`Using Chrome tab: ${tab.url.substring(0, 60)}`);

  const cdp = new CDPSession(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable', {});

  try {
    const normalizedDomain = domain.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const url = `${WEB_BASE}/review/${encodeURIComponent(normalizedDomain)}`;
    const nextData = await scrapeNextData(cdp, url);

    const pageProps = nextData?.props?.pageProps || {};
    const bu = pageProps.businessUnit;
    if (!bu) throw new Error('Business unit not found on page');

    return bu;
  } finally {
    cdp.close();
  }
}

async function getReviewsCdp(domain, opts) {
  const port = await findChromePort();
  if (!port) {
    bail('Chrome not found. Start Chrome with:\n  google-chrome --remote-debugging-port=9333\nOr use API mode with TRUSTPILOT_API_KEY env var.');
  }

  const tabs = await getCdpTabs(port);
  const tab = tabs.find(t => t.type === 'page' && !t.url.startsWith('chrome'));
  if (!tab) bail('No suitable Chrome tab found.');

  const cdp = new CDPSession(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable', {});

  try {
    const normalizedDomain = domain.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const allReviews = [];
    let currentPage = opts.page || 1;
    let totalPages = 1;
    let businessUnit = null;
    let pagination = null;

    do {
      const params = new URLSearchParams({ page: String(currentPage) });
      if (opts.stars) params.set('stars', String(opts.stars));
      if (opts.lang) params.set('languages', opts.lang);
      if (opts.sort) params.set('sort', opts.sort);

      const url = `${WEB_BASE}/review/${encodeURIComponent(normalizedDomain)}?${params.toString()}`;
      const nextData = await scrapeNextData(cdp, url);

      const pageProps = nextData?.props?.pageProps || {};
      const reviews = pageProps.reviews || [];
      const filters = pageProps.filters || {};

      if (!businessUnit) businessUnit = pageProps.businessUnit;
      pagination = filters.pagination || {};
      totalPages = pagination.totalPages || 1;

      log(`Page ${currentPage}/${totalPages}: got ${reviews.length} reviews`);
      allReviews.push(...reviews);

      currentPage++;

      // Rate limiting: be polite between pages
      if (currentPage <= totalPages && currentPage <= (opts.page || 1) + (opts.pages || 1) - 1) {
        await sleep(2000 + Math.random() * 2000);
      }
    } while (
      currentPage <= totalPages &&
      currentPage <= (opts.page || 1) + (opts.pages || 1) - 1 &&
      (!opts.limit || allReviews.length < opts.limit)
    );

    return { reviews: allReviews, businessUnit, pagination, pages: { from: opts.page || 1, to: currentPage - 1 } };
  } finally {
    cdp.close();
  }
}

// ─────────────────────────────────────────────────────────
// Auth command (CDP-based session capture)
// ─────────────────────────────────────────────────────────

async function doAuth() {
  log('Looking for Chrome with remote debugging...');
  const port = await findChromePort();
  if (!port) {
    bail(
      'Chrome not found. Start Chrome with remote debugging:\n' +
      '  google-chrome --remote-debugging-port=9333\n' +
      'Then run this command again.'
    );
  }

  log(`Found Chrome on port ${port}`);
  const tabs = await getCdpTabs(port);
  const tab = tabs.find(t => t.type === 'page' && !t.url.startsWith('chrome'));
  if (!tab) bail('No suitable tab found.');

  const cdp = new CDPSession(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Network.enable', {});

  log('Navigating to Trustpilot...');
  await cdp.send('Page.enable', {});
  await cdp.send('Page.navigate', { url: 'https://www.trustpilot.com/review/www.apple.com' });
  await sleep(10000);

  // Check if blocked
  const contentResult = await cdp.send('Runtime.evaluate', {
    expression: 'document.body?.innerText?.substring(0, 300) || ""',
    returnByValue: true,
  });
  const content = contentResult.result?.value || '';

  if (content.includes('bot') && content.includes('blocked')) {
    cdp.close();
    console.error('\n❌ WAF_BLOCKED: Trustpilot is blocking requests from this IP/network.');
    console.error('   This means CDP browser scraping will not work from this IP.');
    console.error('\n   Solutions:');
    console.error('   1. Use the API mode instead: set TRUSTPILOT_API_KEY env var');
    console.error('      Get a free API key at: https://developers.trustpilot.com/');
    console.error('   2. Use Chrome from a residential IP / VPN');
    process.exit(1);
  }

  // Try to extract cookies
  const cookiesResult = await cdp.send('Network.getAllCookies', {});
  const tpCookies = (cookiesResult.cookies || []).filter(c => c.domain.includes('trustpilot'));

  cdp.close();

  if (tpCookies.length === 0) {
    console.error('⚠️  No Trustpilot cookies found. The CDP browser mode may still work without cookies.');
  }

  saveSession({ cdpPort: port, cookieCount: tpCookies.length, mode: 'cdp' });
  console.log('✅ CDP session captured');
  console.log(`   Port: ${port}`);
  console.log(`   Cookies: ${tpCookies.length} Trustpilot cookies`);
  console.log(`   Saved to: ${SESSION_FILE}`);
  console.log('\n⚠️  WARNING: CDP mode requires accessible IP.');
  console.log('   If blocked, use API mode: TRUSTPILOT_API_KEY=your_key node review-scraper.mjs reviews <domain>');
}

// ─────────────────────────────────────────────────────────
// Check command
// ─────────────────────────────────────────────────────────

async function doCheck() {
  const apiKey = getApiKey();
  let apiOk = false;
  let cdpOk = false;
  let wafBlocked = false;

  if (apiKey) {
    console.log(`API key found: ${apiKey.substring(0, 4)}...${apiKey.slice(-4)}`);
    console.log('Testing API access...');
    try {
      const result = await findBusinessUnit('apple.com', apiKey);
      console.log(`✅ API mode works! Found: ${result.displayName || result.identifyingName}`);
      apiOk = true;
    } catch (e) {
      if (e.code === 'WAF_BLOCKED' || e.message.includes('WAF_BLOCKED')) {
        wafBlocked = true;
        console.error('❌ API mode BLOCKED by Trustpilot WAF (IP-level block)');
        console.error('   This IP/network is blocked. Run from a residential/unblocked IP.');
      } else {
        console.error(`❌ API mode failed: ${e.message}`);
      }
    }
  } else {
    console.log('ℹ️  No API key set');
    console.log('   Set TRUSTPILOT_API_KEY env var or save in session.json');
    console.log('   Get free key at: https://developers.trustpilot.com/');
  }

  // Check CDP
  const port = await findChromePort();
  if (port) {
    console.log(`\nChrome found on port ${port}`);
    if (!apiOk && !wafBlocked) {
      console.log('Testing CDP access...');
      try {
        const bu = await searchViaCdp('apple.com');
        console.log(`✅ CDP mode works! Found: ${bu.displayName}`);
        cdpOk = true;
      } catch (e) {
        if (e.message.includes('WAF_BLOCKED')) {
          console.error('❌ CDP mode BLOCKED by Trustpilot WAF (IP-level block)');
          console.error('   Set TRUSTPILOT_API_KEY to use API mode instead');
          wafBlocked = true;
        } else {
          console.error(`❌ CDP mode failed: ${e.message}`);
        }
      }
    } else {
      console.log('   (CDP not tested since API mode is preferred)');
    }
  } else {
    console.log('\nℹ️  Chrome not found (CDP mode unavailable)');
    console.log('   CDP mode: start Chrome with --remote-debugging-port=9333');
  }

  if (wafBlocked && !apiOk && !cdpOk) {
    console.error('\n⚠️  Both modes are blocked from this IP.');
    console.error('   This IP/network is on Trustpilot\'s WAF blocklist.');
    console.error('   Options:');
    console.error('   1. Run from a residential/unblocked IP');
    console.error('   2. Use a residential proxy (HTTP_PROXY env var)');
    process.exit(1);
  }

  if (!apiKey && !port) {
    console.error('\n❌ No API key and no Chrome found');
    console.error('   API mode: set TRUSTPILOT_API_KEY env var');
    console.error('   CDP mode: start Chrome with --remote-debugging-port=9333');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────
// Search command
// ─────────────────────────────────────────────────────────

async function doSearch(domain, opts) {
  const apiKey = getApiKey();

  let businessUnit;
  if (apiKey) {
    log('Using API mode');
    businessUnit = await findBusinessUnit(domain, apiKey);
  } else {
    log('No API key — using CDP browser mode');
    businessUnit = await searchViaCdp(domain);
  }

  const output = {
    id: businessUnit.id,
    displayName: businessUnit.displayName,
    identifyingName: businessUnit.identifyingName,
    domain: businessUnit.identifyingName || domain,
    numberOfReviews: businessUnit.numberOfReviews,
    trustScore: businessUnit.trustScore,
    stars: businessUnit.stars,
    websiteUrl: businessUnit.websiteUrl,
    isClaimed: businessUnit.isClaimed,
    isCollectingReviews: businessUnit.isCollectingReviews,
    categories: (businessUnit.categories || [])
      .filter(c => c.isPrimary)
      .map(c => ({ id: c.id, name: c.name })),
    allCategories: (businessUnit.categories || []).map(c => ({ id: c.id, name: c.name })),
  };

  if (opts.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n📊 ${output.displayName} (${output.identifyingName})`);
    console.log(`   Business Unit ID: ${output.id}`);
    console.log(`   Trust Score: ${output.trustScore} (${output.stars} stars)`);
    console.log(`   Reviews: ${output.numberOfReviews}`);
    console.log(`   Claimed: ${output.isClaimed ? 'Yes' : 'No'}`);
    if (output.categories.length) {
      console.log(`   Category: ${output.categories.map(c => c.name).join(', ')}`);
    }
    console.log(`   URL: ${WEB_BASE}/review/${output.identifyingName}`);
  }

  return output;
}

// ─────────────────────────────────────────────────────────
// Reviews command
// ─────────────────────────────────────────────────────────

async function doReviews(domain, opts) {
  const apiKey = getApiKey();

  let reviews = [];
  let businessUnit = null;
  let pagination = null;

  if (apiKey) {
    log('Using API mode');

    // First get the business unit ID
    const bu = await findBusinessUnit(domain, apiKey);
    businessUnit = bu;
    const businessUnitId = bu.id;
    log(`Business Unit: ${bu.displayName} (${businessUnitId})`);

    const startPage = opts.page || 1;
    const numPages = opts.pages || 1;
    const perPage = Math.min(opts.perPage || 20, 100);

    for (let page = startPage; page < startPage + numPages; page++) {
      log(`Fetching page ${page}/${startPage + numPages - 1}...`);
      const apiOpts = { page, perPage };
      if (opts.stars) apiOpts.stars = opts.stars;
      if (opts.lang) apiOpts.language = opts.lang;
      if (opts.sort === 'recency' || opts.sort === 'recent') apiOpts.orderBy = 'createdat.desc';
      else if (opts.sort === 'oldest') apiOpts.orderBy = 'createdat.asc';

      const data = await getReviewsApi(businessUnitId, apiOpts, apiKey);
      const pageReviews = data.reviews || [];
      pagination = data.pagination || data;

      log(`  Got ${pageReviews.length} reviews`);
      reviews.push(...pageReviews);

      if (pageReviews.length < perPage) break; // last page
      if (page < startPage + numPages - 1) await sleep(1000 + Math.random() * 1000);
    }

    // Normalize API response
    reviews = reviews.map(r => normalizeApiReview(r));
  } else {
    log('No API key — using CDP browser mode');
    const result = await getReviewsCdp(domain, opts);
    reviews = result.reviews.map(r => normalizeNextDataReview(r));
    businessUnit = result.businessUnit;
    pagination = result.pagination;
  }

  // Apply limit
  if (opts.limit) reviews = reviews.slice(0, opts.limit);

  const output = {
    domain: domain.replace(/^https?:\/\//i, '').replace(/\/$/, ''),
    businessUnit: businessUnit ? {
      id: businessUnit.id,
      displayName: businessUnit.displayName,
      trustScore: businessUnit.trustScore,
      stars: businessUnit.stars,
    } : null,
    pagination,
    count: reviews.length,
    reviews,
  };

  // Save cache
  const cacheFile = resolve(CACHE_DIR, `reviews-${cacheKey(output.domain)}-${Date.now()}.json`);
  saveJson(cacheFile, output);
  log(`Saved to: ${cacheFile}`);

  if (opts.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const bu = output.businessUnit;
    if (bu) {
      console.log(`\n📊 ${bu.displayName} — Trust Score: ${bu.trustScore} (${bu.stars}⭐)`);
    }
    if (pagination) {
      console.log(`   Reviews: ${pagination.totalCount || '?'} total, page ${pagination.currentPage || '?'}/${pagination.totalPages || '?'}`);
    }
    console.log(`\n📝 ${output.count} reviews:\n`);
    for (const r of output.reviews) {
      console.log(`[${'⭐'.repeat(r.rating || 0)}] ${r.title || '(no title)'}`);
      console.log(`  By: ${r.consumer?.displayName || 'Anonymous'} (${r.consumer?.countryCode || '?'})`);
      console.log(`  ${new Date(r.publishedDate || r.dates?.publishedDate || 0).toLocaleDateString()}`);
      if (r.text) console.log(`  "${r.text.substring(0, 120)}${r.text.length > 120 ? '...' : ''}"`);
      if (r.reply) console.log(`  ↩ Reply: ${String(r.reply.text || r.reply).substring(0, 80)}...`);
      console.log();
    }
  }

  return output;
}

// ─────────────────────────────────────────────────────────
// Review normalizers (unify API and Next.js data formats)
// ─────────────────────────────────────────────────────────

function normalizeApiReview(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.text,
    rating: r.stars,
    publishedDate: r.createdAt,
    updatedDate: r.updatedAt || null,
    experiencedDate: r.experience?.date || null,
    language: r.language,
    isVerified: r.isVerified || false,
    consumer: {
      id: r.consumer?.id,
      displayName: r.consumer?.displayName,
      countryCode: r.consumer?.countryCode,
      numberOfReviews: r.consumer?.numberOfReviews,
    },
    reply: r.companyReply ? {
      text: r.companyReply.text,
      date: r.companyReply.createdAt,
    } : null,
    source: r.source || null,
    reviewUrl: `${WEB_BASE}/reviews/${r.id}`,
  };
}

function normalizeNextDataReview(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.text,
    rating: r.rating,
    publishedDate: r.dates?.publishedDate || null,
    updatedDate: r.dates?.updatedDate || null,
    experiencedDate: r.dates?.experiencedDate || null,
    language: r.language,
    isVerified: r.labels?.verification?.isVerified || false,
    verificationLevel: r.labels?.verification?.verificationLevel || null,
    consumer: {
      id: r.consumer?.id,
      displayName: r.consumer?.displayName,
      countryCode: r.consumer?.countryCode,
      numberOfReviews: r.consumer?.numberOfReviews,
    },
    reply: r.reply ? {
      text: typeof r.reply === 'string' ? r.reply : r.reply.text,
      date: r.reply?.publishedDate || null,
    } : null,
    source: r.source || r.labels?.verification?.reviewSourceName || null,
    reviewUrl: `${WEB_BASE}/reviews/${r.id}`,
  };
}

// ─────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
trustpilot-review-scraper — Trustpilot business search & review scraper

MODES:
  API mode  (preferred)  — requires TRUSTPILOT_API_KEY env var
  CDP mode  (fallback)   — uses Chrome browser session, no API key needed
                           ⚠️  BLOCKED from Turkish/data-center IPs

SETUP:
  API mode:  export TRUSTPILOT_API_KEY=your_key
             Get key at: https://developers.trustpilot.com/
  CDP mode:  node review-scraper.mjs auth
             (Chrome must be running with --remote-debugging-port=9333)

USAGE:
  node review-scraper.mjs search <domain>            # find a business
  node review-scraper.mjs reviews <domain>           # get latest reviews (page 1)
  node review-scraper.mjs reviews <domain> [options]

OPTIONS:
  --stars=1,2          Filter by star rating (1-5, comma-separated)
  --lang=en            Filter by language (ISO code, 'all' for all)
  --page=N             Start from page N (default: 1)
  --pages=N            Fetch N pages (default: 1)
  --limit=N            Max total reviews to return
  --sort=recency       Sort order: recency | oldest | relevance
  --output=json        JSON output (default: pretty-print)

EXAMPLES:
  node review-scraper.mjs search apple.com
  node review-scraper.mjs reviews amazon.com
  node review-scraper.mjs reviews amazon.com --stars=1 --pages=3
  node review-scraper.mjs reviews amazon.com --lang=en --limit=100
  node review-scraper.mjs reviews netflix.com --output=json > out.json

SPECIAL COMMANDS:
  node review-scraper.mjs auth    # (CDP mode) capture browser session
  node review-scraper.mjs check   # test API key or CDP connection

DATA STORAGE:
  ~/.local/share/showrun/data/trustpilot/
    session.json          Saved session config
    cache/                Cached results
`);
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(CACHE_DIR);

  const args = process.argv.slice(2);
  const { flags, positional } = parseFlags(args);
  const [command, ...rest] = positional;

  if (!command || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'auth':
      await doAuth();
      break;

    case 'check':
      await doCheck();
      break;

    case 'search':
    case 'find': {
      const domain = rest[0];
      if (!domain) bail('Usage: node review-scraper.mjs search <domain>');
      await doSearch(domain, { output: flags.output });
      break;
    }

    case 'reviews':
    case 'review': {
      const domain = rest[0];
      if (!domain) bail('Usage: node review-scraper.mjs reviews <domain> [options]');
      await doReviews(domain, {
        page: flags.page ? parseInt(flags.page) : 1,
        pages: flags.pages ? parseInt(flags.pages) : 1,
        perPage: flags.perPage ? parseInt(flags.perPage) : 20,
        limit: flags.limit ? parseInt(flags.limit) : null,
        stars: flags.stars || null,
        lang: flags.lang || flags.language || null,
        sort: flags.sort || 'recency',
        output: flags.output || null,
      });
      break;
    }

    default:
      bail(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

main().catch(e => {
  if (process.env.DEBUG) {
    console.error(e.stack);
  } else if (e.code === 'WAF_BLOCKED') {
    console.error(`\n❌ WAF_BLOCKED: ${e.message}`);
  } else if (e.code === 'API_KEY_INVALID') {
    console.error(`\n❌ ${e.message}`);
  } else {
    console.error(`[tp:fatal] ${e.message}`);
  }
  process.exit(1);
});
