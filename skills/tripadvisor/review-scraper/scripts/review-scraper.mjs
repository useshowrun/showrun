#!/usr/bin/env node
// review-scraper.mjs — Tripadvisor hotel/restaurant/attraction review scraper
//
// ─── HOW IT WORKS ────────────────────────────────────────────────────────────
// Tripadvisor uses pre-registered GraphQL queries served from /data/graphql/ids
// These require an active browser session (cookies). This script uses CDP to
// connect to Chrome, navigate to tripadvisor.com to establish a session, then
// makes the GraphQL calls within the browser context.
//
// ─── PREREQUISITES ───────────────────────────────────────────────────────────
//   1. Chrome/Chromium with remote debugging enabled:
//      google-chrome --remote-debugging-port=9333
//   2. Node 22+ (built-in fetch + WebSocket)
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//   # Search for a location (returns locationId)
//   node review-scraper.mjs search "Marriott Times Square New York"
//
//   # Fetch reviews by URL (extracts locationId from URL)
//   node review-scraper.mjs reviews "https://www.tripadvisor.com/Hotel_Review-g60763-d93388-Reviews-..."
//
//   # Fetch reviews by locationId
//   node review-scraper.mjs reviews --id=93388
//
//   # With options
//   node review-scraper.mjs reviews --id=93388 --limit=50 --offset=0
//   node review-scraper.mjs reviews --id=93388 --lang=en --rating=5,4
//   node review-scraper.mjs reviews --id=93388 --type=FAMILY --pages=3
//   node review-scraper.mjs reviews --id=93388 --sort=recent
//   node review-scraper.mjs reviews --id=93388 --sort=detailed
//   node review-scraper.mjs reviews --id=93388 --output=reviews.json
//
//   # Get review aggregations (counts by rating/language)
//   node review-scraper.mjs aggregations --id=93388 --lang=en
//
//   # Check CDP connection
//   node review-scraper.mjs check
//
// ─── OUTPUT ──────────────────────────────────────────────────────────────────
// JSON array of review objects:
// [{
//   id: 956659647,
//   rating: 1,
//   title: "Keep Driving",
//   text: "Keep Driving.  By far the worst...",
//   publishedDate: "2024-06-25",
//   language: "en",
//   username: "gpsass1961",
//   displayName: "gpsass1961",
//   hometown: "Chandler, Arizona",
//   totalReviews: 50,
//   tripType: "FAMILY",
//   stayDate: "2024-06-30",
//   helpfulVotes: 0,
//   mgmtResponse: null,
//   additionalRatings: [],
//   photos: [],
//   locationName: "City Express By Marriott Lafayette",
//   locationId: 93388
// }]
//
// ─── PAGINATION ──────────────────────────────────────────────────────────────
// Use --pages=N to automatically paginate (fetches N pages).
// Use --all to fetch all reviews (respects --limit as page size).
// Default page size: 10

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────
const CDP_PORTS = [9333, 9222];
const GRAPHQL_ENDPOINT = '/data/graphql/ids';
const GRAPHQL_HEADERS = {
  'Content-Type': 'application/json',
  'X-Requested-By': 'TNI client 0.1',
};

// Pre-registered query IDs (discovered from JS bundles, verified working)
const QUERY_IDS = {
  // Main review list query
  REVIEWS: 'ef1a9f94012220d3',
  // Location name by ID
  LOCATION_NAME: 'a162e8f65ea938d9',
  // Review aggregations (ratings/language counts)
  AGGREGATIONS: 'e6367f6494143cbf',
  // Location tips (short reviews)
  TIPS: '13fbbde7cccdbabc',
};

// Sort options
const SORT_OPTIONS = {
  default: { sortType: null, sortBy: 'SERVER_DETERMINED' },
  recent: { sortType: 'DEFAULT', sortBy: 'DATE' },
  detailed: { sortType: 'ML_SORTED', sortBy: 'FAVORABLE_RATING' },
};

