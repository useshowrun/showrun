#!/usr/bin/env node
// similarweb-compare.mjs — Side-by-side domain comparison using SimilarWeb
//
// Setup:   node similarweb-compare.mjs auth
// Usage:   node similarweb-compare.mjs compare chatgpt.com claude.ai
//          node similarweb-compare.mjs channels chatgpt.com claude.ai grok.com
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-compare');
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
    console.error('No auth found. Run: node similarweb-compare.mjs auth');
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
      console.error('Session expired or blocked. Run: node similarweb-compare.mjs auth');
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
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 2, 1);
  return { from: dateParam(fromDate), to: dateParam(toDate) };
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

function fmtDuration(secs) {
  if (secs == null) return 'N/A';
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function safeDomainFilename(domain) {
  return domain.replace(/\./g, '_');
}

function validateDomains(domains) {
  if (domains.length < 2) {
    console.error('Error: requires at least 2 domains.');
    process.exit(1);
  }
  if (domains.length > 5) {
    console.error('Error: supports a maximum of 5 domains.');
    process.exit(1);
  }
}

function keysParam(domains) {
  return encodeURIComponent(domains.join(','));
}

// ---------------------------------------------------------------------------
// API: Compare — full engagement comparison
// ---------------------------------------------------------------------------

async function doCompare(auth, domains, country) {
  console.log(`Comparing ${domains.length} domains: ${domains.join(', ')} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const keys = keysParam(domains);

  const [overviewData, engagementData, deviceData, ranksData] = await Promise.all([
    (async () => {
      const url = `${API_BASE}/WebsiteOverview/getheader?keys=${keys}&mainDomainOnly=false&includeCrossData=true`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${WIDGET_API_BASE}/AssetsCompare/Overview/Table?ShouldGetVerifiedData=false&country=${country}&from=${from}&includeSubDomains=true&isWindow=false&keys=${keys}&timeGranularity=Monthly&webSource=Total&to=${to}&unBounced=false`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${WIDGET_API_BASE}/WebsiteOverview/EngagementDesktopVsMobileVisits/Table?country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&keys=${keys}&timeGranularity=Monthly&webSource=Total&ShouldGetVerifiedData=false&beta=false`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
    (async () => {
      const url = `${WIDGET_API_BASE}/WebsiteOverview/WebRanksCountry/Table?country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&keys=${keys}&timeGranularity=Monthly&webSource=Total`;
      const { data } = await apiFetch(auth, url);
      return data;
    })(),
  ]);

  const results = domains.map(domain => {
    const overview = overviewData?.[domain] || {};
    const engagement = (engagementData?.Data || []).find(d => d.Domain === domain) || {};
    const device = (deviceData?.Data || []).find(d => d.Domain === domain) || {};
    const ranks = (ranksData?.Data || []).find(d => d.Domain === domain) || {};
    const deskMob = device.DesktopMobileShareVisits || [];

    return {
      domain,
      title: overview.title || null,
      category: overview.category || null,
      globalRank: ranks.GlobalRank ?? overview.globalRanking ?? null,
      countryRank: ranks.CountryRank ?? null,
      categoryRank: ranks.CategoryRank ?? overview.categoryRanking ?? null,
      avgMonthlyVisits: engagement.AvgMonthVisits ?? null,
      avgMonthlyVisitsFormatted: engagement.AvgMonthVisits != null ? fmtLarge(engagement.AvgMonthVisits) : 'N/A',
      uniqueUsers: engagement.UniqueUsers ?? null,
      uniqueUsersFormatted: engagement.UniqueUsers != null ? fmtLarge(engagement.UniqueUsers) : 'N/A',
      visitsPerUser: engagement.VisitsPerUser ?? null,
      pagesPerVisit: engagement.PagesPerVisit ?? null,
      avgVisitDuration: engagement.AvgVisitDuration ?? null,
      avgVisitDurationFormatted: fmtDuration(engagement.AvgVisitDuration),
      bounceRate: engagement.BounceRate ?? null,
      bounceRateFormatted: engagement.BounceRate != null ? fmtPct(engagement.BounceRate) : 'N/A',
      totalPageViews: engagement.TotalPagesViews ?? null,
      totalPageViewsFormatted: engagement.TotalPagesViews != null ? fmtLarge(engagement.TotalPagesViews) : 'N/A',
      desktopShare: deskMob[0] ?? null,
      desktopShareFormatted: deskMob[0] != null ? fmtPct(deskMob[0]) : 'N/A',
      mobileShare: deskMob[1] ?? null,
      mobileShareFormatted: deskMob[1] != null ? fmtPct(deskMob[1]) : 'N/A',
      yearFounded: overview.yearFounded ?? null,
      employeeRange: overview.employeeRange || null,
    };
  });

  const result = {
    comparedAt: new Date().toISOString(),
    country,
    domains,
    results,
  };

  const cacheFile = resolve(CACHE_DIR, `compare-${domains.map(safeDomainFilename).join('-vs-')}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Channels — marketing channel comparison
// ---------------------------------------------------------------------------

async function doChannels(auth, domains, country) {
  console.log(`Comparing channels for ${domains.join(', ')} (country=${country})...`);
  const { from, to } = defaultDateRange();
  const keys = keysParam(domains);

  const url = `${WIDGET_API_BASE}/MarketingMixTotal/TrafficSourcesOverview/PieChart?country=${country}&from=${from}&to=${to}&includeSubDomains=true&isWindow=false&timeGranularity=Monthly&keys=${keys}`;
  const { data } = await apiFetch(auth, url);

  const totalData = data?.Data?.Total || {};
  const desktopData = data?.Data?.Desktop || {};
  const mobileData = data?.Data?.MobileWeb || {};

  const results = domains.map(domain => {
    const channels = totalData[domain] || {};
    const channelNames = Object.keys(channels);
    const totalTraffic = channelNames.reduce((sum, ch) => sum + (channels[ch] || 0), 0);

    return {
      domain,
      totalTraffic,
      totalTrafficFormatted: fmtLarge(totalTraffic),
      channels: channelNames.map(name => ({
        channel: name,
        visits: channels[name] ?? null,
        visitsFormatted: channels[name] != null ? fmtLarge(channels[name]) : 'N/A',
        share: totalTraffic > 0 ? (channels[name] || 0) / totalTraffic : null,
        shareFormatted: totalTraffic > 0 ? fmtPct((channels[name] || 0) / totalTraffic) : 'N/A',
      })).sort((a, b) => (b.visits || 0) - (a.visits || 0)),
    };
  });

  const result = {
    comparedAt: new Date().toISOString(),
    country,
    domains,
    results,
  };

  const cacheFile = resolve(CACHE_DIR, `channels-${domains.map(safeDomainFilename).join('-vs-')}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
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
        console.error('Usage: similarweb-compare.mjs compare <domain1> <domain2> [domain3...] [--country=999]');
        process.exit(1);
      }
      const domains = positional.map(parseDomain);
      validateDomains(domains);
      const country = flags.country || '999';
      const result = await doCompare(getAuth(), domains, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'channels': {
      if (positional.length < 2) {
        console.error('Usage: similarweb-compare.mjs channels <domain1> <domain2> [domain3...] [--country=999]');
        process.exit(1);
      }
      const domains = positional.map(parseDomain);
      validateDomains(domains);
      const country = flags.country || '999';
      const result = await doChannels(getAuth(), domains, country);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-compare.mjs';
      console.log(`
similarweb-compare — Side-by-side domain comparison using SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} compare <d1> <d2> [d3...]         Full engagement comparison (2-5 domains)
       [--country=999]                              Country code (default: 999 = worldwide)
       Compares: visits, unique users, bounce rate, pages/visit, duration,
       device split, ranks, page views, year founded, employees

  node ${script} channels <d1> <d2> [d3...]        Marketing channel comparison (2-5 domains)
       [--country=999]                              Country code (default: 999 = worldwide)
       Compares: Direct, Organic Search, Paid Search, Social, Referrals,
       Email, Display Ads — with per-domain share breakdown

Examples:
  node ${script} compare chatgpt.com claude.ai grok.com
  node ${script} compare amazon.com ebay.com walmart.com --country=840
  node ${script} channels chatgpt.com claude.ai
  node ${script} channels spotify.com apple.com/music --country=826

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
