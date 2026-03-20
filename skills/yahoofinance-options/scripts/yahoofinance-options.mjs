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
// Requires Node 22+ (built-in fetch).

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
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://query2.finance.yahoo.com';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

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
  if (!target) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');

  console.log(`Using tab: ${target}`);

  // Extract cookies via CDP
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://finance.yahoo.com', 'https://query2.finance.yahoo.com'] }));
  const { cookies } = JSON.parse(raw);

  // Build cookie string from .yahoo.com domain cookies
  const yahooCookies = cookies.filter(c => c.domain.includes('yahoo.com'));
  if (!yahooCookies.length) throw new Error('No Yahoo cookies found. Are you logged in to Yahoo Finance?');

  const cookieStr = yahooCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Check for A3 cookie specifically
  const a3 = yahooCookies.find(c => c.name === 'A3');
  if (!a3) console.warn('Warning: A3 cookie not found. Auth may not work for all endpoints.');

  // Fetch crumb using the cookies
  console.log('Fetching crumb...');
  const crumbResp = await fetch(CRUMB_URL, {
    headers: {
      'cookie': cookieStr,
      'user-agent': USER_AGENT,
    },
  });
  if (!crumbResp.ok) throw new Error(`Failed to fetch crumb (HTTP ${crumbResp.status})`);
  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes('<html>')) throw new Error('Invalid crumb response. Try refreshing Yahoo Finance in Chrome.');

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
    console.error('No auth found. Run: node yahoofinance-options.mjs auth');
    process.exit(1);
  }
  return auth;
}

async function yahooGet(auth, url) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}crumb=${encodeURIComponent(auth.crumb)}`;
  const resp = await fetch(fullUrl, {
    headers: {
      'cookie': auth.cookie,
      'user-agent': USER_AGENT,
      'accept': 'application/json',
    },
  });
  if (resp.status === 401 || resp.status === 403) {
    console.error('Session expired or unauthorized. Run: node yahoofinance-options.mjs auth');
    process.exit(1);
  }
  if (resp.status === 429) {
    console.error('Rate limited by Yahoo Finance. Wait a moment and try again.');
    process.exit(1);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
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

async function fetchOptions(auth, symbol, date) {
  let url = `${BASE_URL}/v7/finance/options/${encodeURIComponent(symbol.toUpperCase())}`;
  if (date != null) {
    url += `?date=${date}`;
  }
  return yahooGet(auth, url);
}

async function cmdExpirations(auth, symbol) {
  const data = await fetchOptions(auth, symbol);
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

async function cmdChain(auth, symbol, dateStr) {
  let unixDate;
  if (dateStr) {
    unixDate = dateToUnix(dateStr);
  }

  const data = await fetchOptions(auth, symbol, unixDate);
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
    await doAuth();
    break;
  }

  case 'expirations': {
    const symbol = args[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-options.mjs expirations <symbol>');
      process.exit(1);
    }
    const auth = getAuth();
    await cmdExpirations(auth, symbol);
    break;
  }

  case 'chain': {
    const { flags, positional } = parseFlags(args);
    const symbol = positional[0];
    if (!symbol) {
      console.error('Usage: node yahoofinance-options.mjs chain <symbol> [--date=YYYY-MM-DD]');
      process.exit(1);
    }
    const auth = getAuth();
    await cmdChain(auth, symbol, flags.date || null);
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
  session.json     Auth cookie & crumb
  cache/           Cached API responses`);
}