// Filter axes
const FILTER_AXES = {
  LANGUAGE: 'LANGUAGE',
  RATING: 'RATING',
  TRAVEL_TYPE: 'TRAVEL_TYPE',
  TRAVEL_TIME: 'TRAVEL_TIME',
  TEXT: 'TEXT',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const log = (...a) => { if (!process.env.QUIET) console.error('[ta]', ...a); };
const warn = (...a) => console.error('[ta:warn]', ...a);
const bail = (msg, code = 1) => { console.error(`[ta:error] ${msg}`); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function extractLocationId(urlOrId) {
  if (!urlOrId) return null;
  // Try numeric ID directly
  const numeric = parseInt(String(urlOrId), 10);
  if (!isNaN(numeric) && String(numeric) === String(urlOrId)) return numeric;
  // Extract from URL pattern: -d{locationId}-
  const match = String(urlOrId).match(/-d(\d+)-/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function buildFilters(options) {
  const filters = [];
  
  // Language filter
  if (options.lang && options.lang !== 'all') {
    const langs = options.lang.split(',').map(l => l.trim()).filter(Boolean);
    if (langs.length > 0) {
      filters.push({ axis: FILTER_AXES.LANGUAGE, selections: langs });
    }
  }
  
  // Rating filter (1-5)
  if (options.rating) {
    const ratings = options.rating.split(',').map(r => r.trim()).filter(r => /^[1-5]$/.test(r));
    if (ratings.length > 0) {
      filters.push({ axis: FILTER_AXES.RATING, selections: ratings });
    }
  }
  
  // Travel type filter
  if (options.type) {
    const validTypes = ['FAMILY', 'COUPLES', 'SOLO', 'BUSINESS', 'FRIENDS'];
    const types = options.type.split(',').map(t => t.trim().toUpperCase()).filter(t => validTypes.includes(t));
    if (types.length > 0) {
      filters.push({ axis: FILTER_AXES.TRAVEL_TYPE, selections: types });
    }
  }
  
  // Text search
  if (options.keyword) {
    filters.push({ axis: FILTER_AXES.TEXT, selections: [options.keyword] });
  }
  
  return filters;
}

// ─── CDP Connection ────────────────────────────────────────────────────────────
async function findChrome() {
  for (const port of CDP_PORTS) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(3000)
      });
      if (resp.ok) {
        const tabs = await resp.json();
        if (Array.isArray(tabs) && tabs.length > 0) return { port, tabs };
      }
    } catch { /* try next port */ }
  }
  return null;
}

class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._msgId = 1;
    this._pending = new Map();
    this._eventHandlers = [];
  }

  async connect() {
    let WS;
    try {
      const m = await import('ws');
      WS = m.default;
    } catch {
      if (typeof WebSocket !== 'undefined') WS = WebSocket;
      else bail('WebSocket not available. Install ws: npm install ws');
    }

    return new Promise((res, rej) => {
      this.ws = new WS(this.wsUrl);
      const onMsg = (raw) => {
        try {
          const msg = JSON.parse(typeof raw === 'string' ? raw : raw.data);
          if (msg.id && this._pending.has(msg.id)) {
            const { resolve, reject } = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
          for (const h of this._eventHandlers) {
            try { h(msg); } catch(e) {}
          }
        } catch {}
      };

      if (this.ws.addEventListener) {
        this.ws.addEventListener('open', res);
        this.ws.addEventListener('error', (e) => rej(e.error || new Error('WebSocket error')));
        this.ws.addEventListener('message', (e) => onMsg(e));
      } else {
        this.ws.on('open', res);
        this.ws.on('error', rej);
        this.ws.on('message', onMsg);
      }
      setTimeout(() => rej(new Error('CDP connect timeout')), 10000);
    });
  }

  send(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = this._msgId++;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeout);
    });
  }

  onEvent(handler) {
    this._eventHandlers.push(handler);
    return () => { this._eventHandlers = this._eventHandlers.filter(h => h !== handler); };
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

// ─── Tripadvisor API ───────────────────────────────────────────────────────────
async function makeGraphQLRequest(cdp, operations) {
  const operationsJson = JSON.stringify(operations);
  
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const resp = await fetch('${GRAPHQL_ENDPOINT}', {
            method: 'POST',
            headers: ${JSON.stringify(GRAPHQL_HEADERS)},
            credentials: 'include',
            body: ${JSON.stringify(operationsJson)}
          });
          const data = await resp.json();
          return JSON.stringify({ ok: true, status: resp.status, data });
        } catch(e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.result?.type === 'string') {
    const parsed = JSON.parse(result.result.value);
    if (!parsed.ok) throw new Error(`GraphQL fetch failed: ${parsed.error}`);
    if (parsed.status === 403) throw new Error('WAF_BLOCKED: Cloudflare/bot protection triggered. Try clearing cookies or using a different IP.');
    if (parsed.status === 429) throw new Error('RATE_LIMITED: Too many requests. Wait and retry.');
    if (parsed.status !== 200) throw new Error(`HTTP ${parsed.status} from GraphQL endpoint`);
    return parsed.data;
  }
  
  throw new Error('Unexpected CDP evaluate result');
}

