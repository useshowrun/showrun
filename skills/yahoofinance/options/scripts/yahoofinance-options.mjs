#!/usr/bin/env node
// yahoofinance-options.mjs — Fetch options chains from Yahoo Finance
//
// Setup (one-time, requires Chrome with Yahoo Finance open):
//   node yahoofinance-options.mjs auth
//
// Usage:
//   node yahoofinance-options.mjs expirations AAPL
//   node yahoofinance-options.mjs chain AAPL
//   node yahoofinance-options.mjs chain AAPL --date=2026-04-17
//
// All API requests are routed through Chrome CDP (no direct HTTP).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-options');
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
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://query2.finance.yahoo.com';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';

// ---------------------------------------------------------------------------
// Auth: fetch crumb via Chrome CDP
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');

  console.log(`Using tab: ${tabId}`);
  console.log('Fetching crumb...');

  const { status, body } = cdpFetch(tabId, CRUMB_URL);
  if (status !== 200 || !body || body.includes('<html>')) {
    throw new Error(`Failed to fetch crumb (HTTP ${status}). Try refreshing Yahoo Finance in Chrome.`);
  }

  const crumb = body.trim();
  console.log(`Crumb: ${crumb}`);

  saveJson(SESSION_FILE, {
    crumb,
    capturedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.crumb) {
    console.error('No auth found. Run: node yahoofinance-options.mjs auth');
    process.exit(1);
  }
  return session;
}

function yahooGet(session, url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}crumb=${encodeURIComponent(session.crumb)}`;

  const tabId = findYahooTab();
  if (!tabId) {
    console.error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
    process.exit(1);
  }

  const { status, body } = cdpFetch(tabId, fullUrl);

  if (status === 401 || status === 403) {
    console.error('Session expired or unauthorized. Run: node yahoofinance-options.mjs auth');
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited by Yahoo Finance. Wait a moment and try again.');
    process.exit(1);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${body.substring(0, 200)}`);
  }

  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Options data helpers
// ---------------------------------------------------------------------------

function unixToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function unixToISO(ts) {
  return new Date(ts * 1000).toISOString();
}

function dateToUnix(dateStr) {
  // dateStr is YYYY-MM-DD
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}

function formatOption(opt) {
  return {
    contractSymbol: opt.contractSymbol,
    lastTradeDate: opt.lastTradeDate ? unixToISO(opt.lastTradeDate) : null,
    strike: opt.strike,
    lastPrice: opt.lastPrice,
    bid: opt.bid,
    ask: opt.ask,
    change: opt.change,
    percentChange: opt.percentChange,
    volume: opt.volume,
    openInterest: opt.openInterest,
    impliedVolatility: opt.impliedVolatility,
    inTheMoney: opt.inTheMoney,
    contractSize: opt.contractSize,
    currency: opt.currency,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fetchOptions(session, symbol, date) {
  let url = `${BASE_URL}/v7/finance/options/${encodeURIComponent(symbol.toUpperCase())}`;
  if (date != null) {
    url += `?date=${date}`;
  }
  return yahooGet(session, url);
}

function cmdExpirations(session, symbol) {
  const data = fetchOptions(session, symbol);
  const result = data?.optionChain?.result?.[0];
  if (!result) {
    console.error(`No options data found for ${symbol.toUpperCase()}.`);
    process.exit(1);
  }

  const expirations = (result.expirationDates || []).map(ts => ({
    unix: ts,
    date: unixToDate(ts),
  }));

  const output = {
    symbol: symbol.toUpperCase(),
    expirations: expirations.map(e => e.date),
    expirationTimestamps: expirations.map(e => e.unix),
  };

  // Save to cache
  const cacheFile = resolve(CACHE_DIR, `expirations-${symbol.toUpperCase()}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
}

function cmdChain(session, symbol, dateStr) {
  let unixDate;
  if (dateStr) {
    unixDate = dateToUnix(dateStr);
  }

  const data = fetchOptions(session, symbol, unixDate);
  const result = data?.optionChain?.result?.[0];
  if (!result) {
    console.error(`No options data found for ${symbol.toUpperCase()}.`);
    process.exit(1);
  }

  const opts = result.options?.[0];
  if (!opts) {
    console.error(`No options chain available for ${symbol.toUpperCase()}${dateStr ? ' on ' + dateStr : ''}.`);
    process.exit(1);
  }

  // Extract underlying quote info
  const quote = result.quote || {};
  const underlying = {
    symbol: quote.symbol,
    shortName: quote.shortName,
    longName: quote.longName,
    regularMarketPrice: quote.regularMarketPrice,
    regularMarketChange: quote.regularMarketChange,
    regularMarketChangePercent: quote.regularMarketChangePercent,
    regularMarketTime: quote.regularMarketTime ? unixToISO(quote.regularMarketTime) : null,
    marketState: quote.marketState,
    exchange: quote.exchange,
    currency: quote.currency,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
  };

  const calls = (opts.calls || []).map(formatOption);
  const puts = (opts.puts || []).map(formatOption);

  const output = {
    symbol: symbol.toUpperCase(),
    expirationDate: dateStr || (opts.expirationDate ? unixToDate(opts.expirationDate) : null),
    underlying,
    calls,
    puts,
  };

  // Save to cache
  const suffix = dateStr ? `-${dateStr}` : '';
  const cacheFile = resolve(CACHE_DIR, `chain-${symbol.toUpperCase()}${suffix}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
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
    doAuth();
    break;
  }

  case 'expirations': {
    const symbol = args[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-options.mjs expirations <symbol>');
      process.exit(1);
    }
    const session = getSession();
    cmdExpirations(session, symbol);
    break;
  }

  case 'chain': {
    const { flags, positional } = parseFlags(args);
    const symbol = positional[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-options.mjs chain <symbol> [--date=YYYY-MM-DD]');
      process.exit(1);
    }
    const session = getSession();
    cmdChain(session, symbol, flags.date || null);
    break;
  }

  default:
    console.log(`yahoofinance-options — Fetch options chains from Yahoo Finance

Commands:
  auth                                    Authenticate via Chrome (one-time)
  expirations <symbol>                    List available expiration dates
  chain <symbol> [--date=YYYY-MM-DD]      Fetch options chain (calls + puts)

Examples:
  node yahoofinance-options.mjs auth
  node yahoofinance-options.mjs expirations AAPL
  node yahoofinance-options.mjs chain AAPL
  node yahoofinance-options.mjs chain AAPL --date=2026-04-17

Data: ${DATA_DIR}/
  session.json     Auth crumb
  cache/           Cached API responses`);
}
