#!/usr/bin/env node

/**
 * Booking.com Hotel Search Skill
 *
 * Uses Chrome CDP (remote debugging) to bypass AWS WAF.
 *
 * Architecture:
 * - Navigates pages via CDP Page.navigate
 * - For GraphQL: intercepts actual browser requests via Network domain
 *   (browser sends proper headers + CSRF token automatically)
 * - Scrapes HTML via Runtime.evaluate
 *
 * Usage:
 *   node hotel-search.mjs search "Amsterdam" --checkin=2025-06-01 --checkout=2025-06-03
 *   node hotel-search.mjs detail nl/hisoestduinen --checkin=2025-06-01 --checkout=2025-06-03
 *   node hotel-search.mjs reviews nl/hisoestduinen --pages=3
 *   node hotel-search.mjs autocomplete "Amsterdam"
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_PORT = parseInt(process.env.CDP_PORT || '9333');
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/booking-com');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const BASE_URL = 'https://www.booking.com';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...v] = arg.slice(2).split('=');
      flags[k] = v.length > 0 ? v.join('=') : true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function cacheKey(name) {
  return join(DATA_DIR, name.replace(/[^a-z0-9._-]/gi, '_') + '.json');
}

function readCache(key) {
  if (process.env.NO_CACHE) return null;
  const path = cacheKey(key);
  if (!existsSync(path)) return null;
  try {
    const { timestamp, data } = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.now() - timestamp < CACHE_TTL_MS) return data;
  } catch(e) {}
  return null;
}

function writeCache(key, data) {
  ensureDataDir();
  writeFileSync(cacheKey(key), JSON.stringify({ timestamp: Date.now(), data }, null, 2));
}

function defaultDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// CDP Connection
// ---------------------------------------------------------------------------

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(
        Object.assign(new Error(`Cannot connect to CDP at ${this.wsUrl}.\nEnsure Chrome is running with: google-chrome --remote-debugging-port=${CDP_PORT}`), { code: 3 })
      ));
      this.ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          } else if (msg.method) {
            const ls = this.eventListeners.get(msg.method) || [];
            for (const cb of ls) { try { cb(msg.params); } catch(e) {} }
          }
        } catch(e) {}
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  on(event, cb) {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, []);
    this.eventListeners.get(event).push(cb);
    return () => {
      const ls = this.eventListeners.get(event) || [];
      this.eventListeners.set(event, ls.filter(c => c !== cb));
    };
  }

  async navigate(url, waitMs = 8000) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
    const r = await this.send('Runtime.evaluate', { expression: 'location.href' });
    return r.result?.value;
  }

  async eval(expr, awaitPromise = false, timeout = 30000) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      timeout,
    });
    return r?.result?.value;
  }

  close() { try { this.ws.close(); } catch(e) {} }
}

async function connectCDP() {
  let tabs;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    tabs = await res.json();
  } catch(e) {
    throw Object.assign(
      new Error(`Cannot reach CDP at port ${CDP_PORT}.\nLaunch Chrome with: google-chrome --remote-debugging-port=${CDP_PORT}`),
      { code: 3 }
    );
  }

  let tab = tabs.find(t => t.type === 'page' && t.url?.includes('booking.com'));
  if (!tab) tab = tabs.find(t => t.type === 'page');
  if (!tab) {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new`);
    tab = await res.json();
  }

  log(`Using tab: ${tab.id} (${tab.url?.substring(0, 60) || 'empty'})`);

  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable', { maxPostDataSize: 2097152 });
  // Input domain needed for Input.insertText and Input.dispatchMouseEvent
  // (No explicit enable needed — Input domain methods work without calling Input.enable)

  // Ensure we're on booking.com for correct session
  if (!tab.url?.includes('booking.com')) {
    log('Navigating to Booking.com...');
    await cdp.navigate(BASE_URL + '/', 5000);
  }

  return cdp;
}

// ---------------------------------------------------------------------------
// GraphQL helpers

/**
 * Extract the data from a GraphQL response.
 * Booking.com may return either a single object {data:...} or batch array [{data:...}].
 */
function gqlData(response) {
  if (!response) return null;
  const entry = Array.isArray(response) ? response[0] : response;
  return entry?.data || null;
}

