#!/usr/bin/env node
// reddit-search.mjs — Search Reddit posts, comments, subreddits, and users
//
// Setup (optional, for personalized results):
//   node reddit-search.mjs auth
//
// Commands:
//   node reddit-search.mjs posts <query> [--sort=relevance] [--time=all] [--limit=25] [--after=cursor] [--sub=name]
//   node reddit-search.mjs comments <query> [--sort=relevance] [--time=all] [--limit=25] [--after=cursor] [--sub=name]
//   node reddit-search.mjs subreddits <query> [--limit=25] [--after=cursor]
//   node reddit-search.mjs users <query> [--limit=25] [--after=cursor]
//   node reddit-search.mjs all <query>
//   node reddit-search.mjs autocomplete <query>
//
// Requires Node 22+ (built-in fetch). All search endpoints work without auth.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/reddit-search');
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
// Auth: extract cookies from Chrome Reddit tab (optional)
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Reddit tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/r/', 'reddit.com']) {
    for (const line of list.split('\n')) {
      if (line.includes('reddit.com') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('reddit.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No Reddit tab found. Open Reddit in Chrome first.');

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.reddit.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('reddit.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const bearerToken = cookieMap['token_v2'] || '';
  if (bearerToken) {
    console.log('Bearer token extracted from token_v2 cookie.');
  }

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    csrfToken: cookieMap['csrf_token'] || '',
    bearerToken,
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
    console.error('No auth found. Run: node reddit-search.mjs auth');
    process.exit(1);
  }
  return auth;
}

function getOptionalAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Reddit requires session cookies for all API access.');
    console.error('Run: node reddit-search.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    ...(auth?.cookie ? { 'cookie': auth.cookie } : {}),
  };
}

