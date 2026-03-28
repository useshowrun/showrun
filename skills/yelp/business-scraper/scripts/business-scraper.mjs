#!/usr/bin/env node
/**
 * Yelp Business Scraper
 *
 * Scrapes business search results, business details, and reviews from Yelp.
 * Uses Chrome CDP to bypass DataDome WAF protection.
 *
 * Usage:
 *   node business-scraper.mjs search "restaurants" "San Francisco, CA"
 *   node business-scraper.mjs search "pizza" "New York, NY" --start=10 --sortby=rating
 *   node business-scraper.mjs get gary-danko-san-francisco
 *   node business-scraper.mjs reviews gary-danko-san-francisco
 *   node business-scraper.mjs reviews gary-danko-san-francisco --pages=3
 *   node business-scraper.mjs reviews gary-danko-san-francisco --sort=DATE_DESC
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_PORT = process.env.CDP_PORT || 9333;
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const YELP_BASE = 'https://www.yelp.com';
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yelp');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

// GQL document IDs (stable unless Yelp deploys new JS bundles)
const GQL_DOC_IDS = {
  GetBusinessReviewFeed: '6c42e4744b662c607dddf3031426e89c8ad492ee98fd3c8ef778787ae898247b',
  GetLocalBusinessJsonLinkedData: '619b0b64de025819cc6f695f2641c72b6f48fae5ff57c92bb5437314203fdafc',
  GetBusinessHours: '3a647e54dc8a46dfe3992682c5cc4d184e3731cdf2ecd9a2e24d6bc03c2fbb35',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg) { console.error(`[yelp] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function saveJson(path, data) { ensureDir(resolve(path, '..')); writeFileSync(path, JSON.stringify(data, null, 2)); }

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) {
      flags[m[1]] = m[2] !== undefined ? m[2] : true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

async function getCdpTargets() {
  const res = execSync(`curl -s http://${CDP_HOST}:${CDP_PORT}/json/list`, { encoding: 'utf8', timeout: 5000 });
  return JSON.parse(res);
}

async function createCdpTab() {
  try {
    const res = execSync(`curl -s -X PUT "http://${CDP_HOST}:${CDP_PORT}/json/new?about:blank"`, { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(res);
  } catch {
    // Some Chrome versions use POST
    const res = execSync(`curl -s "http://${CDP_HOST}:${CDP_PORT}/json/new?about:blank"`, { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(res);
  }
}

async function closeCdpTab(id) {
  try { execSync(`curl -s "http://${CDP_HOST}:${CDP_PORT}/json/close/${id}"`, { timeout: 5000 }); } catch {}
}

/**
 * Connect to CDP WebSocket and return a send() function + event listener registration
 */
