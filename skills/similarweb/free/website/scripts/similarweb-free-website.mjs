#!/usr/bin/env node
// similarweb-free-website.mjs — Website traffic analytics from a SimilarWeb FREE account.
//
// Uses the "Website Performance" widgets exposed to free/expired-trial accounts on
// pro.similarweb.com. Free tier covers a SINGLE most-recent complete month, worldwide
// (country=999) only. Country breakdowns beyond worldwide require a paid plan.
//
// Setup:   node similarweb-free-website.mjs auth
// Usage:   node similarweb-free-website.mjs overview netflix.com
//          node similarweb-free-website.mjs traffic netflix.com
//          node similarweb-free-website.mjs channels netflix.com
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-free-website');
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
// CDP integration (only used by `auth`)
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

  const cookieStr = cookies
    .filter(c => c.domain.includes('similarweb.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to SimilarWeb?');

  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const hasSgToken = cookies.some(c => c.name.includes('SGTOKEN'));
  if (!hasSgToken) console.warn('Warning: SGTOKEN cookie not found. API calls may fail.');
  if (!cookieMap['aws-waf-token']) console.warn('Warning: aws-waf-token not found. AWS WAF may block requests.');

  saveJson(SESSION_FILE, { cookie: cookieStr, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';
const WIDGET_API_BASE = 'https://pro.similarweb.com/widgetApi';

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node similarweb-free-website.mjs auth');
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
    resp = await fetch(url, { ...options, headers: { ...baseHeaders(auth), ...options.headers } });
  } catch (err) {
    throw new Error(`Network error fetching ${url.split('?')[0]}: ${err.message}`);
  }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node similarweb-free-website.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function defaultMonthRange() {
  // Free tier exposes the single most recent complete month. SimilarWeb data
  // lags ~1 month, so the current month is never available.
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: dateParam(first), to: dateParam(last) };
}

// Range spanning the N most recent complete months. Free tier's `SingleMetric`
// endpoint rejects historical months (HTTP 400), but the `Graph` endpoint at
// Weekly granularity happily serves multi-month history — which the `visits`
// command exploits when --months=N is passed.
function monthsBackRange(monthsBack) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: dateParam(first), to: dateParam(last) };
}

function fmtLarge(val) {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return String(Math.round(val));
}

function fmtPct(val, decimals = 2) {
  if (val == null) return 'N/A';
  return (val * 100).toFixed(decimals) + '%';
}

