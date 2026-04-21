#!/usr/bin/env node
// seekingalpha-symbol.mjs — Stock/ETF data from Seeking Alpha: ratings, financials, earnings, dividends, valuation, and more
//
// Setup:   node seekingalpha-symbol.mjs auth
// Usage:   node seekingalpha-symbol.mjs summary AAPL
//          node seekingalpha-symbol.mjs ratings AAPL
//          node seekingalpha-symbol.mjs financials AAPL --type=income --period=annual
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-symbol');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
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
    console.error('No auth found. Run: node seekingalpha-symbol.mjs auth');
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
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      headers: { ...baseHeaders(auth), ...options.headers },
    });
  } catch (err) {
    throw new Error(`Network error fetching ${url.split('?')[0]}: ${err.message}`);
  }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node seekingalpha-symbol.mjs auth');
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
  // Accept URLs like https://seekingalpha.com/symbol/AAPL or plain tickers
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

function ratingLabel(val) {
  // SA ratings: 1=Very Bearish, 2=Bearish, 3=Neutral, 4=Bullish, 5=Very Bullish
  if (val >= 4.5) return 'Strong Buy';
  if (val >= 3.5) return 'Buy';
  if (val >= 2.5) return 'Hold';
  if (val >= 1.5) return 'Sell';
  return 'Strong Sell';
}

function fmt(val, decimals = 2) {
  if (val == null || val === '') return 'N/A';
  if (typeof val === 'number') return val.toFixed(decimals);
  return String(val);
}

