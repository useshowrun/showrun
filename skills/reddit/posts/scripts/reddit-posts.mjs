#!/usr/bin/env node
// reddit-posts.mjs — Browse Reddit feeds, view posts, vote, save, and comment
//
// Setup (one-time, for authenticated commands):
//   node reddit-posts.mjs auth
//
// Commands:
//   node reddit-posts.mjs home [--sort=hot] [--time=all] [--limit=25] [--after=cursor] [--sr-detail]
//   node reddit-posts.mjs popular [--sort=hot] [--time=all] [--limit=25] [--after=cursor]
//   node reddit-posts.mjs all [--sort=hot] [--time=all] [--limit=25] [--after=cursor]
//   node reddit-posts.mjs sub <name> [--sort=hot] [--time=all] [--limit=25] [--after=cursor]
//   node reddit-posts.mjs best [--limit=25] [--after=cursor]
//   node reddit-posts.mjs view <url|post_id> [--sort=best] [--limit=25] [--depth=3]
//   node reddit-posts.mjs comments <url|post_id> [--sort=best] [--limit=25] [--depth=3]
//   node reddit-posts.mjs vote <id> <up|down|unvote>
//   node reddit-posts.mjs save <id>
//   node reddit-posts.mjs unsave <id>
//   node reddit-posts.mjs comment <parent_id> <text>
//
// Requires Node 22+ (built-in fetch). Feed commands work without auth.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/reddit-posts');
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
// Auth: extract cookies + bearer token + modhash from Chrome Reddit tab
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
    console.error('No auth found. Run: node reddit-posts.mjs auth');
    process.exit(1);
  }
  return auth;
}

function getOptionalAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Reddit requires session cookies for all API access.');
    console.error('Run: node reddit-posts.mjs auth');
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

function oauthHeaders(auth) {
  return {
    'accept': 'application/json',
    'user-agent': UA,
    'cookie': auth.cookie,
    ...(auth.bearerToken ? { 'authorization': `Bearer ${auth.bearerToken}` } : {}),
  };
}

async function apiFetch(url, auth = null) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 429) console.error('Rate limited. Slow down requests.');
  return { status: resp.status, ok: resp.ok, data };
}

async function oauthFetch(url, auth, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...oauthHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node reddit-posts.mjs auth');
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Utility helpers
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
  return new Date(utc * 1000).toISOString().split('T')[0];
}

function formatNumber(n) {
  return n?.toLocaleString('en-US') || '0';
}