function fmtDuration(seconds) {
  if (seconds == null) return 'N/A';
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function safeDomainFilename(domain) {
  return domain.replace(/\./g, '_');
}

function cacheWrite(domain, suffix, result) {
  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-${suffix}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// overview — getheader
// ---------------------------------------------------------------------------

async function fetchOverview(auth, domain, country) {
  console.log(`Fetching overview for ${domain}...`);
  const { from, to } = defaultMonthRange();
  const url = `${API_BASE}/WebsiteOverview/getheader?keys=${domain}&mainDomainOnly=false&includeCrossData=true&key=${domain}&isWWW=false&country=${country}&from=${from}&to=${to}&isWindow=false&webSource=Total`;
  const { data } = await apiFetch(auth, url);
  const site = data[domain] || data[Object.keys(data)[0]] || {};

  const apps = [];
  for (const group of Object.values(site.relatedApps || {})) {
    for (const app of (Array.isArray(group) ? group : [])) {
      apps.push({
        store: app.store === 0 ? 'Google Play' : app.store === 1 ? 'App Store' : String(app.store),
        id: app.id || null,
        title: app.title || null,
        author: app.author || null,
        category: app.category || null,
        rating: app.rating ?? null,
        ratingCount: app.ratecount ?? null,
      });
    }
  }

  const result = {
    domain,
    title: site.title || null,
    description: site.description || null,
    category: site.category || null,
    globalRanking: site.globalRanking ?? null,
    categoryRanking: site.categoryRanking ?? null,
    highestTrafficCountry: site.highestTrafficCountry ?? null,
    highestTrafficCountryRanking: site.highestTrafficCountryRanking ?? null,
    isSubDomain: site.isSubDomain ?? null,
    icon: site.icon || null,
    relatedApps: apps,
  };
  cacheWrite(domain, 'overview', result);
  return result;
}

// ---------------------------------------------------------------------------
// traffic — engagement + visits + ranks + device split
// ---------------------------------------------------------------------------

async function fetchTraffic(auth, domain, country) {
  console.log(`Fetching traffic & engagement for ${domain}...`);
  const { from, to } = defaultMonthRange();

  const [engagement, visits, ranks, device] = await Promise.all([
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/EngagementOverview/Table?country=${country}&from=${from}&to=${to}&isWindow=false&webSource=Total&includeSubDomains=true&timeGranularity=Monthly&keys=${domain}&ShouldGetVerifiedData=false`).then(r => r.data?.Data?.[0] || {}),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/EngagementVisits/SingleMetric?country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly&ShouldGetVerifiedData=false`).then(r => r.data?.Data?.[domain] || {}),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/WebRanks/SingleMetric?country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly`).then(r => r.data?.Data?.[domain] || {}),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/EngagementDesktopVsMobileVisits/PieChart?country=${country}&from=${from}&to=${to}&keys=${domain}&webSource=Total&isWindow=false&includeSubDomains=true&timeGranularity=Monthly&ShouldGetVerifiedData=false`).then(r => r.data?.Data?.[domain] || {}),
  ]);

  const desktop = device.Desktop || 0;
  const mobile = device['Mobile Web'] || 0;
  const deviceTotal = desktop + mobile;

  const result = {
    domain,
    country,
    monthlyVisits: visits.TotalVisits ?? engagement.AvgMonthVisits ?? null,
    monthlyVisitsFormatted: fmtLarge(visits.TotalVisits ?? engagement.AvgMonthVisits),
    visitsChange: visits.Change ?? null,
    visitsChangeFormatted: visits.Change != null ? fmtPct(visits.Change) : 'N/A',
    bounceRate: engagement.BounceRate ?? null,
    bounceRateFormatted: engagement.BounceRate != null ? fmtPct(engagement.BounceRate) : 'N/A',
    pagesPerVisit: engagement.PagesPerVisit ?? null,
    avgVisitDuration: engagement.AvgVisitDuration ?? null,
    avgVisitDurationFormatted: fmtDuration(engagement.AvgVisitDuration),
    totalPageViews: engagement.TotalPagesViews ?? null,
    totalPageViewsFormatted: fmtLarge(engagement.TotalPagesViews),
    deviceSplit: {
      desktopShare: deviceTotal > 0 ? desktop / deviceTotal : null,
      desktopShareFormatted: deviceTotal > 0 ? fmtPct(desktop / deviceTotal) : 'N/A',
      mobileShare: deviceTotal > 0 ? mobile / deviceTotal : null,
      mobileShareFormatted: deviceTotal > 0 ? fmtPct(mobile / deviceTotal) : 'N/A',
      desktopVisits: desktop || null,
      mobileVisits: mobile || null,
    },
    ranks: {
      global: ranks.GlobalRank?.Value ?? null,
      country: ranks.CountryRank?.Value ?? null,
      category: ranks.CategoryRank?.Value ?? null,
      categoryName: ranks.Category || null,
    },
  };
  cacheWrite(domain, 'traffic', result);
  return result;
}

// ---------------------------------------------------------------------------
// visits — weekly visit trend graph
// ---------------------------------------------------------------------------

async function fetchVisits(auth, domain, country, { months = 1 } = {}) {
  const label = months > 1 ? `${months}-month weekly` : 'weekly';
  console.log(`Fetching ${label} visit trend for ${domain}...`);
  const { from, to } = months > 1 ? monthsBackRange(months) : defaultMonthRange();
  const url = `${WIDGET_API_BASE}/WebsiteOverview/EngagementVisits/Graph?country=${country}&from=${from}&to=${to}&timeGranularity=Weekly&ShouldGetVerifiedData=false&includeSubDomains=true&isWindow=false&keys=${domain}&webSource=Total`;
  const { data } = await apiFetch(auth, url);
  const series = data?.Data?.[domain]?.Total?.[0] || [];

  const weeks = series.map(p => ({
    weekStarting: p.Key || null,
    visits: p.Value ?? null,
    visitsFormatted: fmtLarge(p.Value),
  }));

  const result = {
    domain,
    country,
    granularity: 'Weekly',
    weeks,
  };

  // When >1 month requested, aggregate weekly points into whole-month totals
  // for easy month-over-month reads. Weekly series is always primary output.
  if (months > 1) {
    const byMonth = new Map();
    for (const w of weeks) {
      const key = w.weekStarting?.slice(0, 7); // YYYY-MM
      if (!key || w.visits == null) continue;
      byMonth.set(key, (byMonth.get(key) || 0) + w.visits);
    }
    result.months = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, visits]) => ({
        month,
        visits,
        visitsFormatted: fmtLarge(visits),
      }));
  }
  cacheWrite(domain, 'visits', result);
  return result;
}

