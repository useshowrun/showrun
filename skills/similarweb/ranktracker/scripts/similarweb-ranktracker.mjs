#!/usr/bin/env node
// similarweb-ranktracker.mjs — Search rank tracking from SimilarWeb: campaigns, rank distribution, keyword positions over time
//
// Setup:   node similarweb-ranktracker.mjs auth
// Usage:   node similarweb-ranktracker.mjs campaigns
//          node similarweb-ranktracker.mjs ranks <campaign-id>
//          node similarweb-ranktracker.mjs keywords <campaign-id>
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-ranktracker');
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
    console.error('No auth found. Run: node similarweb-ranktracker.mjs auth');
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
      console.error('Session expired or blocked. Run: node similarweb-ranktracker.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';

// Demo campaign GUIDs (built-in demos)
const DEMO_CAMPAIGNS = {
  'rayban': '6c9cd4c1-3cdf-4b71-bbfe-a87f8e75f5a8',
  'sixt': '3b1ca8ee-2d66-4b84-8eec-28e8f12ec5b3',
  'hubspot': '1badc5b5-b010-4c18-aeb7-019313d4e3fb',
};

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
  // End yesterday (today's data may not be available yet)
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 1, toDate.getDate());
  return { from: dateParam(fromDate), to: dateParam(toDate) };
}

function fmtLarge(val) {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return String(val);
}

// Resolve campaign ID: accept GUID, demo name, or short name
function resolveCampaignId(input) {
  const lower = input.toLowerCase();
  if (DEMO_CAMPAIGNS[lower]) return { id: DEMO_CAMPAIGNS[lower], isDemo: true };
  // If it looks like a GUID, use it directly
  if (input.match(/^[0-9a-f]{8}-/i)) return { id: input, isDemo: false };
  throw new Error(`Unknown campaign: "${input}". Use a campaign GUID or demo name (rayban, sixt, hubspot).`);
}

function apiPrefix(isDemo) {
  return isDemo ? 'rankTracker/demo' : 'rankTracker';
}

// ---------------------------------------------------------------------------
// API: List Campaigns
// ---------------------------------------------------------------------------

