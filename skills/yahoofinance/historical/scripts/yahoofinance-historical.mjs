#!/usr/bin/env node
// yahoofinance-historical.mjs — Fetch historical price data, dividends, splits,
// and shares outstanding from Yahoo Finance.
//
// Setup (one-time, requires Chrome with Yahoo Finance open):
//   node yahoofinance-historical.mjs auth
//
// Usage:
//   node yahoofinance-historical.mjs prices AAPL
//   node yahoofinance-historical.mjs prices AAPL --period=1y --interval=1wk
//   node yahoofinance-historical.mjs prices AAPL --start=2023-01-01 --end=2024-01-01
//   node yahoofinance-historical.mjs dividends AAPL
//   node yahoofinance-historical.mjs splits AAPL --period=max
//   node yahoofinance-historical.mjs shares AAPL --start=2023-01-01
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHART_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart';
const TIMESERIES_BASE = 'https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';

const VALID_PERIODS = ['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'];
const VALID_INTERVALS = ['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo'];


// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-historical');
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
// Auth: fetch crumb via Chrome CDP
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open https://finance.yahoo.com in Chrome first.');
  console.log(`Using tab: ${tabId}`);

  console.log('Fetching crumb...');
  const { status, body } = cdpFetch(tabId, CRUMB_URL);
  if (status !== 200 || !body || body.length < 4 || body.includes('<html>')) {
    throw new Error(`Failed to fetch crumb: HTTP ${status} — ${body.substring(0, 200)}`);
  }

  const session = {
    crumb: body,
    capturedAt: new Date().toISOString(),
  };
  saveJson(SESSION_FILE, session);
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Crumb: ${body}`);
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session || !session.crumb) {
    console.error('No auth found. Run: node yahoofinance-historical.mjs auth');
    process.exit(1);
  }
  return session;
}

// ---------------------------------------------------------------------------
// HTTP helpers (all requests go through Chrome CDP)
// ---------------------------------------------------------------------------

function yahooFetch(session, url) {
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open https://finance.yahoo.com in Chrome first.');

  const { status, body } = cdpFetch(tabId, url);

  if (status === 401 || status === 403) {
    console.error(`Auth expired (HTTP ${status}). Run: node yahoofinance-historical.mjs auth`);
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Try again later.');
    process.exit(1);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${body.substring(0, 500)}`);
  }
  if (body.includes('Will be right back')) {
    throw new Error('Yahoo Finance is currently down. Try again later.');
  }

  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function dateToUnix(dateStr) {
  // Accept YYYY-MM-DD format
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  return Math.floor(d.getTime() / 1000);
}

