#!/usr/bin/env node
// hackernews-search.mjs — Search Hacker News stories, comments, authors, and front page
//
// Setup (optional):
//   node hackernews-search.mjs auth
//
// Commands:
//   node hackernews-search.mjs stories <query> [--sort=relevance|date] [--limit=20] [--page=0] [--points=N] [--time=day|week|month|year]
//   node hackernews-search.mjs comments <query> [--sort=relevance|date] [--limit=20] [--page=0] [--points=N] [--time=day|week|month|year]
//   node hackernews-search.mjs author <username> [--type=story|comment] [--limit=20] [--page=0] [--points=N]
//   node hackernews-search.mjs front [YYYY-MM-DD]
//
// Requires Node 22+ (built-in fetch). All commands work without auth (Algolia API is public).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/hackernews-search');
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
// CDP integration (only needed for auth)
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome HN tab (optional)
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Hacker News tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('news.ycombinator.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) throw new Error('No HN tab found. Open news.ycombinator.com in Chrome first.');
  console.log(`Using tab: ${target}`);
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://news.ycombinator.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieStr = cookies.filter(c => c.domain.includes('ycombinator.com')).map(c => `${c.name}=${c.value}`).join('; ');
  const userCookie = cookies.find(c => c.name === 'user');
  const username = userCookie?.value?.split('&')?.[0] || '';
  saveJson(SESSION_FILE, { cookie: cookieStr, username, extractedAt: new Date().toISOString() });
  console.log(`Auth saved (user: ${username || 'anonymous'}).`);
}

// ---------------------------------------------------------------------------
// HTTP helpers (Algolia is public — no auth needed)
// ---------------------------------------------------------------------------

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

