#!/usr/bin/env node
// similarweb-search.mjs — SimilarWeb search: find domains, keywords, favorites, recent views
//
// Setup:   node similarweb-search.mjs auth
// Usage:   node similarweb-search.mjs search shopify
//          node similarweb-search.mjs keywords "ai chatbot"
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-search');
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
    console.error('No auth found. Run: node similarweb-search.mjs auth');
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
      console.error('Session expired or blocked. Run: node similarweb-search.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';
const AUTOCOMPLETE_BASE = 'https://pro.similarweb.com/autocomplete';

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

// ---------------------------------------------------------------------------
// API: Search websites
// ---------------------------------------------------------------------------

async function fetchSearch(auth, term, count = 25) {
  console.log(`Searching websites for "${term}"...`);
  const url = `${AUTOCOMPLETE_BASE}/websites?size=${count}&term=${encodeURIComponent(term)}&webSource=Desktop&validate=true`;
  const { data } = await apiFetch(auth, url);

  const items = (Array.isArray(data) ? data : []).map(item => ({
    domain: item.name || null,
    favicon: item.image || null,
  }));

  const result = {
    query: term,
    count: items.length,
    results: items,
  };

  const cacheFile = resolve(CACHE_DIR, `search-${term.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Search keywords
// ---------------------------------------------------------------------------

async function fetchKeywords(auth, term, count = 20) {
  console.log(`Searching keywords for "${term}"...`);
  const url = `${AUTOCOMPLETE_BASE}/keywords?size=${count}&term=${encodeURIComponent(term)}&webSource=Desktop&validate=true`;
  const { data } = await apiFetch(auth, url);

  const items = (Array.isArray(data) ? data : []).map(item => ({
    keyword: item.name || null,
  }));

  const result = {
    query: term,
    count: items.length,
    keywords: items,
  };

  const cacheFile = resolve(CACHE_DIR, `keywords-${term.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Favorites
// ---------------------------------------------------------------------------

async function fetchFavorites(auth) {
  console.log('Fetching favorites...');
  const url = `${API_BASE}/userdata/favorites?display=true`;
  const { data } = await apiFetch(auth, url);

  const items = Array.isArray(data) ? data : (data?.items || data?.favorites || []);

  const favorites = items.map(item => ({
    domain: item.Domain || item.domain || item.name || null,
    favicon: item.Favicon || item.favicon || item.Icon || null,
    addedAt: item.AddedAt || item.addedAt || item.CreatedAt || null,
  }));

  const result = {
    count: favorites.length,
    favorites,
  };

  const cacheFile = resolve(CACHE_DIR, 'favorites.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Recent
// ---------------------------------------------------------------------------

async function fetchRecent(auth) {
  console.log('Fetching recently viewed...');
  const url = `${API_BASE}/userdata/recent?display=true`;
  const { data } = await apiFetch(auth, url);

  const items = Array.isArray(data) ? data : [];

  const recent = items.map(item => ({
    domain: item.data?.mainItem || null,
    comparedWith: item.data?.comparedItems || [],
    page: item.data?.pageTitle || null,
    category: item.data?.category || null,
    date: item.updatedTime || null,
    isFavorite: item.isFavorite ?? false,
  }));

  const result = {
    count: recent.length,
    recent,
  };

  const cacheFile = resolve(CACHE_DIR, 'recent.json');
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

    case 'search': {
      const term = positional[0];
      if (!term) { console.error('Usage: similarweb-search.mjs search <term> [--count=25]'); process.exit(1); }
      const count = parseInt(flags.count || '25', 10);
      const result = await fetchSearch(getAuth(), term, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'keywords': {
      const term = positional[0];
      if (!term) { console.error('Usage: similarweb-search.mjs keywords <term> [--count=20]'); process.exit(1); }
      const count = parseInt(flags.count || '20', 10);
      const result = await fetchKeywords(getAuth(), term, count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'favorites': {
      const result = await fetchFavorites(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'recent': {
      const result = await fetchRecent(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-search.mjs';
      console.log(`
similarweb-search — SimilarWeb search: find domains, keywords, favorites, recent views

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} search <term>                     Search for websites/domains
       [--count=25]                                 Number of results (default: 25)
  node ${script} keywords <term>                   Search for keyword suggestions
       [--count=20]                                 Number of results (default: 20)
  node ${script} favorites                         List favorited domains
  node ${script} recent                            List recently viewed domains

Examples:
  node ${script} search shopify
  node ${script} search "artificial intelligence"
  node ${script} keywords "ai chatbot"
  node ${script} keywords ecommerce --count=50

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
