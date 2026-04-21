#!/usr/bin/env node
// yahoofinance-etf.mjs — Fetch ETF/Mutual Fund data (holdings, operations, bond ratings, sector weights)
//
// Setup:  node yahoofinance-etf.mjs auth
// Usage:  node yahoofinance-etf.mjs view SPY
//         node yahoofinance-etf.mjs holdings SPY
//         node yahoofinance-etf.mjs operations SPY
//         node yahoofinance-etf.mjs equity-holdings SPY
//         node yahoofinance-etf.mjs bond-holdings BND

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUERY2_URL = 'https://query2.finance.yahoo.com';
const QUERY1_URL = 'https://query1.finance.yahoo.com';
const QUOTE_SUMMARY_URL = `${QUERY2_URL}/v10/finance/quoteSummary`;
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

const MODULES = 'quoteType,summaryProfile,fundProfile,topHoldings';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------
const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-etf');
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
  const { status, body } = cdpFetch(tabId, CRUMB_URL);
  if (status !== 200 || !body || body.includes('<html>') || body.includes('Too Many Requests') || body.length > 60) {
    throw new Error(`Failed to fetch crumb: HTTP ${status} — ${body.substring(0, 100)}`);
  }
  const crumb = body;
  console.log('Crumb obtained via Chrome CDP.');

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
  if (!s || !s.crumb) { console.error('No auth. Run: node yahoofinance-etf.mjs auth'); process.exit(1); }
  return s;
}

function apiFetch(session, url) {
  const tabId = findYahooTab();
  if (!tabId) { console.error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome.'); process.exit(1); }
  const { status, body } = cdpFetch(tabId, url);
  if (status === 401 || status === 403) { console.error(`Auth expired (${status}). Run: node yahoofinance-etf.mjs auth`); process.exit(1); }
  if (status === 429) { console.error('Rate limited (429). Wait and retry.'); process.exit(1); }
  if (status === 404) { console.error('Not found (404). Check symbol.'); process.exit(1); }
  let data; try { data = JSON.parse(body); } catch { data = body; }
  if (status < 200 || status >= 300) { console.error(`HTTP ${status}: ${String(data).substring(0, 200)}`); process.exit(1); }
  return data;
}

// ---------------------------------------------------------------------------
// Fetch quoteSummary
// ---------------------------------------------------------------------------
function fetchSummary(symbol) {
  const session = getSession();
  const url = `${QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}?modules=${MODULES}&crumb=${encodeURIComponent(session.crumb)}`;
  const data = apiFetch(session, url);
  const result = data?.quoteSummary?.result?.[0];
  if (!result) { console.error('No data returned for symbol:', symbol); process.exit(1); }

  // Cache
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `${symbol.toUpperCase()}.json`), result);
  return result;
}

