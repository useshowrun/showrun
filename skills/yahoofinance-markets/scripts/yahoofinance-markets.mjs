#!/usr/bin/env node
// yahoofinance-markets.mjs — Fetch Yahoo Finance market summary and status
//
// Setup (one-time, requires Chrome with finance.yahoo.com open):
//   node yahoofinance-markets.mjs auth
//
// Usage:
//   node yahoofinance-markets.mjs summary [--market=us_market]
//   node yahoofinance-markets.mjs status [--market=us_market]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUERY1_URL = 'https://query1.finance.yahoo.com';
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const KNOWN_MARKETS = [
  'us_market', 'gb_market', 'de_market', 'fr_market',
  'jp_market', 'hk_market', 'ca_market', 'au_market',
];

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-markets');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return null;
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome via CDP, fetch crumb
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['finance.yahoo.com', 'yahoo.com/quote', 'yahoo.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');

  console.log(`Using tab: ${target}`);

  // Extract cookies via CDP Network.getCookies
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://finance.yahoo.com', 'https://www.yahoo.com', 'https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'] }));
  const { cookies } = JSON.parse(raw);

  // Build cookie string from all yahoo.com domain cookies
  const cookieStr = cookies
    .filter(c => c.domain.includes('yahoo.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No Yahoo cookies found. Make sure you are on finance.yahoo.com.');

  // Extract User-Agent from browser
  let userAgent = USER_AGENT;
  try {
    const uaResult = cdp('eval', target, 'navigator.userAgent');
    if (uaResult && uaResult.length > 10) userAgent = uaResult;
  } catch { /* use default */ }

  console.log('Fetching crumb...');

  // Fetch crumb using extracted cookies
  const crumbResp = await fetch(CRUMB_URL, {
    headers: {
      'Cookie': cookieStr,
      'User-Agent': userAgent,
    },
    redirect: 'follow',
  });

  if (!crumbResp.ok) {
    throw new Error(`Failed to fetch crumb: HTTP ${crumbResp.status} ${crumbResp.statusText}`);
  }

  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes('<html>') || crumb.includes('Too Many Requests')) {
    throw new Error(`Invalid crumb response: ${crumb.substring(0, 100)}`);
  }

  const session = {
    cookies: cookieStr,
    crumb,
    userAgent,
    capturedAt: new Date().toISOString(),
  };

  saveJson(SESSION_FILE, session);
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Crumb: ${crumb}`);
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session || !session.cookies || !session.crumb) {
    console.error('No auth found. Run: node yahoofinance-markets.mjs auth');
    process.exit(1);
  }
  return session;
}

function baseHeaders(session) {
  return {
    'Cookie': session.cookies,
    'User-Agent': session.userAgent || USER_AGENT,
    'Accept': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers with error handling
// ---------------------------------------------------------------------------

async function apiFetch(session, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(session), ...options.headers },
  });

  if (resp.status === 401 || resp.status === 403) {
    console.error(`Auth expired (HTTP ${resp.status}). Run: node yahoofinance-markets.mjs auth`);
    process.exit(1);
  }
  if (resp.status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes and try again.');
    process.exit(1);
  }

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
    process.exit(1);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(val, opts = {}) {
  if (val === null || val === undefined || val === 'Infinity' || val === 'NaN') return 'N/A';
  if (typeof val === 'object' && val.raw !== undefined) val = val.raw;
  if (typeof val === 'object' && val.fmt !== undefined) return val.fmt;
  if (opts.pct) return (val * 100).toFixed(2) + '%';
  if (opts.currency) return typeof val === 'number' ? val.toFixed(2) : String(val);
  if (typeof val === 'number' && !Number.isInteger(val)) return val.toFixed(2);
  return String(val);
}

function printTable(rows, indent = '  ') {
  if (!rows.length) return;
  const maxLabel = Math.max(...rows.map(r => r[0].length));
  for (const [label, value] of rows) {
    console.log(`${indent}${label.padEnd(maxLabel + 2)}${value}`);
  }
}

function printSectionHeader(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}`);
}

// ---------------------------------------------------------------------------
// Command: summary [--market=us_market]
// ---------------------------------------------------------------------------