// ---------------------------------------------------------------------------
// channels — marketing mix / traffic sources
// ---------------------------------------------------------------------------

async function fetchChannels(auth, domain, country) {
  console.log(`Fetching marketing channels for ${domain}...`);
  const { from, to } = defaultMonthRange();
  const url = `${WIDGET_API_BASE}/MarketingMixTotal/TrafficSourcesOverview/PieChart?country=${country}&keys=${domain}&from=${from}&to=${to}&isWindow=false&timeGranularity=Monthly&includeSubDomains=true`;
  const { data } = await apiFetch(auth, url);
  const total = data?.Data?.Total?.[domain] || {};

  const sum = Object.values(total).reduce((s, v) => s + (v || 0), 0);
  const channels = Object.entries(total)
    .map(([channel, visits]) => ({
      channel,
      visits: visits ?? null,
      visitsFormatted: fmtLarge(visits),
      share: sum > 0 ? (visits || 0) / sum : null,
      shareFormatted: sum > 0 ? fmtPct((visits || 0) / sum) : 'N/A',
    }))
    .sort((a, b) => (b.visits || 0) - (a.visits || 0));

  const result = {
    domain,
    country,
    totalVisits: sum,
    totalVisitsFormatted: fmtLarge(sum),
    channels,
  };
  cacheWrite(domain, 'channels', result);
  return result;
}

// ---------------------------------------------------------------------------
// geography — top countries by traffic share
// ---------------------------------------------------------------------------

async function fetchGeography(auth, domain, country, count) {
  console.log(`Fetching audience geography for ${domain}...`);
  const { from, to } = defaultMonthRange();
  const url = `${WIDGET_API_BASE}/WebsiteGeography/Geography/Table?country=${country}&includeSubDomains=true&webSource=Total&timeGranularity=Monthly&orderBy=TotalShare+desc&keys=${domain}&pageSize=${count}&from=${from}&to=${to}&isWindow=false`;
  const { data } = await apiFetch(auth, url);

  const names = {};
  for (const f of data?.Filters?.country || []) names[String(f.id)] = f.text;

  const countries = (data?.Data || []).map(c => ({
    countryCode: c.Country ?? null,
    countryName: names[String(c.Country)] || null,
    share: c.Share ?? c.TotalShare ?? null,
    shareFormatted: fmtPct(c.Share ?? c.TotalShare),
    change: c.Change ?? null,
    changeFormatted: c.Change != null ? fmtPct(c.Change) : 'N/A',
  }));

  const result = {
    domain,
    totalCountries: data?.TotalCount ?? countries.length,
    countries,
  };
  cacheWrite(domain, 'geography', result);
  return result;
}

// ---------------------------------------------------------------------------
// similar — competing websites
// ---------------------------------------------------------------------------

async function fetchSimilar(auth, domain, count) {
  console.log(`Fetching similar sites for ${domain}...`);
  const url = `${API_BASE}/WebsiteOverview/getsimilarsites?key=${domain}&limit=${count}`;
  const { data } = await apiFetch(auth, url);
  const sites = (Array.isArray(data) ? data : []).map(s => ({
    domain: s.Domain || null,
    globalRank: s.Rank ?? null,
  }));
  const result = { domain, count: sites.length, similarSites: sites };
  cacheWrite(domain, 'similar', result);
  return result;
}

// ---------------------------------------------------------------------------
// referrals — incoming + outgoing referral domains + referring categories
// ---------------------------------------------------------------------------

