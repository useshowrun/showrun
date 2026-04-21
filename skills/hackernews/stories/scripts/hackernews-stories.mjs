#!/usr/bin/env node
// hackernews-stories.mjs — Browse HN feeds, view posts, vote, fave, comment, and submit
//
// Setup (for authenticated commands):
//   node hackernews-stories.mjs auth
//
// Commands (no auth):
//   node hackernews-stories.mjs top [--limit=20] [--offset=0]
//   node hackernews-stories.mjs new [--limit=20] [--offset=0]
//   node hackernews-stories.mjs best [--limit=20] [--offset=0]
//   node hackernews-stories.mjs ask [--limit=20] [--offset=0]
//   node hackernews-stories.mjs show [--limit=20] [--offset=0]
//   node hackernews-stories.mjs jobs [--limit=20] [--offset=0]
//   node hackernews-stories.mjs view <id> [--depth=3]
//
// Commands (auth required):
//   node hackernews-stories.mjs vote <id> <up|down|un>
//   node hackernews-stories.mjs fave <id> [--un]
//   node hackernews-stories.mjs comment <id> <text>
//   node hackernews-stories.mjs submit <title> --url=URL | --text=TEXT
//
// Requires Node 22+ (built-in fetch). Zero npm dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/hackernews-stories');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome HN tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Hacker News tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('news.ycombinator.com')) {
      target = line.trim().split(/\s+/)[0]; break;
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
  if (!username) console.error('Warning: Not logged in to HN. Auth commands will not work.');
  saveJson(SESSION_FILE, { cookie: cookieStr, username, extractedAt: new Date().toISOString() });
  console.log(`Auth saved (user: ${username || 'anonymous'}).`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const FIREBASE_BASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

async function firebaseFetch(path) {
  const resp = await fetch(`${FIREBASE_BASE}${path}`);
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

async function algoliaFetch(path) {
  const resp = await fetch(`${ALGOLIA_BASE}${path}`);
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie || !auth.username) {
    console.error('No auth found. Run: node hackernews-stories.mjs auth');
    process.exit(1);
  }
  return auth;
}

async function hnWebFetch(path, auth) {
  const url = `https://news.ycombinator.com${path}`;
  const opts = {
    headers: { 'cookie': auth.cookie, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const timeout = attempt === 0 ? 15000 : 25000;
      const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      return { status: resp.status, ok: resp.ok, text: await resp.text() };
    } catch (e) {
      if (attempt === 0 && (e.name === 'TimeoutError' || e.cause?.code === 'ETIMEDOUT')) {
        console.error('HN timed out, retrying...');
        continue;
      }
      console.error(`HN request failed: ${e.cause?.code || e.message}`);
      return { status: 0, ok: false, text: '' };
    }
  }
}

async function hnWebPost(path, auth, body) {
  const resp = await fetch(`https://news.ycombinator.com${path}`, {
    method: 'POST',
    headers: {
      'cookie': auth.cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body,
    redirect: 'manual',  // Don't follow redirects -- 302 means success
  });
  return { status: resp.status, ok: resp.status >= 200 && resp.status < 400, location: resp.headers.get('location') };
}

// ---------------------------------------------------------------------------
// Token scraping helpers
// ---------------------------------------------------------------------------

// Scrape auth token for a specific item from an HN page
async function scrapeAuthToken(itemId, auth) {
  const { text } = await hnWebFetch(`/item?id=${itemId}`, auth);
  // HN HTML uses &amp; for & in href attributes
  const match = text.match(new RegExp(`vote\\?id=${itemId}&(?:amp;)?how=up&(?:amp;)?auth=([a-f0-9]+)`));
  if (match) return match[1];
  // Try unvote link (if already voted)
  const unMatch = text.match(new RegExp(`vote\\?id=${itemId}&(?:amp;)?how=un&(?:amp;)?auth=([a-f0-9]+)`));
  if (unMatch) return unMatch[1];
  // Try fave/hide link
  const faveMatch = text.match(new RegExp(`fave\\?id=${itemId}&(?:amp;)?auth=([a-f0-9]+)`));
  return faveMatch?.[1] || null;
}

// Scrape hmac for commenting on an item
async function scrapeHmac(itemId, auth) {
  const { text } = await hnWebFetch(`/item?id=${itemId}`, auth);
  const match = text.match(/name="hmac" value="([a-f0-9]+)"/);
  return match?.[1] || null;
}

// Scrape hmac from reply page (for replying to a comment)
async function scrapeReplyHmac(commentId, auth) {
  const { text } = await hnWebFetch(`/reply?id=${commentId}`, auth);
  const match = text.match(/name="hmac" value="([a-f0-9]+)"/);
  return match?.[1] || null;
}

// Scrape fnid from submit page
async function scrapeFnid(auth) {
  const { text } = await hnWebFetch('/submit', auth);
  const match = text.match(/name="fnid" value="([^"]+)"/);
  return match?.[1] || null;
}

// ---------------------------------------------------------------------------
// Feed fetching helper
// ---------------------------------------------------------------------------

async function fetchFeed(label, endpoint, limit, offset) {
  console.log(`Fetching ${label}...`);
  const { ok, data: ids } = await firebaseFetch(`/${endpoint}.json`);
  if (!ok || !Array.isArray(ids)) {
    console.error(`Failed to fetch ${label}.`);
    return;
  }

  const sliced = ids.slice(offset, offset + limit);
  console.log(`Fetching ${sliced.length} items (${offset + 1}-${offset + sliced.length} of ${ids.length})...`);

  // Batch fetch items (10 at a time for speed)
  const items = [];
  for (let i = 0; i < sliced.length; i += 10) {
    const batch = sliced.slice(i, i + 10);
    const results = await Promise.all(batch.map(id => firebaseFetch(`/item/${id}.json`)));
    items.push(...results.filter(r => r.ok && r.data).map(r => r.data));
  }

  return { items, total: ids.length, offset, limit };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatDate(unix) {
  if (!unix) return 'unknown';
  return new Date(unix * 1000).toISOString().split('T')[0];
}

function formatNumber(n) { return n?.toLocaleString('en-US') || '0'; }

function stripHtml(html) { return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); }

function preview(text, max = 150) {
  const clean = stripHtml(text);
  return clean.length > max ? clean.substring(0, max) + '...' : clean;
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
// Comment tree rendering
// ---------------------------------------------------------------------------

function renderComments(children, depth = 0, maxDepth = 3) {
  if (!children || depth >= maxDepth) return;
  for (const child of children) {
    if (!child.author) continue; // skip deleted
    const indent = '  '.repeat(depth + 1);
    const text = stripHtml(child.text || '').substring(0, 120);
    const date = child.created_at ? child.created_at.split('T')[0] : '';
    console.log(`${indent}${child.author} · ${date}`);
    console.log(`${indent}  ${text}${(child.text || '').length > 120 ? '...' : ''}`);
    console.log();
    if (child.children?.length) {
      renderComments(child.children, depth + 1, maxDepth);
    }
  }
}

// ---------------------------------------------------------------------------
// Feed display helper
// ---------------------------------------------------------------------------

function displayFeed(label, result) {
  if (!result) return;
  const { items, total, offset, limit } = result;

  console.log('');
  console.log(`Hacker News — ${label} (${items.length} of ${total})`);
  console.log('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const rank = offset + i + 1;
    const title = item.title || '(untitled)';
    const url = item.url || '(text post)';
    const by = item.by || 'unknown';
    const score = item.score != null ? formatNumber(item.score) : 'N/A';
    const comments = item.descendants != null ? formatNumber(item.descendants) : 'N/A';
    const date = formatDate(item.time);

    console.log(`  ${rank}. ${title}`);
    console.log(`     ${url}`);
    console.log(`     by ${by} · ${score} pts · ${comments} comments · ${date}`);
    console.log(`     ID: ${item.id}`);
    console.log('');
  }

  console.log(`${items.length} items shown (${offset + 1}-${offset + items.length} of ${total}).${offset + items.length < total ? ` Next: --offset=${offset + items.length}` : ''}`);
}

// ---------------------------------------------------------------------------
// API: Feed commands (top, new, best, ask, show, jobs)
// ---------------------------------------------------------------------------

async function cmdFeed(label, endpoint, flags) {
  const limit = Math.min(Math.max(parseInt(flags.limit || '20', 10), 1), 100);
  const offset = Math.max(parseInt(flags.offset || '0', 10), 0);

  const result = await fetchFeed(label, endpoint, limit, offset);
  displayFeed(label, result);

  if (result) {
    const cacheFile = resolve(CACHE_DIR, `${endpoint.replace('stories', '')}-${offset}-${Date.now()}.json`);
    saveJson(cacheFile, { command: label, endpoint, offset, limit, items: result.items, total: result.total });
    console.log(`Saved to: ${cacheFile}`);
  }
}

// ---------------------------------------------------------------------------
// API: View item with comment tree (Algolia)
// ---------------------------------------------------------------------------

async function cmdView(itemId, flags) {
  const maxDepth = Math.min(Math.max(parseInt(flags.depth || '3', 10), 1), 10);

  console.log(`Fetching item ${itemId}...`);
  const { ok, data } = await algoliaFetch(`/items/${itemId}`);
  if (!ok || !data) {
    console.error(`Failed to fetch item ${itemId}.`);
    return;
  }

  const title = data.title || '(untitled)';
  const url = data.url || '';
  const author = data.author || 'unknown';
  const points = data.points != null ? formatNumber(data.points) : 'N/A';
  const commentCount = data.children ? countComments(data.children) : 0;
  const date = data.created_at ? data.created_at.split('T')[0] : 'unknown';

  console.log('');
  console.log(title);
  if (url) console.log(`  ${url}`);
  console.log(`  by ${author} · ${points} pts · ${formatNumber(commentCount)} comments · ${date}`);

  // Show full text for Ask HN / text posts
  if (data.text) {
    console.log('');
    console.log(`  ${stripHtml(data.text)}`);
  }

  if (data.children?.length) {
    console.log('');
    console.log(`  Comments (${maxDepth} levels):`);
    console.log('');
    renderComments(data.children, 0, maxDepth);
  }

  const cacheFile = resolve(CACHE_DIR, `item-${itemId}-${Date.now()}.json`);
  saveJson(cacheFile, data);
  console.log(`Saved to: ${cacheFile}`);
}

function countComments(children) {
  if (!children) return 0;
  let count = 0;
  for (const child of children) {
    if (child.author) count++;
    if (child.children) count += countComments(child.children);
  }
  return count;
}

// ---------------------------------------------------------------------------
// API: Vote (HN Web, auth required)
// ---------------------------------------------------------------------------

async function cmdVote(itemId, direction) {
  if (!['up', 'down', 'un'].includes(direction)) {
    console.error('Vote direction must be one of: up, down, un');
    process.exit(1);
  }

  const auth = getAuth();
  console.log(`Scraping auth token for item ${itemId}...`);
  const token = await scrapeAuthToken(itemId, auth);
  if (!token) {
    console.error(`Could not scrape auth token for item ${itemId}. You may have already voted, or the item may not be voteable.`);
    process.exit(1);
  }

  const goto = encodeURIComponent(`item?id=${itemId}`);
  const { ok, status } = await hnWebFetch(`/vote?id=${itemId}&how=${direction}&auth=${token}&goto=${goto}`, auth);

  if (ok) {
    const labels = { up: `Voted up on ${itemId}`, down: `Voted down on ${itemId}`, un: `Unvoted ${itemId}` };
    console.log(labels[direction]);
  } else {
    console.error(`Vote failed (HTTP ${status}). Downvoting requires high karma.`);
  }
}

// ---------------------------------------------------------------------------
// API: Favorite (HN Web, auth required)
// ---------------------------------------------------------------------------

async function cmdFave(itemId, flags) {
  const unfave = flags.un === 'true';
  const auth = getAuth();

  console.log(`Scraping auth token for item ${itemId}...`);
  const token = await scrapeAuthToken(itemId, auth);
  if (!token) {
    console.error(`Could not scrape auth token for item ${itemId}.`);
    process.exit(1);
  }

  const url = `/fave?id=${itemId}&auth=${token}${unfave ? '&un=t' : ''}`;
  const { ok, status } = await hnWebFetch(url, auth);

  if (ok) {
    console.log(unfave ? `Unfavorited ${itemId}.` : `Favorited ${itemId}.`);
  } else {
    console.error(`Fave failed (HTTP ${status}).`);
  }
}

// ---------------------------------------------------------------------------
// API: Comment (HN Web, auth required)
// ---------------------------------------------------------------------------

async function cmdComment(parentId, text) {
  if (!text) {
    console.error('Comment text is required.');
    process.exit(1);
  }

  const auth = getAuth();
  console.log(`WARNING: This will post a real comment on item ${parentId} as ${auth.username}.`);

  // Try story hmac first, fall back to reply hmac (for replying to comments)
  console.log(`Scraping hmac token for item ${parentId}...`);
  let hmac = await scrapeHmac(parentId, auth);
  if (!hmac) {
    console.log('No hmac on item page, trying reply page...');
    hmac = await scrapeReplyHmac(parentId, auth);
  }
  if (!hmac) {
    console.error(`Could not scrape hmac token for item ${parentId}. Are you logged in?`);
    process.exit(1);
  }

  const goto = encodeURIComponent(`item?id=${parentId}`);
  const body = `parent=${parentId}&hmac=${hmac}&text=${encodeURIComponent(text)}&goto=${goto}`;
  const { ok, status } = await hnWebPost('/comment', auth, body);

  if (ok) {
    console.log(`Comment posted on ${parentId}.`);
  } else {
    console.error(`Comment failed (HTTP ${status}). The hmac may have expired or the item may be locked.`);
  }
}

// ---------------------------------------------------------------------------
// API: Submit story (HN Web, auth required)
// ---------------------------------------------------------------------------

async function cmdSubmit(title, flags) {
  if (!title) {
    console.error('Title is required.');
    process.exit(1);
  }
  const url = flags.url || '';
  const text = flags.text || '';
  if (!url && !text) {
    console.error('Provide either --url=URL (link post) or --text=TEXT (text post).');
    process.exit(1);
  }
  if (url && text) {
    console.error('Provide only one of --url or --text, not both.');
    process.exit(1);
  }

  const auth = getAuth();
  console.log(`WARNING: This will submit a real story to HN as ${auth.username}: "${title}"`);

  console.log('Scraping fnid from submit page...');
  const fnid = await scrapeFnid(auth);
  if (!fnid) {
    console.error('Could not scrape fnid from submit page. Are you logged in?');
    process.exit(1);
  }

  const body = `fnid=${encodeURIComponent(fnid)}&fnop=submit-page&title=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const { ok, status, location } = await hnWebPost('/r', auth, body);

  if (ok) {
    console.log(`Story submitted: ${title}`);
    if (location) console.log(`Location: https://news.ycombinator.com${location}`);
  } else {
    console.error(`Submit failed (HTTP ${status}). The fnid may have expired -- try again immediately.`);
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

    case 'top': {
      await cmdFeed('top stories', 'topstories', flags);
      break;
    }

    case 'new': {
      await cmdFeed('newest stories', 'newstories', flags);
      break;
    }

    case 'best': {
      await cmdFeed('best stories', 'beststories', flags);
      break;
    }

    case 'ask': {
      await cmdFeed('Ask HN', 'askstories', flags);
      break;
    }

    case 'show': {
      await cmdFeed('Show HN', 'showstories', flags);
      break;
    }

    case 'jobs': {
      await cmdFeed('job postings', 'jobstories', flags);
      break;
    }

    case 'view': {
      const id = positional[0];
      if (!id) { console.error('Usage: hackernews-stories.mjs view <id> [--depth=3]'); process.exit(1); }
      await cmdView(id, flags);
      break;
    }

    case 'vote': {
      const id = positional[0];
      const direction = positional[1];
      if (!id || !direction) { console.error('Usage: hackernews-stories.mjs vote <id> <up|down|un>'); process.exit(1); }
      await cmdVote(id, direction);
      break;
    }

    case 'fave': {
      const id = positional[0];
      if (!id) { console.error('Usage: hackernews-stories.mjs fave <id> [--un]'); process.exit(1); }
      await cmdFave(id, flags);
      break;
    }

    case 'comment': {
      const id = positional[0];
      const text = positional.slice(1).join(' ');
      if (!id || !text) { console.error('Usage: hackernews-stories.mjs comment <id> <text>'); process.exit(1); }
      await cmdComment(id, text);
      break;
    }

    case 'submit': {
      const title = positional.join(' ');
      if (!title) { console.error('Usage: hackernews-stories.mjs submit <title> --url=URL | --text=TEXT'); process.exit(1); }
      await cmdSubmit(title, flags);
      break;
    }

    default: {
      const script = 'hackernews-stories.mjs';
      console.log(`
hackernews-stories — Browse HN feeds, view posts, vote, fave, comment, and submit

Setup (for authenticated commands):
  node ${script} auth                                   Extract cookies from Chrome

Feed commands (no auth required):
  node ${script} top [--limit=20] [--offset=0]          Top stories
  node ${script} new [--limit=20] [--offset=0]          Newest stories
  node ${script} best [--limit=20] [--offset=0]         Best stories
  node ${script} ask [--limit=20] [--offset=0]          Ask HN posts
  node ${script} show [--limit=20] [--offset=0]         Show HN posts
  node ${script} jobs [--limit=20] [--offset=0]         Job postings
  node ${script} view <id> [--depth=3]                  View post + comment tree

Authenticated commands:
  node ${script} vote <id> <up|down|un>                 Vote on item
  node ${script} fave <id> [--un]                       Favorite (--un to unfavorite)
  node ${script} comment <id> <text>                    Post a comment
  node ${script} submit <title> --url=URL               Submit a link
  node ${script} submit <title> --text=TEXT             Submit a text post

Examples:
  node ${script} top --limit=10
  node ${script} new --offset=20 --limit=10
  node ${script} ask --limit=5
  node ${script} view 47530330 --depth=5
  node ${script} vote 47530330 up
  node ${script} fave 47530330
  node ${script} comment 47530330 "Great article!"
  node ${script} submit "My Project" --url=https://example.com

Notes:
  Feed commands (top, new, best, ask, show, jobs, view) use public APIs.
  vote, fave, comment, submit require auth (cookies from Chrome HN tab).
  --offset paginates through the full ID list (Firebase returns all IDs at once).

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
