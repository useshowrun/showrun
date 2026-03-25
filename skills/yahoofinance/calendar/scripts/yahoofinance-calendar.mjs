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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

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
// Auth
// ---------------------------------------------------------------------------
async function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['finance.yahoo.com', 'yahoo.com/quote', 'yahoo.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) { target = line.trim().split(/\s+/)[0]; break; }
    }
    if (target) break;
  }
  if (!target) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://finance.yahoo.com', 'https://www.yahoo.com', 'https://query1.finance.yahoo.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieStr = cookies.filter(c => c.domain.includes('yahoo.com')).map(c => `${c.name}=${c.value}`).join('; ');
  if (!cookieStr) throw new Error('No Yahoo cookies found.');

  let userAgent = USER_AGENT;
  try { const ua = cdp('eval', target, 'navigator.userAgent'); if (ua && ua.length > 10) userAgent = ua; } catch {}

  console.log('Fetching crumb...');
  const crumbResp = await fetch(CRUMB_URL, { headers: { 'Cookie': cookieStr, 'User-Agent': userAgent }, redirect: 'follow' });
  if (!crumbResp.ok) throw new Error(`Failed to fetch crumb: HTTP ${crumbResp.status}`);
  const crumb = await crumbResp.text();
  if (!crumb || crumb.includes('<html>') || crumb.includes('Too Many Requests')) throw new Error(`Invalid crumb: ${crumb.substring(0, 100)}`);

  const session = { cookies: cookieStr, crumb, userAgent, capturedAt: new Date().toISOString() };
  saveJson(SESSION_FILE, session);
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Crumb: ${crumb}`);
}

// ---------------------------------------------------------------------------
// Session / HTTP helpers
// ---------------------------------------------------------------------------
function getSession() {
  const s = loadJson(SESSION_FILE);
  if (!s || !s.cookies || !s.crumb) { console.error('No auth. Run: node yahoofinance-calendar.mjs auth'); process.exit(1); }
  return s;
}

async function vizPost(session, body) {
  const url = `${VIZ_URL}?lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': session.cookies,
      'User-Agent': session.userAgent || USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) { console.error(`Auth expired (${resp.status}). Run: node yahoofinance-calendar.mjs auth`); process.exit(1); }
  if (resp.status === 429) { console.error('Rate limited (429). Wait and retry.'); process.exit(1); }
  const data = await resp.json();
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
async function cmdEarnings(args) {
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

  const data = await vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `earnings-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

async function cmdEarningsTicker(symbol, args) {
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

  const data = await vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `earnings-${symbol}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

async function cmdIpos(args) {
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

  const data = await vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `ipos-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

async function cmdSplits(args) {
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

  const data = await vizPost(session, body);
  const { columns, rows } = parseVizResponse(data);
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `splits-${start}-${end}.json`), { columns, rows });
  console.log(JSON.stringify({ columns, rows, count: rows.length }, null, 2));
}

async function cmdEconomic(args) {
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

  const data = await vizPost(session, body);
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
    case 'auth': await doAuth(); break;
    case 'earnings': await cmdEarnings(rest); break;
    case 'earnings-ticker': {
      const sym = rest[0]?.toUpperCase();
      if (!sym || sym.startsWith('--')) { console.error('Usage: earnings-ticker <symbol> [--count=25]'); process.exit(1); }
      await cmdEarningsTicker(sym, rest.slice(1));
      break;
    }
    case 'ipos': await cmdIpos(rest); break;
    case 'splits': await cmdSplits(rest); break;
    case 'economic': await cmdEconomic(rest); break;
    default: console.error(`Unknown command: ${cmd}`); printHelp(); process.exit(1);
  }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
