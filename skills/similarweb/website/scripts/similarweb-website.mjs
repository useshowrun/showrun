#!/usr/bin/env node
// similarweb-website.mjs — Website traffic analytics from SimilarWeb: overview, similar sites, search traffic, keywords, social, ads
//
// Setup:   node similarweb-website.mjs auth
// Usage:   node similarweb-website.mjs overview google.com
//          node similarweb-website.mjs similar google.com --count=20
//          node similarweb-website.mjs search-traffic google.com --country=999
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-website');
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
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
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

  // Build full cookie string — AWS WAF token and session cookies are needed
  const cookieStr = cookies
    .filter(c => c.domain.includes('similarweb.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to SimilarWeb?');

  // Check for critical cookies
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const hasSgToken = cookies.some(c => c.name.includes('SGTOKEN'));
  const hasWafToken = cookieMap['aws-waf-token'];
  if (!hasSgToken) console.warn('Warning: SGTOKEN cookie not found. API calls may fail.');
  if (!hasWafToken) console.warn('Warning: aws-waf-token not found. AWS WAF may block requests.');

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
    console.error('No auth found. Run: node similarweb-website.mjs auth');
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
      console.error('Session expired or blocked. Run: node similarweb-website.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';
const WIDGET_API_BASE = 'https://pro.similarweb.com/widgetApi';

function parseDomain(input) {
  // Accept: example.com, www.example.com, https://example.com/path, http://www.example.com
  let domain = input.trim();
  // Strip protocol
  domain = domain.replace(/^https?:\/\//, '');
  // Strip path
  domain = domain.replace(/\/.*$/, '');
  // Strip www.
  domain = domain.replace(/^www\./, '');
  // Strip port
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
  // Format: YYYY|MM|DD URL-encoded as YYYY%7CMM%7CDD
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}%7C${m}%7C${d}`;
}

function defaultDateRange() {
  // Most recent complete month. SimilarWeb data lags ~1 month, so the current
  // month is never available, and standard/free accounts only allow a 1-month
  // window (requests spanning multiple months return HTTP 400).
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
  // Replace dots with underscores for cache filenames
  return domain.replace(/\./g, '_');
}

// ---------------------------------------------------------------------------
// API: Overview
// ---------------------------------------------------------------------------

async function fetchOverview(auth, domain) {
  console.log(`Fetching overview for ${domain}...`);
  const { from, to } = defaultDateRange();
  const url = `${API_BASE}/WebsiteOverview/getheader?keys=${domain}&mainDomainOnly=false&includeCrossData=true&key=${domain}&isWWW=false&country=999&from=${from}&to=${to}&isWindow=false&webSource=Total`;
  const { data } = await apiFetch(auth, url);

  const siteData = data[domain] || data[Object.keys(data)[0]] || {};

  const result = {
    domain,
    title: siteData.title || null,
    description: siteData.description || null,
    category: siteData.category || null,
    globalRanking: siteData.globalRanking ?? null,
    categoryRanking: siteData.categoryRanking ?? null,
    monthlyVisits: siteData.monthlyVisits ?? null,
    monthlyVisitsFormatted: siteData.monthlyVisits != null ? fmtLarge(siteData.monthlyVisits) : 'N/A',
    yearFounded: siteData.yearFounded ?? null,
    employeeRange: siteData.employeeRange || null,
    highestTrafficCountry: siteData.highestTrafficCountry ?? null,
    icon: siteData.icon || null,
    relatedApps: siteData.relatedApps || null,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-overview.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Similar Sites
// ---------------------------------------------------------------------------

async function fetchSimilarSites(auth, domain, count = 20) {
  console.log(`Fetching similar sites for ${domain}...`);
  const url = `${API_BASE}/WebsiteOverview/getsimilarsites?key=${domain}&limit=${count}&country=999&webSource=Total`;
  const { data } = await apiFetch(auth, url);

  const sites = (Array.isArray(data) ? data : []).map(s => ({
    domain: s.Domain || null,
    rank: s.Rank ?? null,
    favicon: s.Favicon || null,
  }));

  const result = {
    domain,
    count: sites.length,
    similarSites: sites,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-similar.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Search Traffic
// ---------------------------------------------------------------------------

async function fetchSearchTraffic(auth, domain, country = '999') {
  console.log(`Fetching search traffic for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const url = `${API_BASE}/searchoverview/overview/traffic?keys=${domain}&country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&webSource=Total`;
  const { data } = await apiFetch(auth, url);

  const trafficSources = data?.TrafficSourcesVisits?.[domain] || {};
  const allGraph = trafficSources?.All?.Graph || [];
  const organicGraph = trafficSources?.Organic?.Graph || [];
  const paidGraph = trafficSources?.Paid?.Graph || [];

  const result = {
    domain,
    country,
    months: allGraph.map((entry, i) => ({
      date: entry.Key || null,
      totalSearchVisits: entry.Value ?? null,
      totalSearchVisitsFormatted: entry.Value != null ? fmtLarge(entry.Value) : 'N/A',
      organicVisits: organicGraph[i]?.Value ?? null,
      organicVisitsFormatted: organicGraph[i]?.Value != null ? fmtLarge(organicGraph[i].Value) : 'N/A',
      paidVisits: paidGraph[i]?.Value ?? null,
      paidVisitsFormatted: paidGraph[i]?.Value != null ? fmtLarge(paidGraph[i].Value) : 'N/A',
    })),
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-search-traffic.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Keywords
// ---------------------------------------------------------------------------

async function fetchKeywords(auth, domain, country = '999') {
  console.log(`Fetching keywords for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();

  // Fetch keyword count and brand split in parallel
  const [keywordData, brandData, rankData] = await Promise.all([
    (async () => {
      const url = `${API_BASE}/searchoverview/overview/keywords?keys=${domain}&country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&webSource=Total`;
      const { data } = await apiFetch(auth, url);
      return data?.[domain] || {};
    })(),
    (async () => {
      const url = `${API_BASE}/searchoverview/keywords/brand-split?keys=${domain}&country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&webSource=Total`;
      const { data } = await apiFetch(auth, url);
      return data?.[domain] || {};
    })(),
    (async () => {
      const url = `${API_BASE}/searchoverview/keywords/rank-distribution?keys=${domain}&country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&webSource=Total`;
      const { data } = await apiFetch(auth, url);
      return data || {};
    })(),
  ]);

  // Parse brand split graph
  const brandSplitGraph = (brandData?.BrandedShareSplitGraph || []).map(entry => ({
    date: entry.Key || null,
    branded: entry.Value?.Branded ?? null,
    nonBranded: entry.Value?.NonBranded ?? null,
  }));

  // Parse rank distribution
  const rankSplit = rankData?.RankSplit?.[domain] || {};

  const result = {
    domain,
    country,
    keywordCounts: {
      yearlyComparison: keywordData.YearlyComparisonInterval || null,
      requestedInterval: keywordData.RequestedInterval || null,
    },
    brandSplit: brandSplitGraph,
    rankDistribution: {
      top3: rankSplit.Top3 || null,
      restTo100: rankSplit.RestTo100 || null,
    },
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-keywords.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Social Traffic
// ---------------------------------------------------------------------------

async function fetchSocial(auth, domain, country = '999') {
  console.log(`Fetching social traffic for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const url = `${API_BASE}/websiteanalysis/GetTrafficSocial?country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&key=${domain}&webSource=Total`;
  const { data } = await apiFetch(auth, url);

  const siteData = data?.dictionary?.[domain] || {};
  const globalSources = data?.Sources || [];

  const sources = (siteData.Sources || globalSources).map(s => ({
    name: s.Name || null,
    count: s.Count ?? null,
    share: s.Value ?? null,
    shareFormatted: s.Value != null ? fmtPct(s.Value) : 'N/A',
  }));

  // Monthly volume data
  const volumes = (siteData.Volumes || []).map(v => ({
    date: v.Key || v.Date || null,
    value: v.Value ?? v.Count ?? null,
    valueFormatted: (v.Value ?? v.Count) != null ? fmtLarge(v.Value ?? v.Count) : 'N/A',
  }));

  const result = {
    domain,
    country,
    totalVolume: siteData.VolumeTotal ?? null,
    totalVolumeFormatted: siteData.VolumeTotal != null ? fmtLarge(siteData.VolumeTotal) : 'N/A',
    sources,
    monthlyVolumes: volumes,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-social.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Ad Publishers
// ---------------------------------------------------------------------------

async function fetchAds(auth, domain, country = '999') {
  console.log(`Fetching ad publishers for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const url = `${API_BASE}/AdIntelligence/Advertiser/Publishers/breakdown?country=${country}&key=${domain}&from=${from}&to=${to}&page=1&pageSize=5&isWindow=false&sort=visits&asc=false`;
  const { data } = await apiFetch(auth, url);

  const records = (data?.records || []).map(r => ({
    publisher: r.entity || null,
    category: r.category || null,
    rank: r.rank ?? null,
    impressionsShare: r.impressionsShare ?? null,
    impressionsShareFormatted: r.impressionsShare != null ? fmtPct(r.impressionsShare) : 'N/A',
    visitsShare: r.visitsShare ?? null,
    visitsShareFormatted: r.visitsShare != null ? fmtPct(r.visitsShare) : 'N/A',
    spendShare: r.spendShare ?? null,
    spendShareFormatted: r.spendShare != null ? fmtPct(r.spendShare) : 'N/A',
  }));

  const result = {
    domain,
    country,
    count: records.length,
    publishers: records,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-ads.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Traffic & Engagement
// ---------------------------------------------------------------------------

async function fetchTraffic(auth, domain, country = '999') {
  console.log(`Fetching traffic & engagement for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();

  const [engagementData, deviceData, ranksData] = await Promise.all([
    (async () => {
      const url = `${WIDGET_API_BASE}/TrafficAndEngagement/EngagementOverview/Table?ShouldGetVerifiedData=false&country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly&unBounced=false`;
      const { data } = await apiFetch(auth, url);
      return data?.Data?.[0] || {};
    })(),
    (async () => {
      const url = `${WIDGET_API_BASE}/WebsiteOverview/EngagementDesktopVsMobileVisits/PieChart?country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly&ShouldGetVerifiedData=false`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${WIDGET_API_BASE}/WebsiteOverview/WebRanks/SingleMetric?country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
  ]);

  const deviceSplit = deviceData?.Data?.[domain] || {};
  const deviceTotal = (deviceSplit.Desktop || 0) + (deviceSplit['Mobile Web'] || 0);
  const ranks = ranksData?.Data?.[domain] || {};

  const result = {
    domain,
    country,
    avgMonthlyVisits: engagementData.AvgMonthVisits ?? null,
    avgMonthlyVisitsFormatted: engagementData.AvgMonthVisits != null ? fmtLarge(engagementData.AvgMonthVisits) : 'N/A',
    uniqueUsers: engagementData.UniqueUsers ?? null,
    uniqueUsersFormatted: engagementData.UniqueUsers != null ? fmtLarge(engagementData.UniqueUsers) : 'N/A',
    visitsPerUser: engagementData.VisitsPerUser ?? null,
    pagesPerVisit: engagementData.PagesPerVisit ?? null,
    avgVisitDuration: engagementData.AvgVisitDuration ?? null,
    avgVisitDurationFormatted: engagementData.AvgVisitDuration != null
      ? `${Math.floor(engagementData.AvgVisitDuration / 60)}m ${Math.round(engagementData.AvgVisitDuration % 60)}s` : 'N/A',
    bounceRate: engagementData.BounceRate ?? null,
    bounceRateFormatted: engagementData.BounceRate != null ? fmtPct(engagementData.BounceRate) : 'N/A',
    totalPageViews: engagementData.TotalPagesViews ?? null,
    totalPageViewsFormatted: engagementData.TotalPagesViews != null ? fmtLarge(engagementData.TotalPagesViews) : 'N/A',
    deviceSplit: {
      desktopShare: deviceTotal > 0 ? (deviceSplit.Desktop || 0) / deviceTotal : null,
      desktopShareFormatted: deviceTotal > 0 ? fmtPct((deviceSplit.Desktop || 0) / deviceTotal) : 'N/A',
      mobileShare: deviceTotal > 0 ? (deviceSplit['Mobile Web'] || 0) / deviceTotal : null,
      mobileShareFormatted: deviceTotal > 0 ? fmtPct((deviceSplit['Mobile Web'] || 0) / deviceTotal) : 'N/A',
    },
    ranks: {
      global: ranks.GlobalRank?.Value ?? null,
      country: ranks.CountryRank?.Value ?? null,
      categoryRank: ranks.CategoryRank?.Value ?? null,
    },
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-traffic.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Marketing Channels
// ---------------------------------------------------------------------------

async function fetchChannels(auth, domain, country = '999') {
  console.log(`Fetching marketing channels for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const url = `${WIDGET_API_BASE}/MarketingMixTotal/TrafficSourcesOverview/PieChart?country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&timeGranularity=Monthly&keys=${domain}`;
  const { data } = await apiFetch(auth, url);

  const total = data?.Data?.Total?.[domain] || {};
  const desktop = data?.Data?.Desktop?.[domain] || {};
  const mobile = data?.Data?.MobileWeb?.[domain] || {};

  const channelNames = Object.keys(total);
  const totalTraffic = channelNames.reduce((sum, ch) => sum + (total[ch] || 0), 0);

  const channels = channelNames.map(name => ({
    channel: name,
    totalVisits: total[name] ?? null,
    totalVisitsFormatted: total[name] != null ? fmtLarge(total[name]) : 'N/A',
    share: totalTraffic > 0 ? (total[name] || 0) / totalTraffic : null,
    shareFormatted: totalTraffic > 0 ? fmtPct((total[name] || 0) / totalTraffic) : 'N/A',
    desktopVisits: desktop[name] ?? null,
    mobileVisits: mobile[name] ?? null,
  })).sort((a, b) => (b.totalVisits || 0) - (a.totalVisits || 0));

  const result = {
    domain,
    country,
    totalTraffic,
    totalTrafficFormatted: fmtLarge(totalTraffic),
    channels,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-channels.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Audience Geography
// ---------------------------------------------------------------------------

async function fetchGeography(auth, domain, count = 10, country = '999') {
  console.log(`Fetching geography for ${domain}...`);
  const { from, to } = defaultDateRange();
  const url = `${WIDGET_API_BASE}/WebsiteGeographyExtended/GeographyExtended/Table?includeSubDomains=true&keys=${domain}&from=${from}&to=${to}&country=${country}&webSource=Total&isWindow=false&timeGranularity=Monthly&page=1&pageSize=${count}&includeRegionalDomains=false`;
  const { data } = await apiFetch(auth, url);

  const countries = (data?.Data || []).map(c => ({
    countryCode: c.Country ?? null,
    share: c.Share ?? null,
    shareFormatted: c.Share != null ? fmtPct(c.Share) : 'N/A',
    usersShare: c.UsersShare ?? null,
    usersShareFormatted: c.UsersShare != null ? fmtPct(c.UsersShare) : 'N/A',
    rank: c.Rank ?? null,
    pagesPerVisit: c.PagePerVisit ?? null,
    avgVisitDuration: c.AvgVisitDuration ?? null,
    bounceRate: c.BounceRate ?? null,
    bounceRateFormatted: c.BounceRate != null ? fmtPct(c.BounceRate) : 'N/A',
    change: c.Change ?? null,
    changeFormatted: c.Change != null ? fmtPct(c.Change) : 'N/A',
  }));

  // Map country codes to names using filter data if available
  const countryNames = {};
  for (const f of data?.Filters?.country || []) {
    countryNames[f.id] = f.text;
  }
  for (const c of countries) {
    c.countryName = countryNames[String(c.countryCode)] || null;
  }

  const result = {
    domain,
    totalCountries: data?.TotalCount ?? countries.length,
    countries,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-geography.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Referrals
// ---------------------------------------------------------------------------

async function fetchReferrals(auth, domain, country = '999') {
  console.log(`Fetching referrals for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const url = `${API_BASE}/websiteanalysis/GetTrafficSourcesTotalReferralsTable?key=${domain}&isWWW=false&country=${country}&to=${to}&from=${from}&isWindow=false&webSource=Total&selectedTab=incomingTraffic&orderBy=TotalShare+desc&ignoreFilterConsistency=false`;
  const { data } = await apiFetch(auth, url);

  const records = (data?.Records || []).slice(0, 20).map(r => ({
    domain: r.Domain || null,
    category: r.Category || null,
    share: r.TotalShare ?? null,
    shareFormatted: r.TotalShare != null ? fmtPct(r.TotalShare) : 'N/A',
    totalVisits: r.TotalVisits ?? null,
    totalVisitsFormatted: r.TotalVisits != null ? fmtLarge(r.TotalVisits) : 'N/A',
    change: r.Change ?? null,
    changeFormatted: r.Change != null ? fmtPct(r.Change) : 'N/A',
    rank: r.Rank ?? null,
  }));

  const result = {
    domain,
    country,
    totalReferringSites: data?.Records?.length ?? 0,
    topReferrals: records,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-referrals.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Display Advertising
// ---------------------------------------------------------------------------

async function fetchDisplay(auth, domain, country = '999') {
  console.log(`Fetching display advertising for ${domain} (country=${country})...`);
  const { from, to } = defaultDateRange();

  const [summaryData, campaignsData] = await Promise.all([
    (async () => {
      const url = `${API_BASE}/AdIntelligence/Advertiser/summary?country=${country}&key=${domain}&from=${from}&to=${to}&isWindow=false`;
      const { data } = await apiFetch(auth, url);
      return data?.data?.[domain] || data?.[domain] || {};
    })(),
    (async () => {
      const url = `${API_BASE}/AdIntelligence/Advertiser/Campaigns/Data?country=${country}&key=${domain}&from=${from}&to=${to}&page=1&pageSize=100&isWindow=false&asc=false&sort=lastSeen`;
      const { data } = await apiFetch(auth, url);
      // data.data is an object with numeric keys, not an array
      const entries = data?.data || {};
      return { records: Object.values(entries), totalCount: data?.totalCount ?? 0 };
    })(),
  ]);

  const campaigns = (campaignsData.records || []).slice(0, 20).map(c => ({
    campaign: c.campaign || null,
    landingPage: c.landingPageLink || null,
    firstSeen: c.firstSeen || null,
    lastSeen: c.lastSeen || null,
    activeDays: c.activeDays ?? null,
    creativesCount: c.creativesCount ?? null,
  }));

  const result = {
    domain,
    country,
    summary: {
      totalCampaigns: summaryData?.campaigns?.count ?? null,
      campaignsChange: summaryData?.campaigns?.change ?? null,
      totalCreatives: summaryData?.creatives?.count ?? null,
      creativesChange: summaryData?.creatives?.change ?? null,
    },
    totalCampaignsAvailable: campaignsData.totalCount,
    campaigns,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-display.json`);
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
      if (!domainArg) { console.error('Usage: similarweb-website.mjs overview <domain>'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const result = await fetchOverview(getAuth(), domain);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'similar': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs similar <domain> [--count=20]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const count = parseInt(flags.count || '20', 10);
      const result = await fetchSimilarSites(getAuth(), domain, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'search-traffic': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs search-traffic <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchSearchTraffic(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'keywords': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs keywords <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchKeywords(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'social': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs social <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchSocial(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'ads': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs ads <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchAds(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'traffic': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs traffic <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchTraffic(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'channels': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs channels <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchChannels(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'geography': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs geography <domain> [--count=10]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const count = parseInt(flags.count || '10', 10);
      const result = await fetchGeography(getAuth(), domain, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'referrals': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs referrals <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchReferrals(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'display': {
      if (!domainArg) { console.error('Usage: similarweb-website.mjs display <domain> [--country=999]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const country = flags.country || '999';
      const result = await fetchDisplay(getAuth(), domain, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-website.mjs';
      console.log(`
similarweb-website — Website traffic analytics from SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} overview <domain>                 Site overview: visits, rank, category, description
  node ${script} traffic <domain>                  Traffic & engagement: visits, duration, bounce, device split
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} channels <domain>                 Marketing channel breakdown (direct, search, social, etc.)
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} geography <domain>                Top countries by traffic share
       [--count=10]                                 Number of countries (default: 10)
  node ${script} referrals <domain>                Top referring domains
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} similar <domain>                  Similar/competing websites with rank
       [--count=20]                                 Number of results (default: 20)
  node ${script} search-traffic <domain>           Organic/paid search traffic by month
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} keywords <domain>                 Keyword count, brand split, rank distribution
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} social <domain>                   Social traffic by platform
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} display <domain>                  Display advertising summary + campaigns
       [--country=999]                              Country code (default: 999 = worldwide)
  node ${script} ads <domain>                      Ad publisher breakdown
       [--country=999]                              Country code (default: 999 = worldwide)

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
