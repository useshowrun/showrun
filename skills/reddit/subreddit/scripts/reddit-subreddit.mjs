#!/usr/bin/env node
// reddit-subreddit.mjs — Subreddit info, rules, wiki, moderators, and subscriptions
//
// Setup (one-time, requires Chrome with reddit.com open):
//   node reddit-subreddit.mjs auth
//
// Commands:
//   node reddit-subreddit.mjs about <name>                     Subreddit metadata
//   node reddit-subreddit.mjs rules <name>                     Subreddit rules
//   node reddit-subreddit.mjs wiki <name> [page]               Wiki page (default: index)
//   node reddit-subreddit.mjs moderators <name>                Moderator list
//   node reddit-subreddit.mjs search <query> [--limit=10]      Search/autocomplete subreddits
//   node reddit-subreddit.mjs subscribe <name>                 Subscribe to subreddit (auth)
//   node reddit-subreddit.mjs unsubscribe <name>               Unsubscribe from subreddit (auth)
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/reddit-subreddit');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome Reddit tab
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
    extractedAt: new Date().toISOString()
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node reddit-subreddit.mjs auth');
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

async function apiFetch(url, auth = getAuth()) {
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

function getBearerToken(auth) {
  if (!auth.bearerToken) {
    throw new Error('No bearer token. Re-run: node reddit-subreddit.mjs auth');
  }
  return auth.bearerToken;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtNum(n) {
  if (n == null) return '?';
  return Number(n).toLocaleString('en-US');
}

function fmtDate(utc) {
  if (!utc) return '?';
  const d = new Date(utc * 1000);
  return d.toISOString().split('T')[0];
}

function slug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function handleError(res, name) {
  if (res.status === 404) {
    console.error(`Subreddit r/${name} not found (404).`);
    process.exit(1);
  }
  if (res.status === 403) {
    console.error(`Subreddit r/${name} is private or quarantined (403).`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Request failed (HTTP ${res.status}).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI flag parsing
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

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function cmdAbout(name) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json?raw_json=1`;
  const res = await apiFetch(url);
  handleError(res, name);

  const d = res.data?.data || res.data;
  const cacheFile = resolve(CACHE_DIR, `about-${name}.json`);
  saveJson(cacheFile, res.data);

  console.log(`r/${d.display_name || name}`);
  if (d.title) console.log(`  ${d.title}`);
  if (d.public_description) console.log(`  ${d.public_description}`);
  console.log(`  ${fmtNum(d.subscribers)} subscribers | ${fmtNum(d.active_user_count)} online`);
  console.log(`  Created: ${fmtDate(d.created_utc)} | Type: ${d.subreddit_type || '?'} | NSFW: ${d.over18 ? 'yes' : 'no'}`);
  if (d.lang) console.log(`  Language: ${d.lang}`);
  if (d.url) console.log(`  URL: https://www.reddit.com${d.url}`);
  if (d.icon_img) console.log(`  Icon: ${d.icon_img}`);
  if (d.banner_img) console.log(`  Banner: ${d.banner_img}`);
  if (d.community_icon) console.log(`  Community icon: ${d.community_icon}`);
  console.log(`\n  Saved to: ${cacheFile}`);
}

async function cmdRules(name) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/about/rules.json?raw_json=1`;
  const res = await apiFetch(url);
  handleError(res, name);

  const rules = res.data?.rules || [];
  const cacheFile = resolve(CACHE_DIR, `rules-${name}.json`);
  saveJson(cacheFile, res.data);

  console.log(`r/${name} rules (${rules.length}):\n`);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    console.log(`  ${i + 1}. ${r.short_name || 'Untitled'}`);
    if (r.description) {
      const desc = r.description.length > 200 ? r.description.substring(0, 200) + '...' : r.description;
      console.log(`     ${desc}`);
    }
    const parts = [];
    if (r.kind) parts.push(`Applies to: ${r.kind}`);
    if (r.violation_reason) parts.push(`Violation: ${r.violation_reason}`);
    if (parts.length) console.log(`     ${parts.join(' | ')}`);
    console.log('');
  }
  if (rules.length === 0) console.log('  No rules defined.\n');
  console.log(`  Saved to: ${cacheFile}`);
}

async function cmdWiki(name, page = 'index') {
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/wiki/${encodeURIComponent(page)}.json?raw_json=1`;
  const res = await apiFetch(url);
  handleError(res, name);

  const d = res.data?.data || res.data;
  const cacheFile = resolve(CACHE_DIR, `wiki-${name}-${page}.json`);
  saveJson(cacheFile, res.data);

  console.log(`r/${name}/wiki/${page}\n`);

  if (d.revision_by?.data?.name) console.log(`  Last edited by: u/${d.revision_by.data.name}`);
  if (d.revision_date) console.log(`  Revision date: ${fmtDate(d.revision_date)}`);
  console.log('');

  const content = d.content_md || '';
  if (content.length > 2000) {
    console.log(content.substring(0, 2000));
    console.log(`\n  ... (truncated, ${fmtNum(content.length)} chars total)`);
  } else if (content) {
    console.log(content);
  } else {
    console.log('  (empty wiki page)');
  }
  console.log(`\n  Saved to: ${cacheFile}`);
}

async function cmdModerators(name) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/about/moderators.json?raw_json=1`;
  const res = await apiFetch(url);
  handleError(res, name);

  const children = res.data?.data?.children || [];
  const cacheFile = resolve(CACHE_DIR, `moderators-${name}.json`);
  saveJson(cacheFile, res.data);

  console.log(`r/${name} moderators (${children.length}):\n`);
  for (const mod of children) {
    const perms = (mod.mod_permissions || []).join(', ') || 'none';
    const since = mod.date ? fmtDate(mod.date) : '?';
    console.log(`  u/${mod.name}  (since ${since})`);
    console.log(`    Permissions: ${perms}`);
    console.log('');
  }
  if (children.length === 0) console.log('  No moderators listed.\n');
  console.log(`  Saved to: ${cacheFile}`);
}

async function cmdSearch(query, flags) {
  const limit = parseInt(flags.limit || '10', 10);
  let url, cacheKey;

  if (limit > 10) {
    // Full search with limit control
    url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&type=sr&limit=${limit}&raw_json=1`;
    cacheKey = `search-${slug(query)}-full`;
  } else {
    // Autocomplete for quick lookups
    url = `https://www.reddit.com/api/subreddit_autocomplete_v2.json?query=${encodeURIComponent(query)}&include_over_18=false&raw_json=1`;
    cacheKey = `search-${slug(query)}`;
  }

  const res = await apiFetch(url);
  if (!res.ok) {
    console.error(`Search failed (HTTP ${res.status}).`);
    process.exit(1);
  }

  const children = res.data?.data?.children || [];
  const cacheFile = resolve(CACHE_DIR, `${cacheKey}.json`);
  saveJson(cacheFile, res.data);

  console.log(`Subreddit search: "${query}" (${children.length} results)\n`);
  for (const item of children) {
    const d = item.data || item;
    console.log(`  r/${d.display_name || d.name || '?'}`);
    if (d.subscribers != null) console.log(`    ${fmtNum(d.subscribers)} subscribers`);
    if (d.public_description) {
      const desc = d.public_description.length > 120 ? d.public_description.substring(0, 120) + '...' : d.public_description;
      console.log(`    ${desc}`);
    }
    console.log('');
  }
  if (children.length === 0) console.log('  No subreddits found.\n');
  console.log(`  Saved to: ${cacheFile}`);
}

async function cmdSubscribe(name) {
  const auth = getAuth();
  const token = await getBearerToken(auth);
  if (!token) throw new Error('Failed to obtain bearer token. Re-run: node reddit-subreddit.mjs auth');

  const resp = await fetch('https://oauth.reddit.com/api/subscribe', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'cookie': auth.cookie,
    },
    body: `action=sub&sr_name=${encodeURIComponent(name)}`,
  });

  if (resp.status === 401 || resp.status === 403) {
    console.error(`Auth failed (HTTP ${resp.status}). Re-run: node reddit-subreddit.mjs auth`);
    process.exit(1);
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Subscribe failed (HTTP ${resp.status}): ${text.substring(0, 200)}`);
    process.exit(1);
  }

  console.log(`Subscribed to r/${name}`);
}

async function cmdUnsubscribe(name) {
  const auth = getAuth();
  const token = await getBearerToken(auth);
  if (!token) throw new Error('Failed to obtain bearer token. Re-run: node reddit-subreddit.mjs auth');

  const resp = await fetch('https://oauth.reddit.com/api/subscribe', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'cookie': auth.cookie,
    },
    body: `action=unsub&sr_name=${encodeURIComponent(name)}`,
  });

  if (resp.status === 401 || resp.status === 403) {
    console.error(`Auth failed (HTTP ${resp.status}). Re-run: node reddit-subreddit.mjs auth`);
    process.exit(1);
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Unsubscribe failed (HTTP ${resp.status}): ${text.substring(0, 200)}`);
    process.exit(1);
  }

  console.log(`Unsubscribed from r/${name}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { flags, positional } = parseFlags(process.argv.slice(2));
const [command, ...rest] = positional;

switch (command) {
  case 'auth':
    await doAuth();
    break;

  case 'about': {
    const name = rest[0];
    if (!name) { console.error('Usage: node reddit-subreddit.mjs about <subreddit>'); process.exit(1); }
    await cmdAbout(name);
    break;
  }

  case 'rules': {
    const name = rest[0];
    if (!name) { console.error('Usage: node reddit-subreddit.mjs rules <subreddit>'); process.exit(1); }
    await cmdRules(name);
    break;
  }

  case 'wiki': {
    const name = rest[0];
    const page = rest[1] || 'index';
    if (!name) { console.error('Usage: node reddit-subreddit.mjs wiki <subreddit> [page]'); process.exit(1); }
    await cmdWiki(name, page);
    break;
  }

  case 'moderators': {
    const name = rest[0];
    if (!name) { console.error('Usage: node reddit-subreddit.mjs moderators <subreddit>'); process.exit(1); }
    await cmdModerators(name);
    break;
  }

  case 'search': {
    const query = rest[0];
    if (!query) { console.error('Usage: node reddit-subreddit.mjs search <query> [--limit=10]'); process.exit(1); }
    await cmdSearch(query, flags);
    break;
  }

  case 'subscribe': {
    const name = rest[0];
    if (!name) { console.error('Usage: node reddit-subreddit.mjs subscribe <subreddit>'); process.exit(1); }
    await cmdSubscribe(name);
    break;
  }

  case 'unsubscribe': {
    const name = rest[0];
    if (!name) { console.error('Usage: node reddit-subreddit.mjs unsubscribe <subreddit>'); process.exit(1); }
    await cmdUnsubscribe(name);
    break;
  }

  default:
    console.log(`reddit-subreddit — Subreddit info, rules, wiki, moderators, and subscriptions

Usage: node reddit-subreddit.mjs <command> [args] [flags]

Commands:
  auth                          Extract Reddit cookies from Chrome (one-time)
  about <name>                  Subreddit metadata (subscribers, description, etc.)
  rules <name>                  Subreddit rules
  wiki <name> [page]            Wiki page (default: index)
  moderators <name>             Moderator list
  search <query> [--limit=10]   Search/autocomplete subreddits
  subscribe <name>              Subscribe to subreddit (requires auth)
  unsubscribe <name>            Unsubscribe from subreddit (requires auth)

Read commands (about, rules, wiki, moderators, search) work without auth.
Only subscribe/unsubscribe require auth.

Examples:
  node reddit-subreddit.mjs about programming
  node reddit-subreddit.mjs rules AskReddit
  node reddit-subreddit.mjs wiki python faq
  node reddit-subreddit.mjs moderators linux
  node reddit-subreddit.mjs search "machine learning" --limit=20
  node reddit-subreddit.mjs subscribe programming
  node reddit-subreddit.mjs unsubscribe funny`);
    break;
}
