#!/usr/bin/env node
// yahoofinance-screener.mjs — Yahoo Finance stock/fund screener
//
// Setup (one-time, requires Chrome with Yahoo Finance open):
//   node yahoofinance-screener.mjs auth
//
// Usage:
//   node yahoofinance-screener.mjs predefined most_actives --count=10
//   node yahoofinance-screener.mjs search --query='[{"op":"gt","field":"percentchange","val":3}]'
//   node yahoofinance-screener.mjs fields
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
const SCREENER_URL = `${QUERY1_URL}/v1/finance/screener`;
const PREDEFINED_URL = `${SCREENER_URL}/predefined/saved`;
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;
const COOKIE_URL = 'https://fc.yahoo.com';

const MAX_RESULTS = 250;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const PREDEFINED_NAMES = [
  'most_actives', 'day_gainers', 'day_losers', 'most_shorted_stocks',
  'aggressive_small_caps', 'undervalued_growth_stocks', 'undervalued_large_caps',
  'small_cap_gainers', 'growth_technology_stocks',
  'top_mutual_funds', 'high_yield_bond', 'portfolio_anchors',
  'solid_large_growth_funds', 'solid_midcap_growth_funds', 'conservative_foreign_funds',
];

const VALID_OPERATORS = ['gt', 'lt', 'gte', 'lte', 'btwn', 'eq', 'is-in'];

// ---------------------------------------------------------------------------
// Screener fields (from yfinance EQUITY_SCREENER_FIELDS)
// ---------------------------------------------------------------------------

