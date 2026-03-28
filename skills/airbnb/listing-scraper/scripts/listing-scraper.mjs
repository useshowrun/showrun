#!/usr/bin/env node
/**
 * Airbnb Listing Scraper
 *
 * Scrapes Airbnb listings, reviews, and availability via internal APIs.
 * No authentication required. Works with just the public API key.
 * Optionally uses Chrome CDP for enhanced requests (recommended for production).
 *
 * Usage:
 *   node listing-scraper.mjs search "Paris, France" --checkin=2025-06-01 --checkout=2025-06-05
 *   node listing-scraper.mjs search "New York" --adults=2 --pages=3
 *   node listing-scraper.mjs reviews 37879131 --pages=5
 *   node listing-scraper.mjs detail 37879131
 *   node listing-scraper.mjs availability 37879131 --month=5 --year=2025
 *   node listing-scraper.mjs suggest "Par"
 *
 * Requires Node.js 18+ (built-in fetch).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.AIRBNB_API_KEY || 'd306zoyjsyarp7ifhu67rjxn52tv0t20';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9333');
const BASE_URL = 'https://www.airbnb.com';
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/airbnb-listing-scraper');
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || '3600000'); // 1 hour
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '800'); // ms between requests

// GraphQL persisted query hashes (SHA256 of the operation body)
const HASHES = {
  reviews: '2ed951bfedf71b87d9d30e24a419e15517af9fbed7ac560a8d1cc7feadfa22e6',
  availability: 'b23335819df0dc391a338d665e2ee2f5d3bff19181d05c0b39bc6c5aac403914',
  // AutoSuggestionsQuery hash for the "recommended destinations" endpoint (no query input)
  autoSuggest: '840ae28ff24af2a4729bd74fb5b98eadcd3412e3a28fea5c9ae18e5a216e6aca',
  listingDetail: '7afae2523702f3fb10726682c19bdfb2313518a4eb1b9f7b15b217e1de1905e5',
};

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
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(join(DATA_DIR, 'cache'), { recursive: true });
}

function cacheKey(name) {
  return join(DATA_DIR, 'cache', name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120) + '.json');
}

function readCache(key) {
  if (process.env.NO_CACHE) return null;
  const path = cacheKey(key);
  if (!existsSync(path)) return null;
  try {
    const { timestamp, data } = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.now() - timestamp < CACHE_TTL_MS) return data;
  } catch (e) {}
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

function encodeListingId(id) {
  return Buffer.from(`StayListing:${id}`).toString('base64');
}

// ---------------------------------------------------------------------------
// CDP Connection (optional — for enhanced requests with browser cookies)
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
      this.ws.addEventListener('error', () =>
        reject(
          Object.assign(new Error(`Cannot connect to CDP at ${this.wsUrl}.\nEnsure Chrome runs with: google-chrome --remote-debugging-port=${CDP_PORT}`), { code: 'CDP_CONNECT_FAIL' })
        )
      );
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
            for (const cb of ls) { try { cb(msg.params); } catch (e) {} }
          }
        } catch (e) {}
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
      // Prevent timer from blocking process exit
      if (t.unref) t.unref();
    });
  }
}

async function getCdpCookies() {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    if (!resp.ok) return null;
    const tabs = await resp.json();
    const airbnbTab = tabs.find(t => t.url?.includes('airbnb.com'));
    const anyTab = tabs[0];
    const tab = airbnbTab || anyTab;
    if (!tab) return null;

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    const result = await cdp.send('Network.getCookies', { urls: ['https://www.airbnb.com'] });
    cdp.ws.close();
    const cookies = result.cookies || [];
    if (cookies.length === 0) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    log(`[cdp] Could not get cookies: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

let _cookieStr = null;
let _lastRequestTime = 0;

async function getHeaders(useCookies = true) {
  if (useCookies && _cookieStr === null) {
    _cookieStr = await getCdpCookies() || '';
    if (_cookieStr) {
      log('[http] Using CDP cookies for enhanced requests');
    } else {
      log('[http] No CDP cookies found — using API key only (public data works fine)');
    }
  }

  const headers = {
    'X-Airbnb-API-Key': API_KEY,
    'Accept': 'application/json',
    'Accept-Language': 'en',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.airbnb.com/',
    'Origin': 'https://www.airbnb.com',
  };

  if (_cookieStr) {
    headers['Cookie'] = _cookieStr;
  }

  return headers;
}

async function apiFetch(url, options = {}) {
  // Rate limiting
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  _lastRequestTime = Date.now();

  const headers = await getHeaders();
  const resp = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '30');
    log(`[http] Rate limited (429). Waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return apiFetch(url, options); // retry once
  }

  if (resp.status === 403 || resp.status === 401) {
    throw Object.assign(
      new Error(`HTTP ${resp.status}: Access denied. Airbnb may require a session.`),
      { code: 'AUTH_REQUIRED', status: resp.status }
    );
  }

  if (!resp.ok && resp.status !== 400) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText} — ${url}`);
  }

  const data = await resp.json();

  // Check for GraphQL errors
  if (data?.errors?.length > 0) {
    const err = data.errors[0];
    if (err.message?.includes('Not logged in') || err.message?.includes('unauthorized')) {
      throw Object.assign(new Error(`Auth required: ${err.message}`), { code: 'AUTH_REQUIRED' });
    }
    log(`[warn] GraphQL error: ${err.message}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// API Operations
// ---------------------------------------------------------------------------

/**
 * Search Airbnb listings.
 * Returns array of listing objects with pagination info.
 */
