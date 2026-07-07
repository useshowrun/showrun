#!/usr/bin/env node
// similarweb-free-market.mjs — Web market / industry analysis from a SimilarWeb FREE account.
//
// Uses the "Web Market Analysis" report exposed to free/expired-trial accounts on
// pro.similarweb.com. Free tier covers the last 3 months, worldwide (country=999),
// and the combined "All traffic" channel only (per-channel rankings need a paid plan).
//
// Setup:   node similarweb-free-market.mjs auth
// Usage:   node similarweb-free-market.mjs industries
//          node similarweb-free-market.mjs industries music
//          node similarweb-free-market.mjs leaders Arts_and_Entertainment
//          node similarweb-free-market.mjs leaders Arts_and_Entertainment/Music
//
// Requires Node 22+ (built-in fetch + crypto).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import crypto from 'crypto';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-free-market');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; }
function saveJson(path, data) { ensureDir(resolve(path, '..')); writeFileSync(path, JSON.stringify(data, null, 2)); }

// --- CDP integration (only used by `auth`) ---------------------------------

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

async function doAuth() {
  console.log('Finding SimilarWeb tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('similarweb.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No SimilarWeb tab found. Open pro.similarweb.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: ['https://pro.similarweb.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieStr = cookies.filter(c => c.domain.includes('similarweb.com')).map(c => `${c.name}=${c.value}`).join('; ');
  if (!cookieStr) throw new Error('No cookies found. Are you logged in to SimilarWeb?');
  if (!cookies.some(c => c.name.includes('SGTOKEN'))) console.warn('Warning: SGTOKEN cookie not found. API calls may fail.');

  saveJson(SESSION_FILE, { cookie: cookieStr, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// --- HTTP helpers ----------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) { console.error('No auth found. Run: node similarweb-free-market.mjs auth'); process.exit(1); }
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

async function apiFetch(auth, url) {
  let resp;
  try {
    resp = await fetch(url, { headers: baseHeaders(auth) });
  } catch (err) {
    throw new Error(`Network error fetching ${url.split('?')[0]}: ${err.message}`);
  }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) console.error('Session expired or blocked. Run: node similarweb-free-market.mjs auth');
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// --- Helpers ---------------------------------------------------------------

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

function last3MonthRange() {
  // Free tier exposes the last 3 complete months. SimilarWeb data lags ~1 month.
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 3, 1);
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
function fmtPct(val, decimals = 2) { return val == null ? 'N/A' : (val * 100).toFixed(decimals) + '%'; }
function fmtDuration(s) { return s == null ? 'N/A' : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`; }

// --- industries ------------------------------------------------------------

async function fetchIndustries(auth, search) {
  console.log('Fetching industry categories...');
  const { data } = await apiFetch(auth, `${API_BASE}/categories`);
  const flat = [];
  for (const top of (Array.isArray(data) ? data : [])) {
    flat.push({ industry: top.name, parent: null });
    for (const son of top.sons || []) flat.push({ industry: `${top.name}/${son.name}`, parent: top.name });
  }
  const filtered = search
    ? flat.filter(x => x.industry.toLowerCase().includes(search.toLowerCase()))
    : flat;
  const result = { total: flat.length, matched: filtered.length, industries: filtered };
  saveJson(resolve(CACHE_DIR, 'industries.json'), result);
  return result;
}

// --- leaders ---------------------------------------------------------------

async function fetchLeaders(auth, industry, country, count) {
  console.log(`Fetching market leaders for ${industry}...`);
  const { from, to } = last3MonthRange();
  const cat = encodeURIComponent(industry);
  const url = `${API_BASE}/Market/Leaders/Table?keys=%24${cat}&duration=3m&from=${from}&to=${to}&webSource=Desktop&isWindow=false&includeSubDomains=true&country=${country}&category=${cat}&sort=Share&asc=false`;
  const { data } = await apiFetch(auth, url);

  const mapPlayer = p => ({
    domain: p.Domain || null,
    globalRank: p.Rank ?? null,
    categoryRank: p.CategoryRank ?? null,
    category: p.Category || null,
    marketShare: p.Share ?? null,
    marketShareFormatted: fmtPct(p.Share),
    avgMonthlyVisits: p.AvgMonthVisits ?? null,
    avgMonthlyVisitsFormatted: fmtLarge(p.AvgMonthVisits),
    uniqueVisitors: p.UniqueUsers ?? null,
    uniqueVisitorsFormatted: fmtLarge(p.UniqueUsers),
    bounceRate: p.BounceRate ?? null,
    bounceRateFormatted: fmtPct(p.BounceRate),
    pagesPerVisit: p.PagesPerVisit ?? null,
    avgVisitDuration: p.AvgVisitDuration ?? null,
    avgVisitDurationFormatted: fmtDuration(p.AvgVisitDuration),
    momChange: p.MoMChange ?? null,
    momChangeFormatted: p.MoMChange != null ? fmtPct(p.MoMChange) : 'N/A',
    desktopShare: Array.isArray(p.DesktopMobileShare) ? p.DesktopMobileShare[0] ?? null : null,
    mobileShare: Array.isArray(p.DesktopMobileShare) ? p.DesktopMobileShare[1] ?? null : null,
  });

  const result = {
    industry,
    country,
    topPlayers: (data?.TopPlayers || []).slice(0, count).map(mapPlayer),
    risingPlayers: (data?.RisingPlayers || []).slice(0, count).map(mapPlayer),
  };
  saveJson(resolve(CACHE_DIR, `${industry.replace(/\//g, '_')}-leaders.json`), result);
  return result;
}

// --- CLI -------------------------------------------------------------------

const [, , command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const SCRIPT = 'similarweb-free-market.mjs';

try {
  const country = flags.country || '999';
  switch (command) {
    case 'auth':
      await doAuth();
      break;
    case 'industries':
      console.log(JSON.stringify(await fetchIndustries(getAuth(), positional[0]), null, 2));
      break;
    case 'leaders': {
      if (!positional[0]) { console.error(`Usage: ${SCRIPT} leaders <industry>  (e.g. Arts_and_Entertainment or Arts_and_Entertainment/Music)`); process.exit(1); }
      console.log(JSON.stringify(await fetchLeaders(getAuth(), positional[0], country, parseInt(flags.count || '25', 10)), null, 2));
      break;
    }
    default:
      console.log(`
similarweb-free-market — Web market / industry analysis from a SimilarWeb FREE account

Setup:
  node ${SCRIPT} auth                          Extract cookies from a logged-in Chrome tab

Commands:
  node ${SCRIPT} industries [search]           List industry categories (optionally filter by substring)
  node ${SCRIPT} leaders <industry>            Top + rising websites in an industry  [--count=25]

Industry keys come from the 'industries' command, e.g.:
  Arts_and_Entertainment
  Arts_and_Entertainment/Music
  E-commerce_and_Shopping

Free-tier limits:
  - Data covers the last 3 complete months, worldwide.
  - Only the combined "All traffic" channel — per-channel rankings (Search, Social,
    Display, ...) require a paid plan.

Data stored in: ${DATA_DIR}
`);
      break;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