function preview(text, maxLen = 150) {
  if (!text) return '';
  const clean = text.replace(/\n+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

function parsePostInput(input) {
  // Accept: full URL, /r/sub/comments/id/..., t3_xxx, or just xxx
  const urlMatch = input.match(/\/comments\/([a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  const fullnameMatch = input.match(/^t3_([a-z0-9]+)$/i);
  if (fullnameMatch) return fullnameMatch[1];
  return input; // assume raw ID
}

function ensureFullname(id, prefix = 't3_') {
  if (id.startsWith('t1_') || id.startsWith('t3_') || id.startsWith('t5_')) return id;
  return prefix + id;
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

function renderFeedPost(d) {
  console.log(`  [${formatDate(d.created_utc)}] ${d.title}`);
  console.log(`    u/${d.author} · r/${d.subreddit} · ${formatNumber(d.score)} pts · ${formatNumber(d.num_comments)} comments`);
  console.log(`    https://reddit.com${d.permalink}`);
  if (d.url && !d.is_self && !d.url.includes(d.permalink)) {
    console.log(`    ${d.url}`);
  }
  if (d.selftext) {
    console.log(`    ${preview(d.selftext)}`);
  }
  console.log();
}

function renderComments(children, depth = 0, maxDepth = 3) {
  if (!children || depth >= maxDepth) return;
  for (const child of children) {
    if (child.kind !== 't1') continue;
    const c = child.data;
    const indent = '  '.repeat(depth + 1);
    const body = (c.body || '').replace(/\n/g, ' ').substring(0, 120);
    console.log(`${indent}${c.author} · ${formatNumber(c.score)} pts · ${formatDate(c.created_utc)}`);
    console.log(`${indent}  ${body}${c.body?.length > 120 ? '...' : ''}`);
    console.log();
    if (c.replies?.data?.children) {
      renderComments(c.replies.data.children, depth + 1, maxDepth);
    }
  }
}

// ---------------------------------------------------------------------------
// API: Feed commands (home, popular, all, sub)
// ---------------------------------------------------------------------------

async function fetchFeed(label, basePath, flags) {
  const sort = flags.sort || 'hot';
  const time = flags.time || 'all';
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const srDetail = flags['sr-detail'] === 'true' ? 'true' : '';
  const auth = getOptionalAuth();

  const params = new URLSearchParams({
    sort,
    t: time,
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);
  if (srDetail) params.set('sr_detail', 'true');

  const url = `https://www.reddit.com${basePath || ''}/.json?${params}`;
  console.log(`Fetching ${label} (${sort})...`);

  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nReddit — ${label} (${sort}) — ${children.length} posts\n`);

  for (const child of children) {
    renderFeedPost(child.data);
  }

  if (afterCursor) {
    console.log(`${children.length} results. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }

  const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const cacheFile = resolve(CACHE_DIR, `${slug}-${sort}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: label,
    sort,
    time,
    limit,
    results: children.map(c => c.data),
    after: afterCursor,
  });
  console.log(`Saved to: ${cacheFile}`);
}

async function fetchHome(flags) {
  await fetchFeed('home', '', flags);
}

async function fetchPopular(flags) {
  await fetchFeed('popular', '/r/popular', flags);
}

async function fetchAll(flags) {
  await fetchFeed('all', '/r/all', flags);
}

async function fetchSub(name, flags) {
  const sort = flags.sort || 'hot';
  const time = flags.time || 'all';
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const auth = getOptionalAuth();

  // Use sort-specific URL path
  const params = new URLSearchParams({
    t: time,
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/${sort}.json?${params}`;
  console.log(`Fetching r/${name} (${sort})...`);

  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nReddit — r/${name} (${sort}) — ${children.length} posts\n`);

  for (const child of children) {
    renderFeedPost(child.data);
  }

  if (afterCursor) {
    console.log(`${children.length} results. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `sub-${name}-${sort}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'sub',
    subreddit: name,
    sort,
    time,
    limit,
    results: children.map(c => c.data),
    after: afterCursor,
  });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Best (auth required)
// ---------------------------------------------------------------------------

async function fetchBest(flags) {
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';
  const auth = getAuth();

  const params = new URLSearchParams({
    limit: String(limit),
    raw_json: '1',
  });
  if (after) params.set('after', after);

  const url = `https://oauth.reddit.com/best?${params}`;
  console.log('Fetching best posts...');

  const { status, ok, data } = await oauthFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nReddit — best — ${children.length} posts\n`);

  for (const child of children) {
    renderFeedPost(child.data);
  }

  if (afterCursor) {
    console.log(`${children.length} results. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} results. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `best-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'best',
    limit,
    results: children.map(c => c.data),
    after: afterCursor,
  });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: View post with comments
// ---------------------------------------------------------------------------

async function viewPost(input, flags) {
  const id = parsePostInput(input);
  const sort = flags.sort || 'best';
  const limit = flags.limit || '';
  const maxDepth = parseInt(flags.depth || '3', 10);
  const auth = getOptionalAuth();

  const params = new URLSearchParams({ raw_json: '1', sort });
  if (limit) params.set('limit', limit);

  const url = `https://www.reddit.com/comments/${id}.json?${params}`;
  console.log(`Fetching post ${id}...`);

  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  if (!Array.isArray(data) || data.length < 2) {
    console.error('Unexpected response format.');
    return;
  }

  // Post info
  const post = data[0]?.data?.children?.[0]?.data;
  if (!post) {
    console.error('Post not found.');
    return;
  }

  const upvoteRatio = post.upvote_ratio ? `${Math.round(post.upvote_ratio * 100)}% upvoted` : '';

  console.log();
  console.log(`[${formatDate(post.created_utc)}] ${post.title}`);
  console.log(`  u/${post.author} · r/${post.subreddit} · ${formatNumber(post.score)} pts · ${formatNumber(post.num_comments)} comments${upvoteRatio ? ` · ${upvoteRatio}` : ''}`);
  console.log(`  https://reddit.com${post.permalink}`);
  if (post.url && !post.is_self && !post.url.includes(post.permalink)) {
    console.log(`  ${post.url}`);
  }
  if (post.selftext) {
    console.log();
    console.log(`  ${post.selftext.replace(/\n/g, '\n  ')}`);
  }
  console.log();

  // Comments
  const comments = data[1]?.data?.children || [];
  if (comments.length > 0) {
    console.log(`  Comments (showing top ${maxDepth} levels):\n`);
    renderComments(comments, 0, maxDepth);
  } else {
    console.log('  No comments yet.');
  }

  const cacheFile = resolve(CACHE_DIR, `post-${id}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'view',
    postId: id,
    sort,
    post,
    comments: comments.filter(c => c.kind === 't1').map(c => c.data),
  });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Comments only
// ---------------------------------------------------------------------------

async function viewComments(input, flags) {
  const id = parsePostInput(input);
  const sort = flags.sort || 'best';
  const limit = flags.limit || '';
  const maxDepth = parseInt(flags.depth || '3', 10);
  const auth = getOptionalAuth();

  const params = new URLSearchParams({ raw_json: '1', sort });
  if (limit) params.set('limit', limit);

  const url = `https://www.reddit.com/comments/${id}.json?${params}`;
  console.log(`Fetching comments for post ${id}...`);

  const { status, ok, data } = await apiFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  if (!Array.isArray(data) || data.length < 2) {
    console.error('Unexpected response format.');
    return;
  }

  const post = data[0]?.data?.children?.[0]?.data;
  const comments = data[1]?.data?.children || [];

  console.log(`\nComments for: ${post?.title || id} (${sort})\n`);

  if (comments.length > 0) {
    renderComments(comments, 0, maxDepth);
  } else {
    console.log('  No comments yet.');
  }

  const cacheFile = resolve(CACHE_DIR, `comments-${id}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'comments',
    postId: id,
    sort,
    comments: comments.filter(c => c.kind === 't1').map(c => c.data),
  });
  console.log(`Saved to: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Vote (auth required)
// ---------------------------------------------------------------------------

async function vote(id, direction) {
  const auth = getAuth();
  const fullname = ensureFullname(id);
  const dirMap = { up: 1, down: -1, unvote: 0 };
  const dir = dirMap[direction];

  if (dir === undefined) {
    console.error('Direction must be: up, down, or unvote');
    process.exit(1);
  }

  console.log(`Voting ${direction} on ${fullname}...`);

  const body = new URLSearchParams({ id: fullname, dir: String(dir) });
  const { status, ok, data } = await oauthFetch('https://oauth.reddit.com/api/vote', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    console.error(`Vote failed (HTTP ${status})`);
    return;
  }

  console.log(`Voted ${direction} on ${fullname}`);
}

// ---------------------------------------------------------------------------
// API: Save (auth required)
// ---------------------------------------------------------------------------

async function savePost(id) {
  const auth = getAuth();
  const fullname = ensureFullname(id);

  console.log(`Saving ${fullname}...`);

  const body = new URLSearchParams({ id: fullname });
  const { status, ok } = await oauthFetch('https://oauth.reddit.com/api/save', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    console.error(`Save failed (HTTP ${status})`);
    return;
  }

  console.log(`Saved ${fullname}`);
}

// ---------------------------------------------------------------------------
// API: Unsave (auth required)
// ---------------------------------------------------------------------------

async function unsavePost(id) {
  const auth = getAuth();
  const fullname = ensureFullname(id);

  console.log(`Unsaving ${fullname}...`);

  const body = new URLSearchParams({ id: fullname });
  const { status, ok } = await oauthFetch('https://oauth.reddit.com/api/unsave', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    console.error(`Unsave failed (HTTP ${status})`);
    return;
  }

  console.log(`Unsaved ${fullname}`);
}

// ---------------------------------------------------------------------------
// API: Comment (auth required)
// ---------------------------------------------------------------------------

async function postComment(parentId, text) {
  const auth = getAuth();
  const fullname = ensureFullname(parentId);

  console.log(`Posting comment on ${fullname}...`);

  const body = new URLSearchParams({
    thing_id: fullname,
    text,
    api_type: 'json',
  });
  const { status, ok, data } = await oauthFetch('https://oauth.reddit.com/api/comment', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    console.error(`Comment failed (HTTP ${status})`);
    return;
  }

  const created = data?.json?.data?.things?.[0]?.data;
  if (created) {
    console.log(`Comment posted: ${created.name}`);
    if (created.permalink) console.log(`  https://reddit.com${created.permalink}`);
  } else {
    console.log('Comment posted.');
    const errors = data?.json?.errors;
    if (errors?.length) console.error('Errors:', errors);
  }
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

    case 'home': {
      await fetchHome(flags);
      break;
    }

    case 'popular': {
      await fetchPopular(flags);
      break;
    }

    case 'all': {
      await fetchAll(flags);
      break;
    }

    case 'sub': {
      const name = positional[0];
      if (!name) { console.error('Usage: reddit-posts.mjs sub <name> [--sort=hot|new|top|controversial|rising] [--time=all] [--limit=25] [--after=cursor]'); process.exit(1); }
      await fetchSub(name, flags);
      break;
    }

    case 'best': {
      await fetchBest(flags);
      break;
    }

    case 'view': {
      const input = positional[0];
      if (!input) { console.error('Usage: reddit-posts.mjs view <url|post_id> [--sort=best|top|new|controversial|old|qa] [--limit=N] [--depth=3]'); process.exit(1); }
      await viewPost(input, flags);
      break;
    }

    case 'comments': {
      const input = positional[0];
      if (!input) { console.error('Usage: reddit-posts.mjs comments <url|post_id> [--sort=best|top|new|controversial|old|qa] [--limit=N] [--depth=3]'); process.exit(1); }
      await viewComments(input, flags);
      break;
    }

    case 'vote': {
      const id = positional[0];
      const direction = positional[1];
      if (!id || !direction) { console.error('Usage: reddit-posts.mjs vote <id> <up|down|unvote>'); process.exit(1); }
      await vote(id, direction);
      break;
    }

    case 'save': {
      const id = positional[0];
      if (!id) { console.error('Usage: reddit-posts.mjs save <id>'); process.exit(1); }
      await savePost(id);
      break;
    }

    case 'unsave': {
      const id = positional[0];
      if (!id) { console.error('Usage: reddit-posts.mjs unsave <id>'); process.exit(1); }
      await unsavePost(id);
      break;
    }

    case 'comment': {
      const parentId = positional[0];
      const text = positional.slice(1).join(' ');
      if (!parentId || !text) { console.error('Usage: reddit-posts.mjs comment <parent_id> <text>'); process.exit(1); }
      await postComment(parentId, text);
      break;
    }

    default: {
      const script = 'reddit-posts.mjs';
      console.log(`
reddit-posts — Browse Reddit feeds, view posts, vote, save, and comment

Setup (one-time, for authenticated commands):
  node ${script} auth                                   Extract cookies + bearer token from Chrome

Browse feeds (no auth needed):
  node ${script} home                                   Homepage feed
       [--sort=hot|new|top|controversial|rising] [--time=hour|day|week|month|year|all]
       [--limit=25] [--after=cursor] [--sr-detail]
  node ${script} popular                                Popular posts
       [--sort=hot|new|top|controversial|rising] [--time=all] [--limit=25] [--after=cursor]
  node ${script} all                                    All posts
       [--sort=hot|new|top|controversial|rising] [--time=all] [--limit=25] [--after=cursor]
  node ${script} sub <name>                             Subreddit feed
       [--sort=hot|new|top|controversial|rising] [--time=all] [--limit=25] [--after=cursor]

View posts (no auth needed):
  node ${script} view <url|post_id>                     Full post with comment tree
       [--sort=best|top|new|controversial|old|qa] [--limit=N] [--depth=3]
  node ${script} comments <url|post_id>                 Comment tree only
       [--sort=best|top|new|controversial|old|qa] [--limit=N] [--depth=3]

Authenticated commands (auth required):
  node ${script} best                                   Best posts (personalized)
       [--limit=25] [--after=cursor]
  node ${script} vote <id> <up|down|unvote>             Vote on post or comment
  node ${script} save <id>                              Save post or comment
  node ${script} unsave <id>                            Unsave post or comment
  node ${script} comment <parent_id> <text>             Post a comment or reply

Examples:
  node ${script} home --sort=top --time=week --limit=10
  node ${script} sub programming --sort=top --time=month
  node ${script} view https://www.reddit.com/r/node/comments/abc123/some-slug/
  node ${script} view abc123 --depth=5
  node ${script} comments t3_abc123 --sort=top
  node ${script} vote t3_abc123 up
  node ${script} save t3_abc123
  node ${script} comment t3_abc123 "Great post!"
  node ${script} comment t1_def456 "Replying to your comment"

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
