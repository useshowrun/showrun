#!/usr/bin/env node
// seekingalpha-market.mjs — Market indices, movers, trending stocks, ETF tables, top yields & ratings
//
// Setup:   node seekingalpha-market.mjs auth
// Usage:   node seekingalpha-market.mjs indices
//          node seekingalpha-market.mjs movers
//          node seekingalpha-market.mjs trending
//          node seekingalpha-market.mjs top-yielding
//          node seekingalpha-market.mjs top-rated --cap=large
//          node seekingalpha-market.mjs tables
//          node seekingalpha-market.mjs tables sectors
//          node seekingalpha-market.mjs tables crypto
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-market');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}
function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

function findCdpScript() {
  const here = dirname(new URL(import.meta.url).pathname);
  const ancestorCandidates = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    ancestorCandidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    ancestorCandidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  const candidates = [
    process.env.SHOWRUN_ROOT ? resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs') : null,
    ...ancestorCandidates,
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
  ].filter(Boolean);
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.'); })();
}
function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Seeking Alpha tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('seekingalpha.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No Seeking Alpha tab found. Open seekingalpha.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://seekingalpha.com'] }));
  const { cookies } = JSON.parse(raw);

  // Build full cookie string — PerimeterX cookies are needed
  const cookieStr = cookies
    .filter(c => c.domain.includes('seekingalpha.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to Seeking Alpha?');

  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const userCookieKey = cookieMap['user_cookie_key'] || null;
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints may not work.');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userCookieKey,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node seekingalpha-market.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node seekingalpha-market.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function buildIncludedLookup(data) {
  const lookup = {};
  for (const inc of (data.included || [])) {
    lookup[`${inc.type}:${inc.id}`] = inc;
  }
  return lookup;
}

/**
 * Batch-fetch price and fundamental data from the symbol_data endpoint.
 * Returns a Map of uppercase slug -> { price, marketCap, divYield, eps }.
 * Silently returns empty data for slugs that fail (e.g. indices).
 */