// ---------------------------------------------------------------------------
// Helper: safely get nested value
// ---------------------------------------------------------------------------
function val(obj, ...keys) {
  let v = obj;
  for (const k of keys) { v = v?.[k]; if (v === undefined || v === null) return null; }
  if (typeof v === 'object' && 'raw' in v) return v.raw;
  if (typeof v === 'object' && 'fmt' in v) return v.fmt;
  return v;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdView(symbol) {
  const r = fetchSummary(symbol);
  const qt = r.quoteType || {};
  const sp = r.summaryProfile || {};
  const fp = r.fundProfile || {};
  const fees = fp.feesExpensesInvestment || {};
  const th = r.topHoldings || {};

  const info = {
    symbol: qt.symbol,
    shortName: qt.shortName,
    longName: qt.longName,
    quoteType: qt.quoteType,
    category: fp.categoryName,
    family: fp.family,
    legalType: fp.legalType,
    totalNetAssets: val(fees, 'totalNetAssets'),
    inceptionDate: fp.initInvestment != null ? undefined : undefined,
    description: sp.longBusinessSummary,
  };
  console.log(JSON.stringify(info, null, 2));
}

function cmdHoldings(symbol) {
  const r = fetchSummary(symbol);
  const th = r.topHoldings || {};

  const holdings = (th.holdings || []).map(h => ({
    symbol: h.symbol,
    name: h.holdingName,
    pctAssets: val(h, 'holdingPercent'),
  }));

  const sectorWeightings = {};
  for (const sw of (th.sectorWeightings || [])) {
    for (const [key, rawVal] of Object.entries(sw)) {
      sectorWeightings[key] = typeof rawVal === 'object' && 'raw' in rawVal ? rawVal.raw : rawVal;
    }
  }

  const assetComposition = {
    stocks: val(th, 'stockPosition'),
    bonds: val(th, 'bondPosition'),
    cash: val(th, 'cashPosition'),
    other: val(th, 'otherPosition'),
    preferred: val(th, 'preferredPosition'),
    convertible: val(th, 'convertiblePosition'),
  };

  console.log(JSON.stringify({ holdings, sectorWeightings, assetComposition }, null, 2));
}

function cmdOperations(symbol) {
  const r = fetchSummary(symbol);
  const fp = r.fundProfile || {};
  const fees = fp.feesExpensesInvestment || {};
  const ops = fp.feesExpensesInvestmentCat || {};

  const info = {
    totalNetAssets: val(fees, 'totalNetAssets'),
    annualReportExpenseRatio: val(fees, 'annualReportExpenseRatio'),
    annualHoldingsTurnover: val(fees, 'annualHoldingsTurnover'),
    projectionExpenseRatio: val(fees, 'projectionValues', 'fiveYearExpenseProjection'),
    managementFee: val(fp, 'managementInfo', 'totalFee'),
    categoryAvgExpenseRatio: val(ops, 'annualReportExpenseRatio'),
    categoryAvgHoldingsTurnover: val(ops, 'annualHoldingsTurnover'),
  };
  console.log(JSON.stringify(info, null, 2));
}

function cmdEquityHoldings(symbol) {
  const r = fetchSummary(symbol);
  const eq = r.topHoldings?.equityHoldings || {};

  const info = {
    priceToEarnings: val(eq, 'priceToEarnings'),
    priceToBook: val(eq, 'priceToBook'),
    priceToSales: val(eq, 'priceToSales'),
    priceToCashflow: val(eq, 'priceToCashflow'),
    medianMarketCap: val(eq, 'medianMarketCap'),
    threeYearEarningsGrowth: val(eq, 'threeYearEarningsGrowth'),
  };
  console.log(JSON.stringify(info, null, 2));
}

function cmdBondHoldings(symbol) {
  const r = fetchSummary(symbol);
  const bh = r.topHoldings?.bondHoldings || {};
  const br = r.topHoldings?.bondRatings || [];

  const ratings = {};
  for (const entry of br) {
    for (const [key, rawVal] of Object.entries(entry)) {
      ratings[key] = typeof rawVal === 'object' && 'raw' in rawVal ? rawVal.raw : rawVal;
    }
  }

  const info = {
    maturity: val(bh, 'maturity'),
    duration: val(bh, 'duration'),
    creditQuality: val(bh, 'creditQuality'),
    ratings,
  };
  console.log(JSON.stringify(info, null, 2));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`yahoofinance-etf -- Fetch ETF/Mutual Fund data from Yahoo Finance

Commands:
  auth                          Authenticate via Chrome CDP (one-time)
  view <symbol>                 Fund overview (name, category, family, type, net assets, description)
  holdings <symbol>             Top holdings, sector weightings, asset composition
  operations <symbol>           Expense ratio, turnover, management fees, net assets
  equity-holdings <symbol>      P/E, P/B, P/S, P/CF, median market cap
  bond-holdings <symbol>        Maturity, duration, credit quality, bond ratings

Examples:
  node yahoofinance-etf.mjs auth
  node yahoofinance-etf.mjs view SPY
  node yahoofinance-etf.mjs holdings QQQ
  node yahoofinance-etf.mjs operations VFINX
  node yahoofinance-etf.mjs equity-holdings SPY
  node yahoofinance-etf.mjs bond-holdings BND`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) { printHelp(); process.exit(0); }

const symbol = rest[0]?.toUpperCase();

try {
  switch (cmd) {
    case 'auth': doAuth(); break;
    case 'view': if (!symbol) { console.error('Usage: view <symbol>'); process.exit(1); } cmdView(symbol); break;
    case 'holdings': if (!symbol) { console.error('Usage: holdings <symbol>'); process.exit(1); } cmdHoldings(symbol); break;
    case 'operations': if (!symbol) { console.error('Usage: operations <symbol>'); process.exit(1); } cmdOperations(symbol); break;
    case 'equity-holdings': if (!symbol) { console.error('Usage: equity-holdings <symbol>'); process.exit(1); } cmdEquityHoldings(symbol); break;
    case 'bond-holdings': if (!symbol) { console.error('Usage: bond-holdings <symbol>'); process.exit(1); } cmdBondHoldings(symbol); break;
    default: console.error(`Unknown command: ${cmd}`); printHelp(); process.exit(1);
  }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
