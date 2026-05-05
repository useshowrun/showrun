#!/usr/bin/env node
// yahoofinance-calendar.mjs — Fetch financial calendars (earnings, IPOs, splits, economic events)
//
// All calendar types use the Yahoo Finance visualization API:
// POST https://query1.finance.yahoo.com/v1/finance/visualization
//
// Setup:  node yahoofinance-calendar.mjs auth
// Usage:  node yahoofinance-calendar.mjs earnings --start=2026-03-17 --end=2026-03-21
//         node yahoofinance-calendar.mjs earnings-ticker AAPL --count=25
//         node yahoofinance-calendar.mjs ipos --start=2026-03-17 --end=2026-03-24
//         node yahoofinance-calendar.mjs splits --start=2026-03-17 --end=2026-03-24
//         node yahoofinance-calendar.mjs economic --start=2026-03-17 --end=2026-03-24

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUERY1_URL = 'https://query1.finance.yahoo.com';
const VIZ_URL = `${QUERY1_URL}/v1/finance/visualization`;
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

// Calendar type configs (from yfinance calendars.py PREDEFINED_CALENDARS)
const CALENDAR_CONFIGS = {
  sp_earnings: {
    sortField: 'intradaymarketcap',
    includeFields: ['ticker', 'companyshortname', 'intradaymarketcap', 'eventname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct'],
  },
  ipo_info: {
    sortField: 'startdatetime',
    includeFields: ['ticker', 'companyshortname', 'exchange_short_name', 'filingdate', 'startdatetime', 'amendeddate', 'pricefrom', 'priceto', 'offerprice', 'currencyname', 'shares', 'dealtype'],
  },
  economic_event: {
    sortField: 'startdatetime',
    includeFields: ['econ_release', 'country_code', 'startdatetime', 'period', 'after_release_actual', 'consensus_estimate', 'prior_release_actual', 'originally_reported_actual'],
  },
  splits: {
    sortField: 'startdatetime',
    includeFields: ['ticker', 'companyshortname', 'startdatetime', 'optionable', 'old_share_worth', 'share_worth'],
  },
};

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-calendar');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(p) { if (!existsSync(p)) return null; return JSON.parse(readFileSync(p, 'utf8')); }
function saveJson(p, data) { ensureDir(resolve(p, '..')); writeFileSync(p, JSON.stringify(data, null, 2)); }

// ---------------------------------------------------------------------------
// CDP
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
// Auth
// ---------------------------------------------------------------------------
function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
  console.log(`Using tab: ${tabId}`);

  console.log('Fetching crumb...');
  const resp = cdpFetch(tabId, CRUMB_URL);
  const crumb = resp.body.trim();
  if (resp.status !== 200 || !crumb || crumb.includes('<html>')) {
    throw new Error(`Failed to fetch crumb: HTTP ${resp.status} — ${crumb.substring(0, 100)}`);
  }
  console.log('  Got crumb via Chrome CDP.');

  const session = { crumb, capturedAt: new Date().toISOString() };
  saveJson(SESSION_FILE, session);
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Crumb: ${crumb}`);
}

// ---------------------------------------------------------------------------
// Session / HTTP helpers
// ---------------------------------------------------------------------------
function getSession() {
  const s = loadJson(SESSION_FILE);
  if (!s || !s.crumb) { console.error('No auth. Run: node yahoofinance-calendar.mjs auth'); process.exit(1); }
  return s;
}

function vizPost(session, body) {
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
  const url = `${VIZ_URL}?lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const resp = cdpFetch(tabId, url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) { console.error(`Auth expired (${resp.status}). Run: node yahoofinance-calendar.mjs auth`); process.exit(1); }
  if (resp.status === 429) { console.error('Rate limited (HTTP 429). Wait and try again.'); process.exit(1); }
  if (resp.status !== 200) { console.error(`HTTP ${resp.status}: ${resp.body.substring(0, 200)}`); process.exit(1); }
  const data = JSON.parse(resp.body);
  if (data?.finance?.error) { console.error('API error:', JSON.stringify(data.finance.error)); process.exit(1); }
  return data;
}

function parseVizResponse(data) {
  const doc = data?.finance?.result?.[0]?.documents?.[0];
  if (!doc) return { columns: [], rows: [] };
  const columns = doc.columns.map(c => c.label);
  return { columns, rows: doc.rows };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const opts = {};
  for (const a of args) {
    const m = a.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) opts[m[1]] = m[2];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
  }
  return opts;
}