function fmtPct(val) {
  if (val == null) return 'N/A';
  // SA metrics API returns most percentages as percent values (e.g. 10.071 = 10.07%)
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

// ---------------------------------------------------------------------------
// API: Ratings
// ---------------------------------------------------------------------------

async function fetchRatings(auth, ticker) {
  console.log(`Fetching ratings for ${ticker.toUpperCase()}...`);
  const url = `${API_BASE}/symbols/${ticker}/rating/periods?filter[periods][]=0&filter[periods][]=3&filter[periods][]=6`;
  const { data } = await apiFetch(auth, url);

  const periods = data.data || [];
  const result = { ticker: ticker.toUpperCase(), ratings: {} };

  for (const p of periods) {
    const periodMonths = p.meta?.period ?? 0;
    const label = periodMonths === 0 ? 'current' : `${periodMonths}m_ago`;
    const ratings = p.attributes?.ratings || {};
    result.ratings[label] = {
      quantRating: ratings.quantRating ? { score: fmt(ratings.quantRating), label: ratingLabel(ratings.quantRating) } : null,
      authorsRating: ratings.authorsRating ? { score: fmt(ratings.authorsRating), label: ratingLabel(ratings.authorsRating) } : null,
      sellSideRating: ratings.sellSideRating ? { score: fmt(ratings.sellSideRating), label: ratingLabel(ratings.sellSideRating) } : null,
      grades: {
        value: ratings.valueGrade != null ? gradeLabel(ratings.valueGrade) : null,
        growth: ratings.growthGrade != null ? gradeLabel(ratings.growthGrade) : null,
        profitability: ratings.profitabilityGrade != null ? gradeLabel(ratings.profitabilityGrade) : null,
        momentum: ratings.momentumGrade != null ? gradeLabel(ratings.momentumGrade) : null,
        epsRevisions: ratings.epsRevisionsGrade != null ? gradeLabel(ratings.epsRevisionsGrade) : null,
      },
    };
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-ratings.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Metrics (flexible — used for valuation, growth, profitability, momentum)
// ---------------------------------------------------------------------------

async function fetchMetrics(auth, ticker, fields) {
  const fieldsParam = fields.join(',');
  const url = `${API_BASE}/metrics?filter[fields]=${fieldsParam}&filter[slugs]=${ticker}&minified=false`;
  const { data } = await apiFetch(auth, url);

  // Build lookup: metric_type id -> field name (from JSON:API included)
  const metricTypeMap = {};
  for (const inc of (data.included || [])) {
    if (inc.type === 'metric_type' && inc.attributes?.field) {
      metricTypeMap[inc.id] = inc.attributes.field;
    }
  }

  const metrics = {};
  // Also extract ticker ID from included for use by other functions
  const tickerInc = (data.included || []).find(i => i.type === 'ticker');
  if (tickerInc) metrics._tickerId = tickerInc.id;

  for (const item of (data.data || [])) {
    const metricTypeId = item.relationships?.metric_type?.data?.id;
    const field = metricTypeMap[metricTypeId];
    if (field) {
      metrics[field] = item.attributes?.value ?? null;
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// API: Metric Grades
// ---------------------------------------------------------------------------

async function fetchMetricGrades(auth, ticker, fields) {
  const fieldsParam = fields.map(f => `filter[fields][]=${f}`).join('&');
  const url = `${API_BASE}/ticker_metric_grades?${fieldsParam}&filter[slugs]=${ticker}&filter[algos][]=main_quant`;
  const { data } = await apiFetch(auth, url);

  // Build lookup: metric_type id -> field name (from JSON:API included)
  const metricTypeMap = {};
  for (const inc of (data.included || [])) {
    if (inc.type === 'metric_type' && inc.attributes?.field) {
      metricTypeMap[inc.id] = inc.attributes.field;
    }
  }

  const grades = {};
  for (const item of (data.data || [])) {
    const metricTypeId = item.relationships?.metric_type?.data?.id;
    const field = metricTypeMap[metricTypeId];
    const grade = item.attributes?.grade;
    if (field && grade != null) {
      grades[field] = { value: grade, label: gradeLabel(grade) };
    }
  }
  return grades;
}

// ---------------------------------------------------------------------------
// API: Sector Metrics
// ---------------------------------------------------------------------------

async function fetchSectorMetrics(auth, ticker, fields) {
  const fieldsParam = fields.map(f => `filter[fields][]=${f}`).join('&');
  const url = `${API_BASE}/symbols/${ticker}/sector_metrics?${fieldsParam}`;
  const { data } = await apiFetch(auth, url);

  // Build lookup: metric_type id -> field name (from JSON:API included)
  const metricTypeMap = {};
  for (const inc of (data.included || [])) {
    if (inc.type === 'metric_type' && inc.attributes?.field) {
      metricTypeMap[inc.id] = inc.attributes.field;
    }
  }

  const sectorMetrics = {};
  for (const item of (data.data || [])) {
    const metricTypeId = item.relationships?.metric_type?.data?.id;
    const field = metricTypeMap[metricTypeId];
    if (field) {
      sectorMetrics[field] = item.attributes?.value ?? null;
    }
  }
  return sectorMetrics;
}

// ---------------------------------------------------------------------------
// API: Summary
// ---------------------------------------------------------------------------

async function fetchSummary(auth, ticker) {
  console.log(`Fetching summary for ${ticker.toUpperCase()}...`);

  const summaryFields = [
    'marketcap', 'close', 'pe_ratio', 'pe_nongaap_fy1',
    'dividend_yield', 'div_yield_fwd', 'div_rate_fwd', 'div_rate_ttm',
    'price_high_52w', 'price_low_52w',
    'beta24', 'short_interest_shares_outstanding',
    'shares', 'avg_daily_share_volume_3m',
  ];

  // Fetch metrics, ratings, and insider activity in parallel
  const [metrics, ratingsResult, insidersResult] = await Promise.all([
    fetchMetrics(auth, ticker, summaryFields),
    (async () => {
      const url = `${API_BASE}/symbols/${ticker}/rating/periods?filter[periods][]=0`;
      const { data } = await apiFetch(auth, url);
      const ratings = (data.data || [])[0]?.attributes?.ratings || {};
      return {
        quantRating: ratings.quantRating ? { score: fmt(ratings.quantRating), label: ratingLabel(ratings.quantRating) } : null,
        authorsRating: ratings.authorsRating ? { score: fmt(ratings.authorsRating), label: ratingLabel(ratings.authorsRating) } : null,
        sellSideRating: ratings.sellSideRating ? { score: fmt(ratings.sellSideRating), label: ratingLabel(ratings.sellSideRating) } : null,
      };
    })(),
    (async () => {
      try {
        const url = `${API_BASE}/symbols/${ticker}/insiders_sell_buy`;
        const { data } = await apiFetch(auth, url);
        // Response is an array of insider transactions
        const transactions = data.data || [];
        let buyCount = 0, sellCount = 0;
        for (const t of transactions) {
          const type = t.attributes?.transactionType;
          if (type === 'Buy') buyCount++;
          else if (type === 'Sell') sellCount++;
        }
        return {
          buyCount,
          sellCount,
          totalTransactions: transactions.length,
          recentTransactions: transactions.slice(0, 5).map(t => ({
            name: t.attributes?.fullName || null,
            position: t.attributes?.position || null,
            type: t.attributes?.transactionType || null,
            date: t.attributes?.date || null,
            shares: t.attributes?.shares || null,
            value: t.attributes?.totalValue || null,
            price: t.attributes?.price || null,
          })),
        };
      } catch { return null; }
    })(),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    price: metrics.close ?? null,
    marketCap: metrics.marketcap ?? null,
    marketCapFormatted: fmtLarge(metrics.marketcap),
    pe: metrics.pe_ratio ?? null,
    forwardPE: metrics.pe_nongaap_fy1 ?? null,
    dividendYield: metrics.dividend_yield ?? null,
    forwardDivYield: metrics.div_yield_fwd ?? null,
    divRateTTM: metrics.div_rate_ttm ?? null,
    divRateForward: metrics.div_rate_fwd ?? null,
    high52w: metrics.price_high_52w ?? null,
    low52w: metrics.price_low_52w ?? null,
    beta: metrics.beta24 ?? null,
    shortInterestPct: metrics.short_interest_shares_outstanding ?? null,
    shares: metrics.shares ?? null,
    avgVolume3m: metrics.avg_daily_share_volume_3m ?? null,
    ratings: ratingsResult,
    insiderActivity: insidersResult,
  };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-summary.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Financials
// ---------------------------------------------------------------------------

async function fetchFinancials(auth, ticker, type = 'income', period = 'annual') {
  const typeMap = {
    income: 'income-statement',
    balance: 'balance-sheet',
    cashflow: 'cash-flow-statement',
  };
  const statementType = typeMap[type] || typeMap.income;
  console.log(`Fetching ${type} (${period}) for ${ticker.toUpperCase()}...`);

  const url = `${API_BASE}/symbols/${ticker}/fundamentals_metrics?period_type=${period}&statement_type=${statementType}&target_currency=USD`;
  const { data } = await apiFetch(auth, url);

  // Response is a raw array of section objects (not JSON:API), each with title, rows, etc.
  const rawSections = Array.isArray(data) ? data : (data.data || []);

  const sections = [];
  for (const section of rawSections) {
    const sectionRows = [];
    for (const row of (section.rows || [])) {
      const cells = (row.cells || []).map(c => ({
        period: c.name || null,
        value: c.raw_value ?? c.value ?? null,
        formatted: c.value || null,
        yoy: c.yoy_value || null,
      }));
      sectionRows.push({
        name: row.name || '',
        label: row.value || row.name || '',
        bold: row.bold || false,
        cells,
      });
    }
    sections.push({
      title: section.title || '',
      group: section.section_group || '',
      rows: sectionRows,
    });
  }

  const result = {
    ticker: ticker.toUpperCase(),
    statementType: type,
    periodType: period,
    sections,
  };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-financials-${type}-${period}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Earnings
// ---------------------------------------------------------------------------

async function resolveTickerId(auth, ticker) {
  // Use a minimal metrics call to resolve ticker slug -> numeric ticker ID
  const url = `${API_BASE}/metrics?filter[fields]=close&filter[slugs]=${ticker}&minified=false`;
  const { data } = await apiFetch(auth, url);
  const tickerInc = (data.included || []).find(i => i.type === 'ticker');
  if (!tickerInc) throw new Error(`Could not resolve ticker ID for ${ticker}`);
  return tickerInc.id;
}

async function fetchEarnings(auth, ticker) {
  console.log(`Fetching earnings for ${ticker.toUpperCase()}...`);

  // Resolve ticker slug to numeric ID (required by estimates API)
  const tickerId = await resolveTickerId(auth, ticker);

  const url = `${API_BASE}/symbol_data/estimates?estimates_data_items=eps_normalized_actual,eps_normalized_consensus_mean,revenue_actual,revenue_consensus_mean&period_type=quarterly&relative_periods=-3,-2,-1,0,1,2,3&revisions_data_items=eps_normalized_rev7d,eps_normalized_rev30d,eps_normalized_rev90d,revenue_rev7d,revenue_rev30d,revenue_rev90d&ticker_ids=${tickerId}`;
  const { data } = await apiFetch(auth, url);

  const tickerEstimates = data.estimates?.[tickerId] || {};
  const tickerRevisions = data.revisions?.[tickerId] || {};

  // Parse estimates: keyed by data item (e.g. "revenue_actual"), each containing relative period entries
  const earnings = { ticker: ticker.toUpperCase(), tickerId, quarters: [], revisions: {} };

  // Collect all relative periods across all data items
  const periodData = {};
  for (const [dataItem, periodEntries] of Object.entries(tickerEstimates)) {
    for (const [relPeriod, values] of Object.entries(periodEntries)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      const entry = values[0];
      if (!periodData[relPeriod]) {
        periodData[relPeriod] = {
          relativePeriod: parseInt(relPeriod),
          fiscalYear: entry.period?.fiscalyear || null,
          fiscalQuarter: entry.period?.fiscalquarter || null,
          periodEndDate: entry.period?.periodenddate || null,
        };
      }
      periodData[relPeriod][dataItem] = parseFloat(entry.dataitemvalue) || null;
    }
  }

  // Sort by relative period
  earnings.quarters = Object.values(periodData).sort((a, b) => a.relativePeriod - b.relativePeriod);

  // Parse revisions similarly
  for (const [dataItem, periodEntries] of Object.entries(tickerRevisions)) {
    for (const [relPeriod, values] of Object.entries(periodEntries)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      if (!earnings.revisions[relPeriod]) earnings.revisions[relPeriod] = {};
      earnings.revisions[relPeriod][dataItem] = parseFloat(values[0]?.dataitemvalue) || null;
    }
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-earnings.json`);
  saveJson(cacheFile, earnings);
  console.log(`Cached: ${cacheFile}`);
  return earnings;
}

// ---------------------------------------------------------------------------
// API: Dividends
// ---------------------------------------------------------------------------

async function fetchDividends(auth, ticker) {
  console.log(`Fetching dividends for ${ticker.toUpperCase()}...`);

  // Fetch dividend metrics and history in parallel
  const divFields = [
    'dividend_yield', 'div_yield_fwd', 'div_rate_ttm', 'div_rate_fwd',
    'payout_ratio', 'div_grow_rate3', 'div_grow_rate5',
    'dividend_growth', 'div_pay_date', 'last_div_date', 'div_distribution',
  ];

  const [metrics, grades, historyResult] = await Promise.all([
    fetchMetrics(auth, ticker, divFields),
    fetchMetricGrades(auth, ticker, ['dividend_yield', 'div_yield_fwd', 'div_grow_rate3', 'div_grow_rate5', 'payout_ratio']),
    (async () => {
      try {
        const url = `${API_BASE}/symbols/${ticker}/dividend_history?years=5`;
        const { data } = await apiFetch(auth, url);
        return (data.data || []).map(item => {
          const attrs = item.attributes || {};
          return {
            exDate: attrs.ex_date || null,
            payDate: attrs.pay_date || null,
            amount: attrs.amount ?? null,
            frequency: attrs.freq || null,
            type: attrs.type || null,
          };
        });
      } catch { return []; }
    })(),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    yield: metrics.dividend_yield ?? null,
    yieldForward: metrics.div_yield_fwd ?? null,
    rateTTM: metrics.div_rate_ttm ?? null,
    rateForward: metrics.div_rate_fwd ?? null,
    payoutRatio: metrics.payout_ratio ?? null,
    growthRate3y: metrics.div_grow_rate3 ?? null,
    growthRate5y: metrics.div_grow_rate5 ?? null,
    dividendGrowth: metrics.dividend_growth ?? null,
    nextPayDate: metrics.div_pay_date ? new Date(metrics.div_pay_date * 1000).toISOString().split('T')[0] : null,
    lastDivDate: metrics.last_div_date ? new Date(metrics.last_div_date * 1000).toISOString().split('T')[0] : null,
    frequency: metrics.div_distribution != null ? ({ 1: 'Annual', 2: 'Semi-Annual', 3: 'Quarterly', 4: 'Monthly' }[metrics.div_distribution] || String(metrics.div_distribution)) : null,
    grades,
    history: historyResult,
  };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-dividends.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Valuation
// ---------------------------------------------------------------------------

async function fetchValuation(auth, ticker) {
  console.log(`Fetching valuation for ${ticker.toUpperCase()}...`);

  const valFields = [
    'pe_ratio', 'pe_nongaap', 'pe_nongaap_fy1', 'pe_gaap_fy1',
    'peg_gaap', 'peg_nongaap_fy1',
    'ps_ratio', 'ps_ratio_fy1',
    'pb_ratio', 'pb_fy1_ratio',
    'ev_ebitda', 'ev_ebitda_fy1', 'ev_ebit', 'ev_ebit_fy1',
    'ev_12m_sales_ratio', 'ev_sales_fy1',
    'price_cf_ratio', 'price_cf_ratio_fy1',
    'dividend_yield', 'marketcap',
  ];

  const [metrics, grades, sectorMetrics] = await Promise.all([
    fetchMetrics(auth, ticker, valFields),
    fetchMetricGrades(auth, ticker, valFields),
    fetchSectorMetrics(auth, ticker, valFields),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    metrics: {},
  };

  for (const field of valFields) {
    result.metrics[field] = {
      value: metrics[field] ?? null,
      grade: grades[field] || null,
      sectorMedian: sectorMetrics[field] ?? null,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-valuation.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Growth
// ---------------------------------------------------------------------------

async function fetchGrowth(auth, ticker) {
  console.log(`Fetching growth metrics for ${ticker.toUpperCase()}...`);

  const growthFields = [
    'revenue_growth', 'revenue_growth3', 'revenue_growth5',
    'diluted_eps_growth', 'diluted_eps_3y_cagr', 'diluted_eps_5y_cagr',
    'ebitda_yoy', 'ebitda_3y_cagr', 'ebitda_5y_cagr',
    'levered_free_cash_flow_yoy', 'levered_free_cash_flow_3y_cagr',
    'dividend_growth', 'div_grow_rate3', 'div_grow_rate5',
  ];

  const [metrics, grades, sectorMetrics] = await Promise.all([
    fetchMetrics(auth, ticker, growthFields),
    fetchMetricGrades(auth, ticker, growthFields),
    fetchSectorMetrics(auth, ticker, growthFields),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    metrics: {},
  };

  for (const field of growthFields) {
    result.metrics[field] = {
      value: metrics[field] ?? null,
      formatted: fmtPct(metrics[field]),
      grade: grades[field] || null,
      sectorMedian: sectorMetrics[field] ?? null,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-growth.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Profitability
// ---------------------------------------------------------------------------

async function fetchProfitability(auth, ticker) {
  console.log(`Fetching profitability metrics for ${ticker.toUpperCase()}...`);

  const profFields = [
    'gross_margin', 'ebitda_margin', 'ebit_margin', 'net_margin',
    'fcf_margin', 'levered_fcf_margin',
    'roe', 'return_on_avg_tot_assets', 'return_on_total_capital',
    'assets_turnover',
  ];

  const [metrics, grades, sectorMetrics] = await Promise.all([
    fetchMetrics(auth, ticker, profFields),
    fetchMetricGrades(auth, ticker, profFields),
    fetchSectorMetrics(auth, ticker, profFields),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    metrics: {},
  };

  for (const field of profFields) {
    result.metrics[field] = {
      value: metrics[field] ?? null,
      formatted: fmtPct(metrics[field]),
      grade: grades[field] || null,
      sectorMedian: sectorMetrics[field] ?? null,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-profitability.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Momentum
// ---------------------------------------------------------------------------

async function fetchMomentum(auth, ticker) {
  console.log(`Fetching momentum for ${ticker.toUpperCase()}...`);

  const momFields = [
    'price_return_1w', 'price_return_1m', 'price_return_3m',
    'price_return_6m', 'price_return_9m', 'price_return_ytd',
    'price_return_1y', 'price_return_3y', 'price_return_5y', 'price_return_10y',
    'momentum_3m', 'momentum_6m', 'momentum_9m', 'momentum_12m',
    'beta24',
  ];

  const [metrics, grades] = await Promise.all([
    fetchMetrics(auth, ticker, momFields),
    fetchMetricGrades(auth, ticker, momFields),
  ]);

  const result = {
    ticker: ticker.toUpperCase(),
    metrics: {},
  };

  for (const field of momFields) {
    result.metrics[field] = {
      value: metrics[field] ?? null,
      formatted: fmtPct(metrics[field]),
      grade: grades[field] || null,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `${ticker}-momentum.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Peers
// ---------------------------------------------------------------------------

async function fetchPeers(auth, ticker) {
  console.log(`Fetching peers for ${ticker.toUpperCase()}...`);
  const url = `${API_BASE}/symbols/${ticker}/suggested?source_type=peers_similarities&variation=ds_v2`;
  const { data } = await apiFetch(auth, url);

  const peers = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    return {
      ticker: attrs.name || attrs.slug?.toUpperCase() || item.id,
      slug: attrs.slug || null,
      name: attrs.companyName || attrs.company || attrs.name || null,
    };
  });

  // If peers have slugs, fetch key comparison metrics for all
  const peerSlugs = peers.map(p => p.slug || p.ticker?.toLowerCase()).filter(Boolean);
  let peerMetrics = {};

  if (peerSlugs.length > 0) {
    const compFields = ['close', 'marketcap', 'pe_ratio', 'dividend_yield', 'revenue_growth', 'diluted_eps_growth'];
    const slugsParam = [ticker, ...peerSlugs].join(',');
    const fieldsParam = compFields.join(',');
    const metricUrl = `${API_BASE}/metrics?filter[fields]=${fieldsParam}&filter[slugs]=${slugsParam}&minified=false`;

    try {
      const { data: metricData } = await apiFetch(auth, metricUrl);
      // Build lookup maps from JSON:API included
      const metricTypeMap = {};
      const tickerMap = {};
      for (const inc of (metricData.included || [])) {
        if (inc.type === 'metric_type' && inc.attributes?.field) metricTypeMap[inc.id] = inc.attributes.field;
        if (inc.type === 'ticker' && inc.attributes?.slug) tickerMap[inc.id] = inc.attributes.slug;
      }
      for (const item of (metricData.data || [])) {
        const metricTypeId = item.relationships?.metric_type?.data?.id;
        const tickerId = item.relationships?.ticker?.data?.id;
        const field = metricTypeMap[metricTypeId];
        const slug = tickerMap[tickerId];
        if (field && slug) {
          if (!peerMetrics[slug]) peerMetrics[slug] = {};
          peerMetrics[slug][field] = item.attributes?.value ?? null;
        }
      }
    } catch { /* non-critical */ }
  }

  const result = {
    ticker: ticker.toUpperCase(),
    peers: peers.map(p => ({
      ...p,
      metrics: peerMetrics[p.slug || p.ticker?.toLowerCase()] || {},
    })),
    sourceMetrics: peerMetrics[ticker] || {},
  };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-peers.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: News
// ---------------------------------------------------------------------------

async function fetchNews(auth, ticker, count = 10) {
  console.log(`Fetching news for ${ticker.toUpperCase()}...`);
  const url = `${API_BASE}/symbols/${ticker}/news?filter[category]=news_card&include=author,primaryTickers&page[size]=${count}`;
  const { data } = await apiFetch(auth, url);

  // Build included lookup (authors, tickers)
  const included = {};
  for (const inc of (data.included || [])) {
    included[`${inc.type}:${inc.id}`] = inc;
  }

  const articles = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    // Resolve author
    const authorRef = item.relationships?.author?.data;
    const authorInc = authorRef ? included[`${authorRef.type}:${authorRef.id}`] : null;
    // URL from links.self
    const selfLink = item.links?.self;
    const articleUrl = selfLink ? `https://seekingalpha.com${selfLink}` : null;

    return {
      id: item.id,
      title: attrs.title || '',
      publishedAt: attrs.publishOn || attrs.publish_on || null,
      url: articleUrl,
      isPaywalled: attrs.isPaywalled || false,
      commentCount: attrs.commentCount ?? null,
      author: authorInc?.attributes?.nick || authorInc?.attributes?.slug || null,
    };
  });

  const result = { ticker: ticker.toUpperCase(), count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-news.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Analysis
// ---------------------------------------------------------------------------

async function fetchAnalysis(auth, ticker, count = 10) {
  console.log(`Fetching analysis for ${ticker.toUpperCase()}...`);
  const url = `${API_BASE}/symbols/${ticker}/analysis?include=author,primaryTickers,sentiments&page[size]=${count}`;
  const { data } = await apiFetch(auth, url);

  // Build included lookup
  const included = {};
  for (const inc of (data.included || [])) {
    included[`${inc.type}:${inc.id}`] = inc;
  }

  const articles = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const authorRef = item.relationships?.author?.data;
    const authorInc = authorRef ? included[`${authorRef.type}:${authorRef.id}`] : null;
    // Sentiments can have multiple entries (one per ticker); deduplicate
    const sentimentRefs = item.relationships?.sentiments?.data || [];
    const sentiments = [...new Set(sentimentRefs.map(ref => {
      const si = included[`${ref.type}:${ref.id}`];
      return si?.attributes?.type || si?.attributes?.signal || null;
    }).filter(Boolean))];
    // URL from links.self
    const selfLink = item.links?.self;
    const articleUrl = selfLink ? `https://seekingalpha.com${selfLink}` : null;

    return {
      id: item.id,
      title: attrs.title || '',
      publishedAt: attrs.publishOn || attrs.publish_on || null,
      url: articleUrl,
      isPaywalled: attrs.isPaywalled || false,
      commentCount: attrs.commentCount ?? null,
      author: authorInc?.attributes?.nick || authorInc?.attributes?.slug || null,
      authorUrl: authorInc?.attributes?.slug ? `https://seekingalpha.com/author/${authorInc.attributes.slug}` : null,
      sentiments: sentiments.length > 0 ? sentiments : null,
      structuredInsights: attrs.structuredInsights || null,
    };
  });

  const result = { ticker: ticker.toUpperCase(), count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-analysis.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const tickerArg = positional[0];

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'summary': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs summary <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchSummary(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'ratings': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs ratings <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchRatings(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'financials': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs financials <ticker> [--type=income|balance|cashflow] [--period=annual|quarterly]'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const type = flags.type || 'income';
      const period = flags.period || 'annual';
      const result = await fetchFinancials(getAuth(), ticker, type, period);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'earnings': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs earnings <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchEarnings(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'dividends': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs dividends <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchDividends(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'valuation': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs valuation <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchValuation(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'growth': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs growth <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchGrowth(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'profitability': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs profitability <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchProfitability(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'momentum': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs momentum <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchMomentum(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'peers': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs peers <ticker>'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const result = await fetchPeers(getAuth(), ticker);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'news': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs news <ticker> [--count=10]'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const count = parseInt(flags.count || '10', 10);
      const result = await fetchNews(getAuth(), ticker, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'analysis': {
      if (!tickerArg) { console.error('Usage: seekingalpha-symbol.mjs analysis <ticker> [--count=10]'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const count = parseInt(flags.count || '10', 10);
      const result = await fetchAnalysis(getAuth(), ticker, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-symbol.mjs';
      console.log(`
seekingalpha-symbol — Stock/ETF data from Seeking Alpha

Setup:
  node ${script} auth                         Extract cookies from Chrome

Commands:
  node ${script} summary <ticker>             Overview: price, ratings, key metrics, insider activity
  node ${script} ratings <ticker>             Quant/author/sell-side ratings with 3m and 6m history
  node ${script} financials <ticker>          Financial statements
       [--type=income|balance|cashflow]        Statement type (default: income)
       [--period=annual|quarterly]             Period type (default: annual)
  node ${script} earnings <ticker>            EPS/revenue estimates, surprises, revisions
  node ${script} dividends <ticker>           Yield, growth, safety, payout history
  node ${script} valuation <ticker>           P/E, EV/EBITDA, P/S, PEG with sector grades
  node ${script} growth <ticker>              Revenue/EPS/EBITDA growth with grades
  node ${script} profitability <ticker>       Margins, ROE, ROA with grades
  node ${script} momentum <ticker>            Price performance and grades
  node ${script} peers <ticker>               Similar stocks comparison
  node ${script} news <ticker> [--count=10]   Ticker-specific news
  node ${script} analysis <ticker> [--count=10]  Analysis articles for ticker

Ticker formats:
  AAPL                                        Plain ticker symbol
  aapl                                        Case-insensitive
  https://seekingalpha.com/symbol/AAPL        URL format

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
