#!/usr/bin/env node
// seekingalpha-portfolio.mjs — User portfolios, holdings, and rating change alerts from Seeking Alpha
//
// Setup:   node seekingalpha-portfolio.mjs auth
// Usage:   node seekingalpha-portfolio.mjs list
//          node seekingalpha-portfolio.mjs view <portfolioId>
//          node seekingalpha-portfolio.mjs alerts
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-portfolio');
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
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}
function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000 }).trim();
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
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints will not work.');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userCookieKey,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`User key: ${userCookieKey || '(not found)'}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node seekingalpha-portfolio.mjs auth');
    process.exit(1);
  }
  return auth;
}

function getUserKey(auth) {
  if (!auth.userCookieKey) {
    console.error('No user_cookie_key in session. Run: node seekingalpha-portfolio.mjs auth');
    process.exit(1);
  }
  return auth.userCookieKey;
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
      console.error('Session expired or blocked. Run: node seekingalpha-portfolio.mjs auth');
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
    // Also index with normalized (snake_case) key so camelCase relationship refs match
    const snake = inc.type.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    if (snake !== inc.type) lookup[`${snake}:${inc.id}`] = inc;
    // And index with camelCase key for snake_case included items
    const camel = inc.type.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== inc.type) lookup[`${camel}:${inc.id}`] = inc;
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// API: List Portfolios
// ---------------------------------------------------------------------------

async function fetchPortfolios(auth) {
  const userKey = getUserKey(auth);
  console.log('Fetching portfolios...');

  const params = [
    'include[]=holdings',
    'include[]=tickers',
    'include[]=views',
    'include[]=group',
    'include[]=tickers.asset_class',
    'include[]=tickers.sub_industry',
    'include[]=tickers.sector',
    'include[]=tickers.country',
  ].join('&');

  const url = `${API_BASE}/account/${userKey}/portfolios?${params}`;
  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  // Build a map from ticker ID to holding attributes (shares, cost_basis)
  // Holdings link tickers to quantity data; some portfolios have no holdings (watchlist-only).
  const holdingsByTickerId = {};
  for (const inc of (data.included || [])) {
    if (inc.type === 'holding') {
      const tickerRef = inc.relationships?.ticker?.data;
      if (tickerRef) holdingsByTickerId[tickerRef.id] = inc.attributes || {};
    }
  }

  const portfolios = (data.data || []).map(p => {
    const attrs = p.attributes || {};

    // Tickers are the primary list of stocks in a portfolio
    const tickerRefs = p.relationships?.tickers?.data || [];
    const tickers = tickerRefs.map(ref => {
      const ticker = included[`${ref.type}:${ref.id}`];
      if (!ticker) return null;
      const tAttrs = ticker.attributes || {};

      // Resolve sector from ticker relationship
      const sectorRef = ticker.relationships?.sector?.data;
      const sector = sectorRef ? included[`${sectorRef.type}:${sectorRef.id}`] : null;

      // Resolve sub-industry (API uses camelCase ref type but snake_case included type)
      const subIndustryRef = ticker.relationships?.subIndustry?.data
        || ticker.relationships?.sub_industry?.data;
      const subIndustry = subIndustryRef ? included[`${subIndustryRef.type}:${subIndustryRef.id}`] : null;

      // Country is a direct string attribute on ticker, not a relationship
      const country = tAttrs.country || null;

      // Holdings data (shares, cost basis) if available
      const hAttrs = holdingsByTickerId[ticker.id] || {};

      return {
        tickerId: ticker.id,
        symbol: tAttrs.name || tAttrs.slug?.toUpperCase() || null,
        companyName: tAttrs.companyName || tAttrs.company || null,
        sector: sector?.attributes?.name || null,
        subIndustry: subIndustry?.attributes?.name || null,
        equityType: tAttrs.equityType || null,
        fundType: tAttrs.fundType || null,
        country,
        exchange: tAttrs.exchange || null,
        currency: tAttrs.currency || null,
        shares: hAttrs.shares || null,
        costBasis: hAttrs.cost_basis || null,
      };
    }).filter(Boolean);

    return {
      id: p.id,
      name: attrs.title || `Portfolio ${p.id}`,
      isWatchlist: attrs.isWatchlist || false,
      tickersCount: attrs.tickersCount || tickers.length,
      createdAt: attrs.createdOn || null,
      tickers,
    };
  });

  return { portfolios, _included: included, _raw: data };
}