function defaultDates(opts) {
  const today = new Date();
  const start = opts.start || today.toISOString().slice(0, 10);
  const endDate = opts.end || new Date(new Date(start).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  return { start, end: endDate };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdEarnings(args) {
  const opts = parseArgs(args);
  const { start, end } = defaultDates(opts);
  const limit = parseInt(opts.count || '50', 10);
  const offset = parseInt(opts.offset || '0', 10);
  const session = getSession();

  const body = {
    sortType: 'DESC',
    entityIdType: 'sp_earnings',
    sortField: CALENDAR_CONFIGS.sp_earnings.sortField,
    includeFields: CALENDAR_CONFIGS.sp_earnings.includeFields,
    size: Math.min(limit, 100),
    offset,
    query: {
      operator: 'AND',
      operands: [
        { operator: 'EQ', operands: ['region', 'us'] },
        { operator: 'OR', operands: [
          { operator: 'EQ', operands: ['eventtype', 'EAD'] },
          { operator: 'EQ', operands: ['eventtype', 'ERA'] },
        ]},
        { operator: 'GTE', operands: ['startdatetime', start] },
        { operator: 'LTE', operands: ['startdatetime', end] },
      ],
    },
  };

  const data = vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `earnings-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

function cmdEarningsTicker(symbol, args) {
  const opts = parseArgs(args);
  const limit = parseInt(opts.count || '25', 10);
  const session = getSession();

  const body = {
    size: Math.min(limit, 100),
    query: { operator: 'eq', operands: ['ticker', symbol] },
    sortField: 'startdatetime',
    sortType: 'DESC',
    entityIdType: 'earnings',
    includeFields: ['startdatetime', 'timeZoneShortName', 'epsestimate', 'epsactual', 'epssurprisepct', 'eventtype'],
  };

  const data = vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `earnings-${symbol}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

function cmdIpos(args) {
  const opts = parseArgs(args);
  const { start, end } = defaultDates(opts);
  const limit = parseInt(opts.count || '50', 10);
  const offset = parseInt(opts.offset || '0', 10);
  const session = getSession();

  const body = {
    sortType: 'DESC',
    entityIdType: 'ipo_info',
    sortField: CALENDAR_CONFIGS.ipo_info.sortField,
    includeFields: CALENDAR_CONFIGS.ipo_info.includeFields,
    size: Math.min(limit, 100),
    offset,
    query: {
      operator: 'OR',
      operands: [
        { operator: 'GTELT', operands: ['startdatetime', start, end] },
        { operator: 'GTELT', operands: ['filingdate', start, end] },
        { operator: 'GTELT', operands: ['amendeddate', start, end] },
      ],
    },
  };

  const data = vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `ipos-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

function cmdSplits(args) {
  const opts = parseArgs(args);
  const { start, end } = defaultDates(opts);
  const limit = parseInt(opts.count || '50', 10);
  const offset = parseInt(opts.offset || '0', 10);
  const session = getSession();

  const body = {
    sortType: 'DESC',
    entityIdType: 'splits',
    sortField: CALENDAR_CONFIGS.splits.sortField,
    includeFields: CALENDAR_CONFIGS.splits.includeFields,
    size: Math.min(limit, 100),
    offset,
    query: {
      operator: 'AND',
      operands: [
        { operator: 'GTE', operands: ['startdatetime', start] },
        { operator: 'LTE', operands: ['startdatetime', end] },
      ],
    },
  };

  const data = vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `splits-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

function cmdEconomic(args) {
  const opts = parseArgs(args);
  const { start, end } = defaultDates(opts);
  const limit = parseInt(opts.count || '50', 10);
  const offset = parseInt(opts.offset || '0', 10);
  const session = getSession();

  const body = {
    sortType: 'DESC',
    entityIdType: 'economic_event',
    sortField: CALENDAR_CONFIGS.economic_event.sortField,
    includeFields: CALENDAR_CONFIGS.economic_event.includeFields,
    size: Math.min(limit, 100),
    offset,
    query: {
      operator: 'AND',
      operands: [
        { operator: 'GTE', operands: ['startdatetime', start] },
        { operator: 'LTE', operands: ['startdatetime', end] },
      ],
    },
  };

  const data = vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `economic-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`yahoofinance-calendar -- Fetch financial event calendars from Yahoo Finance

All calendar types use Yahoo's visualization API (no HTML scraping).

Commands:
  auth                                          Authenticate via Chrome CDP (one-time)
  earnings [--start=YYYY-MM-DD] [--end=...]     Earnings calendar (defaults: today + 7 days)
           [--count=50] [--offset=0]
  earnings-ticker <symbol> [--count=25]         Earnings history for a specific ticker
  ipos [--start=YYYY-MM-DD] [--end=...]         IPO calendar
       [--count=50] [--offset=0]
  splits [--start=YYYY-MM-DD] [--end=...]       Stock splits calendar
         [--count=50] [--offset=0]
  economic [--start=YYYY-MM-DD] [--end=...]     Economic events calendar
           [--count=50] [--offset=0]

Examples:
  node yahoofinance-calendar.mjs auth
  node yahoofinance-calendar.mjs earnings --start=2026-03-17 --end=2026-03-21
  node yahoofinance-calendar.mjs earnings-ticker AAPL --count=20
  node yahoofinance-calendar.mjs ipos --start=2026-03-01 --end=2026-03-31
  node yahoofinance-calendar.mjs splits --start=2026-03-17 --end=2026-03-24
  node yahoofinance-calendar.mjs economic --start=2026-03-17 --end=2026-03-21`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) { printHelp(); process.exit(0); }

try {
  switch (cmd) {
    case 'auth': doAuth(); break;
    case 'earnings': cmdEarnings(rest); break;
    case 'earnings-ticker': {
      const sym = rest[0]?.toUpperCase();
      if (!sym || sym.startsWith('--')) { console.error('Usage: earnings-ticker <symbol> [--count=25]'); process.exit(1); }
      cmdEarningsTicker(sym, rest.slice(1));
      break;
    }
    case 'ipos': cmdIpos(rest); break;
    case 'splits': cmdSplits(rest); break;
    case 'economic': cmdEconomic(rest); break;
    default: console.error(`Unknown command: ${cmd}`); printHelp(); process.exit(1);
  }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
