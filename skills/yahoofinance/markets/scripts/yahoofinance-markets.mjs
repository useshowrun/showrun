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
// Requires Chrome with finance.yahoo.com open (all API calls go through Chrome CDP).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUERY1_URL = 'https://query1.finance.yahoo.com';
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

function findYahooTab() {
  const list = cdp('list');
  for (const pref of ['finance.yahoo.com', 'yahoo.com/quote', 'yahoo.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) return line.trim().split(/\s+/)[0];
    }
  }
  return null;
}

function cdpFetch(tabId, url, options = {}) {
  const method = options.method || 'GET';
  const hdrs = options.headers ? `,headers:${JSON.stringify(options.headers)}` : '';
  const bodyPart = options.body ? `,body:${JSON.stringify(String(options.body))}` : '';

  const result = cdp('eval', tabId,
    `(async()=>{const r=await fetch('${url}',{method:'${method}',credentials:'include'${hdrs}${bodyPart}});return r.status+'|||'+(await r.text())})()`);

  const sepIdx = result.indexOf('|||');
  const status = parseInt(result.substring(0, sepIdx), 10);
  const body = result.substring(sepIdx + 3);
  return { status, body };
}

// ---------------------------------------------------------------------------
// Auth: fetch crumb from Chrome via CDP
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const target = findYahooTab();
  if (!target) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');

  console.log(`Using tab: ${target}`);
  console.log('Fetching crumb...');

  const { status, body } = cdpFetch(target, CRUMB_URL);

  if (status !== 200 || !body || body.length <= 3 || body.includes('<html>')) {
    throw new Error(`Failed to fetch crumb: HTTP ${status} — ${body.substring(0, 100)}`);
  }

  const crumb = body;
  const session = {
    crumb,
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
  if (!session || !session.crumb) {
    console.error('No auth found. Run: node yahoofinance-markets.mjs auth');
    process.exit(1);
  }
  return session;
}

// ---------------------------------------------------------------------------
// API fetch via Chrome CDP
// ---------------------------------------------------------------------------

function apiFetch(session, url, options = {}) {
  const target = findYahooTab();
  if (!target) {
    console.error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome.');
    process.exit(1);
  }

  const { status, body } = cdpFetch(target, url, options);

  if (status === 401 || status === 403) {
    console.error(`Auth expired (HTTP ${status}). Run: node yahoofinance-markets.mjs auth`);
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Try again in a few minutes.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('Not found (HTTP 404). Check parameters and try again.');
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(body); } catch { data = body; }

  if (status < 200 || status >= 300) {
    console.error(`HTTP ${status}: ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
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
  // The v6 marketSummary endpoint expects a two-letter region code (US, GB, JP…),
  // not the `*_market` identifier used by the status endpoint. Strip the suffix
  // and uppercase to keep `--market=us_market` working for both commands.
  const region = market.replace(/_market$/, '').toUpperCase();
  const params = new URLSearchParams({
    fields: 'shortName,regularMarketPrice,regularMarketChange,regularMarketChangePercent',
    formatted: 'false',
    lang: 'en-US',
    region,
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
  session.json     Auth crumb
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