async function listPortfolios(auth) {
  const { portfolios } = await fetchPortfolios(auth);

  const result = {
    command: 'list',
    count: portfolios.length,
    portfolios: portfolios.map(p => ({
      id: p.id,
      name: p.name,
      isWatchlist: p.isWatchlist,
      tickersCount: p.tickersCount,
      createdAt: p.createdAt,
    })),
  };

  const cacheFile = resolve(CACHE_DIR, 'portfolios.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: View Portfolio Holdings
// ---------------------------------------------------------------------------

async function viewPortfolio(auth, portfolioId) {
  const { portfolios } = await fetchPortfolios(auth);

  const portfolio = portfolios.find(p => String(p.id) === String(portfolioId));
  if (!portfolio) {
    const available = portfolios.map(p => `  ${p.id} — ${p.name}`).join('\n');
    throw new Error(`Portfolio "${portfolioId}" not found. Available portfolios:\n${available}`);
  }

  const result = {
    command: 'view',
    portfolio: {
      id: portfolio.id,
      name: portfolio.name,
      isWatchlist: portfolio.isWatchlist,
      tickersCount: portfolio.tickersCount,
      createdAt: portfolio.createdAt,
      tickers: portfolio.tickers,
    },
  };

  const cacheFile = resolve(CACHE_DIR, `portfolio-${portfolioId}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Rating Change Alerts
// ---------------------------------------------------------------------------

async function fetchAlerts(auth) {
  const userKey = getUserKey(auth);
  console.log('Fetching portfolio rating change alerts...');

  const url = `${API_BASE}/account/${userKey}/portfolios/all/rating_change_notices?with_dismissed=true`;
  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const alerts = (data.data || []).map(item => {
    const attrs = item.attributes || {};

    // Resolve ticker if available
    const tickerRef = item.relationships?.ticker?.data;
    const ticker = tickerRef ? included[`${tickerRef.type}:${tickerRef.id}`] : null;
    const tAttrs = ticker?.attributes || {};

    return {
      id: item.id,
      symbol: tAttrs.slug?.toUpperCase() || tAttrs.name || attrs.ticker_slug?.toUpperCase() || null,
      companyName: tAttrs.company || tAttrs.name || null,
      ratingType: attrs.rating_type || null,
      previousRating: attrs.previous_rating || null,
      newRating: attrs.new_rating || null,
      previousRatingName: attrs.previous_rating_name || null,
      newRatingName: attrs.new_rating_name || null,
      dismissed: attrs.dismissed || false,
      createdAt: attrs.created_at || null,
    };
  });

  const result = {
    command: 'alerts',
    count: alerts.length,
    alerts,
  };

  const cacheFile = resolve(CACHE_DIR, 'alerts.json');
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

    case 'list': {
      const result = await listPortfolios(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'view': {
      const portfolioId = positional[0];
      if (!portfolioId) {
        console.error('Usage: seekingalpha-portfolio.mjs view <portfolioId>');
        console.error('Run "seekingalpha-portfolio.mjs list" to see available portfolio IDs.');
        process.exit(1);
      }
      const result = await viewPortfolio(getAuth(), portfolioId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'alerts': {
      const result = await fetchAlerts(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-portfolio.mjs';
      console.log(`
seekingalpha-portfolio — User portfolios, holdings, and rating change alerts from Seeking Alpha

Setup:
  node ${script} auth                       Extract cookies from Chrome

Commands:
  node ${script} list                       List all portfolios
  node ${script} view <portfolioId>         View portfolio holdings with metrics
  node ${script} alerts                     Portfolio rating change alerts

Examples:
  node ${script} list
  node ${script} view 12345
  node ${script} alerts

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
