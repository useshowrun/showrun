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
// Requires Node 22+ (built-in fetch).

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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

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
    console.error('No auth found. Run: node yahoofinance-sectors.mjs auth');
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
    console.error(`Auth expired (HTTP ${resp.status}). Run: node yahoofinance-sectors.mjs auth`);
    process.exit(1);
  }
  if (resp.status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes and try again.');
    process.exit(1);
  }
  if (resp.status === 404) {
    console.error('Not found (HTTP 404). Check the sector/industry key and try again.');
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
// Sector / Industry fetcher
// ---------------------------------------------------------------------------

async function fetchSector(session, sectorKey) {
  const url = `${SECTORS_URL}/${encodeURIComponent(sectorKey)}?formatted=true&withReturns=true&lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const data = await apiFetch(session, url);

  // Cache
  ensureDir(CACHE_DIR);
  const cacheFile = resolve(CACHE_DIR, `sector-${sectorKey}.json`);
  saveJson(cacheFile, data);

  return data;
}

async function fetchIndustry(session, industryKey) {
  const url = `${INDUSTRIES_URL}/${encodeURIComponent(industryKey)}?formatted=true&withReturns=true&lang=en-US&region=US&crumb=${encodeURIComponent(session.crumb)}`;
  const data = await apiFetch(session, url);

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

async function cmdView(session, sectorKey) {
  if (!SECTOR_KEYS.includes(sectorKey)) {
    console.error(`Unknown sector key: "${sectorKey}". Run "list" to see valid keys.`);
    process.exit(1);
  }

  const result = await fetchSector(session, sectorKey);
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

async function cmdIndustry(session, compositeKey) {
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

  const result = await fetchIndustry(session, industryKey);
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
  session.json     Auth cookies & crumb
  cache/           Cached API responses`);
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'auth': {
    await doAuth();
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
    await cmdView(session, sectorKey);
    break;
  }

  case 'industry': {
    const compositeKey = args[0];
    if (!compositeKey) { console.error('Usage: node yahoofinance-sectors.mjs industry <sector-key>/<industry-key>'); process.exit(1); }
    const session = getSession();
    await cmdIndustry(session, compositeKey);
    break;
  }

  default:
    printHelp();
    break;
}
