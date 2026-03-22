#!/usr/bin/env node
// seekingalpha-search.mjs — Search for symbols, authors, pages on Seeking Alpha
//
// Setup:   node seekingalpha-search.mjs auth
// Usage:   node seekingalpha-search.mjs search apple --type=all --count=6
//          node seekingalpha-search.mjs recent
//          node seekingalpha-search.mjs lookup MSFT,NVDA,AAPL
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-search');
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
    console.error('No auth found. Run: node seekingalpha-search.mjs auth');
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
      console.error('Session expired or blocked. Run: node seekingalpha-search.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '');
}

function toAbsoluteUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  if (!path.startsWith('/')) path = '/' + path;
  return `https://seekingalpha.com${path}`;
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
// API: Unified Search
// ---------------------------------------------------------------------------

async function fetchSearch(auth, query, type = 'all', count = 6) {
  console.log(`Searching for "${query}" (type=${type}, count=${count})...`);

  // Build filter types based on --type flag
  let filterType;
  switch (type) {
    case 'symbols': filterType = 'symbols'; break;
    case 'people':  filterType = 'people'; break;
    case 'pages':   filterType = 'pages'; break;
    default:        filterType = 'people,symbols,pages,shortcuts'; break;
  }

  const url = `${API_BASE}/searches?` + [
    `filter[query]=${encodeURIComponent(query)}`,
    `filter[type]=${filterType}`,
    'filter[list]=all',
    'filter[period]=all',
    `page[size]=${count}`,
    'page[number]=1',
  ].join('&');

  const { data } = await apiFetch(auth, url);

  // The API returns a flat structure: { symbols: [...], people: [...], pages: [...], shortcuts: [] }
  // Each item has: id, type, score, url (relative), name (may contain HTML), content, slug, image_url/image
  const results = { symbols: [], people: [], pages: [], shortcuts: [] };

  for (const sym of (data.symbols || [])) {
    results.symbols.push({
      id: sym.id,
      ticker: (sym.slug || '').toUpperCase(),
      name: stripHtml(sym.name || ''),
      company: stripHtml(sym.content || sym.company || ''),
      url: toAbsoluteUrl(sym.url),
    });
  }
  for (const p of (data.people || [])) {
    results.people.push({
      id: p.id,
      name: stripHtml(p.name || ''),
      slug: p.slug || '',
      url: toAbsoluteUrl(p.url),
    });
  }
  for (const pg of (data.pages || [])) {
    results.pages.push({
      id: pg.id,
      name: stripHtml(pg.name || ''),
      url: toAbsoluteUrl(pg.url),
    });
  }
  for (const sc of (data.shortcuts || [])) {
    results.shortcuts.push({
      id: sc.id,
      name: stripHtml(sc.name || ''),
      url: toAbsoluteUrl(sc.url),
    });
  }

  // Also handle JSON:API format (data.data array) as fallback
  for (const item of (data.data || [])) {
    const attrs = item.attributes || {};
    const itemType = item.type;

    if (itemType === 'symbol' || itemType === 'symbols') {
      results.symbols.push({
        id: item.id,
        ticker: (attrs.slug || '').toUpperCase(),
        name: stripHtml(attrs.name || ''),
        company: stripHtml(attrs.content || attrs.company || ''),
        url: toAbsoluteUrl(attrs.url || `/symbol/${(attrs.slug || '').toUpperCase()}`),
      });
    } else if (itemType === 'people' || itemType === 'person' || itemType === 'author') {
      results.people.push({
        id: item.id,
        name: stripHtml(attrs.name || ''),
        slug: attrs.slug || '',
        url: toAbsoluteUrl(attrs.url || (attrs.slug ? `/author/${attrs.slug}` : null)),
      });
    } else if (itemType === 'page' || itemType === 'pages') {
      results.pages.push({
        id: item.id,
        name: stripHtml(attrs.name || attrs.title || ''),
        url: toAbsoluteUrl(attrs.url || attrs.uri),
      });
    } else if (itemType === 'shortcut' || itemType === 'shortcuts') {
      results.shortcuts.push({
        id: item.id,
        name: stripHtml(attrs.name || attrs.title || ''),
        url: toAbsoluteUrl(attrs.url || attrs.uri),
      });
    }
  }

  const result = {
    command: 'search',
    query,
    type,
    symbols: results.symbols,
    people: results.people,
    pages: results.pages,
    shortcuts: results.shortcuts,
  };

  const cacheFile = resolve(CACHE_DIR, `search-${query.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Recent Searches
// ---------------------------------------------------------------------------

async function fetchRecent(auth, type = null) {
  const userKey = auth.userCookieKey;
  if (!userKey) throw new Error('user_cookie_key not available. Run: node seekingalpha-search.mjs auth');

  console.log(`Fetching recent searches${type ? ` (type=${type})` : ''}...`);

  let url = `${API_BASE}/account/${userKey}/recent_searches`;
  if (type) url += `?type=${encodeURIComponent(type)}`;

  const { data } = await apiFetch(auth, url);

  const searches = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    return {
      id: item.id,
      type: item.type || null,
      query: attrs.query || attrs.name || attrs.slug || '',
      name: attrs.name || attrs.company || '',
      slug: attrs.slug || null,
      searchedAt: attrs.created_at || attrs.date || null,
    };
  });

  const result = { command: 'recent', type: type || 'all', count: searches.length, searches };

  const cacheFile = resolve(CACHE_DIR, `recent${type ? `-${type}` : ''}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Ticker Lookup
// ---------------------------------------------------------------------------

async function fetchLookup(auth, slugs) {
  console.log(`Looking up tickers: ${slugs.join(', ')}...`);

  const url = `${API_BASE}/tickers?` + [
    `filter[slugs]=${slugs.map(s => s.toLowerCase()).join(',')}`,
    'include[gics]=true',
    'per_page=100',
  ].join('&');

  const { data } = await apiFetch(auth, url);

  // Build lookup maps from included array for sector and sub_industry data
  const included = data.included || [];
  const sectorMap = {};
  const subIndustryMap = {};
  for (const inc of included) {
    if (inc.type === 'sector') {
      sectorMap[inc.id] = inc.attributes?.name || null;
    } else if (inc.type === 'sub_industry') {
      subIndustryMap[inc.id] = inc.attributes?.name || null;
    }
  }

  const tickers = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const rels = item.relationships || {};

    // Resolve sector and sub-industry from relationships + included
    const sectorRef = rels.sector?.data;
    const subIndustryRef = rels.subIndustry?.data;
    const sector = sectorRef ? (sectorMap[sectorRef.id] || null) : null;
    const subIndustry = subIndustryRef ? (subIndustryMap[subIndustryRef.id] || null) : null;

    return {
      id: item.id,
      ticker: (attrs.name || attrs.slug || '').toUpperCase(),
      company: attrs.companyName || attrs.company || '',
      exchange: attrs.exchange || null,
      equityType: attrs.equityType || attrs.equity_type || null,
      fundType: attrs.fundType || null,
      currency: attrs.currency || null,
      sector,
      subIndustry,
      followersCount: attrs.followersCount || null,
      isFollowed: attrs.is_followed || false,
      url: `https://seekingalpha.com/symbol/${(attrs.name || attrs.slug || '').toUpperCase()}`,
    };
  });

  const result = { command: 'lookup', count: tickers.length, tickers };

  const slugKey = slugs.map(s => s.toLowerCase()).join('-');
  const cacheFile = resolve(CACHE_DIR, `lookup-${slugKey}.json`);
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

    case 'search': {
      const query = positional[0];
      if (!query) { console.error('Usage: seekingalpha-search.mjs search <query> [--type=all|symbols|people|pages] [--count=6]'); process.exit(1); }
      const type = flags.type || 'all';
      const count = parseInt(flags.count || '6', 10);
      const result = await fetchSearch(getAuth(), query, type, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'recent': {
      const type = flags.type || null;
      const result = await fetchRecent(getAuth(), type);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'lookup': {
      const tickerArg = positional[0];
      if (!tickerArg) { console.error('Usage: seekingalpha-search.mjs lookup <ticker1,ticker2,...>'); process.exit(1); }
      const slugs = tickerArg.split(',').map(s => s.trim()).filter(Boolean);
      if (slugs.length === 0) { console.error('Provide at least one ticker.'); process.exit(1); }
      const result = await fetchLookup(getAuth(), slugs);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-search.mjs';
      console.log(`
seekingalpha-search — Search for symbols, authors, pages on Seeking Alpha

Setup:
  node ${script} auth                                   Extract cookies from Chrome

Commands:
  node ${script} search <query>                         Unified search
       [--type=all|symbols|people|pages] [--count=6]
  node ${script} recent [--type=symbol]                 Recent search history
  node ${script} lookup <ticker1,ticker2,...>            Quick ticker info lookup

Examples:
  node ${script} search apple                           Search all types for "apple"
  node ${script} search "Warren Buffett" --type=people  Search only authors
  node ${script} search MSFT --type=symbols             Search only symbols
  node ${script} recent                                 All recent searches
  node ${script} recent --type=symbol                   Recent symbol searches
  node ${script} lookup AAPL                            Lookup single ticker
  node ${script} lookup MSFT,NVDA,AAPL                  Lookup multiple tickers

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
