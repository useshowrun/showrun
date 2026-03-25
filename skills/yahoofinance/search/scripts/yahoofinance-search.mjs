#!/usr/bin/env node
// yahoofinance-search.mjs — Search Yahoo Finance for symbols, quotes, and news
//
// Setup (one-time, requires Chrome with Yahoo Finance open):
//   node yahoofinance-search.mjs auth
//
// Usage:
//   node yahoofinance-search.mjs search "Apple" [--quotes=8] [--news=8]
//   node yahoofinance-search.mjs lookup "AAPL" [--type=all] [--count=25]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-search');
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
// Constants
// ---------------------------------------------------------------------------

const QUERY1_URL = 'https://query1.finance.yahoo.com';
const QUERY2_URL = 'https://query2.finance.yahoo.com';
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const LOOKUP_TYPES = ['all', 'equity', 'mutualfund', 'etf', 'index', 'future', 'currency', 'cryptocurrency'];

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract A3 cookie from Chrome, then fetch crumb
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['finance.yahoo.com', 'yahoo.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) throw new Error('No Yahoo Finance tab found. Open https://finance.yahoo.com in Chrome first.');

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://finance.yahoo.com', 'https://query1.finance.yahoo.com'] }));
  const { cookies } = JSON.parse(raw);

  // Build cookie string from all yahoo.com domain cookies
  const yahooCookies = cookies.filter(c => c.domain.includes('yahoo.com'));
  if (!yahooCookies.length) throw new Error('No Yahoo cookies found. Are you logged in / have you visited Yahoo Finance?');

  const cookieStr = yahooCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Fetch crumb using these cookies
  console.log('Fetching crumb...');
  const crumbResp = await fetch(CRUMB_URL, {
    headers: {
      'cookie': cookieStr,
      'user-agent': USER_AGENT,
    },
  });

  if (!crumbResp.ok) {
    throw new Error(`Failed to fetch crumb (HTTP ${crumbResp.status}). Try refreshing Yahoo Finance in Chrome.`);
  }

  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes('<html>') || crumb.includes('Too Many Requests')) {
    throw new Error(`Invalid crumb response: ${crumb.substring(0, 100)}. Try again later.`);
  }

  console.log(`Crumb: ${crumb}`);

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    crumb,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie || !auth.crumb) {
    console.error('No auth found. Run: node yahoofinance-search.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'cookie': auth.cookie,
    'user-agent': USER_AGENT,
    'accept': 'application/json',
  };
}

async function apiFetch(auth, url, params = {}) {
  // Always append crumb
  params.crumb = auth.crumb;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }

  const fullUrl = `${url}?${qs.toString()}`;

  const resp = await fetch(fullUrl, {
    headers: baseHeaders(auth),
  });

  const text = await resp.text();

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or invalid crumb. Run: node yahoofinance-search.mjs auth');
    }
    throw new Error(`API request failed (HTTP ${resp.status}): ${text.substring(0, 200)}`);
  }

  if (text.includes('Will be right back')) {
    throw new Error('Yahoo Finance is currently down. Try again later.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Search: symbol/quote/news search
// ---------------------------------------------------------------------------

async function doSearch(auth, query, { quotesCount = 8, newsCount = 8 } = {}) {
  const url = `${QUERY2_URL}/v1/finance/search`;
  const params = {
    q: query,
    quotesCount,
    newsCount,
    listsCount: 8,
    enableFuzzyQuery: false,
    quotesQueryId: 'tss_match_phrase_query',
    newsQueryId: 'news_cie_vespa',
    enableCb: true,
    enableNavLinks: false,
    enableResearchReports: false,
    enableCulturalAssets: false,
    recommendedCount: 8,
  };

  const data = await apiFetch(auth, url, params);

  // Filter quotes to only include entries with a symbol
  const quotes = (data.quotes || []).filter(q => q.symbol).map(q => ({
    symbol: q.symbol,
    shortname: q.shortname || q.shortName,
    exchange: q.exchange || q.exchDisp,
    quoteType: q.quoteType,
    score: q.score,
    industry: q.industry,
    sector: q.sector,
  }));

  const news = (data.news || []).map(n => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    providerPublishTime: n.providerPublishTime,
  }));

  return { quotes, news };
}

// ---------------------------------------------------------------------------
// Lookup: ticker/symbol lookup by type
// ---------------------------------------------------------------------------