async function fetchReferrals(auth, domain, country, count) {
  console.log(`Fetching referrals for ${domain}...`);
  const { from, to } = defaultMonthRange();

  const [incoming, outgoing, categories] = await Promise.all([
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/TopReferrals/Table?country=${country}&from=${from}&includeSubDomains=true&isWindow=false&keys=${domain}&timeGranularity=Monthly&to=${to}&pageSize=${count}&webSource=Total&orderBy=TotalShare+desc`).then(r => r.data),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/TrafficDestinationReferrals/Table?appMode=single&country=${country}&from=${from}&includeSubDomains=true&isWindow=false&keys=${domain}&timeGranularity=Monthly&to=${to}&pageSize=${count}&webSource=Total&orderBy=TotalShare+desc`).then(r => r.data),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverview/TopReferringCategories/Table?country=${country}&from=${from}&includeSubDomains=true&isWindow=false&keys=${domain}&timeGranularity=Monthly&to=${to}&webSource=Total&orderBy=TotalShare+desc`).then(r => r.data),
  ]);

  const mapDomains = d => (d?.Data || []).map(r => ({
    domain: r.Domain || null,
    category: r.Category && r.Category !== '-' ? r.Category : null,
    share: r.Share ?? null,
    shareFormatted: fmtPct(r.Share),
    change: r.Change ?? null,
    changeFormatted: r.Change != null ? fmtPct(r.Change) : 'N/A',
  }));

  const result = {
    domain,
    country,
    incomingReferrals: mapDomains(incoming),
    outgoingReferrals: mapDomains(outgoing),
    referringCategories: (categories?.Data || []).map(c => ({
      category: c.Category || null,
      share: c.Share ?? null,
      shareFormatted: fmtPct(c.Share),
    })),
  };
  cacheWrite(domain, 'referrals', result);
  return result;
}

// ---------------------------------------------------------------------------
// social — social network traffic share
// ---------------------------------------------------------------------------

async function fetchSocial(auth, domain, country) {
  console.log(`Fetching social traffic for ${domain}...`);
  const { from, to } = defaultMonthRange();
  const url = `${WIDGET_API_BASE}/WebsiteOverviewDesktop/TrafficSourcesSocial/PieChart?country=${country}&includeSubDomains=true&timeGranularity=Monthly&from=${from}&to=${to}&isWindow=false&keys=${domain}`;
  const { data } = await apiFetch(auth, url);
  const networks = data?.Data?.[domain] || {};

  const result = {
    domain,
    country,
    networks: Object.entries(networks)
      .map(([name, v]) => ({
        network: name,
        share: v?.Share ?? null,
        shareFormatted: fmtPct(v?.Share),
      }))
      .sort((a, b) => (b.share || 0) - (a.share || 0)),
  };
  cacheWrite(domain, 'social', result);
  return result;
}

// ---------------------------------------------------------------------------
// ads — display ad publishers + ad-driven traffic destinations
// ---------------------------------------------------------------------------

async function fetchAds(auth, domain, country) {
  console.log(`Fetching display advertising for ${domain}...`);
  const { from, to } = defaultMonthRange();
  // Free tier locks these widgets to a fixed page size of 5.
  const [publishers, destinations] = await Promise.all([
    apiFetch(auth, `${API_BASE}/AdIntelligence/Advertiser/Publishers/breakdown?country=${country}&key=${domain}&from=${from}&to=${to}&page=1&pageSize=5&isWindow=false&sort=visits&asc=false`).then(r => r.data),
    apiFetch(auth, `${WIDGET_API_BASE}/WebsiteOverviewDesktop/TrafficDestinationAds/Table?appMode=single&country=${country}&from=${from}&includeSubDomains=true&isWindow=false&keys=${domain}&timeGranularity=Monthly&to=${to}&pageSize=5&webSource=Total&orderBy=TotalShare+desc`).then(r => r.data),
  ]);

  const result = {
    domain,
    country,
    publishers: (publishers?.records || []).map(r => ({
      publisher: r.entity || null,
      category: r.category || null,
      rank: r.rank ?? null,
      impressionsShare: r.impressionsShare ?? null,
      impressionsShareFormatted: fmtPct(r.impressionsShare),
      visitsShare: r.visitsShare ?? null,
      visitsShareFormatted: fmtPct(r.visitsShare),
      spendShare: r.spendShare ?? null,
      spendShareFormatted: fmtPct(r.spendShare),
    })),
    adTrafficDestinations: (destinations?.Data || []).map(r => ({
      domain: r.Domain || null,
      share: r.Share ?? r.TotalShare ?? null,
      shareFormatted: fmtPct(r.Share ?? r.TotalShare),
      change: r.Change ?? null,
      changeFormatted: r.Change != null ? fmtPct(r.Change) : 'N/A',
    })),
  };
  cacheWrite(domain, 'ads', result);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const domainArg = positional[0];
const SCRIPT = 'similarweb-free-website.mjs';

function requireDomain(usage) {
  if (!domainArg) { console.error(`Usage: ${SCRIPT} ${usage}`); process.exit(1); }
  return parseDomain(domainArg);
}

try {
  const country = flags.country || '999';
  switch (command) {
    case 'auth':
      await doAuth();
      break;
    case 'overview':
      console.log(JSON.stringify(await fetchOverview(getAuth(), requireDomain('overview <domain>'), country), null, 2));
      break;
    case 'traffic':
      console.log(JSON.stringify(await fetchTraffic(getAuth(), requireDomain('traffic <domain>'), country), null, 2));
      break;
    case 'visits': {
      // Free tier's `EngagementVisits/Graph` endpoint caps at 6 complete months
      // (verified: API rejects wider ranges with "Allowed interval is YYYY-MM--YYYY-MM").
      const months = Math.max(1, Math.min(6, parseInt(flags.months || '1', 10) || 1));
      console.log(JSON.stringify(await fetchVisits(getAuth(), requireDomain('visits <domain>'), country, { months }), null, 2));
      break;
    }
    case 'channels':
      console.log(JSON.stringify(await fetchChannels(getAuth(), requireDomain('channels <domain>'), country), null, 2));
      break;
    case 'geography':
      console.log(JSON.stringify(await fetchGeography(getAuth(), requireDomain('geography <domain>'), country, parseInt(flags.count || '10', 10)), null, 2));
      break;
    case 'similar':
      console.log(JSON.stringify(await fetchSimilar(getAuth(), requireDomain('similar <domain>'), parseInt(flags.count || '20', 10)), null, 2));
      break;
    case 'referrals':
      console.log(JSON.stringify(await fetchReferrals(getAuth(), requireDomain('referrals <domain>'), country, parseInt(flags.count || '10', 10)), null, 2));
      break;
    case 'social':
      console.log(JSON.stringify(await fetchSocial(getAuth(), requireDomain('social <domain>'), country), null, 2));
      break;
    case 'ads':
      console.log(JSON.stringify(await fetchAds(getAuth(), requireDomain('ads <domain>'), country), null, 2));
      break;
    default:
      console.log(`
similarweb-free-website — Website traffic analytics from a SimilarWeb FREE account

Setup:
  node ${SCRIPT} auth                      Extract cookies from a logged-in Chrome tab

Commands:
  node ${SCRIPT} overview <domain>         Site header: title, description, category, ranks, related apps
  node ${SCRIPT} traffic <domain>          Visits, bounce rate, pages/visit, duration, device split, ranks
  node ${SCRIPT} visits <domain>           Weekly visit trend                    [--months=1..6]
  node ${SCRIPT} channels <domain>         Marketing channel breakdown (direct, search, social, referrals, ...)
  node ${SCRIPT} geography <domain>        Top countries by traffic share        [--count=10]
  node ${SCRIPT} similar <domain>          Similar/competing websites with rank  [--count=20]
  node ${SCRIPT} referrals <domain>        Incoming + outgoing referrals, referring categories  [--count=10]
  node ${SCRIPT} social <domain>           Social network traffic share
  node ${SCRIPT} ads <domain>              Display ad publishers + ad-driven traffic destinations

Domain formats: google.com | www.google.com | https://google.com/path

Free-tier limits:
  - Most commands cover a SINGLE most recent complete month (SimilarWeb lags ~1 month).
  - visits accepts --months=N (up to 6) — the Graph endpoint honors historical
    ranges even on free accounts, unlike the single-metric endpoints. Free-tier
    accounts cap at 6 complete months of history.
  - Worldwide only. The --country flag exists but non-999 values need a paid plan.

Data stored in: ${DATA_DIR}
`);
      break;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