function unixToISO(ts) {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

function unixToDatetime(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC');
}

// ---------------------------------------------------------------------------
// Command: prices
// ---------------------------------------------------------------------------

async function cmdPrices(session, symbol, flags) {
  const period = flags.period || (flags.start ? undefined : '1mo');
  const interval = flags.interval || '1d';
  const prepost = flags.prepost !== undefined;

  if (period && !VALID_PERIODS.includes(period)) {
    console.error(`Invalid period: ${period}. Valid: ${VALID_PERIODS.join(', ')}`);
    process.exit(1);
  }
  if (!VALID_INTERVALS.includes(interval)) {
    console.error(`Invalid interval: ${interval}. Valid: ${VALID_INTERVALS.join(', ')}`);
    process.exit(1);
  }

  const params = new URLSearchParams();
  params.set('interval', interval);
  params.set('includePrePost', prepost ? 'true' : 'false');
  params.set('events', 'div,splits,capitalGains');
  params.set('crumb', session.crumb);

  if (flags.start || flags.end) {
    const now = Math.floor(Date.now() / 1000);
    const p1 = flags.start ? dateToUnix(flags.start) : (flags.end ? dateToUnix(flags.end) - 2592000 : now - 2592000);
    const p2 = flags.end ? dateToUnix(flags.end) : now;
    params.set('period1', p1);
    params.set('period2', p2);
  } else {
    params.set('range', period);
  }

  const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?${params}`;
  const data = await yahooFetch(session, url);

  if (!data.chart || data.chart.error) {
    const errMsg = data.chart?.error?.description || 'Unknown error';
    throw new Error(`Yahoo API error: ${errMsg}`);
  }

  const result = data.chart.result?.[0];
  if (!result) throw new Error('No data returned for this symbol.');

  const meta = result.meta || {};
  const timestamps = result.timestamp;
  if (!timestamps || timestamps.length === 0) {
    console.log(JSON.stringify({ symbol: symbol.toUpperCase(), meta: { currency: meta.currency, timezone: meta.exchangeTimezoneName, instrumentType: meta.instrumentType }, prices: [] }, null, 2));
    return;
  }

  const quote = result.indicators.quote[0];
  const adjclose = result.indicators.adjclose?.[0]?.adjclose;
  const isIntraday = interval.endsWith('m') || interval.endsWith('h');

  const prices = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];

    // Skip null rows
    if (o == null && h == null && l == null && c == null) continue;

    const row = {
      date: isIntraday ? unixToDatetime(timestamps[i]) : unixToISO(timestamps[i]),
      open: o != null ? +o.toFixed(6) : null,
      high: h != null ? +h.toFixed(6) : null,
      low: l != null ? +l.toFixed(6) : null,
      close: c != null ? +c.toFixed(6) : null,
      volume: v != null ? v : null,
    };
    if (adjclose) {
      row.adjClose = adjclose[i] != null ? +adjclose[i].toFixed(6) : null;
    }
    prices.push(row);
  }

  const output = {
    symbol: symbol.toUpperCase(),
    meta: {
      currency: meta.currency,
      timezone: meta.exchangeTimezoneName,
      exchangeName: meta.exchangeName,
      instrumentType: meta.instrumentType,
      regularMarketPrice: meta.regularMarketPrice,
      previousClose: meta.previousClose ?? meta.chartPreviousClose,
    },
    count: prices.length,
    prices,
  };

  // Cache result
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `prices-${symbol.toUpperCase()}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: dividends
// ---------------------------------------------------------------------------

async function cmdDividends(session, symbol, flags) {
  const period = flags.period || 'max';

  const params = new URLSearchParams();
  params.set('interval', '1d');
  params.set('events', 'div');
  params.set('crumb', session.crumb);

  if (period === 'max') {
    // Fetch from ~99 years ago to now
    const now = Math.floor(Date.now() / 1000);
    params.set('period1', 0);
    params.set('period2', now);
  } else if (flags.start || flags.end) {
    const now = Math.floor(Date.now() / 1000);
    const p1 = flags.start ? dateToUnix(flags.start) : 0;
    const p2 = flags.end ? dateToUnix(flags.end) : now;
    params.set('period1', p1);
    params.set('period2', p2);
  } else {
    params.set('range', period);
  }

  const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?${params}`;
  const data = await yahooFetch(session, url);

  if (!data.chart || data.chart.error) {
    const errMsg = data.chart?.error?.description || 'Unknown error';
    throw new Error(`Yahoo API error: ${errMsg}`);
  }

  const result = data.chart.result?.[0];
  if (!result) throw new Error('No data returned for this symbol.');

  const meta = result.meta || {};
  const events = result.events || {};
  const dividendsMap = events.dividends || {};

  const dividends = Object.values(dividendsMap)
    .map(d => ({
      date: unixToISO(d.date),
      amount: d.amount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const output = {
    symbol: symbol.toUpperCase(),
    currency: meta.currency,
    count: dividends.length,
    dividends,
  };

  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `dividends-${symbol.toUpperCase()}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: splits
// ---------------------------------------------------------------------------

async function cmdSplits(session, symbol, flags) {
  const period = flags.period || 'max';

  const params = new URLSearchParams();
  params.set('interval', '1d');
  params.set('events', 'split');
  params.set('crumb', session.crumb);

  if (period === 'max') {
    const now = Math.floor(Date.now() / 1000);
    params.set('period1', 0);
    params.set('period2', now);
  } else if (flags.start || flags.end) {
    const now = Math.floor(Date.now() / 1000);
    const p1 = flags.start ? dateToUnix(flags.start) : 0;
    const p2 = flags.end ? dateToUnix(flags.end) : now;
    params.set('period1', p1);
    params.set('period2', p2);
  } else {
    params.set('range', period);
  }

  const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?${params}`;
  const data = await yahooFetch(session, url);

  if (!data.chart || data.chart.error) {
    const errMsg = data.chart?.error?.description || 'Unknown error';
    throw new Error(`Yahoo API error: ${errMsg}`);
  }

  const result = data.chart.result?.[0];
  if (!result) throw new Error('No data returned for this symbol.');

  const meta = result.meta || {};
  const events = result.events || {};
  const splitsMap = events.splits || {};

  const splits = Object.values(splitsMap)
    .map(s => ({
      date: unixToISO(s.date),
      numerator: s.numerator,
      denominator: s.denominator,
      ratio: `${s.numerator}:${s.denominator}`,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const output = {
    symbol: symbol.toUpperCase(),
    count: splits.length,
    splits,
  };

  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `splits-${symbol.toUpperCase()}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: shares
// ---------------------------------------------------------------------------

async function cmdShares(session, symbol, flags) {
  const now = Math.floor(Date.now() / 1000);
  // Default: last 18 months (matching yfinance behavior)
  const p1 = flags.start ? dateToUnix(flags.start) : now - (548 * 86400);
  const p2 = flags.end ? dateToUnix(flags.end) : now;

  const types = 'quarterlyOrdinarySharesNumber,annualOrdinarySharesNumber';
  const url = `${TIMESERIES_BASE}/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${p1}&period2=${p2}&crumb=${encodeURIComponent(session.crumb)}`;

  const data = await yahooFetch(session, url);

  if (data.finance?.error) {
    throw new Error(`Yahoo API error: ${data.finance.error.description || data.finance.error.code}`);
  }

  const results = data.timeseries?.result || [];
  const sharesEntries = [];

  for (const series of results) {
    // Check for quarterly or annual data
    const quarterly = series.quarterlyOrdinarySharesNumber || [];
    const annual = series.annualOrdinarySharesNumber || [];
    const combined = [...quarterly, ...annual];

    for (const entry of combined) {
      if (entry && entry.asOfDate && entry.reportedValue) {
        sharesEntries.push({
          date: entry.asOfDate,
          sharesOutstanding: entry.reportedValue.raw,
        });
      }
    }
  }

  // Deduplicate by date (prefer quarterly over annual) and sort
  const seen = new Map();
  for (const e of sharesEntries) {
    if (!seen.has(e.date) || e.sharesOutstanding != null) {
      seen.set(e.date, e);
    }
  }
  const shares = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));

  const output = {
    symbol: symbol.toUpperCase(),
    count: shares.length,
    shares,
  };

  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `shares-${symbol.toUpperCase()}.json`);
  saveJson(cacheFile, output);

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--([a-zA-Z][\w-]*)(?:=(.+))?$/);
    if (m) {
      flags[m[1]] = m[2] !== undefined ? m[2] : true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function printHelp() {
  console.log(`yahoofinance-historical -- Fetch historical price data from Yahoo Finance

Commands:
  auth                                  Authenticate via Chrome (one-time)
  prices <symbol> [options]             Fetch OHLCV price history
  dividends <symbol> [options]          Fetch dividend history
  splits <symbol> [options]             Fetch stock split history
  shares <symbol> [options]             Fetch shares outstanding over time

Price options:
  --period=<period>       Range period (default: 1mo)
                          Valid: ${VALID_PERIODS.join(', ')}
  --interval=<interval>   Bar interval (default: 1d)
                          Valid: ${VALID_INTERVALS.join(', ')}
  --start=YYYY-MM-DD      Start date (overrides period)
  --end=YYYY-MM-DD        End date (default: now)
  --prepost               Include pre/post market data

Dividend/Split options:
  --period=<period>       Range period (default: max)
  --start=YYYY-MM-DD      Start date
  --end=YYYY-MM-DD        End date

Shares options:
  --start=YYYY-MM-DD      Start date (default: 18 months ago)
  --end=YYYY-MM-DD        End date (default: now)

Examples:
  node yahoofinance-historical.mjs prices AAPL
  node yahoofinance-historical.mjs prices MSFT --period=1y --interval=1wk
  node yahoofinance-historical.mjs prices TSLA --start=2023-01-01 --end=2024-01-01
  node yahoofinance-historical.mjs prices SPY --interval=5m --period=5d --prepost
  node yahoofinance-historical.mjs dividends AAPL --period=max
  node yahoofinance-historical.mjs splits AAPL
  node yahoofinance-historical.mjs shares AAPL --start=2020-01-01

Data: ${DATA_DIR}/
  session.json     Auth cookies, crumb & user-agent
  cache/           Cached JSON responses`);
}

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'prices': {
      const { flags, positional } = parseFlags(args);
      const symbol = positional[0];
      if (!symbol) {
        console.error('Usage: node yahoofinance-historical.mjs prices <symbol> [--period=1mo] [--interval=1d] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--prepost]');
        process.exit(1);
      }
      const session = getSession();
      await cmdPrices(session, symbol, flags);
      break;
    }

    case 'dividends': {
      const { flags, positional } = parseFlags(args);
      const symbol = positional[0];
      if (!symbol) {
        console.error('Usage: node yahoofinance-historical.mjs dividends <symbol> [--period=max]');
        process.exit(1);
      }
      const session = getSession();
      await cmdDividends(session, symbol, flags);
      break;
    }

    case 'splits': {
      const { flags, positional } = parseFlags(args);
      const symbol = positional[0];
      if (!symbol) {
        console.error('Usage: node yahoofinance-historical.mjs splits <symbol> [--period=max]');
        process.exit(1);
      }
      const session = getSession();
      await cmdSplits(session, symbol, flags);
      break;
    }

    case 'shares': {
      const { flags, positional } = parseFlags(args);
      const symbol = positional[0];
      if (!symbol) {
        console.error('Usage: node yahoofinance-historical.mjs shares <symbol> [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]');
        process.exit(1);
      }
      const session = getSession();
      await cmdShares(session, symbol, flags);
      break;
    }

    default:
      printHelp();
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