async function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();
    const eventListeners = new Map();

    ws.on('open', () => {
      const send = (method, params = {}) => {
        const id = msgId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };
      const on = (event, handler) => {
        if (!eventListeners.has(event)) eventListeners.set(event, []);
        eventListeners.get(event).push(handler);
      };
      const close = () => ws.close();
      resolve({ send, on, close, ws });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP: ${msg.error.message}`));
        else res(msg.result);
      }
      if (msg.method) {
        const handlers = eventListeners.get(msg.method) || [];
        for (const h of handlers) h(msg.params);
      }
    });

    ws.on('error', reject);
    ws.on('close', () => {
      for (const [, { rej }] of pending) rej(new Error('CDP connection closed'));
      pending.clear();
    });
  });
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract window.yelp.react_root_props from page HTML
 */
function extractReactRootProps(html) {
  const match = html.match(/window\.yelp\.react_root_props\s*=\s*(\{)/);
  if (!match) return null;

  const start = html.indexOf(match[0]) + match[0].length - 1;
  let depth = 0, inStr = false, esc = false, i = start;
  while (i < html.length) {
    const c = html[i];
    if (esc) { esc = false; }
    else if (c === '\\' && inStr) { esc = true; }
    else if (c === '"' && !esc) { inStr = !inStr; }
    else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    i++;
  }

  try { return JSON.parse(html.substring(start, i + 1)); } catch { return null; }
}

/**
 * Extract Apollo cache from page HTML
 */
function extractApolloCache(html) {
  // Apollo cache is in an HTML comment: <!--{...}-->
  const scriptPattern = /<script[^>]*><!--(\{.*?}?)--><\/script>/gs;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    if (match[1].includes('ROOT_QUERY') || match[1].includes('Business:')) {
      try {
        // Decode HTML entities
        const decoded = match[1]
          .replace(/&quot;/g, '"')
          .replace(/&#x2F;/g, '/')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'");
        return JSON.parse(decoded);
      } catch {}
    }
  }
  return null;
}

/**
 * Resolve a reference in the Apollo cache
 */
function resolveRef(cache, val) {
  if (!val || typeof val !== 'object') return val;
  if (val.__ref) return cache[val.__ref] || val;
  return val;
}

// ---------------------------------------------------------------------------
// Page navigation with network interception
// ---------------------------------------------------------------------------

async function loadPageWithInterception(url, waitMs = 15000) {
  const tab = await createCdpTab();
  const { send, on, close } = await connectCdp(tab.webSocketDebuggerUrl);

  const intercepted = new Map();

  try {
    await send('Network.enable', { maxPostDataSize: 200000 });
    await send('Page.enable', {});

    on('Network.requestWillBeSent', ({ requestId, request }) => {
      const u = request.url;
      if (u.includes('yelp.com') && (u.includes('/gql') || u.includes('/props') || u.includes('/review_feed'))) {
        intercepted.set(requestId, {
          url: u, method: request.method, postData: request.postData,
        });
      }
    });

    on('Network.responseReceived', ({ requestId, response }) => {
      if (intercepted.has(requestId)) {
        intercepted.get(requestId).status = response.status;
        intercepted.get(requestId).mimeType = response.mimeType;
      }
    });

    log(`Loading: ${url}`);
    await send('Page.navigate', { url });
    await sleep(waitMs);

    // Get page HTML
    const htmlResult = await send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    const html = htmlResult.result?.value || '';

    // Get response bodies for intercepted calls
    const apiResponses = {};
    for (const [reqId, reqData] of intercepted.entries()) {
      try {
        const body = await send('Network.getResponseBody', { requestId: reqId });
        apiResponses[reqId] = { ...reqData, body: body.body };
      } catch {}
    }

    return { html, apiResponses };
  } finally {
    close();
    await closeCdpTab(tab.id);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchBusinesses({ query, location, start = 0, sortby = 'best_match', limit = null }) {
  const params = new URLSearchParams({
    find_desc: query,
    find_loc: location,
    start: String(start),
    sortby,
  });
  const url = `${YELP_BASE}/search?${params}`;

  const { html } = await loadPageWithInterception(url, 12000);

  // Check for WAF block
  if (html.includes('captcha-delivery.com') || html.includes('Please enable JS and disable any ad blocker')) {
    throw new Error('WAF_BLOCKED: DataDome captcha detected. Try again later.');
  }

  const props = extractReactRootProps(html);
  if (!props) throw new Error('Could not extract page data from search results');

  const searchApp = props?.legacyProps?.searchAppProps;
  if (!searchApp) throw new Error('searchAppProps not found in page data');

  const mainContent = searchApp?.searchPageProps?.mainContentComponentsListProps || [];
  const searchContext = searchApp?.searchPageProps?.searchContext || {};

  // Filter for actual business results
  const businessItems = mainContent.filter(item =>
    item.bizId && item.searchResultBusiness
  );

  if (limit) businessItems.splice(limit);

  const businesses = businessItems.map((item, idx) => {
    const b = item.searchResultBusiness;
    return {
      ranking: item.ranking || (start + idx + 1),
      bizId: item.bizId,
      alias: b.alias,
      name: b.name,
      url: b.alias ? `${YELP_BASE}/biz/${b.alias}` : null,
      rating: b.rating,
      reviewCount: b.reviewCount,
      phone: b.phone || null,
      priceRange: b.priceRange || null,
      categories: b.categories?.map(c => c.title) || [],
      neighborhoods: b.neighborhoods || [],
      isAd: b.isAd || false,
    };
  });

  return {
    query,
    location,
    start,
    sortby,
    totalFound: businesses.length,
    businesses,
    searchContext: {
      totalResults: searchContext?.totalResults,
      searchQuery: searchContext?.searchQuery,
    },
  };
}

// ---------------------------------------------------------------------------
// Business Details
// ---------------------------------------------------------------------------

async function getBusinessDetails(aliasOrEncId) {
  // Aliases contain hyphens (like "gary-danko-san-francisco")
  // Encids are base64-like without hyphens (like "WavvLdfdP6g8aZTtbBQHTw")
  const isEncId = /^[A-Za-z0-9_]{20,25}$/.test(aliasOrEncId);
  const bizUrl = isEncId
    ? `${YELP_BASE}/biz_id/${aliasOrEncId}`
    : `${YELP_BASE}/biz/${aliasOrEncId}`;

  const { html, apiResponses } = await loadPageWithInterception(bizUrl, 20000);

  if (html.includes('captcha-delivery.com')) {
    throw new Error('WAF_BLOCKED: DataDome captcha detected.');
  }

  // Extract Apollo cache
  const cache = extractApolloCache(html);
  if (!cache) throw new Error('Could not extract Apollo cache from business page');

  // Find the business key
  const bizKeys = Object.keys(cache).filter(k => k.startsWith('Business:') && k.length > 20);
  if (!bizKeys.length) throw new Error('No business found in Apollo cache');

  const bizKey = bizKeys[0];
  const encid = bizKey.replace('Business:', '');
  const biz = cache[bizKey];

  // Resolve nested refs
  const phone = resolveRef(cache, biz.phoneNumber);
  const location = resolveRef(cache, biz.location);
  const address = location?.address || {};

  const categories = (biz.categories || []).map(ref => {
    const cat = resolveRef(cache, ref);
    return { title: cat?.title, alias: cat?.alias };
  }).filter(c => c.title);

  const hours = resolveRef(cache, biz.operationHours);
  const currentHours = hours?.regularHoursMergedWithSpecialHoursForCurrentDay;

  // Check GQL responses for more data
  let gqlData = {};
  for (const resp of Object.values(apiResponses)) {
    if (resp.url?.includes('/gql') && resp.body) {
      try {
        const parsed = JSON.parse(resp.body);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item?.data?.business) {
              Object.assign(gqlData, item.data.business);
            }
          }
        }
      } catch {}
    }
  }

  return {
    encid,
    alias: biz.alias || aliasOrEncId,
    name: biz.name,
    url: `${YELP_BASE}/biz/${biz.alias || aliasOrEncId}`,
    rating: biz['rating({"roundingMethod":"NEAREST_TENTH"})'] || gqlData.rating || null,
    reviewCount: biz.reviewCount || gqlData.reviewCount || null,
    phone: phone?.formatted || null,
    priceRange: null, // from GQL
    categories,
    address: {
      street: address.addressLine1 || '',
      city: address.city || '',
      state: address.regionCode || '',
      zip: address.postalCode || '',
      formatted: address.formatted || `${address.addressLine1}, ${address.city}, ${address.regionCode} ${address.postalCode}`,
    },
    hours: currentHours ? {
      today: currentHours.hours,
      isOpenNow: currentHours.isCurrentlyOpen,
      hasSpecialHours: currentHours.hasSpecialHours,
    } : null,
    isClosed: biz.isClosed || false,
    neighborhoods: (location?.neighborhoods || []).map(n =>
      n.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    ),
    // Additional from GQL
    ...(gqlData.priceRange ? { priceRange: gqlData.priceRange?.display } : {}),
    ...(gqlData.primaryPhoto ? { photoUrl: gqlData.primaryPhoto?.photoUrl?.url } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

async function getReviews(aliasOrEncId, { maxPages = 1, sortBy = 'RELEVANCE_DESC', ratings = [5,4,3,2,1] } = {}) {
  // First get the business to get encid
  log('Getting business encid...');
  const details = await getBusinessDetails(aliasOrEncId);
  const encid = details.encid;

  log(`Business: ${details.name} (${encid})`);
  log(`Fetching reviews (${maxPages} page(s), sort: ${sortBy})...`);

  const allReviews = [];
  let afterCursor = null;
  let pageNum = 0;
  let pagesCompleted = 0;
  let totalCount = null;

  // We need to load the business page and use the GQL batch endpoint from within it
  // The GQL endpoint requires same-origin fetch with Yelp cookies
  const tab = await createCdpTab();
  const { send, on, close } = await connectCdp(tab.webSocketDebuggerUrl);

  try {
    await send('Network.enable', { maxPostDataSize: 200000 });
    await send('Page.enable', {});

    // Navigate to business page to set up cookies and context
    log(`Loading business page for cookie context...`);
    await send('Page.navigate', { url: `${YELP_BASE}/biz/${aliasOrEncId}` });
    await sleep(15000);

    // Capture any GQL responses during load (includes first page of reviews)
    // Then use fetch() from page context for pagination

    while (pageNum < maxPages) {
      log(`Fetching reviews page ${pageNum + 1}/${maxPages}...`);

      const variables = {
        eliteAllStarSourceFlow: 'biz_page_review_feed',
        fetchMediaReviewContent: false,
        encBizId: encid,
        reviewsPerPage: 10,
        selectedReviewEncId: '',
        hasSelectedReview: false,
        sortBy,
        ratings,
        queryText: '',
        isSearching: false,
        after: afterCursor,
        isTranslating: false,
        translateLanguageCode: 'en',
        reactionsSourceFlow: 'businessPageReviewSection',
        guv: '452D33287CA9D322',
        minConfidenceLevel: 'HIGH_CONFIDENCE',
        highlightType: '',
        highlightIdentifier: '',
        isHighlighting: false,
        shouldFetchAddress: true,
      };

      const gqlBody = JSON.stringify([{
        operationName: 'GetBusinessReviewFeed',
        variables,
        extensions: {
          operationType: 'query',
          documentId: GQL_DOC_IDS.GetBusinessReviewFeed,
        },
      }]);

      // Execute fetch from page context (same origin = bypasses DataDome)
      const fetchResult = await send('Runtime.evaluate', {
        expression: `
          fetch('/gql/batch', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'x-yelp-csrf': document.cookie.match(/csrf_token=([^;]+)/)?.[1] || '',
            },
            body: ${JSON.stringify(gqlBody)}
          }).then(r => r.text()).catch(e => JSON.stringify({ error: e.message }))
        `,
        returnByValue: true,
        awaitPromise: true,
        timeout: 30000,
      });

      const responseText = fetchResult.result?.value || '';

      if (responseText.startsWith('Error') || responseText.includes('"error"')) {
        log(`GQL fetch error on page ${pageNum + 1}: ${responseText.substring(0, 200)}`);
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        log(`Failed to parse GQL response: ${responseText.substring(0, 200)}`);
        break;
      }

      // Handle WAF block
      if (typeof parsed === 'string' && parsed.includes('captcha')) {
        throw new Error('WAF_BLOCKED: DataDome blocked GQL request');
      }

      const reviewData = Array.isArray(parsed)
        ? parsed.find(r => r?.data?.business?.reviews)?.data?.business?.reviews
        : parsed?.data?.business?.reviews;

      if (!reviewData) {
        log('No review data in response');
        break;
      }

      if (totalCount === null) totalCount = reviewData.totalCount;

      const edges = reviewData.edges || [];
      log(`  Got ${edges.length} reviews`);
      pagesCompleted++;

      for (const edge of edges) {
        const node = edge.node;
        if (!node) continue;
        allReviews.push({
          encid: node.encid,
          rating: node.rating,
          text: node.text?.full || '',
          language: node.text?.language || 'en',
          author: {
            encid: node.author?.encid,
            displayName: node.author?.displayName,
            location: node.author?.displayLocation,
            reviewCount: node.author?.reviewCount,
            isElite: !!node.author?.currentTruncatedEliteYear,
          },
          createdAt: node.createdAt?.localDateTimeForBusiness,
          photoCount: node.businessPhotos?.length || 0,
        });
      }

      const pageInfo = reviewData.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;

      afterCursor = pageInfo.endCursor;
      pageNum++;

      if (pageNum < maxPages) await sleep(2000);
    }

  } finally {
    close();
    await closeCdpTab(tab.id);
  }

  return {
    business: {
      encid,
      alias: details.alias,
      name: details.name,
      rating: details.rating,
      totalReviewCount: totalCount || details.reviewCount,
    },
    sortBy,
    pagesScraped: pagesCompleted,
    reviewsReturned: allReviews.length,
    reviews: allReviews,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  // Check CDP is available
  try {
    execSync(`curl -s http://${CDP_HOST}:${CDP_PORT}/json/version`, { encoding: 'utf8', timeout: 3000 });
  } catch {
    console.error(`CDP not available at ${CDP_HOST}:${CDP_PORT}.`);
    console.error('Start Chrome with: --remote-debugging-port=9333');
    console.error('Or set CDP_PORT and CDP_HOST environment variables.');
    process.exit(1);
  }

  // Check for ws module
  try { await import('ws'); } catch {
    console.error('Missing dependency: npm install ws');
    process.exit(1);
  }

  const [,, command, ...args] = process.argv;
  const { flags, positional } = parseFlags(args);

  ensureDir(CACHE_DIR);

  switch (command) {
    case 'search': {
      const query = positional[0];
      const location = positional[1];
      if (!query || !location) {
        console.error('Usage: node business-scraper.mjs search <query> <location> [--start=0] [--sortby=best_match]');
        process.exit(1);
      }
      const result = await searchBusinesses({
        query, location,
        start: parseInt(flags.start || '0'),
        sortby: flags.sortby || 'best_match',
        limit: flags.limit ? parseInt(flags.limit) : null,
      });
      const outFile = resolve(CACHE_DIR, `search-${Date.now()}.json`);
      saveJson(outFile, result);
      console.log(JSON.stringify(result, null, 2));
      log(`Saved to: ${outFile}`);
      break;
    }

    case 'get': {
      const alias = positional[0];
      if (!alias) {
        console.error('Usage: node business-scraper.mjs get <business-alias>');
        process.exit(1);
      }
      const result = await getBusinessDetails(alias);
      const outFile = resolve(CACHE_DIR, `biz-${alias}.json`);
      saveJson(outFile, result);
      console.log(JSON.stringify(result, null, 2));
      log(`Saved to: ${outFile}`);
      break;
    }

    case 'reviews': {
      const alias = positional[0];
      if (!alias) {
        console.error('Usage: node business-scraper.mjs reviews <business-alias> [--pages=1] [--sort=RELEVANCE_DESC]');
        process.exit(1);
      }
      const result = await getReviews(alias, {
        maxPages: parseInt(flags.pages || '1'),
        sortBy: flags.sort || 'RELEVANCE_DESC',
      });
      const outFile = resolve(CACHE_DIR, `reviews-${alias}.json`);
      saveJson(outFile, result);
      console.log(JSON.stringify(result, null, 2));
      log(`Saved to: ${outFile}`);
      break;
    }

    default: {
      console.log(`Yelp Business Scraper

Uses Chrome CDP to bypass DataDome WAF and scrape Yelp data.

Commands:
  search <query> <location>           Search for businesses
  get <business-alias>                Get full business details  
  reviews <business-alias>            Get business reviews

Options (search):
  --start=N         Pagination offset (default: 0, step: 10)
  --sortby=S        Sort: best_match, rating, review_count, distance
  --limit=N         Max results to return

Options (reviews):
  --pages=N         Number of pages to scrape (10 reviews/page, default: 1)
  --sort=S          Sort: RELEVANCE_DESC, DATE_DESC, RATING_ASC, RATING_DESC

Environment:
  CDP_PORT          CDP port (default: 9333)
  CDP_HOST          CDP host (default: 127.0.0.1)

Examples:
  node business-scraper.mjs search "restaurants" "San Francisco, CA"
  node business-scraper.mjs search "pizza" "NYC" --sortby=rating --start=10
  node business-scraper.mjs get gary-danko-san-francisco
  node business-scraper.mjs reviews gary-danko-san-francisco --pages=3
`);
    }
  }
}

main().catch(err => {
  if (err.message?.includes('WAF_BLOCKED')) {
    console.error('WAF BLOCKED:', err.message);
    console.error('Yelp DataDome detected bot-like behavior. Retry after a few minutes.');
    process.exit(2);
  }
  console.error('Error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