async function fetchSymbolData(auth, slugs, fields = ['price', 'marketCap', 'divYield', 'eps']) {
  const result = new Map();
  if (!slugs.length) return result;

  // API supports batch requests; chunk to avoid overly long URLs
  const CHUNK = 30;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const batch = slugs.slice(i, i + CHUNK);
    const slugParams = batch.map(s => `slugs%5B%5D=${encodeURIComponent(s)}`).join('&');
    const fieldParams = fields.map(f => `fields%5B%5D=${encodeURIComponent(f)}`).join('&');
    const url = `${API_BASE}/symbol_data?${slugParams}&${fieldParams}`;
    try {
      const { data } = await apiFetch(auth, url);
      for (const item of (data.data || [])) {
        result.set(item.id.toUpperCase(), item.attributes || {});
      }
    } catch {
      // Silently skip on error (e.g. 403, 404)
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// API: Global Market Indices
// ---------------------------------------------------------------------------

async function fetchIndices(auth) {
  console.log('Fetching global market indices...');
  const url = `${API_BASE}/global_indices?include=tickers`;
  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  // Collect all ticker slugs so we can batch-fetch prices
  const allSlugs = [];
  const slugById = {};
  for (const item of (data.data || [])) {
    for (const ref of (item.relationships?.tickers?.data || [])) {
      const inc = included[`${ref.type}:${ref.id}`];
      if (inc) {
        const slug = (inc.attributes?.slug || inc.attributes?.name || '').toLowerCase();
        if (slug) {
          allSlugs.push(slug);
          slugById[ref.id] = slug;
        }
      }
    }
  }

  // Fetch price data for all index tickers (some may return null for indices)
  const priceData = await fetchSymbolData(auth, allSlugs);

  const indices = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const tickerRefs = item.relationships?.tickers?.data || [];
    const tickers = tickerRefs.map(ref => {
      const inc = included[`${ref.type}:${ref.id}`];
      if (!inc) return null;
      const ta = inc.attributes || {};
      const slug = (ta.slug || ta.name || '').toLowerCase();
      const pd = priceData.get(slug.toUpperCase()) || {};
      return {
        id: inc.id,
        slug: ta.slug || ta.name || '',
        name: ta.company || ta.name || '',
        price: pd.price ?? null,
        marketCap: pd.marketCap ?? null,
      };
    }).filter(Boolean);

    return {
      id: item.id,
      name: attrs.name || attrs.title || '',
      slug: attrs.slug || '',
      tickers,
    };
  });

  // Also capture market status from meta
  const marketStatus = data.meta?.marketData || null;

  const result = { command: 'indices', count: indices.length, marketStatus, indices };

  const cacheFile = resolve(CACHE_DIR, 'indices.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Day Watch — Top Movers (Gainers / Losers)
// ---------------------------------------------------------------------------

async function fetchMovers(auth) {
  console.log('Fetching top day movers...');
  const url = `${API_BASE}/day_watch?sort=ext_percent_change`;
  const { data } = await apiFetch(auth, url);

  // day_watch returns a single object: data.data.attributes has keyed arrays
  const attrs = data.data?.attributes || {};
  const topGainers = attrs.top_gainers || [];
  const topLosers = attrs.top_losers || [];
  const mostActive = attrs.most_active || [];
  const cryptos = attrs.cryptocurrencies || [];
  const sp500Gainers = attrs.sp500_gainers || [];
  const sp500Losers = attrs.sp500_losers || [];

  // Collect all slugs for price enrichment
  const allItems = [...topGainers, ...topLosers, ...mostActive, ...cryptos, ...sp500Gainers, ...sp500Losers];
  const allSlugs = [...new Set(allItems.map(i => (i.slug || '').toLowerCase()).filter(Boolean))];
  const priceData = await fetchSymbolData(auth, allSlugs);

  function enrichList(items) {
    return items.map(item => {
      const pd = priceData.get((item.slug || '').toUpperCase()) || {};
      return {
        id: item.id,
        slug: item.slug || '',
        name: item.name || '',
        price: pd.price ?? null,
        marketCap: pd.marketCap ?? null,
        divYield: pd.divYield ?? null,
      };
    });
  }

  const result = {
    command: 'movers',
    gainers: { count: topGainers.length, stocks: enrichList(topGainers) },
    losers: { count: topLosers.length, stocks: enrichList(topLosers) },
    mostActive: { count: mostActive.length, stocks: enrichList(mostActive) },
    cryptocurrencies: { count: cryptos.length, stocks: enrichList(cryptos) },
    sp500Gainers: { count: sp500Gainers.length, stocks: enrichList(sp500Gainers) },
    sp500Losers: { count: sp500Losers.length, stocks: enrichList(sp500Losers) },
  };

  const cacheFile = resolve(CACHE_DIR, 'movers.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Trending Stocks
// ---------------------------------------------------------------------------

async function fetchTrending(auth) {
  console.log('Fetching trending stocks...');
  const url = `${API_BASE}/homepage_cards/trending_stocks`;
  const { data } = await apiFetch(auth, url);

  // trending_stocks returns a plain array (not JSONAPI)
  const items = Array.isArray(data) ? data : [];

  // Enrich with price data
  const slugs = items.map(i => (i.slug || '').toLowerCase()).filter(Boolean);
  const priceData = await fetchSymbolData(auth, slugs);

  const stocks = items.map(item => {
    const pd = priceData.get((item.slug || item.name || '').toUpperCase()) || {};
    return {
      id: item.id,
      slug: item.slug || '',
      name: item.company_name || item.name || '',
      price: pd.price ?? null,
      marketCap: pd.marketCap ?? null,
      divYield: pd.divYield ?? null,
    };
  });

  const result = { command: 'trending', count: stocks.length, stocks };

  const cacheFile = resolve(CACHE_DIR, 'trending.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top Dividend Yielding Stocks
// ---------------------------------------------------------------------------

async function fetchTopYielding(auth) {
  console.log('Fetching top dividend yielding stocks...');
  const url = `${API_BASE}/homepage_cards/top_yielding_tickers?per_group=10`;
  const { data } = await apiFetch(auth, url);

  // top_yielding_tickers returns { sp500: [...], cap400: [...], cap600: [...] }
  // Each item has: slug, name, company_name, div_yield_fwd
  const groups = {};

  // Collect all slugs across all groups for price enrichment
  const allSlugs = [];
  for (const [groupName, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const slug = (item.slug || '').toLowerCase();
      if (slug) allSlugs.push(slug);
    }
  }
  const priceData = await fetchSymbolData(auth, [...new Set(allSlugs)]);

  for (const [groupName, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    groups[groupName] = items.map(item => {
      const pd = priceData.get((item.slug || item.name || '').toUpperCase()) || {};
      return {
        slug: item.slug || '',
        name: item.company_name || item.name || '',
        dividendYield: item.div_yield_fwd ?? null,
        price: pd.price ?? null,
        marketCap: pd.marketCap ?? null,
      };
    });
  }

  const totalCount = Object.values(groups).reduce((sum, g) => sum + g.length, 0);
  const result = { command: 'top-yielding', totalCount, groups };

  const cacheFile = resolve(CACHE_DIR, 'top-yielding.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top-Rated Stocks by Market Cap
// ---------------------------------------------------------------------------

async function fetchTopRated(auth, cap = 'large') {
  const validCaps = ['large', 'mid', 'small'];
  const capKey = validCaps.includes(cap) ? cap : 'large';
  const capValue = `${capKey}_cap`;

  console.log(`Fetching top-rated stocks (${capKey} cap)...`);
  const url = `${API_BASE}/homepage_cards/latest_ratings_by_marketcap?` + [
    `filters[market_caps][]=${capValue}`,
    'filters[metrics][]=quant_rating',
    'per_group=10',
  ].join('&');

  const { data } = await apiFetch(auth, url);

  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  const included = data.included || [];

  // Build metric_type lookup: id -> field name
  const metricTypeMap = {};
  for (const inc of included) {
    if (inc.type === 'metric_type') {
      metricTypeMap[inc.id] = inc.attributes?.field || '';
    }
  }

  // Build metric lookup: "[tickerId, metricTypeId]" -> value
  const metricsByTicker = {};
  for (const inc of included) {
    if (inc.type === 'metric') {
      const mtId = inc.relationships?.metric_type?.data?.id;
      const fieldName = metricTypeMap[mtId] || '';
      // Parse the composite id "[tickerId, metricTypeId]"
      const match = inc.id.match(/\[(\d+),\s*(\d+)\]/);
      if (match) {
        const tickerId = match[1];
        if (!metricsByTicker[tickerId]) metricsByTicker[tickerId] = {};
        metricsByTicker[tickerId][fieldName] = inc.attributes?.value ?? null;
      }
    }
  }

  // Build tickerChanges lookup: tickerId -> latest change info
  const changesByTicker = {};
  for (const inc of included) {
    if (inc.type === 'tickerChanges') {
      const tickerId = String(inc.attributes?.tickerId || '');
      if (tickerId) {
        changesByTicker[tickerId] = {
          newRating: inc.attributes?.newRating ?? null,
          previousRating: inc.attributes?.previousRating ?? null,
          ratingScore: inc.attributes?.ratingNew ?? null,
          previousScore: inc.attributes?.ratingPrevious ?? null,
          changedAt: inc.attributes?.createdAt ?? null,
        };
      }
    }
  }

  // Enrich with price data
  const slugs = items.map(i => (i.attributes?.slug || '').toLowerCase()).filter(Boolean);
  const priceData = await fetchSymbolData(auth, slugs);

  const stocks = items.map(item => {
    const attrs = item.attributes || {};
    const metrics = metricsByTicker[item.id] || {};
    const changes = changesByTicker[item.id] || {};
    const pd = priceData.get((attrs.slug || attrs.name || '').toUpperCase()) || {};
    return {
      id: item.id,
      slug: attrs.slug || attrs.name || '',
      name: attrs.company || attrs.companyName || '',
      exchange: attrs.exchange || null,
      quantRating: metrics.quant_rating ?? null,
      marketCap: metrics.marketcap_display ?? null,
      ratingLabel: changes.newRating ?? null,
      ratingScore: changes.ratingScore ?? null,
      previousRating: changes.previousRating ?? null,
      changedAt: changes.changedAt ?? null,
      price: pd.price ?? null,
    };
  });

  const result = { command: 'top-rated', cap: capKey, count: stocks.length, stocks };

  const cacheFile = resolve(CACHE_DIR, `top-rated-${capKey}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: ETF Performance Tables (Market Data categories)
// ---------------------------------------------------------------------------

// Alias map: short/friendly names -> canonical API slugs
const TABLE_ALIASES = {
  key_markets: 'key_markets',
  key: 'key_markets',
  bonds: 'bonds',
  bond: 'bonds',
  commodities: 'commodities',
  commodity: 'commodities',
  countries: 'countries',
  country: 'countries',
  currencies: 'currencies',
  currency: 'currencies',
  forex: 'currencies',
  fx: 'currencies',
  dividends: 'dividends',
  dividend: 'dividends',
  emerging_markets: 'emerging_markets',
  emerging: 'emerging_markets',
  em: 'emerging_markets',
  global_and_regions: 'global_and_regions',
  global: 'global_and_regions',
  regions: 'global_and_regions',
  growth_vs_value: 'growth_vs_value',
  growth: 'growth_vs_value',
  value: 'growth_vs_value',
  market_cap: 'market_cap',
  cap: 'market_cap',
  real_estate: 'real_estate',
  realestate: 'real_estate',
  reit: 'real_estate',
  sectors: 'sectors',
  sector: 'sectors',
  strategies: 'strategies',
  strategy: 'strategies',
  smart_beta: 'smart_beta',
  beta: 'smart_beta',
  themes_and_subsectors: 'themes_and_subsectors',
  themes: 'themes_and_subsectors',
  subsectors: 'themes_and_subsectors',
  cryptocurrency: 'cryptocurrency',
  crypto: 'cryptocurrency',
  dividend_aristocrats: 'dividend_aristocrats',
  aristocrats: 'dividend_aristocrats',
  dividend_champions: 'dividend_champions',
  champions: 'dividend_champions',
};

function resolveTableSlug(input) {
  if (!input) return null;
  const key = input.toLowerCase().replace(/[-\s]+/g, '_');
  return TABLE_ALIASES[key] || null;
}

async function fetchTableCategories(auth) {
  console.log('Fetching ETF performance table categories...');
  const url = `${API_BASE}/etf_performance_categories`;
  const { data } = await apiFetch(auth, url);

  const categories = (data.data || []).map(item => ({
    id: item.id,
    name: item.attributes?.name || '',
    slug: item.attributes?.slug || '',
  }));

  const result = { command: 'tables', count: categories.length, categories };

  const cacheFile = resolve(CACHE_DIR, 'tables-categories.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

async function fetchTableData(auth, slug) {
  console.log(`Fetching ETF table: ${slug}...`);
  const url = `${API_BASE}/etf_performance_categories/${slug}`;
  const { data } = await apiFetch(auth, url);

  const included = buildIncludedLookup(data);
  const catAttrs = data.data?.attributes || {};
  const sectionRefs = data.data?.relationships?.sections?.data || [];

  // Collect all ticker slugs across all sections for price enrichment
  const allSlugs = [];
  for (const secRef of sectionRefs) {
    const sec = included[`${secRef.type}:${secRef.id}`];
    if (!sec) continue;
    for (const tRef of (sec.relationships?.tickers?.data || [])) {
      const tag = included[`${tRef.type}:${tRef.id}`];
      if (tag) {
        const s = (tag.attributes?.slug || '').toLowerCase();
        if (s) allSlugs.push(s);
      }
    }
  }

  const priceData = await fetchSymbolData(auth, [...new Set(allSlugs)]);

  // Build sections with their tickers
  const sections = sectionRefs.map(secRef => {
    const sec = included[`${secRef.type}:${secRef.id}`];
    if (!sec) return null;
    const secAttrs = sec.attributes || {};
    const tickerRefs = sec.relationships?.tickers?.data || [];

    const tickers = tickerRefs.map(tRef => {
      const tag = included[`${tRef.type}:${tRef.id}`];
      if (!tag) return null;
      const ta = tag.attributes || {};
      const pd = priceData.get((ta.slug || '').toUpperCase()) || {};
      const ticker = {
        slug: (ta.slug || ta.name || '').toUpperCase(),
        name: ta.company || ta.name || '',
        alias: ta.alias_name || null,
        price: pd.price ?? null,
        marketCap: pd.marketCap ?? null,
        divYield: pd.divYield ?? null,
      };
      // Include forward dividend yield from the API when available (dividends layout)
      if (ta.div_yield_fwd != null) {
        ticker.divYieldFwd = ta.div_yield_fwd;
      }
      // Include sector when available
      if (ta.sector) {
        ticker.sector = ta.sector;
      }
      return ticker;
    }).filter(Boolean);

    return {
      name: secAttrs.name || '',
      layout: secAttrs.layout || 'performance',
      count: tickers.length,
      tickers,
    };
  }).filter(Boolean);

  const totalTickers = sections.reduce((sum, s) => sum + s.count, 0);
  const result = {
    command: 'tables',
    category: catAttrs.name || slug,
    slug,
    totalTickers,
    sections,
  };

  const cacheFile = resolve(CACHE_DIR, `tables-${slug}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] || '';
const { flags, positional } = parseFlags(args.slice(1));

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'indices': {
      const result = await fetchIndices(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'movers': {
      const result = await fetchMovers(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'trending': {
      const result = await fetchTrending(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'top-yielding': {
      const result = await fetchTopYielding(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'top-rated': {
      const cap = flags.cap || 'large';
      const result = await fetchTopRated(getAuth(), cap);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'tables': {
      const categoryArg = positional[0] || '';
      if (!categoryArg) {
        const result = await fetchTableCategories(getAuth());
        console.log(JSON.stringify(result, null, 2));
      } else {
        const slug = resolveTableSlug(categoryArg);
        if (!slug) {
          const allAliases = [...new Set(Object.values(TABLE_ALIASES))];
          console.error(`Unknown category: "${categoryArg}"`);
          console.error(`Available categories: ${allAliases.join(', ')}`);
          console.error(`\nRun: node seekingalpha-market.mjs tables   (to list all categories)`);
          process.exit(1);
        }
        const result = await fetchTableData(getAuth(), slug);
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    default: {
      const script = 'seekingalpha-market.mjs';
      console.log(`
seekingalpha-market — Market indices, movers, trending stocks, ETF tables, top yields & ratings

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} indices                           Global market indices with current values
  node ${script} movers                            Top day movers (gainers & losers)
  node ${script} trending                          Trending stocks
  node ${script} top-yielding                      Top dividend yielding stocks
  node ${script} top-rated [--cap=large|mid|small] Top-rated stocks by market cap
  node ${script} tables                            List ETF table categories
  node ${script} tables <category>                 ETF performance data for a category

Table categories: key_markets, bonds, commodities, countries, currencies, dividends,
  emerging_markets, global, growth_vs_value, market_cap, real_estate, sectors, strategies,
  smart_beta, themes, crypto, dividend_aristocrats, dividend_champions

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