async function fetchReviews(cdp, locationId, options = {}) {
  const {
    limit = 10,
    offset = 0,
    lang = 'en',
    sort = 'default',
    rating = null,
    type = null,
    keyword = null,
  } = options;

  const sortOpts = SORT_OPTIONS[sort] || SORT_OPTIONS.default;
  const filters = buildFilters({ lang, rating, type, keyword });

  const body = [{
    variables: {
      locationId: parseInt(locationId, 10),
      filters,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      sortType: sortOpts.sortType,
      sortBy: sortOpts.sortBy,
      language: lang === 'all' ? 'en' : lang,
      doMachineTranslation: false,
      photosPerReviewLimit: 0,
    },
    extensions: { preRegisteredQueryId: QUERY_IDS.REVIEWS }
  }];

  const response = await makeGraphQLRequest(cdp, body);
  
  if (response[0]?.errors) {
    const errMsg = response[0].errors.map(e => e.message).join(', ');
    throw new Error(`GraphQL errors: ${errMsg}`);
  }

  const pageData = response[0]?.data?.ReviewsProxy_getReviewListPageForLocation?.[0];
  if (!pageData) throw new Error('No review data in response');

  return {
    totalCount: pageData.totalCount || 0,
    reviews: (pageData.reviews || []).map(normalizeReview),
    sortType: pageData.reviewListOptions?.sortType,
    sortBy: pageData.reviewListOptions?.sortBy,
  };
}

async function fetchAggregations(cdp, locationId, lang = 'en') {
  const body = [{
    variables: {
      locationId: parseInt(locationId, 10),
      keywordVariant: `location_keywords_v2_llr_order_30_${lang}`,
      language: lang,
    },
    extensions: { preRegisteredQueryId: QUERY_IDS.AGGREGATIONS }
  }];

  const response = await makeGraphQLRequest(cdp, body);
  
  if (response[0]?.errors) {
    const errMsg = response[0].errors.map(e => e.message).join(', ');
    throw new Error(`GraphQL errors: ${errMsg}`);
  }

  const aggData = response[0]?.data?.reviewAggregations?.[0];
  return aggData || null;
}

async function fetchLocationName(cdp, locationId) {
  const body = [{
    variables: { locationId: parseInt(locationId, 10) },
    extensions: { preRegisteredQueryId: QUERY_IDS.LOCATION_NAME }
  }];

  const response = await makeGraphQLRequest(cdp, body);
  return response[0]?.data?.locations?.[0]?.name || null;
}