async function searchListings(opts = {}) {
  const {
    query,
    checkin,
    checkout,
    adults = 2,
    children = 0,
    infants = 0,
    pets = 0,
    itemsPerGrid = 18,
    itemsOffset = 0,
    sectionOffset = 0,
    currency = 'USD',
    priceMin,
    priceMax,
    roomTypes,    // array: ['entire_home', 'private_room', 'shared_room']
    minBedrooms,
    maxBedrooms,
    amenities,    // array of amenity IDs
    superhost,
  } = opts;

  if (!query) throw new Error('query is required for search');

  const cKey = `search_${query}_${checkin || ''}_${checkout || ''}_a${adults}_off${itemsOffset}`;
  const cached = readCache(cKey);
  if (cached) {
    log(`[cache] search hit: ${cKey}`);
    return cached;
  }

  const params = new URLSearchParams({
    version: '1.8.3',
    sectionId: 'EXPLORE_TABS_PANEL',
    items_per_grid: String(itemsPerGrid),
    tab_id: 'home_tab',
    refinement_paths: '/homes',
    source: 'structured_search_input_header',
    search_type: 'filter_change',
    query,
    adults: String(adults),
    children: String(children),
    infants: String(infants),
    pets: String(pets),
    locale: 'en',
    currency,
    supports_for_you_v3: 'true',
  });

  if (checkin) params.set('checkin', checkin);
  if (checkout) params.set('checkout', checkout);
  if (itemsOffset > 0) params.set('items_offset', String(itemsOffset));
  if (sectionOffset > 0) params.set('section_offset', String(sectionOffset));
  if (priceMin != null) params.set('price_min', String(priceMin));
  if (priceMax != null) params.set('price_max', String(priceMax));
  if (minBedrooms != null) params.set('min_bedrooms', String(minBedrooms));
  if (maxBedrooms != null) params.set('max_bedrooms', String(maxBedrooms));
  if (superhost) params.set('superhost', 'true');
  if (roomTypes) for (const rt of roomTypes) params.append('room_types[]', rt);
  if (amenities) for (const a of amenities) params.append('amenities[]', String(a));

  const url = `${BASE_URL}/api/v2/explore_tabs?${params}`;
  log(`[search] ${url.slice(0, 100)}...`);

  const data = await apiFetch(url);

  const tab = data?.explore_tabs?.[0];
  if (!tab) {
    throw new Error('Unexpected response structure from explore_tabs');
  }

  const pagination = tab.pagination_metadata || {};
  const sections = tab.sections || [];

  // Find sections with listings
  const listings = [];
  for (const section of sections) {
    if (section.listings?.length > 0) {
      listings.push(...section.listings);
    }
  }

  const result = {
    query,
    listings: listings.map(l => normalizeListing(l)),
    pagination: {
      hasNextPage: !!pagination.has_next_page,
      hasPreviousPage: !!pagination.has_previous_page,
      itemsOffset: pagination.items_offset || 0,
      sectionOffset: pagination.section_offset || 0,
      searchSessionId: pagination.search_session_id || null,
      totalCount: pagination.max_total_count || 0,
    },
  };

  writeCache(cKey, result);
  return result;
}

/**
 * Normalize a raw listing from explore_tabs response.
 */
