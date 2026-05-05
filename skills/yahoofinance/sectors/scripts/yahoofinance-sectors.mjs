#!/usr/bin/env node
// yahoofinance-sectors.mjs — Fetch Yahoo Finance sector and industry data
// (overview, top companies, ETFs, mutual funds, industries)
//
// Setup (one-time, requires Chrome with finance.yahoo.com open):
//   node yahoofinance-sectors.mjs auth
//
// Usage:
//   node yahoofinance-sectors.mjs list
//   node yahoofinance-sectors.mjs view technology
//   node yahoofinance-sectors.mjs industry technology/software-application
//
// Requires Node 22+ and Chrome with finance.yahoo.com open.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUERY1_URL = 'https://query1.finance.yahoo.com';
const SECTORS_URL = `${QUERY1_URL}/v1/finance/sectors`;
const INDUSTRIES_URL = `${QUERY1_URL}/v1/finance/industries`;
const CRUMB_URL = `${QUERY1_URL}/v1/test/getcrumb`;

const SECTOR_KEYS = [
  'technology',
  'financial-services',
  'consumer-cyclical',
  'communication-services',
  'healthcare',
  'industrials',
  'consumer-defensive',
  'energy',
  'basic-materials',
  'real-estate',
  'utilities',
];

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/yahoofinance-sectors');
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
// Auth: fetch crumb from Chrome via CDP
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Yahoo Finance tab...');
  const tabId = findYahooTab();
  if (!tabId) throw new Error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
  console.log(`Using tab: ${tabId}`);

  console.log('Fetching crumb...');
  const { status, body } = cdpFetch(tabId, CRUMB_URL);
  if (status !== 200 || !body || body.length < 4 || body.includes('<html>')) {
    throw new Error(`Failed to fetch crumb: HTTP ${status} — ${body.substring(0, 100)}`);
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
// Session helpers
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session || !session.crumb) {
    console.error('No auth found. Run: node yahoofinance-sectors.mjs auth');
    process.exit(1);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Chrome CDP fetch for all API requests
// ---------------------------------------------------------------------------

function apiFetch(session, url) {
  const tabId = findYahooTab();
  if (!tabId) {
    console.error('No Yahoo Finance tab found. Open finance.yahoo.com in Chrome first.');
    process.exit(1);
  }

  const { status, body } = cdpFetch(tabId, url);

  if (status === 401 || status === 403) {
    console.error(`Auth expired (HTTP ${status}). Run: node yahoofinance-sectors.mjs auth`);
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Try again shortly.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('Not found (HTTP 404). Check the sector/industry key and try again.');
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
// Sector / Industry fetcher
// ---------------------------------------------------------------------------

function fetchSector(session, sectorKey) {
  const url = `${SECTORS_URL}/${encodeURIComponent(sectorKey)}?formatted=true&withReturns=true&lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const data = apiFetch(session, url);

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `sector-${sectorKey}.json`);
  saveJson(cacheFile, data);

  return data;
}

function fetchIndustry(session, industryKey) {
  const url = `${INDUSTRIES_URL}/${encodeURIComponent(industryKey)}?formatted=true&withReturns=true&lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const data = apiFetch(session, url);

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `industry-${industryKey}.json`);
  saveJson(cacheFile, data);

  return data;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(val, opts = {}) {
  if (val === null || val === undefined || val === 'Infinity' || val === 'NaN') return 'N/A';
  if (typeof val === 'object' && val.fmt !== undefined) return val.fmt;
  if (typeof val === 'object' && val.raw !== undefined) val = val.raw;
  if (opts.pct) {
    if (typeof val === 'number') return (val * 100).toFixed(2) + '%';
    return String(val);
  }
  if (opts.bignum && typeof val === 'number') {
    const abs = Math.abs(val);
    if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
    return val.toLocaleString();
  }
  if (typeof val === 'number' && !Number.isInteger(val)) return val.toFixed(4);
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
// Command: list
// ---------------------------------------------------------------------------

function cmdList() {
  printSectionHeader('Yahoo Finance Sectors');
  console.log();
  for (const key of SECTOR_KEYS) {
    console.log(`  ${key}`);
  }
  console.log(`\n  Total: ${SECTOR_KEYS.length} sectors`);
  console.log('\n  Usage: node yahoofinance-sectors.mjs view <sector-key>');
}

// ---------------------------------------------------------------------------
// Command: view <sector-key>
// ---------------------------------------------------------------------------

function cmdView(session, sectorKey) {
  if (!SECTOR_KEYS.includes(sectorKey)) {
    console.error(`Unknown sector key: "${sectorKey}". Run "list" to see valid keys.`);
    process.exit(1);
  }

  const result = fetchSector(session, sectorKey);
  const data = result?.data;
  if (!data) {
    console.error('No data returned for this sector.');
    process.exit(1);
  }

  const name = data.name || sectorKey;
  const symbol = data.symbol || 'N/A';

  printSectionHeader(`${name} (${symbol})`);

  // Overview
  const overview = data.overview || {};
  console.log('\n  -- Overview --');
  printTable([
    ['Companies Count', fmt(overview.companiesCount)],
    ['Market Cap', fmt(overview.marketCap, { bignum: true })],
    ['Market Weight', fmt(overview.marketWeight, { pct: true })],
    ['Employee Count', fmt(overview.employeeCount, { bignum: true })],
    ['Industries Count', fmt(overview.industriesCount)],
  ]);

  if (overview.description) {
    console.log('\n  -- Description --');
    const words = overview.description.split(/\s+/);
    let line = '    ';
    for (const w of words) {
      if (line.length + w.length > 78) { console.log(line); line = '    '; }
      line += (line.length > 4 ? ' ' : '') + w;
    }
    if (line.trim()) console.log(line);
  }

  // Top Companies
  const topCompanies = data.topCompanies || [];
  if (topCompanies.length) {
    console.log(`\n  -- Top Companies (${topCompanies.length}) --`);
    const hdr = '    ' + 'Symbol'.padEnd(10) + 'Name'.padEnd(30) + 'Rating'.padEnd(10) + 'Mkt Weight';
    console.log(hdr);
    console.log('    ' + '-'.repeat(hdr.trim().length));
    for (const c of topCompanies) {
      const sym = (c.symbol || '').padEnd(10);
      const cname = (c.name || '').substring(0, 28).padEnd(30);
      const rating = (c.rating || 'N/A').padEnd(10);
      const mw = c.marketWeight ? fmt(c.marketWeight, { pct: true }) : 'N/A';
      console.log(`    ${sym}${cname}${rating}${mw}`);
    }
  }

  // Top ETFs
  const topETFs = data.topETFs || [];
  if (topETFs.length) {
    console.log(`\n  -- Top ETFs (${topETFs.length}) --`);
    for (const e of topETFs) {
      console.log(`    ${(e.symbol || 'N/A').padEnd(10)} ${e.name || ''}`);
    }
  }

  // Top Mutual Funds
  const topMFs = data.topMutualFunds || [];
  if (topMFs.length) {
    console.log(`\n  -- Top Mutual Funds (${topMFs.length}) --`);
    for (const f of topMFs) {
      console.log(`    ${(f.symbol || 'N/A').padEnd(10)} ${f.name || ''}`);
    }
  }

  // Industries
  const industries = data.industries || [];
  const filteredIndustries = industries.filter(i => i.name !== 'All Industries');
  if (filteredIndustries.length) {
    console.log(`\n  -- Industries (${filteredIndustries.length}) --`);
    const ihdr = '    ' + 'Key'.padEnd(40) + 'Name'.padEnd(35) + 'Symbol'.padEnd(12) + 'Mkt Weight';
    console.log(ihdr);
    console.log('    ' + '-'.repeat(ihdr.trim().length));
    for (const ind of filteredIndustries) {
      const key = (ind.key || '').padEnd(40);
      const iname = (ind.name || '').substring(0, 33).padEnd(35);
      const isym = (ind.symbol || 'N/A').padEnd(12);
      const imw = ind.marketWeight ? fmt(ind.marketWeight, { pct: true }) : 'N/A';
      console.log(`    ${key}${iname}${isym}${imw}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: industry <sector-key>/<industry-key>
// ---------------------------------------------------------------------------

function cmdIndustry(session, compositeKey) {
  const slashIdx = compositeKey.indexOf('/');
  if (slashIdx === -1) {
    console.error('Usage: node yahoofinance-sectors.mjs industry <sector-key>/<industry-key>');
    console.error('Example: node yahoofinance-sectors.mjs industry technology/software-application');
    process.exit(1);
  }

  const sectorKey = compositeKey.substring(0, slashIdx);
  const industryKey = compositeKey.substring(slashIdx + 1);

  if (!sectorKey || !industryKey) {
    console.error('Both sector-key and industry-key are required.');
    process.exit(1);
  }

  const result = fetchIndustry(session, industryKey);
  const data = result?.data;
  if (!data) {
    console.error(`No data returned for industry "${industryKey}".`);
    process.exit(1);
  }

  const name = data.name || industryKey;
  const symbol = data.symbol || 'N/A';
  const parentSectorKey = data.sectorKey || sectorKey;
  const parentSectorName = data.sectorName || sectorKey;

  printSectionHeader(`${name} (${symbol})`);
  console.log(`  Sector: ${parentSectorName} (${parentSectorKey})`);

  // Overview
  const overview = data.overview || {};
  console.log('\n  -- Overview --');
  printTable([
    ['Companies Count', fmt(overview.companiesCount)],
    ['Market Cap', fmt(overview.marketCap, { bignum: true })],
    ['Market Weight', fmt(overview.marketWeight, { pct: true })],
    ['Employee Count', fmt(overview.employeeCount, { bignum: true })],
  ]);

  if (overview.description) {
    console.log('\n  -- Description --');
    const words = overview.description.split(/\s+/);
    let line = '    ';
    for (const w of words) {
      if (line.length + w.length > 78) { console.log(line); line = '    '; }
      line += (line.length > 4 ? ' ' : '') + w;
    }
    if (line.trim()) console.log(line);
  }

  // Top Companies
  const topCompanies = data.topCompanies || [];
  if (topCompanies.length) {
    console.log(`\n  -- Top Companies (${topCompanies.length}) --`);
    const hdr = '    ' + 'Symbol'.padEnd(10) + 'Name'.padEnd(30) + 'Rating'.padEnd(10) + 'Mkt Weight';
    console.log(hdr);
    console.log('    ' + '-'.repeat(hdr.trim().length));
    for (const c of topCompanies) {
      const sym = (c.symbol || '').padEnd(10);
      const cname = (c.name || '').substring(0, 28).padEnd(30);
      const rating = (c.rating || 'N/A').padEnd(10);
      const mw = c.marketWeight ? fmt(c.marketWeight, { pct: true }) : 'N/A';
      console.log(`    ${sym}${cname}${rating}${mw}`);
    }
  }

  // Top Performing Companies
  const topPerf = data.topPerformingCompanies || [];
  if (topPerf.length) {
    console.log(`\n  -- Top Performing Companies (${topPerf.length}) --`);
    const hdr = '    ' + 'Symbol'.padEnd(10) + 'Name'.padEnd(30) + 'YTD Return'.padEnd(14) + 'Last Price'.padEnd(14) + 'Target Price';
    console.log(hdr);
    console.log('    ' + '-'.repeat(hdr.trim().length));
    for (const c of topPerf) {
      const sym = (c.symbol || '').padEnd(10);
      const cname = (c.name || '').substring(0, 28).padEnd(30);
      const ytd = (c.ytdReturn ? fmt(c.ytdReturn, { pct: true }) : 'N/A').padEnd(14);
      const lp = (c.lastPrice ? fmt(c.lastPrice) : 'N/A').padEnd(14);
      const tp = c.targetPrice ? fmt(c.targetPrice) : 'N/A';
      console.log(`    ${sym}${cname}${ytd}${lp}${tp}`);
    }
  }

  // Top Growth Companies
  const topGrowth = data.topGrowthCompanies || [];
  if (topGrowth.length) {
    console.log(`\n  -- Top Growth Companies (${topGrowth.length}) --`);
    const hdr = '    ' + 'Symbol'.padEnd(10) + 'Name'.padEnd(30) + 'YTD Return'.padEnd(14) + 'Growth Est';
    console.log(hdr);
    console.log('    ' + '-'.repeat(hdr.trim().length));
    for (const c of topGrowth) {
      const sym = (c.symbol || '').padEnd(10);
      const cname = (c.name || '').substring(0, 28).padEnd(30);
      const ytd = (c.ytdReturn ? fmt(c.ytdReturn, { pct: true }) : 'N/A').padEnd(14);
      const ge = c.growthEstimate ? fmt(c.growthEstimate, { pct: true }) : 'N/A';
      console.log(`    ${sym}${cname}${ytd}${ge}`);
    }
  }

  // Top ETFs (if present for industry)
  const topETFs = data.topETFs || [];
  if (topETFs.length) {
    console.log(`\n  -- Top ETFs (${topETFs.length}) --`);
    for (const e of topETFs) {
      console.log(`    ${(e.symbol || 'N/A').padEnd(10)} ${e.name || ''}`);
    }
  }

  // Top Mutual Funds (if present for industry)
  const topMFs = data.topMutualFunds || [];
  if (topMFs.length) {
    console.log(`\n  -- Top Mutual Funds (${topMFs.length}) --`);
    for (const f of topMFs) {
      console.log(`    ${(f.symbol || 'N/A').padEnd(10)} ${f.name || ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`yahoofinance-sectors -- Fetch Yahoo Finance sector & industry data

Commands:
  auth                                      Authenticate via Chrome CDP (one-time)
  list                                      List all 11 sector keys
  view <sector-key>                         Sector overview, top companies, ETFs, funds, industries
  industry <sector-key>/<industry-key>      Industry detail (companies, performance, growth)

Sector keys:
  technology, financial-services, consumer-cyclical, communication-services,
  healthcare, industrials, consumer-defensive, energy, basic-materials,
  real-estate, utilities

Examples:
  node yahoofinance-sectors.mjs auth
  node yahoofinance-sectors.mjs list
  node yahoofinance-sectors.mjs view technology
  node yahoofinance-sectors.mjs view healthcare
  node yahoofinance-sectors.mjs industry technology/software-application
  node yahoofinance-sectors.mjs industry financial-services/banks-diversified

Data: ${DATA_DIR}/
  session.json     Auth crumb
  cache/           Cached API responses`);
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'auth': {
    doAuth();
    break;
  }

  case 'list': {
    cmdList();
    break;
  }

  case 'view': {
    const sectorKey = args[0];
    if (!sectorKey) { console.error('Usage: node yahoofinance-sectors.mjs view <sector-key>'); process.exit(1); }
    const session = getSession();
    cmdView(session, sectorKey);
    break;
  }

  case 'industry': {
    const compositeKey = args[0];
    if (!compositeKey) { console.error('Usage: node yahoofinance-sectors.mjs industry <sector-key>/<industry-key>'); process.exit(1); }
    const session = getSession();
    cmdIndustry(session, compositeKey);
    break;
  }

  default:
    printHelp();
    break;
}