async function searchLocation(cdp, query) {
  // Navigate to search page and extract URL/locationId from results
  log(`Searching for: "${query}"`);
  
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          // Use the SERP search page to find location
          const encodedQuery = encodeURIComponent(${JSON.stringify(query)});
          const resp = await fetch('/Search?q=' + encodedQuery, {
            credentials: 'include',
            redirect: 'follow',
            headers: { 'Accept': 'text/html' }
          });
          const html = await resp.text();
          
          // Extract search results from HTML
          const results = [];
          const linkRegex = /href="(\\/(Hotel_Review|Restaurant_Review|Attraction_Review)-g\\d+-d(\\d+)-Reviews-[^"]+)"/gi;
          let match;
          const seen = new Set();
          
          while ((match = linkRegex.exec(html)) !== null && results.length < 10) {
            const url = match[1];
            const locationId = parseInt(match[3], 10);
            if (!seen.has(locationId)) {
              seen.add(locationId);
              // Try to extract name from URL
              const namePart = url.split('-Reviews-')[1]?.split('.html')[0]?.replace(/-/g, ' ') || '';
              results.push({ url, locationId, name: namePart });
            }
          }
          
          return JSON.stringify({ ok: true, results, finalUrl: resp.url });
        } catch(e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  const parsed = JSON.parse(result.result?.value || '{}');
  if (!parsed.ok) throw new Error(`Search failed: ${parsed.error}`);
  return parsed.results || [];
}

// ─── Data normalization ────────────────────────────────────────────────────────
function normalizeReview(r) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title || '',
    text: r.text || '',
    publishedDate: r.publishedDate,
    createdDate: r.createdDate,
    language: r.language,
    originalLanguage: r.originalLanguage,
    translationType: r.translationType || null,
    username: r.username || r.userProfile?.username || '',
    displayName: r.userProfile?.displayName || r.username || '',
    hometown: r.userProfile?.hometown?.location?.additionalNames?.long ||
              r.userProfile?.hometown?.fallbackString || null,
    totalReviews: r.userProfile?.contributionCounts?.sumAllUgc || 0,
    profileUrl: r.userProfile?.route?.url || null,
    tripType: r.tripInfo?.tripType || null,
    stayDate: r.tripInfo?.stayDate || null,
    helpfulVotes: r.helpfulVotes || 0,
    mgmtResponse: r.mgmtResponse ? {
      text: r.mgmtResponse.text || '',
      language: r.mgmtResponse.language || '',
    } : null,
    additionalRatings: (r.additionalRatings || []).map(ar => ({
      label: ar.ratingLabelLocalizedString,
      rating: ar.rating,
    })),
    photos: (r.photos || []).map(p => ({
      id: p.photo?.id,
      urlTemplate: p.photo?.photoSizeDynamic?.urlTemplate,
      maxWidth: p.photo?.photoSizeDynamic?.maxWidth,
      maxHeight: p.photo?.photoSizeDynamic?.maxHeight,
      caption: p.photo?.caption || '',
    })).filter(p => p.id),
    alertStatus: r.alertStatus || false,
    locationName: r.location?.name || r.productName || '',
    locationId: r.locationId || r.location?.locationId,
    placeType: r.location?.placeType || null,
    reviewDetailUrl: r.reviewDetailPageWrapper?.reviewDetailPageRoute?.url || null,
  };
}