async function algoliaFetch(path) {
  const url = `${ALGOLIA_BASE}${path}`;
  const resp = await fetch(url);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function slug(query) {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

function preview(text, maxLen = 150) {
  if (!text) return '';
  const clean = text.replace(/<[^>]*>/g, '').replace(/\n+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

function timeToUnix(timeStr) {
  const now = Math.floor(Date.now() / 1000);
  const periods = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
  return periods[timeStr] ? now - periods[timeStr] : 0;
}

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// API: Search stories
// ---------------------------------------------------------------------------

async function searchStories(query, flags) {
  const sort = flags.sort || 'relevance';
  const limit = Math.min(Math.max(parseInt(flags.limit || '20', 10), 1), 1000);
  const page = Math.max(parseInt(flags.page || '0', 10), 0);
  const minPoints = parseInt(flags.points || '0', 10);
  const time = flags.time || '';

  const endpoint = sort === 'date' ? '/search_by_date' : '/search';
  const params = new URLSearchParams({ query, tags: 'story', hitsPerPage: String(limit), page: String(page) });

  const numericFilters = [];
  if (minPoints > 0) numericFilters.push(`points>${minPoints}`);
  if (time) {
    const ts = timeToUnix(time);
    if (ts > 0) numericFilters.push(`created_at_i>${ts}`);
  }
  if (numericFilters.length) params.set('numericFilters', numericFilters.join(','));

  console.log(`Searching stories for "${query}" (${sort})...`);

  const { status, ok, data } = await algoliaFetch(`${endpoint}?${params}`);
  if (!ok) { console.error(`API error (HTTP ${status})`); return; }

  const hits = data.hits || [];
  const nbHits = data.nbHits || 0;
  const nbPages = data.nbPages || 0;
  const currentPage = data.page || 0;

  console.log('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`  ${i + 1 + currentPage * limit}. ${h.title}`);
    if (h.url) console.log(`     ${h.url}`);
    console.log(`     by ${h.author} · ${formatNumber(h.points)} pts · ${formatNumber(h.num_comments)} comments · ${formatDate(h.created_at)}`);
    console.log(`     ID: ${h.objectID}`);
    console.log('');
  }

  console.log(`${formatNumber(nbHits)} results. Page ${currentPage + 1}/${nbPages}.${currentPage + 1 < nbPages ? ` Next page: --page=${currentPage + 1}` : ''}`);

  const cacheFile = resolve(CACHE_DIR, `stories-${slug(query)}-${page}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'stories', query, sort, limit, page: currentPage, hits, nbHits, nbPages });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Search comments
// ---------------------------------------------------------------------------

async function searchComments(query, flags) {
  const sort = flags.sort || 'relevance';
  const limit = Math.min(Math.max(parseInt(flags.limit || '20', 10), 1), 1000);
  const page = Math.max(parseInt(flags.page || '0', 10), 0);
  const minPoints = parseInt(flags.points || '0', 10);
  const time = flags.time || '';

  const endpoint = sort === 'date' ? '/search_by_date' : '/search';
  const params = new URLSearchParams({ query, tags: 'comment', hitsPerPage: String(limit), page: String(page) });

  const numericFilters = [];
  if (minPoints > 0) numericFilters.push(`points>${minPoints}`);
  if (time) {
    const ts = timeToUnix(time);
    if (ts > 0) numericFilters.push(`created_at_i>${ts}`);
  }
  if (numericFilters.length) params.set('numericFilters', numericFilters.join(','));

  console.log(`Searching comments for "${query}" (${sort})...`);

  const { status, ok, data } = await algoliaFetch(`${endpoint}?${params}`);
  if (!ok) { console.error(`API error (HTTP ${status})`); return; }

  const hits = data.hits || [];
  const nbHits = data.nbHits || 0;
  const nbPages = data.nbPages || 0;
  const currentPage = data.page || 0;

  console.log('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`  ${i + 1 + currentPage * limit}. ${preview(h.comment_text)}`);
    console.log(`     by ${h.author} · on "${h.story_title || 'unknown'}" · ${formatDate(h.created_at)}`);
    console.log(`     Story: ${h.story_id || h.objectID}`);
    console.log('');
  }

  console.log(`${formatNumber(nbHits)} results. Page ${currentPage + 1}/${nbPages}.${currentPage + 1 < nbPages ? ` Next page: --page=${currentPage + 1}` : ''}`);

  const cacheFile = resolve(CACHE_DIR, `comments-${slug(query)}-${page}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'comments', query, sort, limit, page: currentPage, hits, nbHits, nbPages });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Author activity
// ---------------------------------------------------------------------------

async function searchAuthor(name, flags) {
  const type = flags.type || '';
  const limit = Math.min(Math.max(parseInt(flags.limit || '20', 10), 1), 1000);
  const page = Math.max(parseInt(flags.page || '0', 10), 0);
  const minPoints = parseInt(flags.points || '0', 10);

  let tags = `author_${name}`;
  if (type === 'story') tags += ',story';
  else if (type === 'comment') tags += ',comment';

  const params = new URLSearchParams({ tags, hitsPerPage: String(limit), page: String(page) });

  const numericFilters = [];
  if (minPoints > 0) numericFilters.push(`points>${minPoints}`);
  if (numericFilters.length) params.set('numericFilters', numericFilters.join(','));

  console.log(`Fetching activity for "${name}"${type ? ` (${type}s only)` : ''}...`);

  const { status, ok, data } = await algoliaFetch(`/search_by_date?${params}`);
  if (!ok) { console.error(`API error (HTTP ${status})`); return; }

  const hits = data.hits || [];
  const nbHits = data.nbHits || 0;
  const nbPages = data.nbPages || 0;
  const currentPage = data.page || 0;

  console.log('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const itemTags = h._tags || [];
    const isStory = itemTags.includes('story');

    if (isStory) {
      console.log(`  ${i + 1 + currentPage * limit}. [story] ${h.title}`);
      if (h.url) console.log(`     ${h.url}`);
      console.log(`     ${formatNumber(h.points)} pts · ${formatNumber(h.num_comments)} comments · ${formatDate(h.created_at)}`);
      console.log(`     ID: ${h.objectID}`);
    } else {
      console.log(`  ${i + 1 + currentPage * limit}. [comment] ${preview(h.comment_text)}`);
      console.log(`     on "${h.story_title || 'unknown'}" · ${formatDate(h.created_at)}`);
      console.log(`     Story: ${h.story_id || h.objectID}`);
    }
    console.log('');
  }

  console.log(`${formatNumber(nbHits)} results. Page ${currentPage + 1}/${nbPages}.${currentPage + 1 < nbPages ? ` Next page: --page=${currentPage + 1}` : ''}`);

  const cacheFile = resolve(CACHE_DIR, `author-${slug(name)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'author', name, type, limit, page: currentPage, hits, nbHits, nbPages });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Front page for a date
// ---------------------------------------------------------------------------

async function searchFront(dateStr) {
  let targetDate;
  if (dateStr) {
    targetDate = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(targetDate.getTime())) {
      console.error(`Invalid date: ${dateStr}. Use YYYY-MM-DD format.`);
      process.exit(1);
    }
  } else {
    targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() - 1);
    targetDate.setUTCHours(0, 0, 0, 0);
  }

  const dateLabel = targetDate.toISOString().slice(0, 10);
  const startUnix = Math.floor(targetDate.getTime() / 1000);
  const endUnix = startUnix + 86400;

  const params = new URLSearchParams({
    tags: 'front_page',
    numericFilters: `created_at_i>${startUnix},created_at_i<${endUnix}`,
    hitsPerPage: '30',
  });

  console.log(`Fetching front page for ${dateLabel}...`);

  const { status, ok, data } = await algoliaFetch(`/search?${params}`);
  if (!ok) { console.error(`API error (HTTP ${status})`); return; }

  const hits = data.hits || [];

  console.log('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`  ${i + 1}. ${h.title}`);
    if (h.url) console.log(`     ${h.url}`);
    console.log(`     by ${h.author} · ${formatNumber(h.points)} pts · ${formatNumber(h.num_comments)} comments · ${formatDate(h.created_at)}`);
    console.log(`     ID: ${h.objectID}`);
    console.log('');
  }

  console.log(`${hits.length} front page stories for ${dateLabel}.`);

  const cacheFile = resolve(CACHE_DIR, `front-${dateLabel}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'front', date: dateLabel, hits });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] || '';
const { flags, positional } = parseFlags(args.slice(1));

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'stories': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: hackernews-search.mjs stories <query> [--sort=relevance|date] [--limit=20] [--page=0] [--points=N] [--time=day|week|month|year]'); process.exit(1); }
      await searchStories(query, flags);
      break;
    }

    case 'comments': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: hackernews-search.mjs comments <query> [--sort=relevance|date] [--limit=20] [--page=0] [--points=N] [--time=day|week|month|year]'); process.exit(1); }
      await searchComments(query, flags);
      break;
    }

    case 'author': {
      const name = positional[0] || '';
      if (!name) { console.error('Usage: hackernews-search.mjs author <username> [--type=story|comment] [--limit=20] [--page=0] [--points=N]'); process.exit(1); }
      await searchAuthor(name, flags);
      break;
    }

    case 'front': {
      const dateArg = positional[0] || '';
      await searchFront(dateArg);
      break;
    }

    default: {
      const script = 'hackernews-search.mjs';
      console.log(`
hackernews-search — Search Hacker News via Algolia API

Setup (optional, for HN cookie extraction):
  node ${script} auth                                   Extract cookies from Chrome

Commands:
  node ${script} stories <query>                        Search stories by relevance
       [--sort=relevance|date] [--limit=20] [--page=0]
       [--points=N] [--time=day|week|month|year]
  node ${script} comments <query>                       Search comments
       [--sort=relevance|date] [--limit=20] [--page=0]
       [--points=N] [--time=day|week|month|year]
  node ${script} author <username>                      All activity by a user
       [--type=story|comment] [--limit=20] [--page=0] [--points=N]
  node ${script} front [YYYY-MM-DD]                     Front page stories for a date

Examples:
  node ${script} stories startup --sort=date --limit=10
  node ${script} stories "machine learning" --points=100 --time=month
  node ${script} comments "best framework" --sort=date
  node ${script} author pg --type=story
  node ${script} front 2024-01-15
  node ${script} front

Notes:
  All commands use the public Algolia HN Search API. No auth required.
  Auth is only needed if you want to extract HN cookies for other tools.

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
