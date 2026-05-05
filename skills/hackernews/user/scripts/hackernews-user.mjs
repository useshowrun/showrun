#!/usr/bin/env node
// hackernews-user.mjs — Hacker News user profiles, posts, comments & authenticated views
//
// Setup (one-time, requires Chrome with HN open):
//   node hackernews-user.mjs auth
//
// Public commands (no auth needed):
//   node hackernews-user.mjs about <name>             User profile (Firebase)
//   node hackernews-user.mjs posts <name>              User's stories (Algolia)
//   node hackernews-user.mjs comments <name>           User's comments (Algolia)
//
// Authenticated commands (requires auth):
//   node hackernews-user.mjs threads                   Your comment threads
//   node hackernews-user.mjs favorites                 Your favorited items
//   node hackernews-user.mjs upvoted                   Items you upvoted
//   node hackernews-user.mjs hidden                    Items you hid
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/hackernews-user');
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
// Auth: extract HN cookies from Chrome
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
  if (!username) console.error('Warning: Not logged in to HN. Authenticated commands will not work.');
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
    console.error('No auth found. Run: node hackernews-user.mjs auth');
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
      return { status: resp.status, ok: resp.ok, data: await resp.text() };
    } catch (e) {
      if (attempt === 0 && (e.name === 'TimeoutError' || e.cause?.code === 'ETIMEDOUT')) {
        console.error('HN timed out, retrying...');
        continue;
      }
      console.error(`HN request failed: ${e.cause?.code || e.message}`);
      return { status: 0, ok: false, data: '' };
    }
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatDate(unix) {
  if (!unix) return 'unknown';
  return new Date(unix * 1000).toISOString().split('T')[0];
}

function formatNumber(n) {
  return n?.toLocaleString('en-US') || '0';
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

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

function timestamp() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function parseHnItems(html) {
  const items = [];
  const rows = html.split('<tr class="athing');
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const idMatch = row.match(/id="(\d+)"/);
    const titleMatch = row.match(/<span class="titleline"><a[^>]*>([^<]+)<\/a>/);
    const urlMatch = row.match(/<span class="titleline"><a href="([^"]+)"/);
    const scoreMatch = row.match(/(\d+) point/);
    const authorMatch = row.match(/class="hnuser">([^<]+)/);
    const commentsMatch = row.match(/(\d+)&nbsp;comment/);
    const ageMatch = row.match(/class="age"[^>]*><a[^>]*>([^<]+)<\/a>/);

    if (idMatch) {
      items.push({
        id: parseInt(idMatch[1]),
        title: titleMatch?.[1] || '',
        url: urlMatch?.[1] || '',
        score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
        author: authorMatch?.[1] || '',
        comments: commentsMatch ? parseInt(commentsMatch[1]) : 0,
        age: ageMatch?.[1] || '',
      });
    }
  }
  return items;
}