// ─── Session setup ─────────────────────────────────────────────────────────────
async function ensureTripadvisorSession(cdp) {
  // Navigate to tripadvisor homepage to ensure cookies are set
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      // Check if we already have a TA session
      const cookies = document.cookie;
      if (cookies.includes('TASession') || cookies.includes('TASID')) {
        return JSON.stringify({ hasSession: true, url: location.href });
      }
      return JSON.stringify({ hasSession: false, url: location.href });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  const state = JSON.parse(result.result?.value || '{}');
  
  if (!state.hasSession || !state.url?.includes('tripadvisor')) {
    log('No TA session, navigating to establish one...');
    await cdp.send('Page.navigate', { url: 'https://www.tripadvisor.com' });
    await sleep(4000);
  } else {
    log('TA session found');
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
async function cmdCheck() {
  const chrome = await findChrome();
  if (!chrome) {
    console.error('ERROR: Chrome not found on ports', CDP_PORTS.join(', '));
    console.error('Start Chrome with: google-chrome --remote-debugging-port=9333');
    process.exit(1);
  }
  
  log(`Chrome found on port ${chrome.port}`);
  const target = chrome.tabs.find(t => t.type === 'page') || chrome.tabs[0];
  log(`Using tab: ${target.url?.substring(0, 60)}`);
  
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  await cdp.connect();
  
  await ensureTripadvisorSession(cdp);
  
  // Test with a known locationId
  const testReviews = await fetchReviews(cdp, 93388, { limit: 1 });
  log(`✅ Review API working. Test location (93388): ${testReviews.totalCount} reviews`);
  
  console.log(JSON.stringify({
    status: 'ok',
    chromePort: chrome.port,
    testLocationId: 93388,
    testReviewCount: testReviews.totalCount,
  }, null, 2));
  
  await cdp.close();
}

async function cmdSearch(query) {
  if (!query) bail('Usage: node review-scraper.mjs search "hotel name"');
  
  const chrome = await findChrome();
  if (!chrome) bail('Chrome not found. Start with: google-chrome --remote-debugging-port=9333');
  
  const target = chrome.tabs.find(t => t.type === 'page') || chrome.tabs[0];
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable', {});
  
  await ensureTripadvisorSession(cdp);
  const results = await searchLocation(cdp, query);
  
  console.log(JSON.stringify(results, null, 2));
  await cdp.close();
}

async function cmdReviews(flags, positional) {
  // Parse locationId or URL
  let locationId = flags.id ? parseInt(flags.id, 10) : null;
  
  if (!locationId && positional[0]) {
    locationId = extractLocationId(positional[0]);
  }
  
  if (!locationId) {
    bail('Provide a locationId (--id=123456) or a Tripadvisor review URL');
  }
  
  const limit = parseInt(flags.limit || '10', 10);
  const offset = parseInt(flags.offset || '0', 10);
  const pages = flags.all ? Infinity : parseInt(flags.pages || '1', 10);
  const sort = flags.sort || 'default';
  const lang = flags.lang || 'en';
  const outputFile = flags.output || null;
  
  const chrome = await findChrome();
  if (!chrome) bail('Chrome not found. Start with: google-chrome --remote-debugging-port=9333');
  
  const target = chrome.tabs.find(t => t.type === 'page') || chrome.tabs[0];
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable', {});
  
  await ensureTripadvisorSession(cdp);
  
  log(`Fetching reviews for locationId=${locationId}...`);
  
  const allReviews = [];
  let currentOffset = offset;
  let totalCount = null;
  let pageNum = 0;
  
  while (pageNum < pages) {
    pageNum++;
    log(`Page ${pageNum}${pages !== Infinity ? `/${pages}` : ''} (offset=${currentOffset})...`);
    
    const result = await fetchReviews(cdp, locationId, {
      limit,
      offset: currentOffset,
      lang,
      sort,
      rating: flags.rating || null,
      type: flags.type || null,
      keyword: flags.keyword || null,
    });
    
    if (totalCount === null) {
      totalCount = result.totalCount;
      log(`Total reviews available: ${totalCount}`);
    }
    
    if (!result.reviews.length) {
      log('No more reviews found, stopping pagination');
      break;
    }
    
    allReviews.push(...result.reviews);
    currentOffset += limit;
    
    if (currentOffset >= totalCount) {
      log('Reached end of reviews');
      break;
    }
    
    // Rate limit between pages
    if (pageNum < pages && pages !== Infinity) {
      await sleep(500);
    }
  }
  
  const output = {
    locationId,
    totalCount,
    fetchedCount: allReviews.length,
    offset: offset,
    lang,
    sort,
    reviews: allReviews,
  };
  
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(output, null, 2));
    log(`Saved ${allReviews.length} reviews to ${outputFile}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  
  await cdp.close();
}

async function cmdAggregations(flags) {
  const locationId = flags.id ? parseInt(flags.id, 10) : null;
  if (!locationId) bail('Provide a locationId: --id=123456');
  
  const lang = flags.lang || 'en';
  
  const chrome = await findChrome();
  if (!chrome) bail('Chrome not found. Start with: google-chrome --remote-debugging-port=9333');
  
  const target = chrome.tabs.find(t => t.type === 'page') || chrome.tabs[0];
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable', {});
  
  await ensureTripadvisorSession(cdp);
  
  const aggs = await fetchAggregations(cdp, locationId, lang);
  console.log(JSON.stringify(aggs, null, 2));
  
  await cdp.close();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const { flags, positional } = parseFlags(args);
  
  const command = positional[0] || 'help';
  
  try {
    switch (command) {
      case 'check':
        await cmdCheck();
        break;
        
      case 'search':
        await cmdSearch(positional.slice(1).join(' ') || flags.q);
        break;
        
      case 'reviews':
        await cmdReviews(flags, positional.slice(1));
        break;
        
      case 'aggregations':
      case 'aggs':
        await cmdAggregations(flags);
        break;
        
      default:
        console.log(`
Tripadvisor Review Scraper

Usage:
  node review-scraper.mjs check
  node review-scraper.mjs search "hotel name"
  node review-scraper.mjs reviews --id=<locationId> [options]
  node review-scraper.mjs reviews <tripadvisor-url>
  node review-scraper.mjs aggregations --id=<locationId>

Options:
  --id=<n>         Location ID (from URL pattern -d<id>-)
  --limit=<n>      Reviews per page (default: 10)
  --offset=<n>     Starting offset (default: 0)
  --pages=<n>      Number of pages to fetch (default: 1)
  --all            Fetch all reviews (overrides --pages)
  --lang=<code>    Language filter (default: en, use 'all' for no filter)
  --rating=<1-5>   Comma-separated ratings to filter (e.g. --rating=5,4)
  --type=<type>    Travel type (FAMILY,COUPLES,SOLO,BUSINESS,FRIENDS)
  --sort=<type>    Sort order: default|recent|detailed (default: default)
  --keyword=<kw>   Text search keyword
  --output=<file>  Save output to JSON file

Examples:
  node review-scraper.mjs check
  node review-scraper.mjs search "Marriott Times Square New York"
  node review-scraper.mjs reviews --id=93388 --pages=5
  node review-scraper.mjs reviews --id=93388 --rating=5 --lang=en
  node review-scraper.mjs reviews "https://www.tripadvisor.com/Hotel_Review-g60763-d93388-Reviews-..."
  node review-scraper.mjs aggregations --id=93388 --lang=en
        `);
    }
  } catch (err) {
    const msg = err.message || String(err);
    
    if (msg.includes('WAF_BLOCKED')) {
      console.error('[ta:error] WAF/Bot protection triggered.');
      console.error('Solutions:');
      console.error('  1. Open https://www.tripadvisor.com in Chrome (solve any CAPTCHA)');
      console.error('  2. Wait a few minutes before retrying');
      console.error('  3. Use a residential IP');
    } else if (msg.includes('RATE_LIMITED')) {
      console.error('[ta:error] Rate limited. Wait 30-60 seconds and retry.');
    } else if (msg.includes('CDP') || msg.includes('WebSocket')) {
      console.error(`[ta:error] CDP connection failed: ${msg}`);
      console.error('Make sure Chrome is running with: google-chrome --remote-debugging-port=9333');
    } else {
      console.error(`[ta:error] ${msg}`);
    }
    process.exit(1);
  }
}

main();
