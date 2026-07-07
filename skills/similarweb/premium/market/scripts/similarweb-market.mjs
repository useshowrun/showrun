#!/usr/bin/env node
// similarweb-market.mjs — Industry/market analysis from SimilarWeb: website rankings, market leaders, industry benchmarks
//
// Setup:   node similarweb-market.mjs auth
// Usage:   node similarweb-market.mjs leaders AI_Chatbots_and_Tools
//          node similarweb-market.mjs leaders All --country=840 --count=20 --source=Desktop
//
// Requires Node 22+ (built-in fetch + crypto).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-market');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth — reuses similarweb-website session if available
// ---------------------------------------------------------------------------

async function doAuth() {
  const websiteSession = resolve(homedir(), '.local/share/showrun/data/similarweb-website/session.json');
  if (existsSync(websiteSession)) {
    const ws = JSON.parse(readFileSync(websiteSession, 'utf8'));
    if (ws.cookie) {
      saveJson(SESSION_FILE, ws);
      console.log(`Reused session from similarweb-website (extracted at ${ws.extractedAt})`);
      console.log(`Saved to: ${SESSION_FILE}`);
      return;
    }
  }

  console.log('Finding SimilarWeb tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('similarweb.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No SimilarWeb tab found. Open pro.similarweb.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://pro.similarweb.com'] }));
  const { cookies } = JSON.parse(raw);

  const cookieStr = cookies
    .filter(c => c.domain.includes('similarweb.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to SimilarWeb?');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
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
    console.error('No auth found. Run: node similarweb-market.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'content-type': 'application/json; charset=utf-8',
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    'x-sw-page': 'https://pro.similarweb.com/',
    'x-sw-page-view-id': crypto.randomUUID(),
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
      console.error('Session expired or blocked. Run: node similarweb-market.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';

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

function dateParam(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}%7C${m}%7C${d}`;
}

function parseDateStr(str) {
  // Accept YYYY-MM or YYYY-MM-DD
  const parts = str.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2] || 1);
}

function getDateRange(flags) {
  if (flags.from && flags.to) {
    return { from: dateParam(parseDateStr(flags.from)), to: dateParam(parseDateStr(flags.to)) };
  }
  // Default: last 3 complete months
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 2, 1);
  return { from: dateParam(fromDate), to: dateParam(toDate) };
}

function getDuration(flags) {
  if (flags.from && flags.to) {
    const f = parseDateStr(flags.from);
    const t = parseDateStr(flags.to);
    const months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + 1;
    return `${months}m`;
  }
  return '3m';
}

// Normalize source: Total, Desktop, MobileWeb
function normalizeSource(input) {
  if (!input) return 'Total';
  const s = input.toLowerCase();
  if (s === 'desktop') return 'Desktop';
  if (s === 'mobile' || s === 'mobileweb') return 'MobileWeb';
  return 'Total';
}

function fmtLarge(val) {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return String(val);
}

function fmtPct(val, decimals = 2) {
  if (val == null) return 'N/A';
  return (val * 100).toFixed(decimals) + '%';
}

function safeFilename(str) {
  return str.replace(/[~/\\]/g, '_').replace(/\s+/g, '_').toLowerCase();
}

// Normalize industry input: accept human-friendly names
// "AI Chatbots and Tools" -> "AI_Chatbots_and_Tools"
// "Computers Electronics and Technology > Programming" -> "Computers_Electronics_and_Technology~Programming"
function normalizeIndustry(input) {
  if (!input) return 'All';
  let cat = input.trim();
  cat = cat.replace(/\s*[>/]\s*/g, '~');
  cat = cat.replace(/\s+/g, '_');
  return cat;
}

// ---------------------------------------------------------------------------
// API: Industries (categories list)
// ---------------------------------------------------------------------------

async function fetchIndustries(auth, filter) {
  console.log('Fetching industries...');
  const url = `${API_BASE}/startupSettings?force=false`;
  const { data } = await apiFetch(auth, url);

  const cats = data?.categories || [];
  const result = [];

  for (const cat of cats) {
    const name = cat.name;
    const displayName = name.replace(/_/g, ' ');
    const subcats = (cat.sons || []).map(s => ({
      id: `${name}~${s.name}`,
      displayName: s.name.replace(/_/g, ' '),
    }));
    result.push({ id: name, displayName, subcategories: subcats });
  }

  if (filter) {
    const f = filter.toLowerCase();
    return result.filter(c =>
      c.displayName.toLowerCase().includes(f) ||
      c.subcategories.some(s => s.displayName.toLowerCase().includes(f))
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// API: Market Leaders
// ---------------------------------------------------------------------------

async function fetchLeaders(auth, industry, country, source, count, flags) {
  const ind = normalizeIndustry(industry);
  const src = normalizeSource(source);
  const { from, to } = getDateRange(flags);
  const duration = getDuration(flags);
  console.log(`Fetching market leaders for ${ind} (country=${country}, source=${src}, count=${count})...`);
  const encodedInd = encodeURIComponent('$' + ind);
  const url = `${API_BASE}/Market/Leaders/Table?keys=${encodedInd}&duration=${duration}&from=${from}&to=${to}&webSource=${src}&isWindow=false&includeSubDomains=true&country=${country}&category=${encodeURIComponent(ind)}&sort=Share&asc=false`;
  const { data } = await apiFetch(auth, url);

  const allDomains = data?.Data || [];
  const domains = allDomains.slice(0, count).map((d, i) => ({
    rank: i + 1,
    domain: d.Domain || null,
    industry: d.Category || null,
    share: d.Share ?? null,
    shareFormatted: d.Share != null ? fmtPct(d.Share) : 'N/A',
    avgMonthlyVisits: d.AvgMonthVisits ?? null,
    avgMonthlyVisitsFormatted: d.AvgMonthVisits != null ? fmtLarge(d.AvgMonthVisits) : 'N/A',
    uniqueUsers: d.UniqueUsers ?? null,
    uniqueUsersFormatted: d.UniqueUsers != null ? fmtLarge(d.UniqueUsers) : 'N/A',
    pagesPerVisit: d.PagesPerVisit ?? null,
    avgVisitDuration: d.AvgVisitDuration ?? null,
    avgVisitDurationFormatted: d.AvgVisitDuration != null
      ? `${Math.floor(d.AvgVisitDuration / 60)}m ${Math.round(d.AvgVisitDuration % 60)}s` : 'N/A',
    bounceRate: d.BounceRate ?? null,
    bounceRateFormatted: d.BounceRate != null ? fmtPct(d.BounceRate) : 'N/A',
    momChange: d.MoMChange ?? null,
    momChangeFormatted: d.MoMChange != null ? fmtPct(d.MoMChange) : 'N/A',
    globalRank: d.Rank ?? null,
    industryRank: d.CategoryRank ?? null,
    desktopShare: d.DesktopMobileShare?.[0] ?? null,
    mobileShare: d.DesktopMobileShare?.[1] ?? null,
  }));

  const result = {
    industry: ind,
    country,
    source: src,
    totalDomains: data?.TotalCount ?? allDomains.length,
    domains,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeFilename(ind)}-leaders-${country}-${src.toLowerCase()}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Market Trends (top movers — rising and declining)
// ---------------------------------------------------------------------------

async function fetchTrends(auth, industry, country, source, count, flags) {
  const ind = normalizeIndustry(industry);
  const src = normalizeSource(source);
  const { from, to } = getDateRange(flags);
  const duration = getDuration(flags);
  console.log(`Fetching market trends for ${ind} (country=${country}, source=${src})...`);
  const encodedInd = encodeURIComponent('$' + ind);
  const url = `${API_BASE}/Market/Leaders/Table?keys=${encodedInd}&duration=${duration}&from=${from}&to=${to}&webSource=${src}&isWindow=false&includeSubDomains=true&country=${country}&category=${encodeURIComponent(ind)}&sort=MoMChange&asc=false`;
  const { data } = await apiFetch(auth, url);

  const allDomains = data?.Data || [];

  const rising = allDomains
    .filter(d => d.MoMChange != null && d.MoMChange > 0)
    .slice(0, count)
    .map(d => ({
      domain: d.Domain || null,
      momChange: d.MoMChange ?? null,
      momChangeFormatted: d.MoMChange != null ? fmtPct(d.MoMChange) : 'N/A',
      avgMonthlyVisits: d.AvgMonthVisits ?? null,
      avgMonthlyVisitsFormatted: d.AvgMonthVisits != null ? fmtLarge(d.AvgMonthVisits) : 'N/A',
      share: d.Share ?? null,
      shareFormatted: d.Share != null ? fmtPct(d.Share) : 'N/A',
      industryRank: d.CategoryRank ?? null,
    }));

  const declining = allDomains
    .filter(d => d.MoMChange != null && d.MoMChange < 0)
    .sort((a, b) => (a.MoMChange || 0) - (b.MoMChange || 0))
    .slice(0, count)
    .map(d => ({
      domain: d.Domain || null,
      momChange: d.MoMChange ?? null,
      momChangeFormatted: d.MoMChange != null ? fmtPct(d.MoMChange) : 'N/A',
      avgMonthlyVisits: d.AvgMonthVisits ?? null,
      avgMonthlyVisitsFormatted: d.AvgMonthVisits != null ? fmtLarge(d.AvgMonthVisits) : 'N/A',
      share: d.Share ?? null,
      shareFormatted: d.Share != null ? fmtPct(d.Share) : 'N/A',
      industryRank: d.CategoryRank ?? null,
    }));

  const result = {
    industry: ind,
    country,
    source: src,
    totalDomains: data?.TotalCount ?? allDomains.length,
    rising,
    declining,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeFilename(ind)}-trends-${country}-${src.toLowerCase()}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Market Benchmarks (industry averages)
// ---------------------------------------------------------------------------

async function fetchBenchmarks(auth, industry, country, source, flags) {
  const ind = normalizeIndustry(industry);
  const src = normalizeSource(source);
  const { from, to } = getDateRange(flags);
  const duration = getDuration(flags);
  console.log(`Fetching market benchmarks for ${ind} (country=${country}, source=${src})...`);
  const encodedInd = encodeURIComponent('$' + ind);
  const url = `${API_BASE}/Market/Leaders/Table?keys=${encodedInd}&duration=${duration}&from=${from}&to=${to}&webSource=${src}&isWindow=false&includeSubDomains=true&country=${country}&category=${encodeURIComponent(ind)}&sort=Share&asc=false`;
  const { data } = await apiFetch(auth, url);

  const allDomains = data?.Data || [];
  const total = allDomains.length;

  if (total === 0) {
    return { industry: ind, country, source: src, totalDomains: 0, benchmarks: null };
  }

  const sum = (arr, fn) => arr.reduce((s, d) => s + (fn(d) || 0), 0);
  const avg = (arr, fn) => { const vals = arr.filter(d => fn(d) != null); return vals.length > 0 ? sum(vals, fn) / vals.length : null; };
  const median = (arr, fn) => {
    const vals = arr.map(fn).filter(v => v != null).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  };

  const totalVisits = sum(allDomains, d => d.AvgMonthVisits);

  const result = {
    industry: ind,
    country,
    source: src,
    totalDomains: data?.TotalCount ?? total,
    benchmarks: {
      totalMarketVisits: totalVisits,
      totalMarketVisitsFormatted: fmtLarge(totalVisits),
      avgBounceRate: avg(allDomains, d => d.BounceRate),
      avgBounceRateFormatted: fmtPct(avg(allDomains, d => d.BounceRate)),
      medianBounceRate: median(allDomains, d => d.BounceRate),
      medianBounceRateFormatted: fmtPct(median(allDomains, d => d.BounceRate)),
      avgPagesPerVisit: avg(allDomains, d => d.PagesPerVisit),
      medianPagesPerVisit: median(allDomains, d => d.PagesPerVisit),
      avgVisitDuration: avg(allDomains, d => d.AvgVisitDuration),
      avgVisitDurationFormatted: avg(allDomains, d => d.AvgVisitDuration) != null
        ? `${Math.floor(avg(allDomains, d => d.AvgVisitDuration) / 60)}m ${Math.round(avg(allDomains, d => d.AvgVisitDuration) % 60)}s` : 'N/A',
      medianVisitDuration: median(allDomains, d => d.AvgVisitDuration),
      avgDesktopShare: avg(allDomains, d => d.DesktopMobileShare?.[0]),
      avgDesktopShareFormatted: fmtPct(avg(allDomains, d => d.DesktopMobileShare?.[0])),
      avgMobileShare: avg(allDomains, d => d.DesktopMobileShare?.[1]),
      avgMobileShareFormatted: fmtPct(avg(allDomains, d => d.DesktopMobileShare?.[1])),
    },
    concentration: {
      top1Share: allDomains[0]?.Share ?? null,
      top1ShareFormatted: allDomains[0]?.Share != null ? fmtPct(allDomains[0].Share) : 'N/A',
      top1Domain: allDomains[0]?.Domain ?? null,
      top3Share: allDomains.slice(0, 3).reduce((s, d) => s + (d.Share || 0), 0),
      top3ShareFormatted: fmtPct(allDomains.slice(0, 3).reduce((s, d) => s + (d.Share || 0), 0)),
      top10Share: allDomains.slice(0, 10).reduce((s, d) => s + (d.Share || 0), 0),
      top10ShareFormatted: fmtPct(allDomains.slice(0, 10).reduce((s, d) => s + (d.Share || 0), 0)),
    },
  };

  const cacheFile = resolve(CACHE_DIR, `${safeFilename(ind)}-benchmarks-${country}-${src.toLowerCase()}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const industryArg = positional[0];

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'industries': {
      const filter = positional[0] || null;
      const industries = await fetchIndustries(getAuth(), filter);
      for (const ind of industries) {
        console.log(ind.id);
        for (const sub of ind.subcategories) {
          console.log(`  ${sub.id}`);
        }
      }
      console.log(`\n${industries.reduce((n, c) => n + 1 + c.subcategories.length, 0)} industries total`);
      break;
    }

    case 'leaders': {
      if (!industryArg) { console.error('Usage: similarweb-market.mjs leaders <industry> [--country=999] [--count=20] [--source=Total] [--from=YYYY-MM] [--to=YYYY-MM]'); process.exit(1); }
      const country = flags.country || '999';
      const count = parseInt(flags.count || '20', 10);
      const source = flags.source || 'Total';
      const result = await fetchLeaders(getAuth(), industryArg, country, source, count, flags);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'trends': {
      if (!industryArg) { console.error('Usage: similarweb-market.mjs trends <industry> [--country=999] [--count=10] [--source=Total] [--from=YYYY-MM] [--to=YYYY-MM]'); process.exit(1); }
      const country = flags.country || '999';
      const count = parseInt(flags.count || '10', 10);
      const source = flags.source || 'Total';
      const result = await fetchTrends(getAuth(), industryArg, country, source, count, flags);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'benchmarks': {
      if (!industryArg) { console.error('Usage: similarweb-market.mjs benchmarks <industry> [--country=999] [--source=Total] [--from=YYYY-MM] [--to=YYYY-MM]'); process.exit(1); }
      const country = flags.country || '999';
      const source = flags.source || 'Total';
      const result = await fetchBenchmarks(getAuth(), industryArg, country, source, flags);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-market.mjs';
      console.log(`
similarweb-market — Industry/market analysis from SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} industries [filter]               List all available industries
  node ${script} leaders <industry>                Top websites in an industry by traffic share
       [--country=999]                              Country code (default: 999 = worldwide)
       [--count=20]                                 Number of results (default: 20)
       [--source=Total]                             Traffic source: Total, Desktop, Mobile
       [--from=YYYY-MM] [--to=YYYY-MM]              Date range (default: last 3 months)
  node ${script} trends <industry>                 Rising and declining websites in an industry
       [--country=999]                              Country code (default: 999 = worldwide)
       [--count=10]                                 Number of rising/declining (default: 10)
       [--source=Total]                             Traffic source: Total, Desktop, Mobile
       [--from=YYYY-MM] [--to=YYYY-MM]              Date range (default: last 3 months)
  node ${script} benchmarks <industry>             Industry benchmarks: avg bounce, duration, pages, device split
       [--country=999]                              Country code (default: 999 = worldwide)
       [--source=Total]                             Traffic source: Total, Desktop, Mobile
       [--from=YYYY-MM] [--to=YYYY-MM]              Date range (default: last 3 months)

Industry formats:
  All                                               All industries
  AI_Chatbots_and_Tools                             Top-level industry
  "AI Chatbots and Tools"                           Spaces auto-converted to underscores
  Computers_Electronics_and_Technology~Programming_and_Developer_Software
                                                    Sub-industry (parent~child)
  "Computers Electronics and Technology > Programming and Developer Software"
                                                    Sub-industry with > separator

Traffic source tabs (--source):
  Total     All traffic (default)
  Desktop   Desktop-only traffic
  Mobile    Mobile web traffic only

  Note: The page-level tabs (Search, Social, Display, Referral, Direct, Email)
  are client-side re-sorts of the same dataset. The API returns all traffic
  source data in each record's engagement metrics.

Country codes:
  999 = Worldwide, 840 = US, 826 = UK, 276 = Germany, 392 = Japan

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