async function fetchCampaigns(auth) {
  console.log('Fetching campaigns...');
  const url = `${API_BASE}/rankTracker/campaigns?`;
  const { data } = await apiFetch(auth, url);

  const userCampaigns = (data.userCampaigns || []).map(c => ({
    id: c.id || c.guid || null,
    name: c.name || null,
    mainSite: c.mainSite || null,
    isDemo: false,
  }));

  const sharedCampaigns = (data.sharedCampaigns || []).map(c => ({
    id: c.id || c.guid || null,
    name: c.name || null,
    mainSite: c.mainSite || null,
    isDemo: false,
  }));

  // Add demo campaigns
  const demos = [
    { id: DEMO_CAMPAIGNS.rayban, name: 'Ray-Ban (Retail)', mainSite: 'ray-ban.com', isDemo: true },
    { id: DEMO_CAMPAIGNS.sixt, name: 'Sixt (Car Rental)', mainSite: 'sixt.com', isDemo: true },
    { id: DEMO_CAMPAIGNS.hubspot, name: 'HubSpot (Software)', mainSite: 'hubspot.com', isDemo: true },
  ];

  const result = {
    userCampaigns,
    sharedCampaigns,
    demoCampaigns: demos,
  };

  const cacheFile = resolve(CACHE_DIR, 'campaigns.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Campaign Details
// ---------------------------------------------------------------------------

async function fetchDetails(auth, campaignInput) {
  const { id, isDemo } = resolveCampaignId(campaignInput);
  console.log(`Fetching campaign details for ${id}${isDemo ? ' (demo)' : ''}...`);
  const prefix = apiPrefix(isDemo);
  const url = `${API_BASE}/${prefix}/campaign/${id}`;
  const { data } = await apiFetch(auth, url);

  const tags = data.tags || {};
  const tagList = Object.entries(tags).map(([keyword, tagNames]) => ({
    keyword,
    tags: tagNames,
  }));

  const result = {
    campaignId: id,
    isDemo,
    competitors: data.competitors || [],
    trackedKeywords: tagList.length,
    tags: tagList,
  };

  const cacheFile = resolve(CACHE_DIR, `campaign-${id.substring(0, 8)}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Rank Distribution
// ---------------------------------------------------------------------------

async function fetchRanks(auth, campaignInput, site) {
  const { id, isDemo } = resolveCampaignId(campaignInput);
  // Get campaign details to find the main site and scraping config
  const prefix = apiPrefix(isDemo);
  const campaignUrl = `${API_BASE}/${prefix}/campaign/${id}`;
  const { data: campaign } = await apiFetch(auth, campaignUrl);

  const mainSite = site || campaign.site || 'unknown';
  const competitors = campaign.competitors || [];
  const allSites = [mainSite, ...competitors].filter(Boolean);

  // Get scraping config from the campaign
  const scrapingConfigs = campaign.scrapingConfigurations || [];
  const scrapingGuid = scrapingConfigs[0]?.guid || scrapingConfigs[0]?.id || '';

  const { from, to } = defaultDateRange();
  const sitesParam = encodeURIComponent(allSites.join(','));

  console.log(`Fetching rank distribution for campaign ${id.substring(0, 8)}...`);
  const url = `${API_BASE}/${prefix}/reports/overviewReport/RankDistribution?campaignguid=${id}&from=${from}&to=${to}&sites=${sitesParam}&scrapingConfigurationGuids=${scrapingGuid}&granularity=daily&isDaily=true&invertedSerpFilter=false&mainSiteSerpFilter=false`;
  const { data } = await apiFetch(auth, url);

  const records = (data.records || []).map(r => {
    const positions = {};
    for (const pg of r.positionGroupData || []) {
      positions[pg.positionGroup] = pg.siteToKeywordsCount?.siteKeywordsCount || {};
    }
    return { date: r.date, positions };
  });

  const result = {
    campaignId: id,
    isDemo,
    sites: allSites,
    dateRange: { from: records[0]?.date, to: records[records.length - 1]?.date },
    totalDays: records.length,
    records,
  };

  const cacheFile = resolve(CACHE_DIR, `ranks-${id.substring(0, 8)}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Keyword Trends (daily positions per keyword)
// ---------------------------------------------------------------------------

async function fetchKeywords(auth, campaignInput, site, count = 50) {
  const { id, isDemo } = resolveCampaignId(campaignInput);
  const prefix = apiPrefix(isDemo);

  // Get campaign details
  const campaignUrl = `${API_BASE}/${prefix}/campaign/${id}`;
  const { data: campaign } = await apiFetch(auth, campaignUrl);

  const mainSite = site || campaign.site || 'unknown';
  const scrapingConfigs = campaign.scrapingConfigurations || [];
  const scrapingGuid = scrapingConfigs[0]?.guid || scrapingConfigs[0]?.id || '';

  const { from, to } = defaultDateRange();

  console.log(`Fetching keyword trends for campaign ${id.substring(0, 8)} (count=${count})...`);
  const url = `${API_BASE}/${prefix}/reports/keywordsTrendReport/TrendTable?campaignguid=${id}&from=${from}&to=${to}&sites=${encodeURIComponent(mainSite)}&scrapingConfigurationGuids=${scrapingGuid}&granularity=daily&isDaily=true&invertedSerpFilter=false&mainSiteSerpFilter=false&page=1&sort=volume&asc=false&trackOverallPosition=false&viewMode=positions`;
  const { data } = await apiFetch(auth, url);

  const keywords = (data.records || []).slice(0, count).map(r => ({
    keyword: r.keyword || null,
    volume: r.volume ?? null,
    volumeFormatted: r.volume != null ? fmtLarge(r.volume) : 'N/A',
    geoLocation: r.geoLocation || null,
    positions: (r.trend || []).map(t => ({
      date: t.key,
      position: t.value,
    })),
    latestPosition: r.trend?.length > 0 ? r.trend[r.trend.length - 1].value : null,
    bestPosition: r.trend?.length > 0 ? Math.min(...r.trend.map(t => t.value).filter(v => v > 0)) : null,
  }));

  const result = {
    campaignId: id,
    isDemo,
    site: mainSite,
    totalKeywords: data.totalCount ?? keywords.length,
    count: keywords.length,
    keywords,
  };

  const cacheFile = resolve(CACHE_DIR, `keywords-${id.substring(0, 8)}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const campaignArg = positional[0];

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'campaigns': {
      const result = await fetchCampaigns(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'details': {
      if (!campaignArg) { console.error('Usage: similarweb-ranktracker.mjs details <campaign-id|demo-name>'); process.exit(1); }
      const result = await fetchDetails(getAuth(), campaignArg);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'ranks': {
      if (!campaignArg) { console.error('Usage: similarweb-ranktracker.mjs ranks <campaign-id|demo-name> [--site=domain]'); process.exit(1); }
      const result = await fetchRanks(getAuth(), campaignArg, flags.site);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'keywords': {
      if (!campaignArg) { console.error('Usage: similarweb-ranktracker.mjs keywords <campaign-id|demo-name> [--site=domain] [--count=50]'); process.exit(1); }
      const count = parseInt(flags.count || '50', 10);
      const result = await fetchKeywords(getAuth(), campaignArg, flags.site, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-ranktracker.mjs';
      console.log(`
similarweb-ranktracker — Search rank tracking from SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} campaigns                         List all campaigns (user + demo)
  node ${script} details <campaign>                Campaign details: tracked keywords, competitors, tags
  node ${script} ranks <campaign>                  Daily rank distribution (positions 1, 2-3, 4-10, etc.)
       [--site=domain]                              Filter to specific site
  node ${script} keywords <campaign>               Per-keyword daily position trends
       [--site=domain]                              Filter to specific site
       [--count=50]                                 Number of keywords (default: 50)

Campaign argument:
  hubspot                                           Demo campaign name (rayban, sixt, hubspot)
  1badc5b5-b010-...                                 Campaign GUID (from 'campaigns' command)

Examples:
  node ${script} campaigns
  node ${script} details hubspot
  node ${script} ranks hubspot
  node ${script} keywords hubspot --count=10

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