// ---------------------------------------------------------------------------
// GraphQL via Network Interception
//
// Instead of calling fetch() manually (which fails with 400 because
// we can't replicate booking.com's dynamic CSRF headers), we trigger
// the page's own React code to make the request. We intercept the
// response via CDP Network domain.
// ---------------------------------------------------------------------------

/**
 * Set up a listener for GraphQL responses matching the given operation names.
 * Returns a promise that resolves when all expected operations are received.
 */
function setupGraphQLInterception(cdp, operationNames, timeoutMs = 15000) {
  const expectedOps = new Set(Array.isArray(operationNames) ? operationNames : [operationNames]);
  const results = {};
  const pendingRequests = new Map();
  const pendingResponses = new Map();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // Return partial results if some operations timed out
      resolve(results);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      removeReqListener();
      removeResListener();
      removeFinListener();
    };

    const removeReqListener = cdp.on('Network.requestWillBeSent', (params) => {
      if (!params.request.url.includes('graphql')) return;
      if (!params.request.postData) return;
      try {
        const body = JSON.parse(params.request.postData);
        const ops = Array.isArray(body) ? body : [body];
        for (const op of ops) {
          if (op.operationName && expectedOps.has(op.operationName)) {
            pendingRequests.set(params.requestId, op.operationName);
          }
        }
      } catch(e) {}
    });

    const removeResListener = cdp.on('Network.responseReceived', (params) => {
      if (pendingRequests.has(params.requestId)) {
        pendingResponses.set(params.requestId, { status: params.response.status });
      }
    });

    const removeFinListener = cdp.on('Network.loadingFinished', async (params) => {
      if (!pendingRequests.has(params.requestId)) return;
      const opName = pendingRequests.get(params.requestId);
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
        if (body?.body) {
          try {
            results[opName] = JSON.parse(body.body);
          } catch(e) {
            results[opName] = { raw: body.body };
          }
        }
      } catch(e) {}
      pendingRequests.delete(params.requestId);
      pendingResponses.delete(params.requestId);

      // Check if all expected ops collected
      if (expectedOps.size > 0 && [...expectedOps].every(op => op in results)) {
        cleanup();
        resolve(results);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// AutoComplete — Resolve destination
// ---------------------------------------------------------------------------

async function autocomplete(cdp, query) {
  const cached = readCache(`autocomplete-${query.toLowerCase()}`);
  if (cached) {
    log(`Autocomplete cache hit for "${query}"`);
    return cached;
  }

  log(`Resolving destination: "${query}"...`);

  // Always navigate to homepage fresh — this ensures the search box is clean
  // and prevents autocomplete debounce issues from previous queries
  log('Loading Booking.com homepage...');
  await cdp.navigate(BASE_URL + '/', 4000);

  // Set up interception BEFORE triggering the input
  const interceptionPromise = setupGraphQLInterception(cdp, ['AutoComplete'], 12000);

  // Get input coordinates for CDP Input events
  const inputRectStr = await cdp.eval(`
    (() => {
      const input = document.querySelector('[name="ss"], [data-testid="destination-container"] input');
      if (!input) return null;
      const r = input.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 });
    })()
  `, false);

  if (!inputRectStr) {
    // Try navigating to homepage explicitly
    log('Search input not found, navigating to homepage...');
    await cdp.navigate(BASE_URL + '/', 4000);
    const inputRectStr2 = await cdp.eval(`
      (() => {
        const input = document.querySelector('[name="ss"], [data-testid="destination-container"] input');
        if (!input) return null;
        const r = input.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 });
      })()
    `, false);
    if (!inputRectStr2) {
      throw new Error('Search input not found on Booking.com homepage. Is booking.com accessible?');
    }
    // restart with fresh interception
    const interceptionPromise2 = setupGraphQLInterception(cdp, ['AutoComplete'], 12000);
    const inputRect2 = JSON.parse(inputRectStr2);
    log(`Input found at ${JSON.stringify(inputRect2)}, typing...`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputRect2.x, y: inputRect2.y, button: 'left', clickCount: 3 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputRect2.x, y: inputRect2.y, button: 'left', clickCount: 3 });
    await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(200);
    for (const char of query) {
      await cdp.send('Input.insertText', { text: char });
      await sleep(50);
    }
    const responses2 = await interceptionPromise2;
    if (!responses2.AutoComplete) throw new Error('AutoComplete request not captured after retry.');
    const results2 = gqlData(responses2.AutoComplete)?.autoCompleteSuggestions?.results || [];
    writeCache(`autocomplete-${query.toLowerCase()}`, results2);
    return results2;
  }

  const inputRect = JSON.parse(inputRectStr);
  log(`Input found at (${Math.round(inputRect.x)}, ${Math.round(inputRect.y)}), typing query...`);

  // Click to focus (triple-click selects all existing text)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 3 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputRect.x, y: inputRect.y, button: 'left', clickCount: 3 });
  await sleep(400);

  // Delete existing text (Backspace to clear)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
  await sleep(200);

  // Type the query (char by char to mimic human typing — triggers React's onChange/autocomplete)
  for (const char of query) {
    await cdp.send('Input.insertText', { text: char });
    await sleep(50);
  }

  const responses = await interceptionPromise;

  if (!responses.AutoComplete) {
    throw new Error('AutoComplete request not captured. Ensure booking.com is open in Chrome with CDP enabled.');
  }

  const results = gqlData(responses.AutoComplete)?.autoCompleteSuggestions?.results || [];
  writeCache(`autocomplete-${query.toLowerCase()}`, results);
  return results;
}

// ---------------------------------------------------------------------------
// Hotel Search — Navigate and scrape
// ---------------------------------------------------------------------------

async function searchHotels(cdp, opts) {
  const { query, checkin, checkout, adults = 2, rooms = 1, page = 1, stars } = opts;

  // Step 1: Resolve destination via autocomplete
  const acResults = await autocomplete(cdp, query);
  if (acResults.length === 0) {
    throw new Error(`No destination found for: "${query}"`);
  }

  const dest = acResults[0];
  const destId = dest.destination?.destId;
  const destType = (dest.destination?.destType || 'city').toLowerCase();
  const destLabel = dest.displayInfo?.label || query;

  log(`Destination: ${destLabel} (destId=${destId}, type=${destType})`);

  // Step 2: Build search URL
  let filterStr = '';
  if (stars) {
    const starList = String(stars).split(',');
    filterStr = starList.map(s => `class%3D${s}`).join('%3B');
  }

  const offset = (page - 1) * 25;
  const searchUrl = [
    `${BASE_URL}/searchresults.html`,
    `?ss=${encodeURIComponent(destLabel)}`,
    `&dest_id=${destId}`,
    `&dest_type=${destType}`,
    `&checkin=${checkin}`,
    `&checkout=${checkout}`,
    `&group_adults=${adults}`,
    `&no_rooms=${rooms}`,
    `&group_children=0`,
    `&order=popularity`,
    `&lang=en-us`,
    offset > 0 ? `&offset=${offset}` : '',
    filterStr ? `&nflt=${filterStr}` : '',
  ].filter(Boolean).join('');

  // Set up GraphQL interception before navigation
  // (The search page makes several GraphQL calls including search results)
  const interceptionPromise = setupGraphQLInterception(
    cdp,
    ['SearchResultsDesktopSearch', 'SearchResults', 'FullSearch', 'DmlSearch'],
    12000
  );

  log('Navigating to search results...');
  const finalUrl = await cdp.navigate(searchUrl, 10000);

  // Check for geo-block
  const isGeoBlocked = finalUrl?.includes('index.html') || finalUrl?.includes('errorc_search');
  if (isGeoBlocked) {
    log('⚠️ Geo-IP block detected (redirect to homepage). Using fallback...');
    return await searchHotelsFallback(cdp, { destId, destLabel, destType, checkin, checkout, adults, rooms });
  }

  // Wait for GraphQL responses (might not come if page loaded from cache)
  const gqlResults = await interceptionPromise;
  log(`GraphQL ops captured: ${Object.keys(gqlResults).join(', ') || 'none'}`);

  // Scrape DOM regardless
  const scrapedStr = await cdp.eval(`
    (() => {
      const cards = document.querySelectorAll('[data-testid="property-card"]');
      const hotels = Array.from(cards).map(card => {
        const link = card.querySelector('a[href*="/hotel/"]');
        const url = link?.href || '';
        const match = url.match(/booking\\.com\\/hotel\\/([a-z]{2})\\/([^.?#]+)/);
        const scoreEl = card.querySelector('[data-testid="review-score"]');
        const scoreChildren = scoreEl ? Array.from(scoreEl.children) : [];
        return {
          name: card.querySelector('[data-testid="title"]')?.textContent?.trim() || '',
          url,
          cc1: match?.[1] || '',
          pageName: match?.[2] || '',
          score: parseFloat(scoreChildren[0]?.textContent?.trim() || '0') || null,
          scoreWord: scoreChildren[1]?.textContent?.trim() || '',
          reviewCount: parseInt((card.querySelector('[data-testid="review-score"] + div')?.textContent || '').replace(/\\D/g, '')) || 0,
          priceText: card.querySelector('[data-testid="price-and-discounted-price"]')?.textContent?.trim() || '',
          city: card.querySelector('[data-testid="address"]')?.textContent?.trim() || '',
        };
      });

      const h1 = document.querySelector('h1');
      const totalMatch = (h1?.textContent || document.title).match(/(\\d[\\d,]+)\\s+propert/i);

      return JSON.stringify({
        hotels,
        totalText: h1?.textContent?.trim() || '',
        totalCount: totalMatch ? parseInt(totalMatch[1].replace(/,/g, '')) : null,
        pageUrl: location.href,
      });
    })()
  `, false);

  let scraped;
  try {
    scraped = JSON.parse(scrapedStr);
  } catch(e) {
    throw new Error('Failed to parse search results DOM');
  }

  if (scraped.hotels.length === 0) {
    log('No hotels found in DOM. Trying fallback...');
    return await searchHotelsFallback(cdp, { destId, destLabel, destType, checkin, checkout, adults, rooms });
  }

  return {
    destination: destLabel,
    destId,
    destType,
    checkin,
    checkout,
    page,
    totalResults: scraped.totalCount,
    hotels: scraped.hotels.filter(h => h.name && h.cc1),
    source: 'dom-scrape',
  };
}

async function searchHotelsFallback(cdp, opts) {
  // Fallback: Use GraphQL recommendations as "search results"
  // Triggered by navigating to homepage and capturing the recommendations call
  log('Fetching hotel recommendations as fallback...');

  const interceptionPromise = setupGraphQLInterception(
    cdp,
    ['MvRexWebRecPlatformPropertyCards'],
    12000
  );

  // Navigate to homepage to trigger recommendations
  await cdp.navigate(BASE_URL + '/', 4000);

  const gqlResults = await interceptionPromise;
  const cards = gqlData(gqlResults?.MvRexWebRecPlatformPropertyCards)?.recommendationPlatform?.propertyCards?.cards || [];

  const hotels = cards.map(card => ({
    id: card.id,
    name: card.translatedName,
    pageName: card.pageName,
    cc1: card.cc1,
    url: `${BASE_URL}/hotel/${card.cc1}/${card.pageName}.html`,
    city: card.locationInfo?.translatedCityName || '',
    country: card.locationInfo?.translatedCountryName || '',
    starRating: card.ratingInfo?.value || null,
    reviewScore: card.reviewInfo?.reviewScore || null,
    reviewCount: card.reviewInfo?.reviewsCount || 0,
    reviewText: card.reviewInfo?.reviewTranslatedText || '',
    pricePerNight: card.priceInfo?.displayPrice?.perStay?.roundedValue || null,
    isGenius: card.isGenius || false,
    ufi: card.ufi,
  }));

  return {
    destination: opts.destLabel,
    destId: opts.destId,
    checkin: opts.checkin,
    checkout: opts.checkout,
    totalResults: hotels.length,
    hotels,
    source: 'graphql-recommendations',
    warning: '⚠️ Geo-IP block: search redirected to homepage. Showing homepage hotel recommendations. Results are NOT filtered by destination.',
  };
}

// ---------------------------------------------------------------------------
// Hotel Detail
// ---------------------------------------------------------------------------

async function getHotelDetail(cdp, cc1, pageName, opts = {}) {
  const { checkin, checkout, adults = 2, rooms = 1 } = opts;
  const cacheId = `hotel-${cc1}-${pageName}`;
  const cached = readCache(cacheId);
  if (cached) { log('Returning cached hotel detail...'); return cached; }

  const url = `${BASE_URL}/hotel/${cc1}/${pageName}.html?checkin=${checkin}&checkout=${checkout}&group_adults=${adults}&no_rooms=${rooms}&lang=en-us`;
  log(`Navigating to hotel: ${url.substring(0, 80)}`);

  // Intercept GraphQL calls the hotel page makes automatically
  const interceptionPromise = setupGraphQLInterception(
    cdp,
    ['Facilities', 'PropertyFaq', 'PropertySurroundingsBlockDesktop'],
    15000
  );

  const finalUrl = await cdp.navigate(url, 8000);
  if (!finalUrl?.includes(`/hotel/${cc1}/${pageName}`)) {
    log(`Warning: unexpected URL: ${finalUrl?.substring(0, 80)}`);
  }

  // Extract DOM data
  const domStr = await cdp.eval(`
    (() => {
      const jsonLdEl = document.querySelector('script[type="application/ld+json"]');
      let jsonLd = null;
      try { jsonLd = JSON.parse(jsonLdEl?.textContent || 'null'); } catch(e) {}

      // Extract hotel ID from page scripts
      let hotelId = null;
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        let m;
        m = s.textContent.match(/"hotelId"\\s*:\\s*"?(\\d+)"?/);
        if (m) { hotelId = parseInt(m[1]); break; }
        m = s.textContent.match(/b_hotel_id['"\\s:=]+"?(\\d+)/);
        if (m) { hotelId = parseInt(m[1]); break; }
      }

      return JSON.stringify({
        url: location.href,
        title: document.title,
        jsonLd,
        hotelId,
        twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
        twitterDescription: document.querySelector('meta[name="twitter:description"]')?.getAttribute('content'),
      });
    })()
  `, false);

  let domData;
  try { domData = JSON.parse(domStr); } catch(e) {
    throw new Error('Failed to parse hotel DOM');
  }

  const jsonLd = domData.jsonLd || {};
  const gqlResults = await interceptionPromise;

  log(`Hotel ID: ${domData.hotelId || 'not found'}`);
  log(`GraphQL ops captured: ${Object.keys(gqlResults).join(', ') || 'none'}`);

  // Build facilities from GraphQL response
  const facilitiesGql = gqlData(gqlResults?.Facilities)?.hotelPageByPageName?.propertyDetails?.facilities || [];
  const facilities = facilitiesGql.map(group => ({
    groupId: group.groupId,
    slug: group.slug,
    facilities: (group.instances || []).map(f => ({
      title: f.title,
      subFacilities: (f.subFacilities || []).map(sf => sf.title),
    })),
  }));

  // Build FAQ from GraphQL response
  const faqGql = gqlData(gqlResults?.PropertyFaq)?.landingContent?.propertyFaq?.questions || [];
  const faq = faqGql.map(q => ({ question: q.question, answer: q.answer }));

  // Build surroundings from GraphQL response
  const surroundingsGqlData = gqlData(gqlResults?.PropertySurroundingsBlockDesktop);
  const surroundings = surroundingsGqlData ? parseSurroundings(surroundingsGqlData) : null;

  const result = {
    url: domData.url,
    pageName,
    cc1,
    name: jsonLd.name || domData.title?.replace(/ \(updated prices \d+\)$/, '') || pageName,
    description: jsonLd.description || domData.twitterDescription || null,
    address: {
      streetAddress: jsonLd.address?.streetAddress,
      postalCode: jsonLd.address?.postalCode,
      city: jsonLd.address?.addressLocality,
      region: jsonLd.address?.addressRegion,
      country: jsonLd.address?.addressCountry,
    },
    reviewScore: jsonLd.aggregateRating?.ratingValue || null,
    reviewCount: jsonLd.aggregateRating?.reviewCount || null,
    image: jsonLd.image || domData.twitterImage || null,
    hotelId: domData.hotelId,
    facilities,
    faq,
    surroundings,
  };

  writeCache(cacheId, result);
  return result;
}

function parseSurroundings(data) {
  const result = {};
  const props = data?.propertySurroundings?.surr;
  if (!props) return null;

  if (props.airports) {
    result.airports = props.airports.map(a => ({
      name: a.name,
      distanceKm: a.distanceKm,
      iataCode: a.iataCode,
    }));
  }
  if (props.landmarks) {
    result.landmarks = props.landmarks.slice(0, 10).map(l => ({
      name: l.name,
      distanceM: l.distanceM,
    }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

async function scrapeReviews(cdp, cc1, pageName, opts = {}) {
  const { pages = 1 } = opts;
  const allReviews = [];

  for (let page = 1; page <= pages; page++) {
    const url = `${BASE_URL}/reviews/${cc1}/hotel/${pageName}.html?lang=en-us&page=${page}`;
    log(`Scraping reviews page ${page}/${pages}...`);

    const finalUrl = await cdp.navigate(url, 6000);

    // Check redirect
    if (!finalUrl?.includes('/reviews/')) {
      log(`Reviews page redirected: ${finalUrl?.substring(0, 80)}`);
      break;
    }

    const reviewsStr = await cdp.eval(`
      (() => {
        const items = document.querySelectorAll('.review_item');
        const reviews = Array.from(items).map(item => {
          const stayText = item.querySelector('.review_item_info_tags')?.textContent?.trim() || '';
          const durationMatch = stayText.match(/Stayed\\s+(\\d+)\\s+night/i);
          const scoreText = item.querySelector('.review-score-badge')?.textContent?.trim();

          return {
            date: item.querySelector('.review_item_date')?.textContent?.trim()?.replace(/^Reviewed:\\s*/, '') || null,
            reviewerName: item.querySelector('.reviewer_name')?.textContent?.trim() || null,
            reviewerCountry: item.querySelector('.reviewer_country')?.textContent?.trim() || null,
            score: scoreText ? parseFloat(scoreText) : null,
            scoreWord: item.querySelector('.review_item_header_scoreword')?.textContent?.trim() || null,
            positiveText: item.querySelector('.review_pos')?.textContent?.trim()?.replace(/^\\+\\s*/, '') || null,
            negativeText: item.querySelector('.review_neg')?.textContent?.trim()?.replace(/^-\\s*/, '') || null,
            stayDuration: durationMatch ? durationMatch[1] + ' nights' : null,
            stayInfo: Array.from(item.querySelectorAll('.review_info_tag'))
              .map(t => t.textContent.trim().replace(/^•\\s*/, ''))
              .filter(t => t).slice(0, 4),
          };
        });

        const nextLink = document.querySelector('link[rel="next"]');
        const totalMatch = document.title.match(/^(\\d+)/);

        return JSON.stringify({
          reviews,
          hasNextPage: !!nextLink,
          totalReviews: totalMatch ? parseInt(totalMatch[1]) : null,
        });
      })()
    `, false);

    let pageData;
    try { pageData = JSON.parse(reviewsStr); } catch(e) {
      log(`Failed to parse reviews page ${page}`);
      break;
    }

    log(`  Page ${page}: ${pageData.reviews.length} reviews (total: ${pageData.totalReviews})`);
    allReviews.push(...pageData.reviews);

    if (!pageData.hasNextPage) break;
    if (page < pages) await sleep(2000);
  }

  return allReviews;
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------

function showHelp() {
  console.log(`
Booking.com Hotel Search Skill

USAGE:
  node hotel-search.mjs <command> [options]

COMMANDS:
  search <destination>     Search hotels (requires Chrome CDP)
  detail <cc/pageName>     Get hotel details & facilities
  reviews <cc/pageName>    Scrape guest reviews
  autocomplete <query>     Resolve destination → destId

OPTIONS:
  --checkin=YYYY-MM-DD     Check-in date (default: 7 days from now)
  --checkout=YYYY-MM-DD    Check-out date (default: 9 days from now)
  --adults=N               Number of adults (default: 2)
  --rooms=N                Number of rooms (default: 1)
  --pages=N                Review pages to scrape (default: 1, 24/page)
  --stars=4,5              Star rating filter
  --page=N                 Search results page (default: 1)
  --output=FILE            Write JSON output to file
  --port=N                 CDP port (default: 9333, or $CDP_PORT)
  --no-cache               Skip cached data ($NO_CACHE=1)

EXAMPLES:
  node hotel-search.mjs search "Amsterdam" --checkin=2025-06-01 --checkout=2025-06-03
  node hotel-search.mjs detail nl/hisoestduinen --checkin=2025-06-01 --checkout=2025-06-03
  node hotel-search.mjs reviews nl/hisoestduinen --pages=3 --output=/tmp/reviews.json
  node hotel-search.mjs autocomplete "Paris, France"

PREREQUISITES:
  Chrome with CDP: google-chrome --remote-debugging-port=9333

NOTES:
  - All API calls execute inside Chrome (bypasses AWS WAF)
  - Search results may not work from Turkish/some IPs (geo-block) → fallback activates
  - Hotel detail + reviews work from all IPs
  - Data cached for 1h in ~/.local/share/showrun/data/booking-com/
`);
  process.exit(0);
}

async function main() {
  const [,, command, ...args] = process.argv;
  const { flags, positional } = parseArgs(args);

  if (!command || flags.help || command === 'help' || command === '--help') showHelp();

  // Override CDP port from flag
  if (flags.port) process.env.CDP_PORT = flags.port;

  let cdp;
  try {
    cdp = await connectCDP();
  } catch(e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(e.code || 3);
  }

  try {
    const checkin = flags.checkin || defaultDate(7);
    const checkout = flags.checkout || defaultDate(9);
    const adults = parseInt(flags.adults || '2');
    const rooms = parseInt(flags.rooms || '1');
    const outputFile = flags.output;

    let result;

    switch (command) {
      case 'autocomplete': {
        const query = positional[0];
        if (!query) { console.error('ERROR: query required'); process.exit(1); }
        result = await autocomplete(cdp, query);
        break;
      }

      case 'search': {
        const query = positional[0];
        if (!query) { console.error('ERROR: destination required'); process.exit(1); }
        result = await searchHotels(cdp, {
          query, checkin, checkout, adults, rooms,
          page: parseInt(flags.page || '1'),
          stars: flags.stars || null,
        });
        break;
      }

      case 'detail': {
        const hotelPath = positional[0];
        if (!hotelPath?.includes('/')) {
          console.error('ERROR: hotel path required (e.g., nl/hisoestduinen)');
          process.exit(1);
        }
        const [cc1, ...rest] = hotelPath.split('/');
        const pageName = rest.join('/');
        result = await getHotelDetail(cdp, cc1, pageName, { checkin, checkout, adults, rooms });
        break;
      }

      case 'reviews': {
        const hotelPath = positional[0];
        if (!hotelPath?.includes('/')) {
          console.error('ERROR: hotel path required (e.g., nl/hisoestduinen)');
          process.exit(1);
        }
        const [cc1, ...rest] = hotelPath.split('/');
        const pageName = rest.join('/');
        const reviews = await scrapeReviews(cdp, cc1, pageName, {
          pages: parseInt(flags.pages || '1'),
        });
        result = {
          cc1, pageName,
          reviewCount: reviews.length,
          reviews,
        };
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
    }

    const output = JSON.stringify(result, null, 2);

    if (outputFile) {
      writeFileSync(outputFile, output);
      console.log(`Output written to: ${outputFile}`);
      // Print brief summary to stdout
      if (result?.hotels) console.log(`Found ${result.hotels.length} hotels (total: ${result.totalResults ?? 'N/A'})`);
      if (result?.reviews) console.log(`Scraped ${result.reviews.length} reviews`);
      if (result?.warning) console.warn(`⚠️  ${result.warning}`);
    } else {
      console.log(output);
    }

  } catch(e) {
    console.error(`ERROR: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(e.code || 1);
  } finally {
    cdp.close();
  }
}

main();
