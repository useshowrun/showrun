#!/usr/bin/env node
// seekingalpha-screener.mjs — Stock/ETF screener for Seeking Alpha
//
// Setup:   node seekingalpha-screener.mjs auth
// Usage:   node seekingalpha-screener.mjs list --type=stock
//          node seekingalpha-screener.mjs run 96793299 --page=1
//          node seekingalpha-screener.mjs filters --type=stock
//          node seekingalpha-screener.mjs top-stocks
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-screener');
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
    console.error('No auth found. Run: node seekingalpha-screener.mjs auth');
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
      console.error('Session expired or blocked. Run: node seekingalpha-screener.mjs auth');
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

// ---------------------------------------------------------------------------
// API: List saved screeners
// ---------------------------------------------------------------------------

async function fetchScreenerList(auth, type = 'stock') {
  console.log(`Fetching saved ${type} screeners...`);
  const url = `${API_BASE}/screeners?type=${encodeURIComponent(type)}`;
  const { data } = await apiFetch(auth, url);

  const screeners = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const meta = item.meta || {};
    const filters = attrs.filters || {};
    return {
      id: item.id,
      name: attrs.name || attrs.title || '',
      type: attrs.category === 'public' ? type : type,
      filtersCount: Array.isArray(filters) ? filters.length : Object.keys(filters).length,
      createdAt: attrs.createdAt || attrs.created_at || null,
      updatedAt: attrs.updatedAt || attrs.updated_at || null,
      resultsCount: meta.results_count ?? null,
      description: attrs.description || '',
    };
  });

  const result = { command: 'list', type, count: screeners.length, screeners };

  const cacheFile = resolve(CACHE_DIR, `screeners-${type}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Get screener config
// ---------------------------------------------------------------------------

async function fetchScreenerConfig(auth, screenerId) {
  console.log(`Fetching screener config for ID ${screenerId}...`);
  const url = `${API_BASE}/screeners/${screenerId}?lang=en`;
  const { data } = await apiFetch(auth, url);

  // The screener config is in data.data.attributes
  const item = data.data || data;
  const attrs = item.attributes || item;

  // filters is an object (not array), columns is "columnOrder" in the API
  const meta = (data.data || data).meta || {};
  return {
    id: item.id || screenerId,
    name: attrs.name || attrs.title || '',
    type: attrs.screener_type || (attrs.category === 'public' ? 'stock' : 'stock'),
    filters: attrs.filters || {},
    sort: attrs.sort || null,
    columns: attrs.columnOrder || attrs.columns || [],
    resultsCount: meta.results_count ?? null,
    rawConfig: attrs,
  };
}

// ---------------------------------------------------------------------------
// API: Run screener (POST screener_results)
// ---------------------------------------------------------------------------

async function runScreener(auth, screenerId, page = 1, perPage = 20) {
  // Step 1: Get the screener config
  const config = await fetchScreenerConfig(auth, screenerId);
  console.log(`Running screener: "${config.name}" (page ${page})...`);

  // Step 2: POST to screener_results with the config as body
  // filters is an object (not array), columns is from columnOrder
  const body = {
    type: config.type || 'stock',
    filters: config.filters || {},
    sort: config.sort || null,
    columns: config.columns || [],
    page: page,
    per_page: perPage,
  };

  const url = `${API_BASE}/screener_results`;
  const { data: resultsData } = await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Parse results — extract ticker slugs and company names
  const resultItems = resultsData.data || resultsData.results || [];
  const tickers = [];

  const stocks = resultItems.map(item => {
    const attrs = item.attributes || item;
    const slug = attrs.slug || attrs.ticker || '';
    if (slug) tickers.push(slug);
    return {
      id: item.id || null,
      slug: slug,
      name: attrs.companyName || attrs.company || attrs.company_name || '',
      exchange: attrs.exchange || '',
    };
  });

  // Step 3: Fetch metrics and grades for result tickers
  // The metrics API returns JSONAPI relational format:
  //   data[]: { id: "[tickerId, metricTypeId]", attributes: { value }, relationships: { metric_type, ticker } }
  //   included[]: metric_type entries with { id, attributes: { field } } and ticker entries with { id, attributes: { slug } }
  let metrics = {};
  let grades = {};

  if (tickers.length > 0) {
    const slugList = tickers.join(',');

    // Fetch key metrics
    const metricFields = [
      'quant_rating', 'authors_rating', 'sell_side_rating',
      'marketcap', 'pe_ratio', 'div_yield_fwd',
      'revenue_growth', 'diluted_eps_growth', 'price_return_1y',
    ].join(',');

    try {
      console.log('Fetching metrics for result tickers...');
      const metricsUrl = `${API_BASE}/metrics?filter[fields]=${metricFields}&filter[slugs]=${slugList}&minified=false`;
      const { data: metricsData } = await apiFetch(auth, metricsUrl);

      // Build lookup maps from included: metric_type id -> field name, ticker id -> slug
      const metricTypeMap = {};
      const tickerIdToSlug = {};
      for (const inc of (metricsData.included || [])) {
        if (inc.type === 'metric_type') metricTypeMap[inc.id] = inc.attributes?.field;
        if (inc.type === 'ticker') tickerIdToSlug[inc.id] = inc.attributes?.slug;
      }

      // Parse metrics: group by ticker slug, keyed by field name
      for (const item of (metricsData.data || [])) {
        const tickerId = item.relationships?.ticker?.data?.id;
        const metricTypeId = item.relationships?.metric_type?.data?.id;
        const slug = tickerIdToSlug[tickerId];
        const field = metricTypeMap[metricTypeId];
        if (slug && field) {
          if (!metrics[slug]) metrics[slug] = {};
          metrics[slug][field] = item.attributes?.value ?? null;
        }
      }
    } catch (e) {
      console.warn(`Warning: Could not fetch metrics: ${e.message}`);
    }

    // Fetch grades (requires filter[algos]=main_quant)
    const gradeFields = [
      'quant_rating', 'authors_rating', 'sell_side_rating',
      'value_category', 'growth_category', 'profitability_category',
      'momentum_category', 'eps_revisions_category',
    ].join(',');

    try {
      console.log('Fetching grades for result tickers...');
      const gradesUrl = `${API_BASE}/ticker_metric_grades?filter[fields]=${gradeFields}&filter[slugs]=${slugList}&filter[algos]=main_quant`;
      const { data: gradesData } = await apiFetch(auth, gradesUrl);

      // Build lookup maps from included
      const gradeTypeMap = {};
      const gradeTickerMap = {};
      for (const inc of (gradesData.included || [])) {
        if (inc.type === 'metric_type') gradeTypeMap[inc.id] = inc.attributes?.field;
        if (inc.type === 'ticker') gradeTickerMap[inc.id] = inc.attributes?.slug;
      }

      // Parse grades: group by ticker slug, keyed by field name
      // Grade values are numeric (1-9), map to letter grades
      const gradeLetters = { 1: 'A+', 2: 'A', 3: 'A-', 4: 'B+', 5: 'B', 6: 'B-', 7: 'C+', 8: 'C', 9: 'C-', 10: 'D+', 11: 'D', 12: 'D-', 13: 'F' };
      for (const item of (gradesData.data || [])) {
        const tickerId = item.relationships?.ticker?.data?.id;
        const metricTypeId = item.relationships?.metric_type?.data?.id;
        const slug = gradeTickerMap[tickerId];
        const field = gradeTypeMap[metricTypeId];
        if (slug && field) {
          if (!grades[slug]) grades[slug] = {};
          const numGrade = item.attributes?.grade;
          grades[slug][field] = gradeLetters[numGrade] || (numGrade ?? null);
        }
      }
    } catch (e) {
      console.warn(`Warning: Could not fetch grades: ${e.message}`);
    }
  }

  // Build enriched results
  const enrichedStocks = stocks.map(s => {
    const m = metrics[s.slug] || {};
    const g = grades[s.slug] || {};
    return {
      ticker: (s.slug || '').toUpperCase(),
      name: s.name || '',
      exchange: s.exchange || '',
      quantRating: m.quant_rating ?? null,
      authorsRating: m.authors_rating ?? null,
      sellSideRating: m.sell_side_rating ?? null,
      marketCap: m.marketcap ?? null,
      peRatio: m.pe_ratio ?? null,
      divYieldFwd: m.div_yield_fwd ?? null,
      revenueGrowth: m.revenue_growth ?? null,
      epsGrowth: m.diluted_eps_growth ?? null,
      priceReturn1y: m.price_return_1y ?? null,
      grades: {
        value: g.value_category ?? null,
        growth: g.growth_category ?? null,
        profitability: g.profitability_category ?? null,
        momentum: g.momentum_category ?? null,
        epsRevisions: g.eps_revisions_category ?? null,
      },
    };
  });

  // Total count from screener config meta (screener_results response has no meta.count)
  const totalCount = config.resultsCount || enrichedStocks.length;

  const result = {
    command: 'run',
    screenerId,
    screenerName: config.name,
    page,
    perPage,
    totalResults: totalCount,
    count: enrichedStocks.length,
    stocks: enrichedStocks,
  };

  const cacheFile = resolve(CACHE_DIR, `screener-${screenerId}-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: List available filter fields
// ---------------------------------------------------------------------------

async function fetchFilters(auth, type = 'stock') {
  console.log(`Fetching available ${type} screener filters...`);
  const url = `${API_BASE}/screener_filters?type=${encodeURIComponent(type)}&variation=show`;
  const { data } = await apiFetch(auth, url);

  // The API returns a plain JSON array of filter groups (not JSONAPI {data: [...]})
  // Each group: { id, label, filters: [{ id, label, type, options, values, ... }] }
  const rawGroups = Array.isArray(data) ? data : (data.data || []);

  const filterGroups = rawGroups.map(group => {
    const filters = (group.filters || []).map(f => ({
      id: f.id,
      label: f.label || f.name || f.id,
      type: f.type || '',
      options: f.options || null,
      values: f.values || null,
      min: f.min ?? null,
      max: f.max ?? null,
    }));
    return {
      id: group.id,
      label: group.label || group.name || group.id,
      filters,
    };
  });

  // Also build a flat list for easy reference
  const allFilters = filterGroups.flatMap(g =>
    g.filters.map(f => ({ ...f, category: g.label }))
  );

  const result = { command: 'filters', type, groupCount: filterGroups.length, totalFilters: allFilters.length, groups: filterGroups, filters: allFilters };

  const cacheFile = resolve(CACHE_DIR, `filters-${type}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top Rated Stocks (built-in screener id 96793299)
// ---------------------------------------------------------------------------

async function fetchTopStocks(auth, page = 1) {
  console.log('Running built-in "Top Rated Stocks" screener...');
  return runScreener(auth, '96793299', page);
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

    case 'list': {
      const type = flags.type || 'stock';
      const result = await fetchScreenerList(getAuth(), type);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'run': {
      const screenerId = positional[0];
      if (!screenerId) {
        console.error('Usage: seekingalpha-screener.mjs run <screenerId> [--page=1]');
        process.exit(1);
      }
      const page = parseInt(flags.page || '1', 10);
      const result = await runScreener(getAuth(), screenerId, page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'filters': {
      const type = flags.type || 'stock';
      const result = await fetchFilters(getAuth(), type);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'top-stocks': {
      const page = parseInt(flags.page || '1', 10);
      const result = await fetchTopStocks(getAuth(), page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-screener.mjs';
      console.log(`
seekingalpha-screener — Stock/ETF screener for Seeking Alpha

Setup:
  node ${script} auth                                Extract cookies from Chrome

Commands:
  node ${script} list [--type=stock|etf]             List saved screeners
  node ${script} run <screenerId> [--page=1]         Run a saved screener
  node ${script} filters [--type=stock]              List available filter fields
  node ${script} top-stocks [--page=1]               Run built-in "Top Rated Stocks" screener

Examples:
  node ${script} list                                List all stock screeners
  node ${script} list --type=etf                     List ETF screeners
  node ${script} run 96793299                        Run screener by ID
  node ${script} run 96793299 --page=2               Page 2 of results
  node ${script} filters                             Show stock filter fields
  node ${script} filters --type=etf                  Show ETF filter fields
  node ${script} top-stocks                          Top rated stocks

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