const SCREENER_FIELDS = {
  eq_fields: [
    'region', 'sector', 'peer_group', 'industry', 'exchange',
  ],
  price: [
    'eodprice', 'intradaypricechange', 'intradayprice',
    'lastclosemarketcap.lasttwelvemonths', 'percentchange',
    'lastclose52weekhigh.lasttwelvemonths', 'fiftytwowkpercentchange',
    'lastclose52weeklow.lasttwelvemonths', 'intradaymarketcap',
  ],
  trading: [
    'beta', 'avgdailyvol3m', 'pctheldinsider', 'pctheldinst',
    'dayvolume', 'eodvolume',
  ],
  short_interest: [
    'short_percentage_of_shares_outstanding.value', 'short_interest.value',
    'short_percentage_of_float.value', 'days_to_cover_short.value',
    'short_interest_percentage_change.value',
  ],
  valuation: [
    'bookvalueshare.lasttwelvemonths', 'lastclosemarketcaptotalrevenue.lasttwelvemonths',
    'lastclosetevtotalrevenue.lasttwelvemonths', 'pricebookratio.quarterly',
    'peratio.lasttwelvemonths', 'lastclosepricetangiblebookvalue.lasttwelvemonths',
    'lastclosepriceearnings.lasttwelvemonths', 'pegratio_5y',
  ],
  profitability: [
    'consecutive_years_of_dividend_growth_count', 'returnonassets.lasttwelvemonths',
    'returnonequity.lasttwelvemonths', 'forward_dividend_per_share',
    'forward_dividend_yield', 'returnontotalcapital.lasttwelvemonths',
  ],
  leverage: [
    'lastclosetevebit.lasttwelvemonths', 'netdebtebitda.lasttwelvemonths',
    'totaldebtequity.lasttwelvemonths', 'ltdebtequity.lasttwelvemonths',
    'ebitinterestexpense.lasttwelvemonths', 'ebitdainterestexpense.lasttwelvemonths',
    'lastclosetevebitda.lasttwelvemonths', 'totaldebtebitda.lasttwelvemonths',
  ],
  liquidity: [
    'quickratio.lasttwelvemonths',
    'altmanzscoreusingtheaveragestockinformationforaperiod.lasttwelvemonths',
    'currentratio.lasttwelvemonths', 'operatingcashflowtocurrentliabilities.lasttwelvemonths',
  ],
  income_statement: [
    'totalrevenues.lasttwelvemonths', 'netincomemargin.lasttwelvemonths',
    'grossprofit.lasttwelvemonths', 'ebitda1yrgrowth.lasttwelvemonths',
    'dilutedepscontinuingoperations.lasttwelvemonths', 'quarterlyrevenuegrowth.quarterly',
    'epsgrowth.lasttwelvemonths', 'netincomeis.lasttwelvemonths',
    'ebitda.lasttwelvemonths', 'dilutedeps1yrgrowth.lasttwelvemonths',
    'totalrevenues1yrgrowth.lasttwelvemonths', 'operatingincome.lasttwelvemonths',
    'netincome1yrgrowth.lasttwelvemonths', 'grossprofitmargin.lasttwelvemonths',
    'ebitdamargin.lasttwelvemonths', 'ebit.lasttwelvemonths',
    'basicepscontinuingoperations.lasttwelvemonths',
    'netepsbasic.lasttwelvemonths', 'netepsdiluted.lasttwelvemonths',
  ],
  balance_sheet: [
    'totalassets.lasttwelvemonths', 'totalcommonsharesoutstanding.lasttwelvemonths',
    'totaldebt.lasttwelvemonths', 'totalequity.lasttwelvemonths',
    'totalcurrentassets.lasttwelvemonths', 'totalcashandshortterminvestments.lasttwelvemonths',
    'totalcommonequity.lasttwelvemonths', 'totalcurrentliabilities.lasttwelvemonths',
    'totalsharesoutstanding',
  ],
  cash_flow: [
    'forward_dividend_yield', 'leveredfreecashflow.lasttwelvemonths',
    'capitalexpenditure.lasttwelvemonths', 'cashfromoperations.lasttwelvemonths',
    'leveredfreecashflow1yrgrowth.lasttwelvemonths', 'unleveredfreecashflow.lasttwelvemonths',
    'cashfromoperations1yrgrowth.lasttwelvemonths',
  ],
  esg: [
    'esg_score', 'environmental_score', 'governance_score',
    'social_score', 'highest_controversy',
  ],
  fund_fields: [
    'categoryname', 'performanceratingoverall', 'initialinvestment',
    'annualreturnnavy1categoryrank', 'riskratingoverall', 'fundnetassets',
  ],
};

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-screener');
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
// Auth: extract A3 cookie from Chrome Yahoo Finance tab, then fetch crumb
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

  // Extract cookies via CDP
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://finance.yahoo.com', 'https://query1.finance.yahoo.com'] }));
  const { cookies } = JSON.parse(raw);

  const cookieStr = cookies
    .filter(c => c.domain.includes('yahoo.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const a3Cookie = cookies.find(c => c.name === 'A3' && c.domain.includes('yahoo.com'));
  if (!a3Cookie) {
    console.error('Warning: A3 cookie not found. Auth may not work for all endpoints.');
  }

  if (!cookieStr) throw new Error('No Yahoo cookies found. Are you logged in?');

  // Fetch crumb using the cookie
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
  if (!crumb || crumb.includes('<html>')) {
    throw new Error('Invalid crumb response. Try refreshing Yahoo Finance in Chrome.');
  }

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    crumb,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Crumb: ${crumb}`);
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie || !auth.crumb) {
    console.error('No auth found. Run: node yahoofinance-screener.mjs auth');
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

function commonParams(auth) {
  return {
    crumb: auth.crumb,
    corsDomain: 'finance.yahoo.com',
    formatted: 'false',
    lang: 'en-US',
    region: 'US',
  };
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function apiGet(auth, url, extraParams = {}) {
  const params = { ...commonParams(auth), ...extraParams };
  const fullUrl = buildUrl(url, params);
  const resp = await fetch(fullUrl, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node yahoofinance-screener.mjs auth');
    }
    throw new Error(`GET failed (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
  }
  return data;
}

async function apiPost(auth, url, body, extraParams = {}) {
  const params = { ...commonParams(auth), ...extraParams };
  const fullUrl = buildUrl(url, params);
  const resp = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      ...baseHeaders(auth),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node yahoofinance-screener.mjs auth');
    }
    throw new Error(`POST failed (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Query conversion: user-friendly JSON -> Yahoo screener format
// ---------------------------------------------------------------------------

function convertQuery(filters) {
  // Input:  [{"op":"gt","field":"percentchange","val":3}, ...]
  // Output: {"operator":"AND","operands":[{"operator":"GT","operands":["percentchange",3]}, ...]}
  const operands = filters.map(f => {
    const op = f.op.toUpperCase();
    if (!VALID_OPERATORS.includes(f.op.toLowerCase())) {
      throw new Error(`Invalid operator "${f.op}". Valid: ${VALID_OPERATORS.join(', ')}`);
    }

    if (op === 'BTWN') {
      // btwn requires 2 values
      const vals = Array.isArray(f.val) ? f.val : [f.val, f.val2];
      if (vals.length !== 2 || vals[0] == null || vals[1] == null) {
        throw new Error(`BTWN operator requires 2 values. Use "val":[low,high] or "val":low,"val2":high`);
      }
      return { operator: op, operands: [f.field, vals[0], vals[1]] };
    }

    if (op === 'IS-IN') {
      // is-in requires array of values, convert to OR of EQ as Yahoo expects
      const vals = Array.isArray(f.val) ? f.val : [f.val];
      const eqs = vals.map(v => ({ operator: 'EQ', operands: [f.field, v] }));
      return { operator: 'OR', operands: eqs };
    }

    return { operator: op, operands: [f.field, f.val] };
  });

  return { operator: 'AND', operands };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runPredefined(auth, name, { count = 25, offset = 0 } = {}) {
  if (!PREDEFINED_NAMES.includes(name)) {
    console.error(`Unknown predefined query: "${name}"`);
    console.error(`Available: ${PREDEFINED_NAMES.join(', ')}`);
    process.exit(1);
  }

  count = Math.min(Number(count), MAX_RESULTS);
  offset = Number(offset);

  const data = await apiGet(auth, PREDEFINED_URL, {
    scrIds: name,
    count: String(count),
    offset: String(offset),
  });

  const result = data?.finance?.result?.[0];
  if (!result) {
    throw new Error('Unexpected response format: ' + JSON.stringify(data).substring(0, 300));
  }

  return result;
}

async function runSearch(auth, queryFilters, { size = 100, offset = 0, sortField = 'ticker', sortAsc = false, quoteType = 'EQUITY' } = {}) {
  size = Math.min(Number(size), MAX_RESULTS);
  offset = Number(offset);

  const query = convertQuery(queryFilters);

  const body = {
    offset,
    size,
    sortField,
    sortType: sortAsc ? 'ASC' : 'DESC',
    quoteType: quoteType.toUpperCase(),
    userId: '',
    userIdType: 'guid',
    query,
  };

  const data = await apiPost(auth, SCREENER_URL, body);

  const result = data?.finance?.result?.[0];
  if (!result) {
    throw new Error('Unexpected response format: ' + JSON.stringify(data).substring(0, 300));
  }

  return result;
}

function printFields() {
  console.log('Yahoo Finance Screener Fields\n');
  for (const [category, fields] of Object.entries(SCREENER_FIELDS)) {
    const label = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    console.log(`  ${label}:`);
    for (const field of fields) {
      console.log(`    ${field}`);
    }
    console.log();
  }
  console.log('Operators: gt, lt, gte, lte, btwn, eq, is-in');
}

function formatQuote(q) {
  const sym = q.symbol || '???';
  const name = q.shortName || q.longName || '';
  const price = q.regularMarketPrice ?? q.ask ?? '';
  const change = q.regularMarketChange ?? '';
  const changePct = q.regularMarketChangePercent ?? '';
  const volume = q.regularMarketVolume ?? '';
  const marketCap = q.marketCap ?? '';

  let line = `  ${sym.padEnd(8)} ${name.substring(0, 30).padEnd(32)}`;
  if (price !== '') line += `$${Number(price).toFixed(2).padStart(10)}`;
  if (change !== '' && changePct !== '') {
    const sign = Number(change) >= 0 ? '+' : '';
    line += `  ${sign}${Number(change).toFixed(2)} (${sign}${Number(changePct).toFixed(2)}%)`;
  }
  if (volume !== '') line += `  vol:${Number(volume).toLocaleString()}`;
  if (marketCap !== '') line += `  mcap:${formatLargeNumber(Number(marketCap))}`;
  return line;
}

function formatLargeNumber(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

function printResult(result, label) {
  const quotes = result.quotes || [];
  const total = result.total ?? '?';
  const start = result.start ?? 0;
  const count = result.count ?? quotes.length;

  console.log(`\n${label}`);
  console.log(`Showing ${start + 1}-${start + quotes.length} of ${total} results\n`);

  for (const q of quotes) {
    console.log(formatQuote(q));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'predefined': {
    const { flags, positional } = parseFlags(args);
    const name = positional[0];
    if (!name) {
      console.error('Usage: node yahoofinance-screener.mjs predefined <name> [--count=25] [--offset=0]');
      console.error(`\nAvailable:\n  ${PREDEFINED_NAMES.join('\n  ')}`);
      process.exit(1);
    }

    const auth = getAuth();
    const count = flags.count ? Number(flags.count) : 25;
    const offset = flags.offset ? Number(flags.offset) : 0;

    const result = await runPredefined(auth, name, { count, offset });
    printResult(result, `Predefined: ${name}`);

    // Cache result
    const outFile = resolve(CACHE_DIR, `predefined-${name}.json`);
    saveJson(outFile, result);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'search': {
    const { flags } = parseFlags(args);
    if (!flags.query) {
      console.error('Usage: node yahoofinance-screener.mjs search --query=JSON [--size=100] [--offset=0] [--sort=field] [--asc] [--type=EQUITY]');
      console.error(`\nQuery format: '[{"op":"gt","field":"percentchange","val":3},{"op":"eq","field":"region","val":"us"}]'`);
      console.error(`Operators: ${VALID_OPERATORS.join(', ')}`);
      console.error(`\nFor btwn: {"op":"btwn","field":"peratio.lasttwelvemonths","val":[0,20]}`);
      console.error(`For is-in: {"op":"is-in","field":"exchange","val":["NMS","NYQ"]}`);
      process.exit(1);
    }

    let queryFilters;
    try {
      queryFilters = JSON.parse(flags.query);
    } catch (e) {
      console.error(`Invalid JSON in --query: ${e.message}`);
      process.exit(1);
    }

    if (!Array.isArray(queryFilters)) {
      console.error('--query must be a JSON array of filter objects');
      process.exit(1);
    }

    const auth = getAuth();
    const size = flags.size ? Number(flags.size) : 100;
    const offset = flags.offset ? Number(flags.offset) : 0;
    const sortField = flags.sort || 'ticker';
    const sortAsc = !!flags.asc;
    const quoteType = flags.type || 'EQUITY';

    const result = await runSearch(auth, queryFilters, { size, offset, sortField, sortAsc, quoteType });
    printResult(result, `Custom search (${quoteType})`);

    // Cache result
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = resolve(CACHE_DIR, `search-${ts}.json`);
    saveJson(outFile, result);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'fields': {
    printFields();
    break;
  }

  default:
    console.log(`yahoofinance-screener — Yahoo Finance stock/fund screener

Commands:
  auth                                    Authenticate via Chrome (one-time)
  predefined <name> [--count=25] [--offset=0]
                                          Run a predefined screen
  search --query=JSON [--size=100] [--offset=0] [--sort=field] [--asc] [--type=EQUITY|MUTUALFUND]
                                          Run a custom screen
  fields                                  List all available screener fields

Predefined screens:
  ${PREDEFINED_NAMES.join('\n  ')}

Query format (JSON array of filters):
  [{"op":"gt","field":"percentchange","val":3},{"op":"eq","field":"region","val":"us"}]

Operators: gt, lt, gte, lte, btwn, eq, is-in
  btwn: {"op":"btwn","field":"peratio.lasttwelvemonths","val":[0,20]}
  is-in: {"op":"is-in","field":"exchange","val":["NMS","NYQ"]}

Examples:
  node yahoofinance-screener.mjs predefined most_actives
  node yahoofinance-screener.mjs predefined day_gainers --count=10
  node yahoofinance-screener.mjs search --query='[{"op":"gt","field":"percentchange","val":3},{"op":"eq","field":"region","val":"us"}]'
  node yahoofinance-screener.mjs search --query='[{"op":"btwn","field":"peratio.lasttwelvemonths","val":[0,20]},{"op":"gte","field":"epsgrowth.lasttwelvemonths","val":25}]' --sort=percentchange --asc
  node yahoofinance-screener.mjs search --query='[{"op":"is-in","field":"exchange","val":["NMS","NYQ"]}]' --type=EQUITY
  node yahoofinance-screener.mjs fields

Data: ${DATA_DIR}/
  session.json     Auth cookies & crumb
  cache/           Screener result JSON files`);
}
