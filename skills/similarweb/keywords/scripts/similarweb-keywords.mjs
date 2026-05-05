#!/usr/bin/env node
// similarweb-keywords.mjs — SEO keyword research from SimilarWeb: SEO overview, top pages, rank distribution, SERP features, keyword gaps
//
// Setup:   node similarweb-keywords.mjs auth
// Usage:   node similarweb-keywords.mjs overview chatgpt.com
//          node similarweb-keywords.mjs pages chatgpt.com
//          node similarweb-keywords.mjs gap chatgpt.com claude.ai
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-keywords');
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
    console.error('No auth found. Run: node similarweb-keywords.mjs auth');
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
      console.error('Session expired or blocked. Run: node similarweb-keywords.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';

function parseDomain(input) {
  let domain = input.trim();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/\/.*$/, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/:\d+$/, '');
  return domain.toLowerCase();
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

function dateParam(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}%7C${m}%7C${d}`;
}

function defaultDateRange() {
  // Most recent complete month - standard/free accounts only allow a 1-month window.
  const now = new Date();
  const monthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const d = dateParam(monthDate);
  return { from: d, to: d };
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

function safeDomainFilename(domain) {
  return domain.replace(/\./g, '_');
}

function pageFilter(domain) {
  return encodeURIComponent(JSON.stringify([{ url: domain, searchType: 'domain' }]));
}

function multiPageFilter(domains) {
  return encodeURIComponent(JSON.stringify(domains.map(d => ({ url: d, searchType: 'domain' }))));
}

// ---------------------------------------------------------------------------
// API: SEO Overview
// ---------------------------------------------------------------------------

async function fetchOverview(auth, domain, country) {
  console.log(`Fetching SEO overview for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const pf = pageFilter(domain);

  const [summary, serpDist, kwSerpDist] = await Promise.all([
    (async () => {
      const url = `${API_BASE}/WebsiteAnalysis/Overview/Summary?to=${to}&from=${from}&isWindow=false&country=${country}&webSource=Total&keys=${domain}&includeSubDomains=true&device=Total&pageFilterJson=${pf}`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${API_BASE}/WebsiteAnalysis/Overview/SerpDistribution?country=${country}&webSource=Total&keys=${domain}&pageFilterJson=${pf}&from=${from}&to=${to}&isWindow=false`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${API_BASE}/WebsiteAnalysis/Overview/KeywordsSerpDistribution?country=${country}&webSource=Total&from=${from}&to=${to}&isWindow=false&keys=${domain}&pageFilterJson=${pf}`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
  ]);

  const result = {
    domain,
    country,
    totalKeywords: summary?.UniqueKeywords ?? null,
    totalKeywordsFormatted: summary?.UniqueKeywords != null ? fmtLarge(summary.UniqueKeywords) : 'N/A',
    totalPages: summary?.UniquePages ?? null,
    totalPagesFormatted: summary?.UniquePages != null ? fmtLarge(summary.UniquePages) : 'N/A',
    searchAdsCount: summary?.Ads ?? null,
    trafficDistribution: {
      organicShare: summary?.TrafficDistribution?.Search?.Organic?.Share ?? null,
      organicShareFormatted: fmtPct(summary?.TrafficDistribution?.Search?.Organic?.Share),
      organicChange: summary?.TrafficDistribution?.Search?.Organic?.Change ?? null,
      paidShare: summary?.TrafficDistribution?.Search?.Paid?.Share ?? null,
      paidShareFormatted: fmtPct(summary?.TrafficDistribution?.Search?.Paid?.Share),
      paidChange: summary?.TrafficDistribution?.Search?.Paid?.Change ?? null,
    },
    brandedDistribution: {
      brandedShare: summary?.TrafficDistribution?.Branded?.Branded?.Share ?? null,
      brandedShareFormatted: fmtPct(summary?.TrafficDistribution?.Branded?.Branded?.Share),
      nonBrandedShare: summary?.TrafficDistribution?.Branded?.NonBranded?.Share ?? null,
      nonBrandedShareFormatted: fmtPct(summary?.TrafficDistribution?.Branded?.NonBranded?.Share),
    },
    intentDistribution: summary?.IntentDistribution || {},
    serpDistribution: {
      classicOrganic: serpDist?.classicOrganic ?? null,
      classicOrganicFormatted: fmtPct(serpDist?.classicOrganic),
      organicSERPFeatures: serpDist?.organicSERPFeatures ?? null,
      searchAds: serpDist?.searchAds ?? null,
      searchAdsFormatted: fmtPct(serpDist?.searchAds),
      pla: serpDist?.pla ?? null,
    },
    keywordsSerpFeatures: kwSerpDist || {},
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-overview-${country}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Rank Distribution
// ---------------------------------------------------------------------------

async function fetchRanks(auth, domain, country) {
  console.log(`Fetching rank distribution for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const pf = pageFilter(domain);

  const url = `${API_BASE}/WebsiteAnalysis/Overview/RankDistributionOverTime?to=${to}&from=${from}&isWindow=false&country=${country}&webSource=Total&keys=${domain}&includeSubDomains=true&device=Total&pageFilterJson=${pf}&getLastThirteenMonths=false`;
  const { data } = await apiFetch(auth, url);

  const distributions = data?.monthlyDistributions || {};
  const months = Object.keys(distributions).sort();

  const result = {
    domain,
    country,
    months: months.map(month => {
      const dist = distributions[month];
      return {
        month,
        totalKeywords: dist?.['1-3']?.totalKeywords ?? null,
        positions: {
          '1-3': { count: dist?.['1-3']?.keywordCount ?? null, share: dist?.['1-3']?.share ?? null, shareFormatted: fmtPct(dist?.['1-3']?.share) },
          '4-10': { count: dist?.['4-10']?.keywordCount ?? null, share: dist?.['4-10']?.share ?? null, shareFormatted: fmtPct(dist?.['4-10']?.share) },
          '11-20': { count: dist?.['11-20']?.keywordCount ?? null, share: dist?.['11-20']?.share ?? null, shareFormatted: fmtPct(dist?.['11-20']?.share) },
          '21-50': { count: dist?.['21-50']?.keywordCount ?? null, share: dist?.['21-50']?.share ?? null, shareFormatted: fmtPct(dist?.['21-50']?.share) },
          '50+': { count: dist?.other?.keywordCount ?? null, share: dist?.other?.share ?? null, shareFormatted: fmtPct(dist?.other?.share) },
        },
      };
    }),
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-ranks-${country}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top Organic Pages
// ---------------------------------------------------------------------------

async function fetchPages(auth, domain, country, sourceType = 'Organic') {
  console.log(`Fetching top ${sourceType.toLowerCase()} pages for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const pf = pageFilter(domain);

  const url = `${API_BASE}/WebsiteAnalysis/Overview/TopOrganicPages?country=${country}&webSource=Total&to=${to}&from=${from}&isWindow=false&keys=${domain}&pageFilterJson=${pf}&selectedPageTab=${sourceType}&sourceType=${sourceType}`;
  const { data } = await apiFetch(auth, url);

  const pages = (data?.data || []).map(p => ({
    url: p.url || null,
    totalClicks: p.totalClicks ?? null,
    totalClicksFormatted: p.totalClicks != null ? fmtLarge(p.totalClicks) : 'N/A',
    clicksShare: p.clicksShare ?? null,
    clicksShareFormatted: p.clicksShare != null ? fmtPct(p.clicksShare) : 'N/A',
    clicksChange: p.clicksChange ?? null,
    clicksChangeFormatted: p.clicksChange != null ? fmtPct(p.clicksChange) : 'N/A',
    keywordsCount: p.keywordsCount ?? null,
    keywordsCountFormatted: p.keywordsCount != null ? fmtLarge(p.keywordsCount) : 'N/A',
    changeState: p.changeState || null,
  }));

  const result = {
    domain,
    country,
    sourceType,
    count: pages.length,
    pages,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-pages-${sourceType.toLowerCase()}-${country}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Keyword Gap
// ---------------------------------------------------------------------------

async function fetchGap(auth, domains, country) {
  if (domains.length < 2 || domains.length > 5) {
    throw new Error('Keyword gap requires 2-5 domains.');
  }
  console.log(`Fetching keyword gap for ${domains.join(' vs ')} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const keys = encodeURIComponent(domains.join(','));
  const pf = multiPageFilter(domains);

  const url = `${API_BASE}/WebsiteAnalysis/Overview/KeywordGap?from=${from}&to=${to}&keys=${keys}&country=${country}&isWindow=false&pageFilterJson=${pf}&sourceType=all&webSource=Total`;
  const { data } = await apiFetch(auth, url);

  const gaps = (data?.keywordGaps || []).map(g => ({
    competitors: g.competitors || [],
    keywordCount: g.keywordCount ?? null,
    keywordCountFormatted: g.keywordCount != null ? fmtLarge(g.keywordCount) : 'N/A',
    volume: g.volume ?? null,
    volumeFormatted: g.volume != null ? fmtLarge(g.volume) : 'N/A',
  }));

  // Label the gaps for clarity
  const labeled = gaps.map(g => {
    const comp = g.competitors;
    let label;
    if (comp.length === domains.length) {
      label = 'shared by all';
    } else if (comp.length === 1) {
      label = `unique to ${comp[0]}`;
    } else {
      label = `shared by ${comp.join(' & ')}`;
    }
    return { ...g, label };
  });

  const result = {
    domains,
    country,
    gaps: labeled,
  };

  const cacheFile = resolve(CACHE_DIR, `gap-${domains.map(safeDomainFilename).join('-vs-')}-${country}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: SEO Trends
// ---------------------------------------------------------------------------

async function fetchTrends(auth, domain, country) {
  console.log(`Fetching SEO trends for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const pf = pageFilter(domain);

  const url = `${API_BASE}/WebsiteAnalysis/Overview/SummaryTrends?to=${to}&from=${from}&isWindow=false&country=${country}&webSource=Total&keys=${domain}&includeSubDomains=true&device=Total&pageFilterJson=${pf}`;
  const { data } = await apiFetch(auth, url);

  const result = {
    domain,
    country,
    trends: data || {},
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-trends-${country}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const domainArg = positional[0];

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'overview': {
      if (!domainArg) { console.error('Usage: similarweb-keywords.mjs overview <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchOverview(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'ranks': {
      if (!domainArg) { console.error('Usage: similarweb-keywords.mjs ranks <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchRanks(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'pages': {
      if (!domainArg) { console.error('Usage: similarweb-keywords.mjs pages <domain> [--country=999] [--source=Organic]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const sourceType = flags.source || 'Organic';
      const result = await fetchPages(getAuth(), domain, country, sourceType);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'gap': {
      if (positional.length < 2) { console.error('Usage: similarweb-keywords.mjs gap <domain1> <domain2> [domain3...] [--country=999]'); process.exit(1); }
      const domains = positional.map(parseDomain);
      const country = flags.country || '999';
      const result = await fetchGap(getAuth(), domains, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'trends': {
      if (!domainArg) { console.error('Usage: similarweb-keywords.mjs trends <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchTrends(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-keywords.mjs';
      console.log(`
similarweb-keywords — SEO keyword research from SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} overview <domain>                 SEO overview: keyword count, organic/paid split,
       [--country=999]                              branded split, intent, SERP distribution
  node ${script} ranks <domain>                    Keyword rank distribution over time (1-3, 4-10, etc.)
       [--country=999]
  node ${script} pages <domain>                    Top organic/paid pages by search clicks
       [--country=999]
       [--source=Organic]                           Source: Organic or Paid (default: Organic)
  node ${script} gap <d1> <d2> [d3...]             Keyword gap analysis between 2-5 domains
       [--country=999]                              Shows unique and shared keywords per domain
  node ${script} trends <domain>                   SEO trends over time (keywords, traffic, positions)
       [--country=999]

Examples:
  node ${script} overview chatgpt.com
  node ${script} overview chatgpt.com --country=840
  node ${script} ranks spotify.com
  node ${script} pages shopify.com --source=Paid
  node ${script} gap chatgpt.com claude.ai grok.com
  node ${script} trends amazon.com --country=826

Domain formats:
  google.com                                        Plain domain
  www.google.com                                    www prefix stripped automatically
  https://google.com/search                         URL — domain extracted automatically

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