async function cmdSummary(session, market) {
  const params = new URLSearchParams({
    fields: 'shortName,regularMarketPrice,regularMarketChange,regularMarketChangePercent',
    formatted: 'false',
    lang: 'en-US',
    market,
    crumb: session.crumb,
  });

  const url = `${QUERY1_URL}/v6/finance/quote/marketSummary?${params}`;
  const data = await apiFetch(session, url);

  const results = data?.marketSummaryResponse?.result;
  if (!results || results.length === 0) {
    console.error(`No market summary data returned for "${market}".`);
    process.exit(1);
  }

  printSectionHeader(`Market Summary - ${market}`);

  for (const item of results) {
    const name = item.shortName || item.fullExchangeName || item.symbol || 'Unknown';
    const symbol = item.symbol || '';
    const price = item.regularMarketPrice?.raw ?? item.regularMarketPrice;
    const change = item.regularMarketChange?.raw ?? item.regularMarketChange;
    const changePct = item.regularMarketChangePercent?.raw ?? item.regularMarketChangePercent;

    const changeStr = change != null ? fmt(change, { currency: true }) : 'N/A';
    const pctStr = changePct != null ? `${fmt(changePct)}%` : 'N/A';
    const priceStr = price != null ? fmt(price, { currency: true }) : 'N/A';

    const sign = change != null && change >= 0 ? '+' : '';
    console.log(`\n  ${name} (${symbol})`);
    console.log(`    Price: ${priceStr}  Change: ${sign}${changeStr} (${sign}${pctStr})`);
  }

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `summary-${market}.json`);
  saveJson(cacheFile, results);

  console.log(`\n  ${results.length} indices returned.`);
}

// ---------------------------------------------------------------------------
// Command: status [--market=us_market]
// ---------------------------------------------------------------------------

async function cmdStatus(session, market) {
  const params = new URLSearchParams({
    formatted: 'true',
    key: 'finance',
    lang: 'en-US',
    market,
    crumb: session.crumb,
  });

  const url = `${QUERY1_URL}/v6/finance/markettime?${params}`;
  const data = await apiFetch(session, url);

  // Parse: finance.marketTimes[0].marketTime[0]
  const marketTimes = data?.finance?.marketTimes;
  if (!marketTimes || marketTimes.length === 0) {
    console.error(`No market time data returned for "${market}".`);
    process.exit(1);
  }

  const mt = marketTimes[0]?.marketTime?.[0];
  if (!mt) {
    console.error(`Unexpected market time response structure for "${market}".`);
    process.exit(1);
  }

  const tz = mt.timezone?.[0] || {};

  printSectionHeader(`Market Status - ${market}`);

  const rows = [];
  rows.push(['Market ID', fmt(mt.id)]);
  rows.push(['Open Time', fmt(mt.open)]);
  rows.push(['Close Time', fmt(mt.close)]);
  rows.push(['Timezone', fmt(tz.short || tz.long)]);
  rows.push(['GMT Offset', tz.gmtoffset != null ? `${tz.gmtoffset / 1000} hours` : 'N/A']);

  console.log();
  printTable(rows);

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `status-${market}.json`);
  saveJson(cacheFile, mt);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2]; else positional.push(arg);
  }
  return { flags, positional };
}

function printHelp() {
  console.log(`yahoofinance-markets -- Fetch Yahoo Finance market summary and status

Commands:
  auth                              Authenticate via Chrome CDP (one-time)
  summary [--market=us_market]      Market summary: indices with price & change
  status  [--market=us_market]      Market time/status: open, close, timezone

Markets:
  ${KNOWN_MARKETS.join(', ')}

Examples:
  node yahoofinance-markets.mjs auth
  node yahoofinance-markets.mjs summary
  node yahoofinance-markets.mjs summary --market=gb_market
  node yahoofinance-markets.mjs status
  node yahoofinance-markets.mjs status --market=jp_market

Data: ${DATA_DIR}/
  session.json     Auth cookies & crumb
  cache/           Cached API responses`);
}

const [,, command, ...args] = process.argv;
const { flags } = parseFlags(args);

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'summary': {
    const session = getSession();
    const market = flags.market || 'us_market';
    await cmdSummary(session, market);
    break;
  }

  case 'status': {
    const session = getSession();
    const market = flags.market || 'us_market';
    await cmdStatus(session, market);
    break;
  }

  default:
    printHelp();
    break;
}
