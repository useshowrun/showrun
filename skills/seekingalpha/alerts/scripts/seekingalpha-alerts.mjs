#!/usr/bin/env node
// seekingalpha-alerts.mjs — Price & rating alerts, notifications, portfolio & market status from Seeking Alpha
//
// Setup:   node seekingalpha-alerts.mjs auth
// Usage:   node seekingalpha-alerts.mjs list AAPL --type=all
//          node seekingalpha-alerts.mjs list TSLA --type=price
//          node seekingalpha-alerts.mjs list MSFT --type=rating --status=triggered
//          node seekingalpha-alerts.mjs list --all
//          node seekingalpha-alerts.mjs notifications
//          node seekingalpha-alerts.mjs portfolio
//          node seekingalpha-alerts.mjs account
//          node seekingalpha-alerts.mjs market
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-alerts');
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
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints will not work.');

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
    console.error('No auth found. Run: node seekingalpha-alerts.mjs auth');
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
      console.error('Session expired or blocked. Run: node seekingalpha-alerts.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

function parseTicker(input) {
  // Accept URLs like https://seekingalpha.com/symbol/AAPL or plain tickers
  const urlMatch = input.match(/seekingalpha\.com\/symbol\/([^\s/?#]+)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return input.toLowerCase();
}

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
// API: Resolve ticker slug to numeric ID
// ---------------------------------------------------------------------------

async function resolveTickerId(auth, slug) {
  console.log(`Resolving ticker ID for ${slug.toUpperCase()}...`);
  const url = `${API_BASE}/tickers?filter[slugs]=${slug}`;
  const { data } = await apiFetch(auth, url);

  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  if (items.length === 0) {
    throw new Error(`Ticker "${slug.toUpperCase()}" not found on Seeking Alpha.`);
  }

  const tickerId = items[0].id;
  const attrs = items[0].attributes || {};
  console.log(`Resolved: ${slug.toUpperCase()} -> ticker ID ${tickerId} (${attrs.name || attrs.company || slug.toUpperCase()})`);
  return tickerId;
}

// ---------------------------------------------------------------------------
// API: List alerts for a ticker
// ---------------------------------------------------------------------------

async function fetchAlerts(auth, slug, type = 'all', status = 'active') {
  if (!auth.userCookieKey) {
    throw new Error('user_cookie_key not available. Run: node seekingalpha-alerts.mjs auth');
  }

  let tickerId = null;
  if (slug) {
    tickerId = await resolveTickerId(auth, slug);
  }

  const types = type === 'all' ? ['price', 'rating'] : [type];
  const allAlerts = [];

  for (const alertType of types) {
    const label = slug ? `${alertType} alerts for ${slug.toUpperCase()}` : `all ${alertType} alerts`;
    console.log(`Fetching ${label} (status=${status})...`);
    const params = [
      `filter[status]=${status}`,
      `filter[type]=${alertType}`,
      'page[size]=50',
    ];
    if (tickerId) {
      params.push(`filter[ticker_ids][]=${tickerId}`);
    }
    if (alertType === 'price') {
      params.push('sort[]=-triggered_at', 'sort[]=-created_at');
    }

    const url = `${API_BASE}/account/${auth.userCookieKey}/alerts?${params.join('&')}`;
    const { data } = await apiFetch(auth, url);

    const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);

    for (const item of items) {
      const attrs = item.attributes || {};
      const alert = {
        id: item.id,
        type: alertType,
        status: attrs.status || status,
        createdAt: attrs.created_at || null,
        triggeredAt: attrs.triggered_at || null,
      };

      if (alertType === 'price') {
        alert.targetPrice = attrs.target_price || attrs.price || null;
        alert.direction = attrs.direction || attrs.condition || null;
        alert.currentPrice = attrs.current_price || null;
      }

      if (alertType === 'rating') {
        alert.ratingType = attrs.rating_type || null;
        alert.previousRating = attrs.previous_rating || null;
        alert.currentRating = attrs.current_rating || null;
      }

      allAlerts.push(alert);
    }

    // Include total from meta if available
    if (data.meta && data.meta.total_count !== undefined) {
      console.log(`  Found ${data.meta.total_count} ${alertType} alert(s)`);
    }
  }

  const result = {
    command: 'list',
    ticker: slug ? slug.toUpperCase() : null,
    tickerId,
    type,
    status,
    count: allAlerts.length,
    alerts: allAlerts,
  };

  const cacheKey = slug ? `${slug}-alerts-${type}-${status}` : `all-alerts-${type}-${status}`;
  const cacheFile = resolve(CACHE_DIR, `${cacheKey}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Inbox notification count
// ---------------------------------------------------------------------------

async function fetchNotifications(auth) {
  console.log('Fetching inbox notification count...');
  const url = `${API_BASE}/inbox_notifications/count`;
  const { data } = await apiFetch(auth, url);

  // Response: { data: { id, type, attributes: { not_seen, headlines, comments, direct_messages } } }
  const attrs = data?.data?.attributes || {};
  const notSeen = attrs.not_seen ?? 0;

  const result = {
    command: 'notifications',
    totalUnseen: notSeen,
    breakdown: {
      headlines: attrs.headlines ?? 0,
      comments: attrs.comments ?? 0,
      directMessages: attrs.direct_messages ?? 0,
    },
    fetchedAt: new Date().toISOString(),
  };

  const cacheFile = resolve(CACHE_DIR, 'notifications.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Portfolio
// ---------------------------------------------------------------------------

async function fetchPortfolio(auth) {
  if (!auth.userCookieKey) {
    throw new Error('user_cookie_key not available. Run: node seekingalpha-alerts.mjs auth');
  }

  console.log('Fetching portfolio...');
  const includes = ['tickers', 'holdings', 'views'].map(i => `include[]=${i}`).join('&');
  const url = `${API_BASE}/account/${auth.userCookieKey}/portfolios?${includes}`;
  const { data } = await apiFetch(auth, url);

  const portfolios = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  const included = Array.isArray(data.included) ? data.included : [];

  // Build ticker lookup from included resources
  const tickerMap = {};
  for (const inc of included) {
    if (inc.type === 'ticker') {
      const attrs = inc.attributes || {};
      tickerMap[inc.id] = {
        id: inc.id,
        slug: attrs.slug,
        name: attrs.name,
        companyName: attrs.companyName || attrs.company,
        exchange: attrs.exchange,
        equityType: attrs.equityType,
        followersCount: attrs.followersCount,
      };
    }
  }

  const result = {
    command: 'portfolio',
    portfolios: portfolios.map(p => {
      const attrs = p.attributes || {};
      const tickerRefs = p.relationships?.tickers?.data || [];
      return {
        id: p.id,
        title: attrs.title,
        tickersCount: attrs.tickersCount,
        isWatchlist: attrs.isWatchlist,
        createdOn: attrs.createdOn,
        tickers: tickerRefs.map(ref => tickerMap[ref.id] || { id: ref.id }),
      };
    }),
    fetchedAt: new Date().toISOString(),
  };

  const cacheFile = resolve(CACHE_DIR, 'portfolio.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Account info
// ---------------------------------------------------------------------------

async function fetchAccount(auth) {
  if (!auth.userCookieKey) {
    throw new Error('user_cookie_key not available. Run: node seekingalpha-alerts.mjs auth');
  }

  console.log('Fetching account info...');
  const url = `${API_BASE}/account/${auth.userCookieKey}/info?include=proSubscription`;
  const { data } = await apiFetch(auth, url);

  const attrs = data?.data?.attributes || {};
  const result = {
    command: 'account',
    userId: attrs.userId,
    email: attrs.email,
    createdAt: attrs.createdAt,
    isAuthor: attrs.isAuthor,
    contributorStatus: attrs.contributorStatus,
    isLimited: attrs.isLimited,
    portfolioItemsCount: attrs.portfolioItemsCount,
    authorFollowingsCount: attrs.authorFollowingsCount,
    fetchedAt: new Date().toISOString(),
  };

  const cacheFile = resolve(CACHE_DIR, 'account.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Market status
// ---------------------------------------------------------------------------

async function fetchMarketStatus(auth) {
  console.log('Fetching market status...');
  const url = `${API_BASE}/market_open`;
  const { data } = await apiFetch(auth, url);

  const attrs = data?.data?.attributes || {};
  const nextOpen = attrs.nextMarketOpen ? new Date(attrs.nextMarketOpen * 1000).toISOString() : null;
  const nextClose = attrs.nextMarketClose ? new Date(attrs.nextMarketClose * 1000).toISOString() : null;

  const result = {
    command: 'market',
    isOpen: attrs.marketOpen ?? false,
    nextOpen,
    nextClose,
    fetchedAt: new Date().toISOString(),
  };

  const cacheFile = resolve(CACHE_DIR, 'market.json');
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
      const tickerArg = positional[0];
      const type = flags.type || 'all';
      const status = flags.status || 'active';
      if (!['price', 'rating', 'all'].includes(type)) {
        console.error('Invalid --type. Must be one of: price, rating, all');
        process.exit(1);
      }
      if (!['active', 'triggered'].includes(status)) {
        console.error('Invalid --status. Must be one of: active, triggered');
        process.exit(1);
      }
      if (!tickerArg && !flags.all) {
        console.error('Usage: seekingalpha-alerts.mjs list <ticker> [--type=price|rating|all] [--status=active|triggered]');
        console.error('       seekingalpha-alerts.mjs list --all [--type=price|rating|all] [--status=active|triggered]');
        process.exit(1);
      }
      const ticker = tickerArg ? parseTicker(tickerArg) : null;
      const result = await fetchAlerts(getAuth(), ticker, type, status);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'notifications': {
      const result = await fetchNotifications(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'portfolio': {
      const result = await fetchPortfolio(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'account': {
      const result = await fetchAccount(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'market': {
      const result = await fetchMarketStatus(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-alerts.mjs';
      console.log(`
seekingalpha-alerts — Price & rating alerts, notifications, portfolio & market status from Seeking Alpha

Setup:
  node ${script} auth                                 Extract cookies from Chrome

Commands:
  node ${script} list <ticker> [--type=all]           List alerts for a ticker
  node ${script} list --all [--type=all]              List all alerts (no ticker filter)
       --type=price                                    Price alerts only
       --type=rating                                   Rating change alerts only
       --type=all                                      Both price and rating (default)
       --status=active                                  Active alerts (default)
       --status=triggered                               Triggered alerts
  node ${script} notifications                        Inbox notification counts
  node ${script} portfolio                            List portfolio tickers
  node ${script} account                              Account info
  node ${script} market                               Market open/close status

Ticker formats:
  AAPL                                                 Plain ticker symbol
  aapl                                                 Case-insensitive
  https://seekingalpha.com/symbol/AAPL                 URL format

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
