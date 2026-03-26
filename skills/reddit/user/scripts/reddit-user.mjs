#!/usr/bin/env node
// reddit-user.mjs — Reddit user profiles, posts, comments, trophies & account data from the terminal
//
// Setup (one-time, requires Chrome with Reddit open):
//   node reddit-user.mjs auth
//
// Public commands (no auth needed):
//   node reddit-user.mjs about <name>                        User profile
//   node reddit-user.mjs posts <name> [--sort=X] [--time=X]  User's posts
//   node reddit-user.mjs comments <name> [--sort=X]          User's comments
//   node reddit-user.mjs trophies <name>                     User's trophy case
//
// Authenticated commands:
//   node reddit-user.mjs me                                  Current user info
//   node reddit-user.mjs karma [--limit=N]                   Karma breakdown by subreddit
//   node reddit-user.mjs prefs                               User preferences
//   node reddit-user.mjs friends                             Friends list
//   node reddit-user.mjs subscriptions [--limit=N]           Subscribed subreddits
//   node reddit-user.mjs saved [--limit=N]                   Saved posts/comments
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/reddit-user');
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
// Auth: extract cookies + bearer token from Chrome Reddit tab
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

  const csrfToken = cookieMap['csrf_token'] || '';

  // Bearer token is the token_v2 cookie (RS256 JWT)
  const bearerToken = cookieMap['token_v2'] || '';
  if (bearerToken) {
    console.log('Bearer token extracted from token_v2 cookie.');
  } else {
    console.error('Warning: token_v2 cookie not found. OAuth endpoints will not work.');
  }

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    csrfToken,
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
    console.error('No auth found. Run: node reddit-user.mjs auth');
    process.exit(1);
  }
  return auth;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'user-agent': UA,
    ...(auth?.cookie ? { 'cookie': auth.cookie } : {}),
  };
}

// For oauth.reddit.com endpoints that need bearer
function oauthHeaders(auth) {
  return {
    'accept': 'application/json',
    'user-agent': UA,
    'cookie': auth.cookie,
    ...(auth.bearerToken ? { 'authorization': `Bearer ${auth.bearerToken}` } : {}),
  };
}

async function apiFetch(url, auth = getAuth()) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 429) {
    console.error('Rate limited. Slow down requests.');
  }
  return { status: resp.status, ok: resp.ok, data };
}