async function apiFetch(url, auth = null) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 429) {
    const reset = resp.headers.get('x-ratelimit-reset');
    console.error(`Rate limited. Reset in ${reset || '?'}s. Slow down requests.`);
  }
  return { status: resp.status, ok: resp.ok, data, headers: Object.fromEntries(resp.headers) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

function formatDate(utc) {
  if (!utc) return 'unknown';
  return new Date(utc * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function slug(query) {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

function preview(text, maxLen = 200) {
  if (!text) return '';
  const clean = text.replace(/\n+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

// ---------------------------------------------------------------------------
// API: Search posts
// ---------------------------------------------------------------------------

async function searchPosts(query, flags) {
  const sort = flags.sort || 'relevance';
  const time = flags.time || 'all';
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const sub = flags.sub || '';
  const auth = getOptionalAuth();

  console.log(`Searching posts for "${query}"...`);

  const params = new URLSearchParams({
    q: query,
    type: 'link',
    sort,
    t: time,
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  let baseUrl;
  if (sub) {
    params.set('restrict_sr', 'on');
    baseUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`;
  } else {
    baseUrl = 'https://www.reddit.com/search.json';
  }

  const url = `${baseUrl}?${params}`;
  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\n--- Posts matching "${query}" (${children.length} results) ---\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  Title:      ${d.title}`);
    console.log(`  Author:     u/${d.author}`);
    console.log(`  Subreddit:  r/${d.subreddit}`);
    console.log(`  Score:      ${d.score}  |  Comments: ${d.num_comments}`);
    console.log(`  Created:    ${formatDate(d.created_utc)}`);
    console.log(`  Link:       https://www.reddit.com${d.permalink}`);
    if (d.url && !d.url.includes(d.permalink)) {
      console.log(`  URL:        ${d.url}`);
    }
    if (d.selftext) {
      console.log(`  Preview:    ${preview(d.selftext)}`);
    }
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} results shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `search-posts-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'posts', query, sort, time, limit, sub, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Search comments
// ---------------------------------------------------------------------------

async function searchComments(query, flags) {
  const sort = flags.sort || 'relevance';
  const time = flags.time || 'all';
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const sub = flags.sub || '';
  const auth = getOptionalAuth();

  console.log(`Searching comments for "${query}"...`);

  const params = new URLSearchParams({
    q: query,
    type: 'comment',
    sort,
    t: time,
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  let baseUrl;
  if (sub) {
    params.set('restrict_sr', 'on');
    baseUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`;
  } else {
    baseUrl = 'https://www.reddit.com/search.json';
  }

  const url = `${baseUrl}?${params}`;
  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\n--- Comments matching "${query}" (${children.length} results) ---\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  Body:       ${preview(d.body)}`);
    console.log(`  Author:     u/${d.author}`);
    console.log(`  Subreddit:  r/${d.subreddit}`);
    console.log(`  Score:      ${d.score}`);
    if (d.link_title) {
      console.log(`  Post:       ${d.link_title}`);
    }
    console.log(`  Created:    ${formatDate(d.created_utc)}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} results shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `search-comments-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'comments', query, sort, time, limit, sub, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Search subreddits
// ---------------------------------------------------------------------------

async function searchSubreddits(query, flags) {
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const auth = getOptionalAuth();

  console.log(`Searching subreddits for "${query}"...`);

  const params = new URLSearchParams({
    q: query,
    type: 'sr',
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  const url = `https://www.reddit.com/search.json?${params}`;
  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\n--- Subreddits matching "${query}" (${children.length} results) ---\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  Name:         r/${d.display_name}`);
    console.log(`  Subscribers:  ${(d.subscribers || 0).toLocaleString()}`);
    if (d.public_description) {
      console.log(`  Description:  ${preview(d.public_description, 150)}`);
    }
    console.log(`  Created:      ${formatDate(d.created_utc)}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} results shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `search-subreddits-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'subreddits', query, limit, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Search users
// ---------------------------------------------------------------------------

async function searchUsers(query, flags) {
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const auth = getOptionalAuth();

  console.log(`Searching users for "${query}"...`);

  const params = new URLSearchParams({
    q: query,
    type: 'user',
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  const url = `https://www.reddit.com/search.json?${params}`;
  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\n--- Users matching "${query}" (${children.length} results) ---\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  Name:           u/${d.name}`);
    console.log(`  Link karma:     ${(d.link_karma || 0).toLocaleString()}`);
    console.log(`  Comment karma:  ${(d.comment_karma || 0).toLocaleString()}`);
    console.log(`  Created:        ${formatDate(d.created_utc)}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} results shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `search-users-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'users', query, limit, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Search all (combined)
// ---------------------------------------------------------------------------

async function searchAll(query) {
  const auth = getOptionalAuth();

  console.log(`Searching everything for "${query}"...\n`);

  const miniFlags = { limit: '5' };

  await searchPosts(query, miniFlags);
  console.log('');
  await searchComments(query, miniFlags);
  console.log('');
  await searchSubreddits(query, miniFlags);
  console.log('');
  await searchUsers(query, miniFlags);

  console.log('\n--- Combined search complete. Use individual commands with --limit for more results. ---');
}

// ---------------------------------------------------------------------------
// API: Subreddit autocomplete
// ---------------------------------------------------------------------------

async function autocomplete(query) {
  const auth = getOptionalAuth();

  console.log(`Autocompleting subreddits for "${query}"...`);

  const params = new URLSearchParams({
    query,
    include_over_18: 'false',
    raw_json: '1',
  });

  const url = `https://www.reddit.com/api/subreddit_autocomplete_v2.json?${params}`;
  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];

  console.log(`\n--- Subreddit autocomplete for "${query}" (${children.length} results) ---\n`);

  for (const child of children) {
    const d = child.data;
    if (d.display_name) {
      console.log(`  r/${d.display_name}  (${(d.subscribers || 0).toLocaleString()} subscribers)`);
    }
  }
  console.log('');

  const cacheFile = resolve(CACHE_DIR, `autocomplete-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'autocomplete', query, results: children.map(c => c.data) });
  console.log(`Cached: ${cacheFile}`);
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

    case 'posts': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs posts <query> [--sort=relevance|top|new|comments] [--time=hour|day|week|month|year|all] [--limit=25] [--after=cursor] [--sub=name]'); process.exit(1); }
      await searchPosts(query, flags);
      break;
    }

    case 'comments': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs comments <query> [--sort=relevance|top|new|comments] [--time=hour|day|week|month|year|all] [--limit=25] [--after=cursor] [--sub=name]'); process.exit(1); }
      await searchComments(query, flags);
      break;
    }

    case 'subreddits': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs subreddits <query> [--limit=25] [--after=cursor]'); process.exit(1); }
      await searchSubreddits(query, flags);
      break;
    }

    case 'users': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs users <query> [--limit=25] [--after=cursor]'); process.exit(1); }
      await searchUsers(query, flags);
      break;
    }

    case 'all': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs all <query>'); process.exit(1); }
      await searchAll(query);
      break;
    }

    case 'autocomplete': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: reddit-search.mjs autocomplete <query>'); process.exit(1); }
      await autocomplete(query);
      break;
    }

    default: {
      const script = 'reddit-search.mjs';
      console.log(`
reddit-search — Search Reddit posts, comments, subreddits, and users

Setup (optional, for personalized results):
  node ${script} auth                                   Extract cookies from Chrome

Commands:
  node ${script} posts <query>                          Search posts
       [--sort=relevance|top|new|comments] [--time=hour|day|week|month|year|all]
       [--limit=25] [--after=cursor] [--sub=name]
  node ${script} comments <query>                       Search comments
       [--sort=relevance|top|new|comments] [--time=hour|day|week|month|year|all]
       [--limit=25] [--after=cursor] [--sub=name]
  node ${script} subreddits <query>                     Search subreddits
       [--limit=25] [--after=cursor]
  node ${script} users <query>                          Search users
       [--limit=25] [--after=cursor]
  node ${script} all <query>                            Search everything (5 per type)
  node ${script} autocomplete <query>                   Subreddit name autocomplete

Examples:
  node ${script} posts javascript --sort=top --time=week
  node ${script} posts "machine learning" --sub=programming --limit=10
  node ${script} comments "best framework" --sort=top --time=month
  node ${script} subreddits cooking
  node ${script} users spez
  node ${script} all "climate change"
  node ${script} autocomplete prog

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
