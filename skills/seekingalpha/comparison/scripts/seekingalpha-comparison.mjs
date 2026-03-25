#!/usr/bin/env node
// seekingalpha-comparison.mjs — Side-by-side stock comparison from Seeking Alpha
//
// Setup:   node seekingalpha-comparison.mjs auth
// Usage:   node seekingalpha-comparison.mjs compare AAPL MSFT NVDA
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-comparison');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Seeking Alpha tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('seekingalpha.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No Seeking Alpha tab found. Open seekingalpha.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://seekingalpha.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));

  // Build full cookie string — PerimeterX cookies are needed
  const cookieStr = cookies
    .filter(c => c.domain.includes('seekingalpha.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to Seeking Alpha?');

  const userCookieKey = cookieMap['user_cookie_key'] || null;
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints may not work.');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userCookieKey,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node seekingalpha-comparison.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node seekingalpha-comparison.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

function parseTicker(input) {
  const urlMatch = input.match(/seekingalpha\.com\/symbol\/([^\s/?#]+)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return input.toLowerCase();
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function gradeLabel(val) {
  // SA grades: 1=A+, 2=A, 3=A-, 4=B+, 5=B, 6=B-, 7=C+, 8=C, 9=C-, 10=D+, 11=D, 12=D-, 13=F
  const grades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
  const idx = Math.round(val) - 1;
  if (idx >= 0 && idx < grades.length) return grades[idx];
  return String(val);
}

function fmt(val, decimals = 2) {
  if (val == null || val === '') return 'N/A';
  if (typeof val === 'number') return val.toFixed(decimals);
  return String(val);
}

function fmtPct(val) {
  if (val == null) return 'N/A';
  // SA API returns values already in percentage form (e.g., 10.07 = 10.07%)
  return val.toFixed(2) + '%';
}

function fmtLarge(val) {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return fmt(val);
}

// Pad or truncate string to fixed width
function pad(str, width, align = 'left') {
  const s = String(str ?? 'N/A');
  if (s.length >= width) return s.substring(0, width);
  if (align === 'right') return s.padStart(width);
  return s.padEnd(width);
}

// ---------------------------------------------------------------------------
// API: Batch Metrics (multiple slugs in one call)
// ---------------------------------------------------------------------------

async function fetchBatchMetrics(auth, slugs, fields) {
  const fieldsParam = fields.join(',');
  const slugsParam = slugs.join(',');
  const url = `${API_BASE}/metrics?filter[fields]=${fieldsParam}&filter[slugs]=${slugsParam}&minified=false`;
  console.log(`Fetching metrics for ${slugs.map(s => s.toUpperCase()).join(', ')}...`);
  const { data } = await apiFetch(auth, url);

  // Build lookup tables from included items (JSON:API format)
  const tickerLookup = {};  // id -> slug
  const fieldLookup = {};   // id -> field name
  for (const inc of (data.included || [])) {
    if (inc.type === 'ticker') tickerLookup[inc.id] = inc.attributes?.slug || '';
    if (inc.type === 'metric_type') fieldLookup[inc.id] = inc.attributes?.field || '';
  }

  // Organize by slug -> field -> value
  const bySlug = {};
  for (const slug of slugs) bySlug[slug] = {};
  for (const item of (data.data || [])) {
    const tickerId = item.relationships?.ticker?.data?.id;
    const metricTypeId = item.relationships?.metric_type?.data?.id;
    const slug = tickerLookup[tickerId] || '';
    const field = fieldLookup[metricTypeId] || '';
    if (slug && field && bySlug[slug]) {
      bySlug[slug][field] = item.attributes?.value;
    }
  }
  return bySlug;
}

// ---------------------------------------------------------------------------
// API: Batch Metric Grades (multiple slugs in one call)
// ---------------------------------------------------------------------------

async function fetchBatchGrades(auth, slugs, fields) {
  const fieldsParam = fields.map(f => `filter[fields][]=${f}`).join('&');
  const slugsParam = slugs.join(',');
  const url = `${API_BASE}/ticker_metric_grades?${fieldsParam}&filter[slugs]=${slugsParam}&filter[algos][]=main_quant`;
  console.log(`Fetching grades for ${slugs.map(s => s.toUpperCase()).join(', ')}...`);
  const { data } = await apiFetch(auth, url);

  // Build lookup tables from included items (JSON:API format)
  const tickerLookup = {};  // id -> slug
  const fieldLookup = {};   // id -> field name
  for (const inc of (data.included || [])) {
    if (inc.type === 'ticker') tickerLookup[inc.id] = inc.attributes?.slug || '';
    if (inc.type === 'metric_type') fieldLookup[inc.id] = inc.attributes?.field || '';
  }

  // Organize by slug -> field -> grade
  const bySlug = {};
  for (const slug of slugs) bySlug[slug] = {};
  for (const item of (data.data || [])) {
    const tickerId = item.relationships?.ticker?.data?.id;
    const metricTypeId = item.relationships?.metric_type?.data?.id;
    const slug = tickerLookup[tickerId] || '';
    const field = fieldLookup[metricTypeId] || '';
    const grade = item.attributes?.grade;
    if (slug && field && bySlug[slug] && grade != null) {
      bySlug[slug][field] = { value: grade, label: gradeLabel(grade) };
    }
  }
  return bySlug;
}

// ---------------------------------------------------------------------------
// API: Batch Ticker Info (company name, sector via GICS)
// ---------------------------------------------------------------------------

async function fetchBatchTickerInfo(auth, slugs) {
  const slugsParam = slugs.join(',');
  const url = `${API_BASE}/tickers?filter[slugs]=${slugsParam}&include[gics]=true&per_page=100`;
  console.log(`Fetching ticker info for ${slugs.map(s => s.toUpperCase()).join(', ')}...`);
  const { data } = await apiFetch(auth, url);

  // Build included lookup for sector/sub_industry data (JSON:API format)
  const included = {};
  for (const inc of (data.included || [])) {
    included[`${inc.type}:${inc.id}`] = inc;
  }

  const bySlug = {};
  for (const item of (data.data || [])) {
    const attrs = item.attributes || {};
    const slug = attrs.slug || '';

    // Resolve sector from relationships
    let sector = null;
    const sectorRef = item.relationships?.sector?.data;
    if (sectorRef) {
      const sectorItem = included[`${sectorRef.type}:${sectorRef.id}`];
      if (sectorItem?.attributes?.name) {
        sector = sectorItem.attributes.name;
      }
    }

    bySlug[slug] = {
      name: attrs.company || attrs.name || slug.toUpperCase(),
      slug,
      sector,
      exchange: attrs.exchange || null,
    };
  }
  return bySlug;
}

// ---------------------------------------------------------------------------
// Compare: orchestrate all batch calls and build comparison table
// ---------------------------------------------------------------------------

async function doCompare(auth, tickers) {
  const slugs = tickers.map(t => parseTicker(t));

  // Metric fields to fetch
  const metricFields = [
    'marketcap_display',
    'pe_ratio',
    'dividend_yield',
    'revenue_growth',
    'diluted_eps_growth',
    'gross_margin',
    'net_margin',
    'rtn_on_common_equity',
    'number_of_employees',
    'tev',
    'tot_analysts_recommendations',
    'authors_count',
  ];

  // Grade fields to fetch
  const gradeFields = [
    'value_category',
    'growth_category',
    'profitability_category',
    'momentum_category',
    'eps_revisions_category',
  ];

  // Fetch all data in parallel — 3 batch API calls total
  const [metricsMap, gradesMap, tickerInfoMap] = await Promise.all([
    fetchBatchMetrics(auth, slugs, metricFields),
    fetchBatchGrades(auth, slugs, gradeFields),
    fetchBatchTickerInfo(auth, slugs),
  ]);

  // Build structured result
  const comparison = {
    tickers: slugs.map(slug => {
      const info = tickerInfoMap[slug] || {};
      const metrics = metricsMap[slug] || {};
      const grades = gradesMap[slug] || {};
      return {
        ticker: slug.toUpperCase(),
        company: info.name || slug.toUpperCase(),
        sector: info.sector || 'N/A',
        exchange: info.exchange || null,
        metrics: {
          marketCap: metrics.marketcap_display ?? null,
          pe: metrics.pe_ratio ?? null,
          dividendYield: metrics.dividend_yield ?? null,
          revenueGrowth: metrics.revenue_growth ?? null,
          epsGrowth: metrics.diluted_eps_growth ?? null,
          grossMargin: metrics.gross_margin ?? null,
          netMargin: metrics.net_margin ?? null,
          roe: metrics.rtn_on_common_equity ?? null,
          employees: metrics.number_of_employees ?? null,
          tev: metrics.tev ?? null,
          analystCount: metrics.tot_analysts_recommendations ?? null,
          authorCount: metrics.authors_count ?? null,
        },
        grades: {
          value: grades.value_category || null,
          growth: grades.growth_category || null,
          profitability: grades.profitability_category || null,
          momentum: grades.momentum_category || null,
          epsRevisions: grades.eps_revisions_category || null,
        },
      };
    }),
    fetchedAt: new Date().toISOString(),
  };

  // Cache result
  const cacheKey = slugs.sort().join('-vs-');
  const cacheFile = resolve(CACHE_DIR, `compare-${cacheKey}.json`);
  saveJson(cacheFile, comparison);
  console.log(`Cached: ${cacheFile}`);

  // Display comparison table
  printComparisonTable(comparison);

  return comparison;
}

// ---------------------------------------------------------------------------
// Display: formatted comparison table
// ---------------------------------------------------------------------------

function printComparisonTable(comparison) {
  const items = comparison.tickers;
  const colWidth = 16;
  const labelWidth = 20;

  // Build header
  const headerCols = items.map(t => pad(t.ticker, colWidth));
  const divider = '-'.repeat(labelWidth + 2) + headerCols.map(() => '-'.repeat(colWidth + 1)).join('');

  console.log('\n' + divider);
  console.log(pad('', labelWidth) + '  ' + headerCols.join(' '));
  console.log(divider);

  // Company info section
  console.log(pad('Company', labelWidth) + '  ' + items.map(t => pad(t.company, colWidth)).join(' '));
  console.log(pad('Sector', labelWidth) + '  ' + items.map(t => pad(t.sector, colWidth)).join(' '));

  console.log(divider);
  console.log('  QUANT GRADES');
  console.log(divider);

  // Grades section
  const gradeRows = [
    ['Value', 'value'],
    ['Growth', 'growth'],
    ['Profitability', 'profitability'],
    ['Momentum', 'momentum'],
    ['EPS Revisions', 'epsRevisions'],
  ];

  for (const [label, key] of gradeRows) {
    const vals = items.map(t => {
      const g = t.grades[key];
      return pad(g ? g.label : 'N/A', colWidth);
    });
    console.log(pad(label, labelWidth) + '  ' + vals.join(' '));
  }

  console.log(divider);
  console.log('  KEY METRICS');
  console.log(divider);

  // Metrics section
  const metricRows = [
    ['Market Cap', 'marketCap', v => fmtLarge(v)],
    ['P/E Ratio', 'pe', v => fmt(v)],
    ['Dividend Yield', 'dividendYield', v => fmtPct(v)],
    ['Revenue Growth', 'revenueGrowth', v => fmtPct(v)],
    ['EPS Growth', 'epsGrowth', v => fmtPct(v)],
    ['Gross Margin', 'grossMargin', v => fmtPct(v)],
    ['Net Margin', 'netMargin', v => fmtPct(v)],
    ['ROE', 'roe', v => fmtPct(v)],
    ['TEV', 'tev', v => fmtLarge(v)],
    ['Employees', 'employees', v => v != null ? Number(v).toLocaleString() : 'N/A'],
    ['Analyst Recs', 'analystCount', v => fmt(v, 0)],
    ['SA Authors', 'authorCount', v => fmt(v, 0)],
  ];

  for (const [label, key, formatter] of metricRows) {
    const vals = items.map(t => {
      const v = t.metrics[key];
      return pad(formatter(v), colWidth);
    });
    console.log(pad(label, labelWidth) + '  ' + vals.join(' '));
  }

  console.log(divider);
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'compare': {
      if (positional.length < 2) {
        console.error('Usage: seekingalpha-comparison.mjs compare <ticker1> <ticker2> [ticker3...]');
        console.error('       Provide 2-10 ticker symbols for comparison.');
        process.exit(1);
      }
      if (positional.length > 10) {
        console.error('Error: Maximum 10 tickers for comparison.');
        process.exit(1);
      }
      const auth = getAuth();
      const result = await doCompare(auth, positional);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-comparison.mjs';
      console.log(`
seekingalpha-comparison — Side-by-side stock comparison from Seeking Alpha

Setup:
  node ${script} auth                                    Extract cookies from Chrome

Commands:
  node ${script} compare <t1> <t2> [t3...]              Compare 2-10 stocks side by side

Examples:
  node ${script} compare AAPL MSFT                      Compare two stocks
  node ${script} compare AAPL MSFT NVDA GOOG AMZN       Compare five stocks

Comparison includes:
  - Company name and sector
  - Quant rating grades (value, growth, profitability, momentum, EPS revisions)
  - Key metrics: market cap, P/E, dividend yield, revenue growth, EPS growth,
    gross margin, net margin, ROE, total enterprise value, employee count

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