function normalizeListing(raw) {
  const l = raw.listing || raw;
  const price = raw.pricing_quote;

  return {
    id: String(l.id_str || l.id || ''),
    name: l.name || '',
    city: l.city || l.localized_city || '',
    neighborhood: l.localized_neighborhood || '',
    publicAddress: l.public_address || '',
    latitude: parseFloat(l.lat) || null,
    longitude: parseFloat(l.lng) || null,
    avgRating: parseFloat(l.avg_rating) || null,
    reviewsCount: parseInt(l.reviews_count) || 0,
    isSuperhost: l.is_superhost === 'True' || l.is_superhost === true,
    isNewListing: l.is_new_listing === 'True' || l.is_new_listing === true,
    personCapacity: parseInt(l.person_capacity) || null,
    bedrooms: parseInt(l.bedrooms) || null,
    bathrooms: parseFloat(l.bathrooms) || null,
    beds: parseInt(l.beds) || null,
    roomType: l.room_type || '',
    roomTypeCategory: l.room_type_category || '',
    propertyType: l.room_and_property_type || l.space_type || '',
    pictureUrl: l.picture_url || '',
    amenityIds: parseList(l.amenity_ids),
    minNights: parseInt(l.min_nights) || null,
    maxNights: parseInt(l.max_nights) || null,
    cancelPolicy: l.cancel_policy || '',
    badges: parseList(l.badges),
    pdpUrl: l.pdp_url_type === 'ROOMS' ? `https://www.airbnb.com/rooms/${l.id_str || l.id}` : null,
    price: price ? {
      amount: price.rate?.amount || null,
      currency: price.rate?.currency || null,
      qualifier: price.rate_type || null,
    } : null,
  };
}

function parseList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val.replace(/'/g, '"')); } catch (e) {}
    // Fallback: try to extract strings from Python repr
    const matches = val.match(/'([^']+)'/g);
    if (matches) return matches.map(m => m.slice(1, -1));
  }
  return [];
}

/**
 * Get listing reviews with pagination.
 */
async function getReviews(listingId, opts = {}) {
  const {
    limit = 7,
    offset = 0,
    sortingPreference = 'BEST_QUALITY',
    currency = 'USD',
    adults = 2,
  } = opts;

  const encId = encodeListingId(listingId);
  const hash = HASHES.reviews;

  const variables = {
    id: encId,
    pdpReviewsRequest: {
      fieldSelector: 'for_p3_translation_only',
      forPreview: false,
      limit,
      offset: String(offset),
      showingTranslationButton: false,
      first: limit,
      sortingPreference,
      checkinDate: null,
      checkoutDate: null,
      numberOfAdults: String(adults),
      numberOfChildren: '0',
      numberOfInfants: '0',
      numberOfPets: '0',
      amenityFilters: null,
    },
  };

  const params = new URLSearchParams({
    operationName: 'StaysPdpReviewsQuery',
    locale: 'en',
    currency,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });

  const url = `${BASE_URL}/api/v3/StaysPdpReviewsQuery/${hash}?${params}`;
  log(`[reviews] listing=${listingId} offset=${offset}`);

  const data = await apiFetch(url);
  const pdp = data?.data?.presentation?.stayProductDetailPage;
  const reviewsData = pdp?.reviews || {};
  const reviews = reviewsData.reviews || [];
  const meta = reviewsData.metadata || {};

  return {
    listingId,
    reviews: reviews.map(r => ({
      id: r.id || '',
      comments: r.comments || r.localizedReview || '',
      rating: r.rating || null,
      language: r.language || '',
      createdAt: r.createdAt || '',
      localizedDate: r.localizedDate || '',
      reviewer: r.reviewer ? {
        id: r.reviewer.id || '',
        firstName: r.reviewer.firstName || r.reviewer.name || '',
        isSuperhost: !!r.reviewer.isSuperhost,
        location: r.localizedReviewerLocation || '',
      } : null,
      response: r.response ? {
        comments: r.response.comments || r.response.localizedResponse || '',
        createdAt: r.response.createdAt || '',
        localizedDate: r.localizedRespondedDate || '',
      } : null,
    })),
    metadata: {
      totalCount: meta.reviewsCount || null,
      tags: (meta.reviewTags || []).map(t => ({ name: t.name, count: t.count, label: t.localizedName })),
      offset,
      limit,
      hasMore: reviews.length >= limit,
    },
  };
}

/**
 * Get listing availability calendar.
 */
