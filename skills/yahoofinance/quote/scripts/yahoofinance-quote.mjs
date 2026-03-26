#!/usr/bin/env node
// yahoofinance-quote.mjs — Fetch Yahoo Finance quote data (summary, profile,
// statistics, holders, analysis, calendar, sustainability, news)
//
// Setup (one-time, requires Chrome with finance.yahoo.com open):
//   node yahoofinance-quote.mjs auth
//
// Usage:
//   node yahoofinance-quote.mjs view AAPL
//   node yahoofinance-quote.mjs profile AAPL
//   node yahoofinance-quote.mjs statistics AAPL
//   node yahoofinance-quote.mjs holders AAPL
//   node yahoofinance-quote.mjs analysis AAPL
//   node yahoofinance-quote.mjs calendar AAPL
//   node yahoofinance-quote.mjs sustainability AAPL
//   node yahoofinance-quote.mjs news AAPL --count=10
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUERY2_URL = 'https://query2.finance.yahoo.com';
const QUERY1_URL = 'https://query1.finance.yahoo.com';
const ROOT_URL = 'https://finance.yahoo.com';
const QUOTE_SUMMARY_URL = `${QUERY2_URL}/v10/finance/quoteSummary`;
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-quote');
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
    console.error('No auth found. Run: node yahoofinance-quote.mjs auth');
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
    console.error(`Auth expired (HTTP ${resp.status}). Run: node yahoofinance-quote.mjs auth`);
    process.exit(1);
  }
  if (resp.status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes and try again.');
    process.exit(1);
  }
  if (resp.status === 404) {
    console.error(`Not found (HTTP 404). Check the symbol and try again.`);
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
// quoteSummary fetcher
// ---------------------------------------------------------------------------

async function fetchQuoteSummary(session, symbol, modules) {
  const modulesStr = modules.join(',');
  const url = `${QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}?modules=${modulesStr}&crumb=${encodeURIComponent(session.crumb)}&corsDomain=finance.yahoo.com&formatted=false&symbol=${encodeURIComponent(symbol)}`;

  const data = await apiFetch(session, url);

  const result = data?.quoteSummary?.result;
  if (!result || result.length === 0) {
    console.error(`No data returned for symbol "${symbol}".`);
    process.exit(1);
  }

  // Save to cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `${symbol.toUpperCase()}-${modules.join('_')}.json`);
  saveJson(cacheFile, result[0]);

  return result[0];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(val, opts = {}) {
  if (val === null || val === undefined || val === 'Infinity' || val === 'NaN') return 'N/A';
  if (typeof val === 'object' && val.raw !== undefined) val = val.raw;
  if (typeof val === 'object' && val.fmt !== undefined) return val.fmt;
  if (opts.pct) return (val * 100).toFixed(2) + '%';
  if (opts.bignum) {
    const abs = Math.abs(val);
    if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
    return val.toLocaleString();
  }
  if (opts.currency) return typeof val === 'number' ? val.toFixed(2) : String(val);
  if (opts.date && typeof val === 'number') return new Date(val * 1000).toLocaleDateString();
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
// Command: view <symbol>
// ---------------------------------------------------------------------------

async function cmdView(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, [
    'summaryDetail', 'price', 'quoteType', 'defaultKeyStatistics', 'financialData',
  ]);

  const price = data.price || {};
  const summary = data.summaryDetail || {};
  const stats = data.defaultKeyStatistics || {};
  const financial = data.financialData || {};
  const qt = data.quoteType || {};

  const name = price.longName || price.shortName || qt.longName || qt.shortName || symbol;
  const currency = price.currency || summary.currency || '';
  const mktState = price.marketState || '';

  // Current price info
  const regularPrice = price.regularMarketPrice ?? summary.regularMarketPrice;
  const regularChange = price.regularMarketChange;
  const regularChangePct = price.regularMarketChangePercent;

  printSectionHeader(`${name} (${symbol.toUpperCase()}) - ${currency}`);

  console.log(`\n  Market State: ${mktState}`);
  console.log(`  Price: ${fmt(regularPrice, { currency: true })} ${currency}  ${fmt(regularChange, { currency: true })} (${fmt(regularChangePct, { pct: true })})`);

  // Pre/post market
  if (price.preMarketPrice) {
    console.log(`  Pre-Market: ${fmt(price.preMarketPrice, { currency: true })} (${fmt(price.preMarketChangePercent, { pct: true })})`);
  }
  if (price.postMarketPrice) {
    console.log(`  Post-Market: ${fmt(price.postMarketPrice, { currency: true })} (${fmt(price.postMarketChangePercent, { pct: true })})`);
  }

  const rows = [];
  rows.push(['Open', fmt(summary.open ?? summary.regularMarketOpen, { currency: true })]);
  rows.push(['Day High', fmt(summary.dayHigh ?? summary.regularMarketDayHigh, { currency: true })]);
  rows.push(['Day Low', fmt(summary.dayLow ?? summary.regularMarketDayLow, { currency: true })]);
  rows.push(['Previous Close', fmt(summary.previousClose ?? summary.regularMarketPreviousClose, { currency: true })]);
  rows.push(['52-Week High', fmt(summary.fiftyTwoWeekHigh, { currency: true })]);
  rows.push(['52-Week Low', fmt(summary.fiftyTwoWeekLow, { currency: true })]);
  rows.push(['50-Day Avg', fmt(summary.fiftyDayAverage, { currency: true })]);
  rows.push(['200-Day Avg', fmt(summary.twoHundredDayAverage, { currency: true })]);
  rows.push(['Market Cap', fmt(price.marketCap ?? summary.marketCap, { bignum: true })]);
  rows.push(['Enterprise Value', fmt(stats.enterpriseValue, { bignum: true })]);
  rows.push(['PE Ratio (TTM)', fmt(summary.trailingPE)]);
  rows.push(['Forward PE', fmt(summary.forwardPE)]);
  rows.push(['PEG Ratio', fmt(stats.pegRatio)]);
  rows.push(['EPS (TTM)', fmt(stats.trailingEps, { currency: true })]);
  rows.push(['Forward EPS', fmt(stats.forwardEps, { currency: true })]);
  rows.push(['Beta', fmt(summary.beta ?? stats.beta)]);
  rows.push(['Dividend Rate', fmt(summary.dividendRate, { currency: true })]);
  rows.push(['Dividend Yield', fmt(summary.dividendYield, { pct: true })]);
  rows.push(['Ex-Dividend Date', fmt(summary.exDividendDate, { date: true })]);
  rows.push(['Volume', fmt(summary.volume ?? summary.regularMarketVolume, { bignum: true })]);
  rows.push(['Avg Volume', fmt(summary.averageVolume, { bignum: true })]);
  rows.push(['Avg Volume (10d)', fmt(summary.averageDailyVolume10Day ?? summary.averageVolume10days, { bignum: true })]);
  rows.push(['Profit Margin', fmt(financial.profitMargins, { pct: true })]);
  rows.push(['Revenue', fmt(financial.totalRevenue, { bignum: true })]);
  rows.push(['Revenue Per Share', fmt(financial.revenuePerShare, { currency: true })]);
  rows.push(['Return on Equity', fmt(financial.returnOnEquity, { pct: true })]);
  rows.push(['Free Cash Flow', fmt(financial.freeCashflow, { bignum: true })]);

  console.log();
  printTable(rows);
}

// ---------------------------------------------------------------------------
// Command: profile <symbol>
// ---------------------------------------------------------------------------

async function cmdProfile(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, ['assetProfile']);

  const profile = data.assetProfile || {};

  printSectionHeader(`${symbol.toUpperCase()} - Company Profile`);

  // Address
  const addrParts = [profile.address1, profile.address2, profile.city, profile.state, profile.zip, profile.country].filter(Boolean);
  if (addrParts.length) console.log(`\n  Address: ${addrParts.join(', ')}`);
  if (profile.phone) console.log(`  Phone: ${profile.phone}`);
  if (profile.website) console.log(`  Website: ${profile.website}`);

  const rows = [];
  rows.push(['Sector', fmt(profile.sector)]);
  rows.push(['Industry', fmt(profile.industry)]);
  rows.push(['Employees', fmt(profile.fullTimeEmployees, { bignum: true })]);
  rows.push(['Audit Risk', fmt(profile.auditRisk)]);
  rows.push(['Board Risk', fmt(profile.boardRisk)]);
  rows.push(['Compensation Risk', fmt(profile.compensationRisk)]);
  rows.push(['Shareholder Rights Risk', fmt(profile.shareHolderRightsRisk)]);
  rows.push(['Overall Risk', fmt(profile.overallRisk)]);
  console.log();
  printTable(rows);

  // Description
  if (profile.longBusinessSummary) {
    console.log(`\n  Description:`);
    // Word-wrap at ~78 chars
    const words = profile.longBusinessSummary.split(/\s+/);
    let line = '    ';
    for (const w of words) {
      if (line.length + w.length > 78) { console.log(line); line = '    '; }
      line += (line.length > 4 ? ' ' : '') + w;
    }
    if (line.trim()) console.log(line);
  }

  // Officers
  const officers = profile.companyOfficers || [];
  if (officers.length) {
    console.log(`\n  Company Officers:`);
    for (const o of officers) {
      const name = o.name || 'Unknown';
      const title = o.title || '';
      const age = o.age ? `, Age ${o.age}` : '';
      const pay = o.totalPay ? `, Pay: ${fmt(o.totalPay, { bignum: true })}` : '';
      console.log(`    ${name} - ${title}${age}${pay}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: statistics <symbol>
// ---------------------------------------------------------------------------

async function cmdStatistics(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, [
    'defaultKeyStatistics', 'financialData',
  ]);

  const stats = data.defaultKeyStatistics || {};
  const financial = data.financialData || {};

  printSectionHeader(`${symbol.toUpperCase()} - Key Statistics`);

  console.log('\n  -- Valuation Measures --');
  printTable([
    ['Enterprise Value', fmt(stats.enterpriseValue, { bignum: true })],
    ['Trailing PE', fmt(stats.trailingEps ? undefined : null)],
    ['Forward PE', fmt(stats.forwardPE)],
    ['PEG Ratio (5yr expected)', fmt(stats.pegRatio)],
    ['Price/Sales (TTM)', fmt(stats.priceToSalesTrailing12Months)],
    ['Price/Book', fmt(stats.priceToBook)],
    ['Enterprise Value/Revenue', fmt(stats.enterpriseToRevenue)],
    ['Enterprise Value/EBITDA', fmt(stats.enterpriseToEbitda)],
  ]);

  console.log('\n  -- Profitability --');
  printTable([
    ['Profit Margin', fmt(financial.profitMargins, { pct: true })],
    ['Operating Margin', fmt(financial.operatingMargins, { pct: true })],
    ['Gross Margin', fmt(financial.grossMargins, { pct: true })],
    ['EBITDA Margin', fmt(financial.ebitdaMargins, { pct: true })],
  ]);

  console.log('\n  -- Management Effectiveness --');
  printTable([
    ['Return on Assets', fmt(financial.returnOnAssets, { pct: true })],
    ['Return on Equity', fmt(financial.returnOnEquity, { pct: true })],
  ]);

  console.log('\n  -- Income Statement --');
  printTable([
    ['Revenue', fmt(financial.totalRevenue, { bignum: true })],
    ['Revenue Per Share', fmt(financial.revenuePerShare, { currency: true })],
    ['Revenue Growth (YoY)', fmt(financial.revenueGrowth, { pct: true })],
    ['Gross Profit', fmt(financial.grossProfits, { bignum: true })],
    ['EBITDA', fmt(financial.ebitda, { bignum: true })],
    ['Net Income to Common', fmt(financial.netIncomeToCommon, { bignum: true })],
    ['Earnings Growth', fmt(financial.earningsGrowth, { pct: true })],
    ['Diluted EPS (TTM)', fmt(stats.trailingEps, { currency: true })],
    ['Forward EPS', fmt(stats.forwardEps, { currency: true })],
  ]);

  console.log('\n  -- Balance Sheet --');
  printTable([
    ['Total Cash', fmt(financial.totalCash, { bignum: true })],
    ['Total Cash Per Share', fmt(financial.totalCashPerShare, { currency: true })],
    ['Total Debt', fmt(financial.totalDebt, { bignum: true })],
    ['Debt/Equity', fmt(financial.debtToEquity)],
    ['Current Ratio', fmt(financial.currentRatio)],
    ['Quick Ratio', fmt(financial.quickRatio)],
    ['Book Value', fmt(stats.bookValue, { currency: true })],
  ]);

  console.log('\n  -- Cash Flow --');
  printTable([
    ['Operating Cash Flow', fmt(financial.operatingCashflow, { bignum: true })],
    ['Free Cash Flow', fmt(financial.freeCashflow, { bignum: true })],
  ]);

  console.log('\n  -- Trading Information --');
  printTable([
    ['Beta', fmt(stats.beta)],
    ['52-Week Change', fmt(stats['52WeekChange'], { pct: true })],
    ['S&P500 52-Week Change', fmt(stats.SandP52WeekChange, { pct: true })],
    ['52-Week High', fmt(stats.fiftyTwoWeekHigh, { currency: true })],
    ['52-Week Low', fmt(stats.fiftyTwoWeekLow, { currency: true })],
    ['50-Day Moving Avg', fmt(stats.fiftyDayAverage, { currency: true })],
    ['200-Day Moving Avg', fmt(stats.twoHundredDayAverage, { currency: true })],
  ]);

  console.log('\n  -- Share Statistics --');
  printTable([
    ['Shares Outstanding', fmt(stats.sharesOutstanding, { bignum: true })],
    ['Implied Shares Outstanding', fmt(stats.impliedSharesOutstanding, { bignum: true })],
    ['Float Shares', fmt(stats.floatShares, { bignum: true })],
    ['% Held by Insiders', fmt(stats.heldPercentInsiders, { pct: true })],
    ['% Held by Institutions', fmt(stats.heldPercentInstitutions, { pct: true })],
    ['Short Ratio', fmt(stats.shortRatio)],
    ['Short % of Float', fmt(stats.shortPercentOfFloat, { pct: true })],
    ['Shares Short', fmt(stats.sharesShort, { bignum: true })],
    ['Shares Short Prior Month', fmt(stats.sharesShortPriorMonth, { bignum: true })],
  ]);

  console.log('\n  -- Dividends & Splits --');
  printTable([
    ['Dividend Rate (Fwd)', fmt(financial.dividendRate, { currency: true })],
    ['Dividend Yield (Fwd)', fmt(financial.dividendYield, { pct: true })],
    ['Trailing Annual Dividend Rate', fmt(stats.trailingAnnualDividendRate, { currency: true })],
    ['Trailing Annual Dividend Yield', fmt(stats.trailingAnnualDividendYield, { pct: true })],
    ['5-Year Avg Dividend Yield', fmt(stats.fiveYearAvgDividendYield)],
    ['Payout Ratio', fmt(stats.payoutRatio, { pct: true })],
    ['Last Split Factor', fmt(stats.lastSplitFactor)],
    ['Last Split Date', fmt(stats.lastSplitDate, { date: true })],
  ]);
}

// ---------------------------------------------------------------------------
// Command: holders <symbol>
// ---------------------------------------------------------------------------

async function cmdHolders(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, [
    'majorHoldersBreakdown', 'institutionOwnership', 'fundOwnership',
    'insiderHolders', 'insiderTransactions', 'netSharePurchaseActivity',
  ]);

  printSectionHeader(`${symbol.toUpperCase()} - Holders`);

  // Major holders breakdown
  const mhb = data.majorHoldersBreakdown || {};
  if (Object.keys(mhb).length) {
    console.log('\n  -- Major Holders Breakdown --');
    printTable([
      ['% Held by Insiders', fmt(mhb.insidersPercentHeld, { pct: true })],
      ['% Held by Institutions', fmt(mhb.institutionsPercentHeld, { pct: true })],
      ['% Float Held by Institutions', fmt(mhb.institutionsFloatPercentHeld, { pct: true })],
      ['Number of Institutions', fmt(mhb.institutionsCount)],
    ]);
  }

  // Top institutional holders
  const instOwn = data.institutionOwnership?.ownershipList || [];
  if (instOwn.length) {
    console.log(`\n  -- Top Institutional Holders (${instOwn.length}) --`);
    for (const h of instOwn.slice(0, 15)) {
      const name = h.organization || 'Unknown';
      const shares = fmt(h.position, { bignum: true });
      const value = fmt(h.value, { bignum: true });
      const pctHeld = h.pctHeld != null ? fmt(h.pctHeld, { pct: true }) : 'N/A';
      const date = h.reportDate ? fmt(h.reportDate, { date: true }) : '';
      console.log(`    ${name}`);
      console.log(`      Shares: ${shares}  Value: ${value}  % Out: ${pctHeld}  Date: ${date}`);
    }
  }

  // Top mutual fund holders
  const fundOwn = data.fundOwnership?.ownershipList || [];
  if (fundOwn.length) {
    console.log(`\n  -- Top Mutual Fund Holders (${fundOwn.length}) --`);
    for (const h of fundOwn.slice(0, 15)) {
      const name = h.organization || 'Unknown';
      const shares = fmt(h.position, { bignum: true });
      const value = fmt(h.value, { bignum: true });
      const pctHeld = h.pctHeld != null ? fmt(h.pctHeld, { pct: true }) : 'N/A';
      const date = h.reportDate ? fmt(h.reportDate, { date: true }) : '';
      console.log(`    ${name}`);
      console.log(`      Shares: ${shares}  Value: ${value}  % Out: ${pctHeld}  Date: ${date}`);
    }
  }

  // Insider holders
  const insiders = data.insiderHolders?.holders || [];
  if (insiders.length) {
    console.log(`\n  -- Insider Roster (${insiders.length}) --`);
    for (const h of insiders) {
      const name = h.name || 'Unknown';
      const relation = h.relation || '';
      const shares = h.positionDirect ? fmt(h.positionDirect, { bignum: true }) : 'N/A';
      const date = h.latestTransDate ? fmt(h.latestTransDate, { date: true }) : '';
      const txnDesc = h.transactionDescription || '';
      console.log(`    ${name} (${relation})`);
      console.log(`      Shares: ${shares}  Last Txn: ${txnDesc}  Date: ${date}`);
    }
  }

  // Insider transactions
  const txns = data.insiderTransactions?.transactions || [];
  if (txns.length) {
    console.log(`\n  -- Recent Insider Transactions (${txns.length}) --`);
    for (const t of txns.slice(0, 15)) {
      const name = t.filerName || 'Unknown';
      const relation = t.filerRelation || '';
      const txnText = t.transactionText || '';
      const shares = fmt(t.shares, { bignum: true });
      const value = t.value ? fmt(t.value, { bignum: true }) : 'N/A';
      const date = t.startDate ? fmt(t.startDate, { date: true }) : '';
      console.log(`    ${date}  ${name} (${relation}) - ${txnText}: ${shares} shares, value: ${value}`);
    }
  }

  // Net share purchase activity
  const nsp = data.netSharePurchaseActivity || {};
  if (Object.keys(nsp).length && nsp.period !== undefined) {
    console.log('\n  -- Net Share Purchase Activity --');
    printTable([
      ['Period', fmt(nsp.period)],
      ['Shares Bought', fmt(nsp.buyInfoShares, { bignum: true })],
      ['Buy % of Insider Shares', fmt(nsp.buyPercentInsiderShares, { pct: true })],
      ['Shares Sold', fmt(nsp.sellInfoShares, { bignum: true })],
      ['Sell % of Insider Shares', fmt(nsp.sellPercentInsiderShares, { pct: true })],
      ['Net Shares Purchased', fmt(nsp.netInfoCount, { bignum: true })],
      ['Net % of Insider Shares', fmt(nsp.netPercentInsiderShares, { pct: true })],
      ['Total Insider Shares', fmt(nsp.totalInsiderShares, { bignum: true })],
    ]);
  }
}

// ---------------------------------------------------------------------------
// Command: analysis <symbol>
// ---------------------------------------------------------------------------

async function cmdAnalysis(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, [
    'earningsTrend', 'earningsHistory', 'recommendationTrend', 'upgradeDowngradeHistory',
  ]);

  printSectionHeader(`${symbol.toUpperCase()} - Analysis`);

  // Earnings history
  const eh = data.earningsHistory?.history || [];
  if (eh.length) {
    console.log('\n  -- Earnings History --');
    for (const e of eh) {
      const period = e.period || '';
      const date = e.quarter ? fmt(e.quarter, { date: true }) : '';
      const epsEst = fmt(e.epsEstimate, { currency: true });
      const epsAct = fmt(e.epsActual, { currency: true });
      const epsDiff = fmt(e.epsDifference, { currency: true });
      const surprise = e.surprisePercent != null ? fmt(e.surprisePercent, { pct: true }) : 'N/A';
      console.log(`    ${date} (${period}): Est: ${epsEst}  Actual: ${epsAct}  Diff: ${epsDiff}  Surprise: ${surprise}`);
    }
  }

  // Earnings trend
  const et = data.earningsTrend?.trend || [];
  if (et.length) {
    console.log('\n  -- Earnings/Revenue Estimates --');
    for (const t of et) {
      const period = t.period || '';
      const endDate = t.endDate || '';
      const eEst = t.earningsEstimate || {};
      const rEst = t.revenueEstimate || {};
      console.log(`\n    Period: ${period} (End: ${endDate})`);
      console.log(`      EPS: Avg: ${fmt(eEst.avg, { currency: true })}  Low: ${fmt(eEst.low, { currency: true })}  High: ${fmt(eEst.high, { currency: true })}  #Analysts: ${fmt(eEst.numberOfAnalysts)}  Growth: ${fmt(eEst.growth, { pct: true })}`);
      console.log(`      Rev: Avg: ${fmt(rEst.avg, { bignum: true })}  Low: ${fmt(rEst.low, { bignum: true })}  High: ${fmt(rEst.high, { bignum: true })}  #Analysts: ${fmt(rEst.numberOfAnalysts)}  Growth: ${fmt(rEst.growth, { pct: true })}`);

      // EPS Trend
      const epsTrend = t.epsTrend || {};
      if (Object.keys(epsTrend).length > 1) {
        console.log(`      EPS Trend: Current: ${fmt(epsTrend.current, { currency: true })}  7d ago: ${fmt(epsTrend['7daysAgo'], { currency: true })}  30d ago: ${fmt(epsTrend['30daysAgo'], { currency: true })}  60d ago: ${fmt(epsTrend['60daysAgo'], { currency: true })}  90d ago: ${fmt(epsTrend['90daysAgo'], { currency: true })}`);
      }

      // EPS Revisions
      const epsRev = t.epsRevisions || {};
      if (Object.keys(epsRev).length > 1) {
        console.log(`      EPS Revisions: Up (7d): ${fmt(epsRev.upLast7days)}  Up (30d): ${fmt(epsRev.upLast30days)}  Down (7d): ${fmt(epsRev.downLast7days)}  Down (30d): ${fmt(epsRev.downLast30days)}`);
      }
    }
  }

  // Recommendation trend
  const rt = data.recommendationTrend?.trend || [];
  if (rt.length) {
    console.log('\n  -- Recommendation Trend --');
    for (const r of rt) {
      console.log(`    ${r.period || 'N/A'}: Strong Buy: ${fmt(r.strongBuy)}  Buy: ${fmt(r.buy)}  Hold: ${fmt(r.hold)}  Sell: ${fmt(r.sell)}  Strong Sell: ${fmt(r.strongSell)}`);
    }
  }

  // Upgrades/downgrades history
  const udh = data.upgradeDowngradeHistory?.history || [];
  if (udh.length) {
    console.log(`\n  -- Recent Upgrades/Downgrades (${Math.min(udh.length, 20)} of ${udh.length}) --`);
    for (const u of udh.slice(0, 20)) {
      const date = u.epochGradeDate ? fmt(u.epochGradeDate, { date: true }) : '';
      const firm = u.firm || 'Unknown';
      const to = u.toGrade || '';
      const from = u.fromGrade || '';
      const action = u.action || '';
      const arrow = from ? `${from} -> ${to}` : to;
      console.log(`    ${date}  ${firm} [${action}]: ${arrow}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: calendar <symbol>
// ---------------------------------------------------------------------------

async function cmdCalendar(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, ['calendarEvents', 'secFilings']);

  printSectionHeader(`${symbol.toUpperCase()} - Calendar & Filings`);

  const events = data.calendarEvents || {};

  // Earnings dates
  const earnings = events.earnings || {};
  if (earnings.earningsDate?.length) {
    console.log('\n  -- Upcoming Earnings --');
    for (const d of earnings.earningsDate) {
      console.log(`    Date: ${fmt(d, { date: true })}`);
    }
    printTable([
      ['EPS Estimate (Avg)', fmt(earnings.earningsAverage, { currency: true })],
      ['EPS Estimate (Low)', fmt(earnings.earningsLow, { currency: true })],
      ['EPS Estimate (High)', fmt(earnings.earningsHigh, { currency: true })],
      ['Revenue Estimate (Avg)', fmt(earnings.revenueAverage, { bignum: true })],
      ['Revenue Estimate (Low)', fmt(earnings.revenueLow, { bignum: true })],
      ['Revenue Estimate (High)', fmt(earnings.revenueHigh, { bignum: true })],
    ]);
  }

  // Dividend dates
  const rows = [];
  if (events.exDividendDate) rows.push(['Ex-Dividend Date', fmt(events.exDividendDate, { date: true })]);
  if (events.dividendDate) rows.push(['Dividend Date', fmt(events.dividendDate, { date: true })]);
  if (rows.length) {
    console.log('\n  -- Dividend Dates --');
    printTable(rows);
  }

  // SEC filings
  const filings = data.secFilings?.filings || [];
  if (filings.length) {
    console.log(`\n  -- Recent SEC Filings (${Math.min(filings.length, 15)} of ${filings.length}) --`);
    for (const f of filings.slice(0, 15)) {
      const date = f.date || '';
      const type = f.type || '';
      const title = f.title || '';
      const url = f.edgarUrl || '';
      console.log(`    ${date}  ${type}: ${title}`);
      if (url) console.log(`      ${url}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: sustainability <symbol>
// ---------------------------------------------------------------------------

async function cmdSustainability(session, symbol) {
  const data = await fetchQuoteSummary(session, symbol, ['esgScores']);

  printSectionHeader(`${symbol.toUpperCase()} - ESG / Sustainability`);

  const esg = data.esgScores || {};
  if (!Object.keys(esg).length || esg.maxAge === undefined && !esg.totalEsg) {
    console.log('\n  No ESG data available for this symbol.');
    return;
  }

  console.log();
  printTable([
    ['Total ESG Score', fmt(esg.totalEsg)],
    ['ESG Performance', fmt(esg.esgPerformance)],
    ['Percentile', fmt(esg.percentile)],
    ['Peer Count', fmt(esg.peerCount)],
    ['Peer Group', fmt(esg.peerGroup)],
  ]);

  console.log('\n  -- Category Scores --');
  printTable([
    ['Environment Score', fmt(esg.environmentScore)],
    ['Environment Percentile', fmt(esg.environmentPercentile)],
    ['Social Score', fmt(esg.socialScore)],
    ['Social Percentile', fmt(esg.socialPercentile)],
    ['Governance Score', fmt(esg.governanceScore)],
    ['Governance Percentile', fmt(esg.governancePercentile)],
  ]);

  if (esg.highestControversy !== undefined || esg.relatedControversy?.length) {
    console.log('\n  -- Controversies --');
    printTable([
      ['Highest Controversy', fmt(esg.highestControversy)],
    ]);
    if (esg.relatedControversy?.length) {
      for (const c of esg.relatedControversy) {
        console.log(`    - ${c}`);
      }
    }
  }

  // Individual ESG topic scores (if available)
  const topicKeys = [
    'adultEntertainment', 'alcoholicBeverages', 'animalTesting', 'catholic',
    'controversialWeapons', 'smallArms', 'furLeather', 'gambling', 'gmo',
    'militaryContract', 'nuclear', 'pesticides', 'palmOil', 'coal', 'tobacco',
  ];
  const topicRows = topicKeys
    .filter(k => esg[k] !== undefined)
    .map(k => [k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()), esg[k] ? 'Yes' : 'No']);
  if (topicRows.length) {
    console.log('\n  -- Involvement Areas --');
    printTable(topicRows);
  }
}

// ---------------------------------------------------------------------------
// Command: news <symbol>
// ---------------------------------------------------------------------------

async function cmdNews(session, symbol, count = 10) {
  const url = `${ROOT_URL}/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin`;

  const payload = {
    serviceConfig: {
      snippetCount: count,
      s: [symbol.toUpperCase()],
    },
  };

  const data = await apiFetch(session, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  printSectionHeader(`${symbol.toUpperCase()} - Latest News`);

  const articles = data?.data?.tickerStream?.stream || [];

  if (!articles.length) {
    console.log('\n  No news articles found.');
    return;
  }

  // Filter out ads
  const news = articles.filter(a => !a.ad || !a.ad.length);

  console.log(`\n  Found ${news.length} articles:\n`);
  for (const article of news) {
    const content = article.content || {};
    const title = content.title || '(no title)';
    const publisher = content.provider?.displayName || content.provider?.name || 'Unknown';
    const pubDate = content.pubDate ? new Date(content.pubDate).toLocaleString() : '';
    const link = content.clickThroughUrl?.url || content.canonicalUrl?.url || '';
    const summary = content.summary || '';

    console.log(`  ${title}`);
    console.log(`    Publisher: ${publisher}  |  ${pubDate}`);
    if (summary) {
      const truncated = summary.length > 150 ? summary.substring(0, 150) + '...' : summary;
      console.log(`    ${truncated}`);
    }
    if (link) console.log(`    ${link}`);
    console.log();
  }

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `${symbol.toUpperCase()}-news.json`);
  saveJson(cacheFile, news);
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
  console.log(`yahoofinance-quote -- Fetch Yahoo Finance quote data

Commands:
  auth                              Authenticate via Chrome CDP (one-time)
  view <symbol>                     Price, market cap, PE, EPS, volume, etc.
  profile <symbol>                  Company description, sector, officers
  statistics <symbol>               Valuation, profitability, trading info
  holders <symbol>                  Institutional, mutual fund, insider holders
  analysis <symbol>                 Earnings estimates, recommendations, upgrades
  calendar <symbol>                 Earnings dates, dividends, SEC filings
  sustainability <symbol>           ESG scores and involvement areas
  news <symbol> [--count=N]         Latest news articles (default: 10)

Examples:
  node yahoofinance-quote.mjs auth
  node yahoofinance-quote.mjs view AAPL
  node yahoofinance-quote.mjs profile MSFT
  node yahoofinance-quote.mjs holders TSLA
  node yahoofinance-quote.mjs news GOOG --count=20

Data: ${DATA_DIR}/
  session.json     Auth cookies & crumb
  cache/           Cached API responses`);
}

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'view': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs view <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdView(session, symbol);
    break;
  }

  case 'profile': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs profile <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdProfile(session, symbol);
    break;
  }

  case 'statistics': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs statistics <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdStatistics(session, symbol);
    break;
  }

  case 'holders': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs holders <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdHolders(session, symbol);
    break;
  }

  case 'analysis': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs analysis <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdAnalysis(session, symbol);
    break;
  }

  case 'calendar': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs calendar <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdCalendar(session, symbol);
    break;
  }

  case 'sustainability': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs sustainability <symbol>'); process.exit(1); }
    const session = getSession();
    await cmdSustainability(session, symbol);
    break;
  }

  case 'news': {
    const symbol = positional[0];
    if (!symbol) { console.error('Usage: node yahoofinance-quote.mjs news <symbol> [--count=N]'); process.exit(1); }
    const session = getSession();
    const count = parseInt(flags.count || '10', 10);
    await cmdNews(session, symbol, count);
    break;
  }

  default:
    printHelp();
    break;
}