async function doLookup(auth, query, { type = 'all', count = 25 } = {}) {
  if (!LOOKUP_TYPES.includes(type)) {
    throw new Error(`Invalid lookup type "${type}". Valid types: ${LOOKUP_TYPES.join(', ')}`);
  }

  const url = `${QUERY1_URL}/v1/finance/lookup`;
  const params = {
    query,
    type,
    start: 0,
    count,
    formatted: false,
    fetchPricingData: true,
    lang: 'en-US',
    region: 'US',
  };

  const data = await apiFetch(auth, url, params);

  // Check for errors
  const error = data?.finance?.error;
  if (error) {
    throw new Error(`Lookup error: ${JSON.stringify(error)}`);
  }

  const result = data?.finance?.result?.[0] || {};
  const documents = result.documents || [];

  return documents.map(d => ({
    symbol: d.symbol,
    shortName: d.shortName,
    exchange: d.exchange,
    exchDisp: d.exchDisp,
    quoteType: d.quoteType,
    sector: d.sector,
    industry: d.industry,
    regularMarketPrice: d.regularMarketPrice,
    regularMarketChange: d.regularMarketChange,
    regularMarketChangePercent: d.regularMarketChangePercent,
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2]; else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'search': {
    const { flags, positional } = parseFlags(args);
    const query = positional[0];
    if (!query) {
      console.error('Usage: node yahoofinance-search.mjs search <query> [--quotes=8] [--news=8]');
      process.exit(1);
    }

    const auth = getAuth();
    const quotesCount = parseInt(flags.quotes || '8', 10);
    const newsCount = parseInt(flags.news || '8', 10);

    console.log(`Searching Yahoo Finance for: "${query}" (quotes=${quotesCount}, news=${newsCount})`);
    const result = await doSearch(auth, query, { quotesCount, newsCount });

    // Cache result
    const cacheFile = resolve(CACHE_DIR, `search-${query.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
    saveJson(cacheFile, result);

    // Display quotes
    if (result.quotes.length) {
      console.log(`\nQuotes (${result.quotes.length}):`);
      for (const q of result.quotes) {
        console.log(`  ${q.symbol.padEnd(10)} ${(q.shortname || '').padEnd(40)} ${(q.exchange || '').padEnd(10)} ${q.quoteType || ''}`);
      }
    } else {
      console.log('\nNo quotes found.');
    }

    // Display news
    if (result.news.length) {
      console.log(`\nNews (${result.news.length}):`);
      for (const n of result.news) {
        const date = n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().split('T')[0] : '';
        console.log(`  [${date}] ${n.title}`);
        console.log(`    ${n.publisher || ''} — ${n.link || ''}`);
      }
    } else {
      console.log('\nNo news found.');
    }

    console.log(JSON.stringify(result, null, 2));
    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  case 'lookup': {
    const { flags, positional } = parseFlags(args);
    const query = positional[0];
    if (!query) {
      console.error('Usage: node yahoofinance-search.mjs lookup <query> [--type=all] [--count=25]');
      console.error(`Types: ${LOOKUP_TYPES.join(', ')}`);
      process.exit(1);
    }

    const auth = getAuth();
    const type = flags.type || 'all';
    const count = parseInt(flags.count || '25', 10);

    console.log(`Looking up: "${query}" (type=${type}, count=${count})`);
    const results = await doLookup(auth, query, { type, count });

    // Cache result
    const cacheFile = resolve(CACHE_DIR, `lookup-${query.replace(/[^a-zA-Z0-9]/g, '_')}-${type}.json`);
    saveJson(cacheFile, results);

    // Display results
    if (results.length) {
      console.log(`\nResults (${results.length}):`);
      for (const d of results) {
        const price = d.regularMarketPrice != null ? `$${d.regularMarketPrice}` : '';
        const change = d.regularMarketChangePercent != null ? `(${d.regularMarketChangePercent > 0 ? '+' : ''}${d.regularMarketChangePercent.toFixed(2)}%)` : '';
        console.log(`  ${(d.symbol || '').padEnd(10)} ${(d.shortName || '').padEnd(40)} ${(d.exchDisp || d.exchange || '').padEnd(10)} ${price} ${change}`);
      }
    } else {
      console.log('\nNo results found.');
    }

    console.log(JSON.stringify(results, null, 2));
    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`yahoofinance-search — Search Yahoo Finance for symbols, quotes, and news

Commands:
  auth                                    Authenticate via Chrome (one-time)
  search <query> [--quotes=8] [--news=8]  Search for symbols and news
  lookup <query> [--type=all] [--count=25] Lookup tickers by type

Lookup types: ${LOOKUP_TYPES.join(', ')}

Examples:
  node yahoofinance-search.mjs auth
  node yahoofinance-search.mjs search "Apple"
  node yahoofinance-search.mjs search "Tesla" --quotes=5 --news=3
  node yahoofinance-search.mjs lookup "AAPL"
  node yahoofinance-search.mjs lookup "Bitcoin" --type=cryptocurrency --count=10

Data: ${DATA_DIR}/
  session.json     Auth cookies & crumb
  cache/           Cached search/lookup results`);
}
