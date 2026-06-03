#!/usr/bin/env node
// instagram-post.mjs — Instagram single-post operations
//
// Commands:
//   node instagram-post.mjs info <shortcode|url>
//   node instagram-post.mjs comments <shortcode|url> [--count=20] [--cursor=X]
//   node instagram-post.mjs likers <shortcode|url>
//
// Auth is shared with instagram-user.mjs (~/.local/share/showrun/data/instagram/session.json).
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
function saveJson(p, d) { ensureDir(resolve(p, '..')); writeFileSync(p, JSON.stringify(d, null, 2)); }

function loadSession() {
  const s = loadJson(SESSION_FILE);
  if (!s || !s.cookie || !s.csrftoken) {
    console.error('No valid session. Run: instagram-user.mjs auth');
    process.exit(1);
  }
  return s;
}

const IG_APP_ID = '936619743392459';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function baseHeaders(session) {
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': session.cookie,
    'referer': 'https://www.instagram.com/',
    'user-agent': UA,
    'x-asbd-id': '129477',
    'x-csrftoken': session.csrftoken,
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-site': 'same-origin',
  };
}

async function apiGet(session, path) {
  const resp = await fetch(`https://www.instagram.com${path}`, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) {
      console.error(`HTTP ${resp.status}. Re-auth: instagram-user.mjs auth`);
      process.exit(1);
    }
    if (resp.status === 404) throw new Error('Not found');
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Shortcode <-> media_id
// ---------------------------------------------------------------------------

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function shortcodeToMediaId(code) {
  let id = 0n;
  for (const ch of code) {
    const idx = SHORTCODE_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid shortcode character: ${ch}`);
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

function parseTarget(input) {
  // Accept: shortcode, /p/<code>/, /reel/<code>/, /tv/<code>/, full URL
  if (!input) return null;
  const m = input.match(/(?:^|\/)(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // Bare shortcode
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  return null;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function bestImage(versions) {
  if (!versions || !versions.length) return null;
  return versions.reduce((best, v) => (!best || v.width > best.width ? v : best), null)?.url || null;
}

function formatMediaItem(item) {
  const carouselMedia = item.carousel_media
    ? item.carousel_media.map(m => ({
        id: m.pk || m.id,
        media_type: m.media_type,
        image_url: bestImage(m.image_versions2?.candidates),
        video_url: m.video_versions?.[0]?.url,
      }))
    : null;
  return {
    id: item.pk || item.id,
    code: item.code,
    url: item.code ? `https://www.instagram.com/p/${item.code}/` : null,
    media_type: item.media_type,
    is_video: item.media_type === 2,
    is_carousel: item.media_type === 8,
    taken_at: item.taken_at,
    caption: item.caption?.text || null,
    like_count: item.like_count,
    comment_count: item.comment_count,
    play_count: item.play_count || item.view_count,
    image_url: bestImage(item.image_versions2?.candidates),
    video_url: item.video_versions?.[0]?.url,
    carousel: carouselMedia,
    owner: item.user ? { id: item.user.pk || item.user.id, username: item.user.username, full_name: item.user.full_name, is_verified: item.user.is_verified } : null,
    location: item.location ? { name: item.location.name, id: item.location.pk, lat: item.location.lat, lng: item.location.lng } : null,
    accessibility_caption: item.accessibility_caption,
    hashtags: extractHashtags(item.caption?.text),
    mentions: extractMentions(item.caption?.text),
  };
}

function extractHashtags(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/#([\p{L}0-9_]+)/gu)].map(m => m[1]))];
}

function extractMentions(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/@([A-Za-z0-9_.]+)/g)].map(m => m[1]))];
}

function formatComment(c) {
  return {
    id: c.pk,
    text: c.text,
    created_at: c.created_at,
    like_count: c.comment_like_count,
    reply_count: c.child_comment_count,
    user: c.user ? { id: c.user.pk, username: c.user.username, full_name: c.user.full_name, is_verified: c.user.is_verified } : null,
  };
}

function formatUserShort(u) {
  return {
    id: u.pk || u.id,
    username: u.username,
    full_name: u.full_name,
    is_private: u.is_private,
    is_verified: u.is_verified,
    profile_pic_url: u.profile_pic_url,
  };
}

// ---------------------------------------------------------------------------
// CLI flags
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
// Commands
// ---------------------------------------------------------------------------

async function cmdInfo(session, target) {
  const code = parseTarget(target);
  if (!code) { console.error('Usage: info <shortcode|url>'); process.exit(1); }
  const mediaId = shortcodeToMediaId(code);
  const data = await apiGet(session, `/api/v1/media/${mediaId}/info/`);
  const item = data.items?.[0];
  if (!item) throw new Error(`Post not found: ${code}`);
  const post = formatMediaItem(item);
  saveJson(resolve(CACHE_DIR, `post-${code}.json`), post);
  console.log(JSON.stringify(post, null, 2));
}

async function cmdComments(session, target, flags) {
  const code = parseTarget(target);
  if (!code) { console.error('Usage: comments <shortcode|url> [--count=20] [--cursor=X]'); process.exit(1); }
  const mediaId = shortcodeToMediaId(code);
  let path = `/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`;
  if (flags.cursor) path += `&min_id=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  let comments = (data.comments || []).map(formatComment);
  const requested = parseInt(flags.count || '20', 10);
  if (comments.length > requested) comments = comments.slice(0, requested);
  const result = {
    comments,
    comment_count: data.comment_count,
    nextCursor: data.next_min_id || null,
    has_more: !!data.has_more_comments,
  };
  saveJson(resolve(CACHE_DIR, `comments-${code}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdLikers(session, target) {
  const code = parseTarget(target);
  if (!code) { console.error('Usage: likers <shortcode|url>'); process.exit(1); }
  const mediaId = shortcodeToMediaId(code);
  const data = await apiGet(session, `/api/v1/media/${mediaId}/likers/`);
  const users = (data.users || []).map(formatUserShort);
  const result = { users, user_count: data.user_count };
  saveJson(resolve(CACHE_DIR, `likers-${code}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`instagram-post — Instagram single-post operations

Commands:
  info <shortcode|url>                           Post details
  comments <shortcode|url> [--count=20] [--cursor=X]  Comments
  likers <shortcode|url>                         Recent likers

Auth shared with instagram-user.mjs.`);
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional[1];

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'info':     await cmdInfo(loadSession(), arg1); break;
      case 'comments': await cmdComments(loadSession(), arg1, flags); break;
      case 'likers':   await cmdLikers(loadSession(), arg1); break;
      default: printUsage();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