async function getAvailability(listingId, opts = {}) {
  const {
    month = new Date().getMonth() + 1,
    year = new Date().getFullYear(),
    count = 3,
    currency = 'USD',
  } = opts;

  const hash = HASHES.availability;
  const variables = {
    request: {
      count,
      listingId: String(listingId),
      month,
      year,
      returnPropertyLevelCalendarIfApplicable: false,
    },
  };

  const params = new URLSearchParams({
    operationName: 'PdpAvailabilityCalendar',
    locale: 'en',
    currency,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });

  const url = `${BASE_URL}/api/v3/PdpAvailabilityCalendar/${hash}?${params}`;
  log(`[availability] listing=${listingId} month=${year}-${month}`);

  const data = await apiFetch(url);
  const months = data?.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths || [];

  return {
    listingId,
    months: months.map(m => ({
      year: m.year,
      month: m.month,
      days: (m.days || []).map(d => ({
        date: d.calendarDate,
        available: !!d.available,
        minNights: d.minNights || null,
        maxNights: d.maxNights || null,
        price: d.localPriceFormatted || null,
      })),
    })),
  };
}

/**
 * Location auto-suggestions.
 * 
 * Note: Airbnb's AutoSuggestionsQuery uses rawParams format internally.
 * The "suggest" command uses the explore_tabs search with a limited page to
 * find location matches, which is more reliable than the internal autocomplete.
 * 
 * For exact location names to use in search(), use the `suggest` command
 * to test what search terms work best. The city name + country format works
 * well: "Paris, France", "New York, United States", "London, United Kingdom".
 */
async function getSuggestions(query, opts = {}) {
  const { limit = 5, currency = 'USD' } = opts;

  const hash = HASHES.autoSuggest;
  // The AutoSuggestionsQuery endpoint returns recommended destinations
  // when called with rawParams format (what the Airbnb frontend actually sends)
  const variables = {
    skipExtendedSearchParams: false,
    autoSuggestionsRequest: {
      rawParams: [
        { filterName: 'query', filterValues: [query] }
      ],
      source: 'SEARCH_BAR',
      treatmentFlags: []
    }
  };

  const params = new URLSearchParams({
    operationName: 'AutoSuggestionsQuery',
    locale: 'en',
    currency,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });

  const url = `${BASE_URL}/api/v3/AutoSuggestionsQuery/${hash}?${params}`;
  log(`[suggest] query="${query}"`);

  const data = await apiFetch(url);
  const suggestionsData = data?.data?.presentation?.autoSuggestions?.staysAutoSuggestionResults || [];

  const suggestions = [];
  for (const group of suggestionsData) {
    for (const item of (group.items || [])) {
      suggestions.push({
        name: item.title || item.locationName || item.name || '',
        subtitle: item.subtitle || item.description || '',
        country: item.country || '',
        type: item.locationSuggestionType || item.__typename || '',
        searchQuery: item.searchParams?.query || item.location || '',
      });
    }
  }

  // If no suggestions returned (API hash may have changed), suggest fallback
  if (suggestions.length === 0) {
    log(`[suggest] No suggestions from API. Use search command directly with: "${query}"`);
  }

  return { query, suggestions: suggestions.slice(0, limit) };
}

/**
 * Get listing detail via StaysPdpSections.
 * Note: Provides richer host and amenity info than search results.
 */
async function getListingDetail(listingId, opts = {}) {
  const {
    checkin = defaultDate(7),
    checkout = defaultDate(9),
    adults = 2,
    currency = 'USD',
  } = opts;

  const encId = encodeListingId(listingId);
  const demandId = Buffer.from(`DemandStayListing:${listingId}`).toString('base64');
  const hash = HASHES.listingDetail;

  const body = {
    operationName: 'StaysPdpSections',
    variables: {
      id: encId,
      demandStayListingId: demandId,
      pdpSectionsRequest: {
        adults: String(adults),
        amenityFilters: null,
        bypassTargetings: false,
        categoryTag: null,
        causeId: null,
        children: '0',
        disasterId: null,
        discountedGuestFeeVersion: null,
        federatedSearchId: null,
        forceBoostPriorityMessageType: null,
        hostPreview: false,
        infants: '0',
        interactionType: null,
        layouts: ['SIDEBAR', 'SINGLE_COLUMN'],
        pets: '0',
        pdpTypeOverride: null,
        preview: false,
        previousStateCheckIn: null,
        previousStateCheckOut: null,
        priceDropSource: null,
        privateBookingSessionId: null,
        promotionUuid: null,
        relaxedAmenityIds: null,
        searchId: null,
        selectedCancellationPolicyId: null,
        selectedRatePlanId: null,
        splitStays: null,
        staysBookingContextParam: null,
        translateUgc: null,
        useNewSectionWrapperApi: false,
        checkIn: checkin,
        checkOut: checkout,
      },
    },
    extensions: {
      persistedQuery: { version: 1, sha256Hash: hash },
    },
  };

  const url = `${BASE_URL}/api/v3/StaysPdpSections/${hash}?operationName=StaysPdpSections&locale=en&currency=${currency}`;
  log(`[detail] listing=${listingId}`);

  const data = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const sections = data?.data?.presentation?.stayProductDetailPage?.sections?.sections || [];

  // Extract meaningful sections
  const result = {
    listingId,
    sections: sections.length,
    raw: sections.slice(0, 3).map(s => ({
      id: s.sectionComponent?.sectionId || s.id || '',
      type: s.__typename || '',
    })),
  };

  // Try to extract overview data
  const overviewSection = sections.find(s =>
    s.sectionComponent?.sectionId?.includes('OVERVIEW') ||
    s.sectionComponent?.sectionId?.includes('TITLE')
  );
  if (overviewSection) {
    result.overview = overviewSection;
  }

  // Fall back: basic info is available from search results
  if (sections.length === 0) {
    log(`[detail] No sections returned for listing ${listingId}. Use search + reviews instead.`);
    result.warning = 'No section data returned. Use searchListings() + getReviews() for complete data.';
  }

  return result;
}