async function oauthFetch(url, auth) {
  const resp = await fetch(url, { headers: oauthHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 401 || resp.status === 403) {
    console.error('Session expired. Run: node reddit-user.mjs auth');
  }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function formatDate(utc) {
  return new Date(utc * 1000).toISOString().split('T')[0];
}

function formatNumber(n) {
  return n?.toLocaleString('en-US') || '0';
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 30);
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
// API functions
// ---------------------------------------------------------------------------

async function fetchAbout(name) {
  const url = `https://www.reddit.com/user/${encodeURIComponent(name)}/about.json?raw_json=1`;
  const result = await apiFetch(url);
  if (result.status === 404) throw new Error(`User u/${name} not found.`);
  if (result.status === 403) throw new Error(`User u/${name} is suspended or banned.`);
  if (!result.ok) throw new Error(`Failed to fetch profile (HTTP ${result.status})`);
  return result.data;
}

async function fetchPosts(name, { sort = 'new', time = 'all', limit = 25, after = '' } = {}) {
  const params = new URLSearchParams({ sort, t: time, limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);
  const url = `https://www.reddit.com/user/${encodeURIComponent(name)}/submitted.json?${params}`;
  const result = await apiFetch(url);
  if (result.status === 404) throw new Error(`User u/${name} not found.`);
  if (result.status === 403) throw new Error(`User u/${name} is suspended or banned.`);
  if (!result.ok) throw new Error(`Failed to fetch posts (HTTP ${result.status})`);
  return result.data;
}

async function fetchComments(name, { sort = 'new', time = 'all', limit = 25, after = '' } = {}) {
  const params = new URLSearchParams({ sort, t: time, limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);
  const url = `https://www.reddit.com/user/${encodeURIComponent(name)}/comments.json?${params}`;
  const result = await apiFetch(url);
  if (result.status === 404) throw new Error(`User u/${name} not found.`);
  if (result.status === 403) throw new Error(`User u/${name} is suspended or banned.`);
  if (!result.ok) throw new Error(`Failed to fetch comments (HTTP ${result.status})`);
  return result.data;
}

async function fetchTrophies(name) {
  const url = `https://www.reddit.com/user/${encodeURIComponent(name)}/trophies.json?raw_json=1`;
  const result = await apiFetch(url);
  if (result.status === 404) throw new Error(`User u/${name} not found.`);
  if (result.status === 403) throw new Error(`User u/${name} is suspended or banned.`);
  if (!result.ok) throw new Error(`Failed to fetch trophies (HTTP ${result.status})`);
  return result.data;
}

async function fetchMe(auth) {
  const url = 'https://oauth.reddit.com/api/v1/me?raw_json=1';
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch current user (HTTP ${result.status})`);
  return result.data;
}

async function fetchKarma(auth) {
  const url = 'https://oauth.reddit.com/api/v1/me/karma?raw_json=1';
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch karma breakdown (HTTP ${result.status})`);
  return result.data;
}

async function fetchPrefs(auth) {
  const url = 'https://oauth.reddit.com/api/v1/me/prefs?raw_json=1';
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch preferences (HTTP ${result.status})`);
  return result.data;
}

async function fetchFriends(auth) {
  const url = 'https://oauth.reddit.com/api/v1/me/friends?raw_json=1';
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch friends (HTTP ${result.status})`);
  return result.data;
}

async function fetchSubscriptions(auth, { limit = 25, after = '' } = {}) {
  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);
  const url = `https://oauth.reddit.com/subreddits/mine/subscriber?${params}`;
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch subscriptions (HTTP ${result.status})`);
  return result.data;
}

async function fetchSaved(auth, { limit = 25, after = '' } = {}) {
  // First get the current username
  const me = await fetchMe(auth);
  const username = me.name;
  if (!username) throw new Error('Could not determine current username.');
  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);
  const url = `https://oauth.reddit.com/user/${encodeURIComponent(username)}/saved.json?${params}`;
  const result = await oauthFetch(url, auth);
  if (!result.ok) throw new Error(`Failed to fetch saved items (HTTP ${result.status})`);
  return { username, ...result.data };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayAbout(data) {
  const d = data.data || data;
  const name = d.name || '(unknown)';
  const linkK = d.link_karma || 0;
  const commentK = d.comment_karma || 0;
  const totalK = d.total_karma || (linkK + commentK);
  const created = d.created_utc ? formatDate(d.created_utc) : '(unknown)';
  const verified = d.has_verified_email ? 'yes' : 'no';
  const gold = d.is_gold ? 'yes' : 'no';
  const mod = d.is_mod ? 'yes' : 'no';

  console.log(`\nu/${name}`);
  console.log(`  Total karma: ${formatNumber(totalK)} (link: ${formatNumber(linkK)} | comment: ${formatNumber(commentK)})`);
  console.log(`  Created: ${created} | Verified: ${verified} | Gold: ${gold} | Mod: ${mod}`);
  if (d.icon_img) console.log(`  Icon: ${d.icon_img.split('?')[0]}`);
  if (d.snoovatar_img) console.log(`  Snoovatar: ${d.snoovatar_img}`);
  if (d.subreddit?.display_name_prefixed) console.log(`  Profile sub: ${d.subreddit.display_name_prefixed}`);
  if (d.subreddit?.public_description) console.log(`  Bio: ${d.subreddit.public_description.substring(0, 200)}`);
}

function displayPosts(data, name) {
  const children = data?.data?.children || [];
  const after = data?.data?.after || null;

  console.log(`\nu/${name} -- ${children.length} posts\n`);

  for (const child of children) {
    const p = child.data;
    const date = p.created_utc ? formatDate(p.created_utc) : '(unknown)';
    const title = p.title || '(no title)';
    const sub = p.subreddit_name_prefixed || `r/${p.subreddit}`;
    const score = formatNumber(p.score);
    const comments = formatNumber(p.num_comments);
    const link = `https://reddit.com${p.permalink}`;

    console.log(`  [${date}] ${title}`);
    console.log(`    ${sub} · ${score} points · ${comments} comments`);
    console.log(`    ${link}\n`);
  }

  if (after) {
    console.log(`${children.length} results. Next page: --after=${after}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }
}

function displayComments(data, name) {
  const children = data?.data?.children || [];
  const after = data?.data?.after || null;

  console.log(`\nu/${name} -- ${children.length} comments\n`);

  for (const child of children) {
    const c = child.data;
    const date = c.created_utc ? formatDate(c.created_utc) : '(unknown)';
    const body = (c.body || '').replace(/\n/g, ' ').substring(0, 150);
    const sub = c.subreddit_name_prefixed || `r/${c.subreddit}`;
    const score = formatNumber(c.score);
    const linkTitle = c.link_title || '(unknown thread)';

    console.log(`  [${date}] ${body}${c.body && c.body.length > 150 ? '...' : ''}`);
    console.log(`    ${sub} · ${score} points · re: ${linkTitle}`);
    console.log();
  }

  if (after) {
    console.log(`${children.length} results. Next page: --after=${after}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }
}

function displayTrophies(data) {
  const trophies = data?.data?.trophies || [];
  console.log(`\n--- Trophy Case (${trophies.length} trophies) ---\n`);

  if (!trophies.length) {
    console.log('  (no trophies)');
    return;
  }

  for (const t of trophies) {
    const d = t.data || t;
    const name = d.name || '(unnamed)';
    const desc = d.description || '';
    const awardId = d.award_id || '';
    const granted = d.granted_at ? formatDate(d.granted_at) : '';

    let line = `  ${name}`;
    if (desc) line += ` -- ${desc}`;
    if (granted) line += ` (${granted})`;
    if (awardId) line += ` [${awardId}]`;
    console.log(line);
  }
}

function displayMe(data) {
  const name = data.name || '(unknown)';
  const totalK = data.total_karma || 0;
  const linkK = data.link_karma || 0;
  const commentK = data.comment_karma || 0;
  const created = data.created_utc ? formatDate(data.created_utc) : '(unknown)';
  const verified = data.has_verified_email ? 'yes' : 'no';
  const gold = data.is_gold ? 'yes' : 'no';
  const inbox = data.inbox_count || 0;
  const hasMail = data.has_mail ? 'yes' : 'no';
  const coins = data.coins || 0;

  console.log(`\nu/${name}`);
  console.log(`  Total karma: ${formatNumber(totalK)} (link: ${formatNumber(linkK)} | comment: ${formatNumber(commentK)})`);
  console.log(`  Created: ${created} | Verified: ${verified} | Gold: ${gold}`);
  console.log(`  Inbox: ${inbox} messages | Has mail: ${hasMail}`);
  console.log(`  Coins: ${formatNumber(coins)}`);
  if (data.icon_img) console.log(`  Icon: ${data.icon_img.split('?')[0]}`);
}

function displayKarma(data, limit) {
  const entries = data?.data || [];
  const sorted = [...entries].sort((a, b) => ((b.link_karma + b.comment_karma) - (a.link_karma + a.comment_karma)));
  const shown = sorted.slice(0, limit);

  console.log(`\n--- Karma Breakdown (top ${shown.length} of ${entries.length} subreddits) ---\n`);
  console.log(`  ${'Subreddit'.padEnd(30)} ${'Link'.padStart(10)} ${'Comment'.padStart(10)} ${'Total'.padStart(10)}`);
  console.log(`  ${''.padEnd(30, '-')} ${''.padEnd(10, '-')} ${''.padEnd(10, '-')} ${''.padEnd(10, '-')}`);

  for (const entry of shown) {
    const sr = (entry.sr || '(unknown)').substring(0, 30);
    const lk = formatNumber(entry.link_karma || 0);
    const ck = formatNumber(entry.comment_karma || 0);
    const total = formatNumber((entry.link_karma || 0) + (entry.comment_karma || 0));
    console.log(`  ${sr.padEnd(30)} ${lk.padStart(10)} ${ck.padStart(10)} ${total.padStart(10)}`);
  }
}

function displayPrefs(data) {
  console.log('\n--- User Preferences ---\n');
  const keys = [
    'over_18', 'email_messages', 'default_comment_sort', 'enable_followers',
    'hide_from_robots', 'show_link_flair', 'show_flair', 'nightmode',
    'lang', 'num_comments', 'min_comment_score', 'num_sites',
    'search_include_over_18', 'show_trending', 'show_presence',
    'mark_messages_read', 'live_orangereds', 'highlight_new_comments',
  ];
  for (const k of keys) {
    if (data[k] !== undefined) {
      console.log(`  ${k}: ${data[k]}`);
    }
  }
  // Show any other prefs not in the known list
  let extraCount = 0;
  for (const [k, v] of Object.entries(data)) {
    if (keys.includes(k)) continue;
    if (v === null || v === undefined) continue;
    extraCount++;
  }
  if (extraCount > 0) {
    console.log(`\n  ... and ${extraCount} more preferences (see cached JSON for full list)`);
  }
}

function displayFriends(data) {
  // Response may be { kind: "UserList", data: { children: [...] } } or array
  const children = data?.data?.children || (Array.isArray(data) ? data : []);

  console.log(`\n--- Friends (${children.length}) ---\n`);

  if (!children.length) {
    console.log('  (no friends found)');
    return;
  }

  for (const f of children) {
    const name = f.name || f.data?.name || '(unknown)';
    const date = f.date ? formatDate(f.date) : (f.data?.date ? formatDate(f.data.date) : '');
    let line = `  u/${name}`;
    if (date) line += ` (added: ${date})`;
    console.log(line);
  }
}

function displaySubscriptions(data) {
  const children = data?.data?.children || [];
  const after = data?.data?.after || null;

  console.log(`\n--- Subscribed Subreddits (${children.length}) ---\n`);

  for (const child of children) {
    const s = child.data || child;
    const name = s.display_name || s.display_name_prefixed || '(unknown)';
    const subs = formatNumber(s.subscribers || 0);
    const url = s.url || '';
    console.log(`  r/${name} -- ${subs} subscribers${url ? `  ${url}` : ''}`);
  }

  if (after) {
    console.log(`\n${children.length} results. Next page: --after=${after}`);
  } else {
    console.log(`\n${children.length} results. No more pages.`);
  }
}

function displaySaved(data) {
  const children = data?.data?.children || [];
  const after = data?.data?.after || null;
  const username = data.username || '(you)';

  console.log(`\nu/${username} -- ${children.length} saved items\n`);

  for (const child of children) {
    const d = child.data;
    const kind = child.kind === 't3' ? 'post' : child.kind === 't1' ? 'comment' : child.kind;
    const date = d.created_utc ? formatDate(d.created_utc) : '';
    const sub = d.subreddit_name_prefixed || `r/${d.subreddit}`;
    const score = formatNumber(d.score || 0);

    if (kind === 'post') {
      const title = d.title || '(no title)';
      console.log(`  [${kind}] [${date}] ${title}`);
      console.log(`    ${sub} · ${score} points`);
    } else if (kind === 'comment') {
      const body = (d.body || '').replace(/\n/g, ' ').substring(0, 150);
      const linkTitle = d.link_title || '(unknown thread)';
      console.log(`  [${kind}] [${date}] ${body}${d.body && d.body.length > 150 ? '...' : ''}`);
      console.log(`    ${sub} · ${score} points · re: ${linkTitle}`);
    } else {
      console.log(`  [${kind}] [${date}] ${JSON.stringify(d).substring(0, 120)}...`);
    }
    console.log();
  }

  if (after) {
    console.log(`${children.length} results. Next page: --after=${after}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'about': {
    const name = positional[0];
    if (!name) { console.error('Usage: node reddit-user.mjs about <username>'); process.exit(1); }
    console.log(`Fetching profile for u/${name}...`);
    const data = await fetchAbout(name);
    const outFile = resolve(CACHE_DIR, `about-${slug(name)}.json`);
    saveJson(outFile, data);
    displayAbout(data);
    console.log(`\n  Saved to: ${outFile}`);
    break;
  }

  case 'posts': {
    const name = positional[0];
    if (!name) { console.error('Usage: node reddit-user.mjs posts <username> [--sort=hot|new|top|controversial] [--time=hour|day|week|month|year|all] [--limit=N] [--after=cursor]'); process.exit(1); }
    const sort = flags.sort || 'new';
    const time = flags.time || 'all';
    const limit = parseInt(flags.limit || '25');
    const after = flags.after || '';
    console.log(`Fetching posts for u/${name} (sort=${sort}, time=${time}, limit=${limit})...`);
    const data = await fetchPosts(name, { sort, time, limit, after });
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `posts-${slug(name)}-${ts}.json`);
    saveJson(outFile, data);
    displayPosts(data, name);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'comments': {
    const name = positional[0];
    if (!name) { console.error('Usage: node reddit-user.mjs comments <username> [--sort=hot|new|top|controversial] [--time=hour|day|week|month|year|all] [--limit=N] [--after=cursor]'); process.exit(1); }
    const sort = flags.sort || 'new';
    const time = flags.time || 'all';
    const limit = parseInt(flags.limit || '25');
    const after = flags.after || '';
    console.log(`Fetching comments for u/${name} (sort=${sort}, time=${time}, limit=${limit})...`);
    const data = await fetchComments(name, { sort, time, limit, after });
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `comments-${slug(name)}-${ts}.json`);
    saveJson(outFile, data);
    displayComments(data, name);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'trophies': {
    const name = positional[0];
    if (!name) { console.error('Usage: node reddit-user.mjs trophies <username>'); process.exit(1); }
    console.log(`Fetching trophies for u/${name}...`);
    const data = await fetchTrophies(name);
    const outFile = resolve(CACHE_DIR, `trophies-${slug(name)}.json`);
    saveJson(outFile, data);
    displayTrophies(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'me': {
    const auth = getAuth();
    console.log('Fetching current user info...');
    const data = await fetchMe(auth);
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `me-${ts}.json`);
    saveJson(outFile, data);
    displayMe(data);
    console.log(`\n  Saved to: ${outFile}`);
    break;
  }

  case 'karma': {
    const auth = getAuth();
    if (!auth.bearerToken) {
      console.error('Bearer token required for karma breakdown. Run: node reddit-user.mjs auth');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '20');
    console.log('Fetching karma breakdown...');
    const data = await fetchKarma(auth);
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `karma-${ts}.json`);
    saveJson(outFile, data);
    displayKarma(data, limit);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'prefs': {
    const auth = getAuth();
    if (!auth.bearerToken) {
      console.error('Bearer token required for preferences. Run: node reddit-user.mjs auth');
      process.exit(1);
    }
    console.log('Fetching user preferences...');
    const data = await fetchPrefs(auth);
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `prefs-${ts}.json`);
    saveJson(outFile, data);
    displayPrefs(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'friends': {
    const auth = getAuth();
    if (!auth.bearerToken) {
      console.error('Bearer token required for friends list. Run: node reddit-user.mjs auth');
      process.exit(1);
    }
    console.log('Fetching friends list...');
    const data = await fetchFriends(auth);
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `friends-${ts}.json`);
    saveJson(outFile, data);
    displayFriends(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'subscriptions': {
    const auth = getAuth();
    if (!auth.bearerToken) {
      console.error('Bearer token required for subscriptions. Run: node reddit-user.mjs auth');
      process.exit(1);
    }
    const limit = Math.min(parseInt(flags.limit || '25'), 100);
    const after = flags.after || '';
    console.log(`Fetching subscribed subreddits (limit=${limit})...`);
    const data = await fetchSubscriptions(auth, { limit, after });
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `subscriptions-${ts}.json`);
    saveJson(outFile, data);
    displaySubscriptions(data);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'saved': {
    const auth = getAuth();
    if (!auth.bearerToken) {
      console.error('Bearer token required for saved items. Run: node reddit-user.mjs auth');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '25');
    const after = flags.after || '';
    console.log('Fetching saved items...');
    const data = await fetchSaved(auth, { limit, after });
    const ts = Date.now();
    const outFile = resolve(CACHE_DIR, `saved-${ts}.json`);
    saveJson(outFile, data);
    displaySaved(data);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  default:
    console.log(`reddit-user -- Reddit user profiles, posts, comments & account data

Commands (public, no auth needed):
  about <name>              User profile (karma, created date, verified status)
  posts <name>              User's submitted posts
  comments <name>           User's comments
  trophies <name>           User's trophy case

Commands (auth required):
  auth                      Authenticate via Chrome (one-time)
  me                        Current user info (cookies only)
  karma [--limit=N]         Karma breakdown by subreddit (bearer required)
  prefs                     User preferences (bearer required)
  friends                   Friends list (bearer required)
  subscriptions [--limit=N] Subscribed subreddits (bearer required)
  saved [--limit=N]         Saved posts/comments (bearer required)

Flags for posts/comments:
  --sort=hot|new|top|controversial
  --time=hour|day|week|month|year|all
  --limit=N                 Items per page (1-100)
  --after=cursor            Pagination cursor

Data: ${DATA_DIR}/
  session.json     Auth cookies + bearer token
  cache/           Cached API responses`);
}