function parseHnComments(html) {
  const comments = [];
  const rows = html.split('<tr class="athing comtr');
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const idMatch = row.match(/id="(\d+)"/);
    const authorMatch = row.match(/class="hnuser">([^<]+)/);
    const ageMatch = row.match(/class="age"[^>]*><a[^>]*>([^<]+)<\/a>/);
    const textMatch = row.match(/<div class="commtext[^"]*">([\s\S]*?)<\/div>/);
    const onMatch = row.match(/on: <a href="item\?id=(\d+)">([^<]*)<\/a>/);

    if (idMatch) {
      comments.push({
        id: parseInt(idMatch[1]),
        author: authorMatch?.[1] || '',
        age: ageMatch?.[1] || '',
        text: textMatch?.[1]?.replace(/<[^>]+>/g, ' ')?.replace(/\s+/g, ' ')?.trim()?.substring(0, 200) || '',
        onStoryId: onMatch ? parseInt(onMatch[1]) : null,
        onStoryTitle: onMatch?.[2] || '',
      });
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function fetchAbout(name) {
  const result = await firebaseFetch(`/user/${encodeURIComponent(name)}.json`);
  if (!result.ok || !result.data) throw new Error(`User not found: ${name} (HTTP ${result.status})`);
  return result.data;
}

async function fetchPosts(name, { sort = 'date', limit = 20, page = 0, points = null } = {}) {
  const endpoint = sort === 'relevance' ? '/search' : '/search_by_date';
  let url = `${endpoint}?tags=story,author_${encodeURIComponent(name)}&hitsPerPage=${limit}&page=${page}`;
  if (points) url += `&numericFilters=points>${points}`;
  const result = await algoliaFetch(url);
  if (!result.ok) throw new Error(`Failed to fetch posts for ${name} (HTTP ${result.status})`);
  return result.data;
}

async function fetchComments(name, { sort = 'date', limit = 20, page = 0, points = null } = {}) {
  const endpoint = sort === 'relevance' ? '/search' : '/search_by_date';
  let url = `${endpoint}?tags=comment,author_${encodeURIComponent(name)}&hitsPerPage=${limit}&page=${page}`;
  if (points) url += `&numericFilters=points>${points}`;
  const result = await algoliaFetch(url);
  if (!result.ok) throw new Error(`Failed to fetch comments for ${name} (HTTP ${result.status})`);
  return result.data;
}

async function fetchThreads(auth) {
  const result = await hnWebFetch(`/threads?id=${encodeURIComponent(auth.username)}`, auth);
  if (!result.ok) throw new Error(`Failed to fetch threads (HTTP ${result.status})`);
  return result.data;
}

async function fetchFavorites(auth) {
  const result = await hnWebFetch(`/favorites?id=${encodeURIComponent(auth.username)}`, auth);
  if (!result.ok) throw new Error(`Failed to fetch favorites (HTTP ${result.status})`);
  return result.data;
}

async function fetchUpvoted(auth) {
  const result = await hnWebFetch(`/upvoted?id=${encodeURIComponent(auth.username)}`, auth);
  if (!result.ok) throw new Error(`Failed to fetch upvoted (HTTP ${result.status})`);
  return result.data;
}

async function fetchHidden(auth) {
  const result = await hnWebFetch('/hidden', auth);
  if (!result.ok) throw new Error(`Failed to fetch hidden (HTTP ${result.status})`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayAbout(data) {
  console.log(`\nu/${data.id}`);
  console.log(`  Karma: ${formatNumber(data.karma)}`);
  console.log(`  Created: ${formatDate(data.created)}`);
  console.log(`  Submitted: ${formatNumber(data.submitted?.length || 0)} items`);
  if (data.about) {
    console.log(`  About: ${preview(data.about, 300)}`);
  }
}

function displayPosts(data, name, page, sort) {
  const sortLabel = sort === 'relevance' ? 'most relevant' : 'newest first';
  console.log(`\nu/${name} — stories (${sortLabel}, page ${page + 1})\n`);
  const hits = data.hits || [];
  if (!hits.length) {
    console.log('  (no stories found)');
    return;
  }
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`  ${i + 1}. ${h.title || '(untitled)'}`);
    if (h.url) console.log(`     ${h.url}`);
    console.log(`     ${formatNumber(h.points)} pts · ${formatNumber(h.num_comments)} comments · ${h.created_at?.split('T')[0] || 'unknown'}`);
    console.log(`     ID: ${h.objectID}`);
    console.log();
  }
  const totalHits = data.nbHits || 0;
  const totalPages = data.nbPages || 0;
  console.log(`${formatNumber(totalHits)} results. Page ${page + 1}/${totalPages}.${page + 1 < totalPages ? ` Next: --page=${page + 1}` : ''}`);
}

function displayComments(data, name, page, sort) {
  const sortLabel = sort === 'relevance' ? 'most relevant' : 'newest first';
  console.log(`\nu/${name} — comments (${sortLabel}, page ${page + 1})\n`);
  const hits = data.hits || [];
  if (!hits.length) {
    console.log('  (no comments found)');
    return;
  }
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const text = preview(h.comment_text || '', 150);
    console.log(`  ${i + 1}. "${text}"`);
    if (h.story_title) console.log(`     on: ${h.story_title} (#${h.story_id || '?'})`);
    console.log(`     ${h.created_at?.split('T')[0] || 'unknown'} · ID: ${h.objectID}`);
    console.log();
  }
  const totalHits = data.nbHits || 0;
  const totalPages = data.nbPages || 0;
  console.log(`${formatNumber(totalHits)} results. Page ${page + 1}/${totalPages}.${page + 1 < totalPages ? ` Next: --page=${page + 1}` : ''}`);
}

function displayThreads(comments) {
  console.log('\nYour comment threads:\n');
  if (!comments.length) {
    console.log('  (no threads found)');
    return;
  }
  for (const c of comments) {
    const age = c.age ? `[${c.age}]` : '[unknown]';
    const story = c.onStoryTitle ? `"${c.onStoryTitle}"` : '(unknown story)';
    const storyId = c.onStoryId ? ` (#${c.onStoryId})` : '';
    console.log(`  ${age} on ${story}${storyId}`);
    if (c.text) console.log(`    ${c.text}`);
    console.log();
  }
  console.log(`${comments.length} threads shown.`);
}

function displayItems(items, label) {
  console.log(`\n${label}:\n`);
  if (!items.length) {
    console.log('  (no items found)');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`  ${i + 1}. ${item.title || '(untitled)'}`);
    if (item.url && !item.url.startsWith('item?id=')) console.log(`     ${item.url}`);
    const parts = [];
    if (item.score) parts.push(`${formatNumber(item.score)} pts`);
    if (item.author) parts.push(`by ${item.author}`);
    if (item.comments) parts.push(`${formatNumber(item.comments)} comments`);
    if (item.age) parts.push(item.age);
    if (parts.length) console.log(`     ${parts.join(' · ')}`);
    console.log(`     ID: ${item.id}`);
    console.log();
  }
  console.log(`${items.length} items shown.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

try {
switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'about': {
    const name = positional[0];
    if (!name) {
      console.error('Usage: node hackernews-user.mjs about <name>');
      process.exit(1);
    }
    console.log(`Fetching profile for ${name}...`);
    const data = await fetchAbout(name);
    const outFile = resolve(CACHE_DIR, `about-${name}.json`);
    saveJson(outFile, data);
    displayAbout(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'posts': {
    const name = positional[0];
    if (!name) {
      console.error('Usage: node hackernews-user.mjs posts <name> [--sort=date|relevance] [--limit=N] [--page=N] [--points=N]');
      process.exit(1);
    }
    const sort = flags.sort || 'date';
    const limit = parseInt(flags.limit || '20');
    const page = parseInt(flags.page || '0');
    const points = flags.points ? parseInt(flags.points) : null;
    console.log(`Fetching stories by ${name}...`);
    const data = await fetchPosts(name, { sort, limit, page, points });
    const outFile = resolve(CACHE_DIR, `posts-${name}-${page}-${timestamp()}.json`);
    saveJson(outFile, data);
    displayPosts(data, name, page, sort);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'comments': {
    const name = positional[0];
    if (!name) {
      console.error('Usage: node hackernews-user.mjs comments <name> [--sort=date|relevance] [--limit=N] [--page=N] [--points=N]');
      process.exit(1);
    }
    const sort = flags.sort || 'date';
    const limit = parseInt(flags.limit || '20');
    const page = parseInt(flags.page || '0');
    const points = flags.points ? parseInt(flags.points) : null;
    console.log(`Fetching comments by ${name}...`);
    const data = await fetchComments(name, { sort, limit, page, points });
    const outFile = resolve(CACHE_DIR, `comments-${name}-${page}-${timestamp()}.json`);
    saveJson(outFile, data);
    displayComments(data, name, page, sort);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'threads': {
    const auth = getAuth();
    console.log(`Fetching threads for ${auth.username}...`);
    const html = await fetchThreads(auth);
    const comments = parseHnComments(html);
    const outFile = resolve(CACHE_DIR, `threads-${timestamp()}.json`);
    saveJson(outFile, comments);
    displayThreads(comments);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'favorites': {
    const auth = getAuth();
    console.log(`Fetching favorites for ${auth.username}...`);
    const html = await fetchFavorites(auth);
    const items = parseHnItems(html);
    const outFile = resolve(CACHE_DIR, `favorites-${timestamp()}.json`);
    saveJson(outFile, items);
    displayItems(items, 'Your favorites');
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'upvoted': {
    const auth = getAuth();
    console.log(`Fetching upvoted items for ${auth.username}...`);
    const html = await fetchUpvoted(auth);
    const items = parseHnItems(html);
    const outFile = resolve(CACHE_DIR, `upvoted-${timestamp()}.json`);
    saveJson(outFile, items);
    displayItems(items, 'Your upvoted items');
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'hidden': {
    const auth = getAuth();
    console.log(`Fetching hidden items for ${auth.username}...`);
    const html = await fetchHidden(auth);
    const items = parseHnItems(html);
    const outFile = resolve(CACHE_DIR, `hidden-${timestamp()}.json`);
    saveJson(outFile, items);
    displayItems(items, 'Your hidden items');
    console.log(`Saved to: ${outFile}`);
    break;
  }

  default:
    console.log(`hackernews-user — Hacker News user profiles & activity

Public commands (no auth needed):
  about <name>              User profile (karma, created, bio)
  posts <name>              User's stories (Algolia search)
    --sort=date|relevance   Sort order (default: date)
    --limit=N               Results per page (default: 20)
    --page=N                Page number, 0-indexed (default: 0)
    --points=N              Minimum points filter
  comments <name>           User's comments (Algolia search)
    --sort=date|relevance   Sort order (default: date)
    --limit=N               Results per page (default: 20)
    --page=N                Page number, 0-indexed (default: 0)
    --points=N              Minimum points filter

Authenticated commands (run 'auth' first):
  auth                      Extract HN cookies from Chrome
  threads                   Your comment threads
  favorites                 Your favorited items
  upvoted                   Items you upvoted (only visible to you)
  hidden                    Items you hid

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Cached API responses`);
}
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