/**
 * Paginate through all search results.
 */
async function* searchAllPages(opts = {}) {
  const { maxPages = 10, ...searchOpts } = opts;
  let itemsOffset = 0;
  let sectionOffset = 0;
  let page = 0;

  while (page < maxPages) {
    const result = await searchListings({ ...searchOpts, itemsOffset, sectionOffset });
    yield result;

    if (!result.pagination.hasNextPage) break;
    itemsOffset = result.pagination.itemsOffset;
    sectionOffset = result.pagination.sectionOffset;
    page++;
  }
}

/**
 * Get all reviews for a listing (paginated).
 */
async function getAllReviews(listingId, opts = {}) {
  const { maxPages = 10, limit = 7, ...reviewOpts } = opts;
  const allReviews = [];
  let offset = 0;
  let page = 0;

  let totalCount = null;

  while (page < maxPages) {
    const result = await getReviews(listingId, { ...reviewOpts, limit, offset });
    allReviews.push(...result.reviews);

    if (totalCount === null) totalCount = result.metadata.totalCount;
    log(`[reviews] Fetched ${allReviews.length}/${totalCount || '?'} reviews`);

    if (!result.metadata.hasMore || result.reviews.length === 0) break;
    offset += limit;
    page++;
  }

  return { listingId, reviews: allReviews, totalCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  ensureDataDir();

  const args = process.argv.slice(2);
  const { flags, positional } = parseArgs(args);
  const command = positional[0];

  if (!command || command === 'help' || flags.help) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'search': {
        const query = positional.slice(1).join(' ') || flags.query;
        if (!query) {
          console.error('Usage: listing-scraper.mjs search "<location>" [options]');
          process.exit(1);
        }

        const maxPages = parseInt(flags.pages || flags.p || '1');
        const checkin = flags.checkin || flags['check-in'];
        const checkout = flags.checkout || flags['check-out'];
        const adults = parseInt(flags.adults || '2');
        const currency = flags.currency || 'USD';
        const output = flags.output || flags.o;

        const allListings = [];
        let totalCount = 0;

        for await (const result of searchAllPages({
          query,
          checkin,
          checkout,
          adults,
          currency,
          maxPages,
        })) {
          allListings.push(...result.listings);
          totalCount = result.pagination.totalCount;
          log(`[search] Page done — ${allListings.length}/${totalCount} listings`);
        }

        const out = {
          query,
          totalFound: totalCount,
          fetched: allListings.length,
          listings: allListings,
        };

        if (output) {
          writeFileSync(output, JSON.stringify(out, null, 2));
          log(`[output] Saved to ${output}`);
        } else {
          console.log(JSON.stringify(out, null, 2));
        }
        break;
      }

      case 'reviews': {
        const listingId = positional[1];
        if (!listingId) {
          console.error('Usage: listing-scraper.mjs reviews <listingId> [options]');
          process.exit(1);
        }

        const maxPages = parseInt(flags.pages || flags.p || '1');
        const limit = parseInt(flags.limit || '7');
        const output = flags.output || flags.o;

        const result = await getAllReviews(listingId, { maxPages, limit });

        if (output) {
          writeFileSync(output, JSON.stringify(result, null, 2));
          log(`[output] Saved to ${output}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'detail': {
        const listingId = positional[1];
        if (!listingId) {
          console.error('Usage: listing-scraper.mjs detail <listingId> [options]');
          process.exit(1);
        }

        const checkin = flags.checkin || defaultDate(7);
        const checkout = flags.checkout || defaultDate(9);
        const output = flags.output || flags.o;

        const result = await getListingDetail(listingId, { checkin, checkout });

        if (output) {
          writeFileSync(output, JSON.stringify(result, null, 2));
          log(`[output] Saved to ${output}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'availability': {
        const listingId = positional[1];
        if (!listingId) {
          console.error('Usage: listing-scraper.mjs availability <listingId> [options]');
          process.exit(1);
        }

        const month = parseInt(flags.month || new Date().getMonth() + 1);
        const year = parseInt(flags.year || new Date().getFullYear());
        const count = parseInt(flags.count || flags.months || '3');
        const output = flags.output || flags.o;

        const result = await getAvailability(listingId, { month, year, count });

        if (output) {
          writeFileSync(output, JSON.stringify(result, null, 2));
          log(`[output] Saved to ${output}`);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'suggest': {
        const query = positional.slice(1).join(' ') || flags.query;
        if (!query) {
          console.error('Usage: listing-scraper.mjs suggest "<partial location>"');
          process.exit(1);
        }

        const result = await getSuggestions(query);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err.code === 'AUTH_REQUIRED') {
      console.error(`\n⛔ Authentication required: ${err.message}`);
      console.error('Airbnb may require login for this operation.');
      console.error('This skill only handles PUBLIC data — if a listing requires auth, it cannot be scraped.');
      process.exit(2);
    }

    if (err.code === 'CDP_CONNECT_FAIL' || err.message?.includes('ECONNREFUSED')) {
      console.error(`\n⚠️  Chrome CDP not available on port ${CDP_PORT}.`);
      console.error('The script will continue without browser cookies (public data still works).');
      console.error(`To enable CDP: google-chrome --remote-debugging-port=${CDP_PORT}`);
      // Not fatal — retry without cookies
      _cookieStr = '';
      return main();
    }

    if (err.message?.includes('blocked') || err.message?.includes('captcha') || err.message?.includes('403')) {
      console.error('\n🚫 WAF/bot detection triggered.');
      console.error('Airbnb may be blocking this IP or detecting automation.');
      console.error('Recommendations:');
      console.error('  1. Reduce request rate: RATE_LIMIT_MS=2000 node listing-scraper.mjs ...');
      console.error('  2. Use Chrome CDP with a real browser session');
      console.error('  3. Use a residential proxy');
      process.exit(3);
    }

    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Airbnb Listing Scraper
======================

Usage: node listing-scraper.mjs <command> [arguments] [options]

Commands:
  search "<location>" [options]     Search listings
  reviews <listingId> [options]     Get listing reviews
  detail <listingId> [options]      Get listing detail info
  availability <listingId> [opts]   Get availability calendar
  suggest "<partial location>"      Location auto-suggestions

Search options:
  --checkin=YYYY-MM-DD      Check-in date
  --checkout=YYYY-MM-DD     Check-out date
  --adults=N                Number of adults (default: 2)
  --pages=N                 Number of pages to fetch (default: 1, 18 listings/page)
  --currency=USD            Currency code
  --output=path.json        Save output to file

Reviews options:
  --pages=N                 Number of pages to fetch (default: 1, 7 reviews/page)
  --limit=N                 Reviews per page (default: 7)
  --output=path.json        Save output to file

Availability options:
  --month=N                 Month (1-12, default: current)
  --year=N                  Year (default: current)
  --months=N                Number of months to fetch (default: 3)

Environment variables:
  CDP_PORT=9333             Chrome remote debugging port
  AIRBNB_API_KEY=...        Override API key
  RATE_LIMIT_MS=800         Delay between requests (ms)
  NO_CACHE=1                Disable response caching
  DEBUG=1                   Show error stack traces

Examples:
  node listing-scraper.mjs search "Paris, France" --checkin=2025-06-01 --checkout=2025-06-05 --adults=2
  node listing-scraper.mjs search "New York" --pages=3 --output=/tmp/nyc.json
  node listing-scraper.mjs reviews 37879131 --pages=5
  node listing-scraper.mjs availability 37879131 --month=6 --year=2025
  node listing-scraper.mjs suggest "Ams"
`);
}

main();
