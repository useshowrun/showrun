#!/usr/bin/env node
// instagram-user.mjs — Instagram user operations via web API
//
// Setup (one-time, requires Chrome with instagram.com open):
//   node instagram-user.mjs auth
//
// Commands:
//   node instagram-user.mjs lookup <username>                         Profile by handle
//   node instagram-user.mjs lookup-id <id>                            Profile by numeric ID
//   node instagram-user.mjs posts <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs reels <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs highlights <username|id>                  Highlight reels tray
//   node instagram-user.mjs tagged <username|id> [--count=12] [--cursor=X]
//   node instagram-user.mjs stories <username|id>                     Active stories
//   node instagram-user.mjs followers <username|id> [--count=25] [--cursor=X]
//   node instagram-user.mjs following <username|id> [--count=25] [--cursor=X]
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadSession() {
  const s = loadJson(SESSION_FILE);
  if (!s || !s.cookie || !s.csrftoken) {
    console.error('No valid session. Run: auth');
    process.exit(1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// CDP integration
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
// Auth: extract cookies from Chrome instagram.com tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.error('Finding instagram.com tab...');
  const list = cdp('list');
  let tabId;
  for (const line of list.split('\n')) {
    if (line.includes('instagram.com')) {
      tabId = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!tabId) {
    console.error('No instagram.com tab found. Open instagram.com in Chrome first.');
    process.exit(1);
  }
  console.error(`Found tab: ${tabId}`);

  const raw = cdp('evalraw', tabId, 'Network.getCookies', JSON.stringify({ urls: ['https://www.instagram.com'] }));
  const parsed = JSON.parse(raw);
  const cookies = parsed.cookies || [];

  const wanted = ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur', 'datr'];
  const found = {};
  for (const c of cookies) {
    if (wanted.includes(c.name)) found[c.name] = c.value;
  }
  if (!found.sessionid || !found.csrftoken) {
    console.error('Could not find sessionid + csrftoken. Are you logged in to instagram.com?');
    process.exit(1);
  }

  const cookieStr = Object.entries(found).map(([k, v]) => `${k}=${v}`).join('; ');
  const session = {
    cookie: cookieStr,
    csrftoken: found.csrftoken,
    userId: found.ds_user_id || '',
    capturedAt: new Date().toISOString(),
  };

  ensureDir(DATA_DIR);
  saveJson(SESSION_FILE, session);
  console.error('Session saved.');
  console.log(JSON.stringify({ ok: true, userId: session.userId, capturedAt: session.capturedAt }));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

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
  const url = `https://www.instagram.com${path}`;
  const resp = await fetch(url, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait and try later.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) {
      console.error(`HTTP ${resp.status}. Session may be expired — run: auth`);
      process.exit(1);
    }
    if (resp.status === 404) throw new Error('Not found');
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function apiPost(session, path, formData) {
  const url = `https://www.instagram.com${path}`;
  const headers = { ...baseHeaders(session), 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(formData).toString();
  const resp = await fetch(url, { method: 'POST', headers, body });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait and try later.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) {
      console.error(`HTTP ${resp.status}. Session may be expired — run: auth`);
      process.exit(1);
    }
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUserProfile(u) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    biography: u.biography,
    bio_links: (u.bio_links || []).map(b => ({ title: b.title, url: b.url, link_type: b.link_type })),
    external_url: u.external_url,
    followers_count: u.edge_followed_by?.count,
    following_count: u.edge_follow?.count,
    posts_count: u.edge_owner_to_timeline_media?.count,
    highlight_reel_count: u.highlight_reel_count,
    profile_pic_url: u.profile_pic_url_hd || u.profile_pic_url,
    is_private: u.is_private,
    is_verified: u.is_verified,
    is_business_account: u.is_business_account,
    is_professional_account: u.is_professional_account,
    business_category_name: u.business_category_name,
    category_name: u.category_name,
    business_email: u.business_email,
    business_phone_number: u.business_phone_number,
    business_address: u.business_address_json ? safeJsonParse(u.business_address_json) : null,
    pronouns: u.pronouns,
    has_clips: u.has_clips,
    has_channel: u.has_channel,
    fbid: u.fbid,
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

function bestImage(versions) {
  if (!versions || !versions.length) return null;
  return versions.reduce((best, v) => (!best || v.width > best.width ? v : best), null)?.url || null;
}

function formatMediaItem(item) {
  // media_type: 1=image, 2=video, 8=carousel
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
    owner: item.user ? { id: item.user.pk || item.user.id, username: item.user.username, full_name: item.user.full_name } : null,
    location: item.location ? { name: item.location.name, id: item.location.pk, lat: item.location.lat, lng: item.location.lng } : null,
    accessibility_caption: item.accessibility_caption,
  };
}

function formatReel(node) {
  // clips/user/ items wrap media under .media
  const item = node.media || node;
  return formatMediaItem(item);
}

function formatStoryItem(item) {
  return {
    id: item.pk || item.id,
    media_type: item.media_type,
    taken_at: item.taken_at,
    expiring_at: item.expiring_at,
    image_url: bestImage(item.image_versions2?.candidates),
    video_url: item.video_versions?.[0]?.url,
    video_duration: item.video_duration,
  };
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------------------------------------------------------------------
// User resolver
// ---------------------------------------------------------------------------

async function fetchProfile(session, username) {
  username = username.replace(/^@/, '').toLowerCase();
  const data = await apiGet(session, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  if (!data?.data?.user) throw new Error(`User not found: ${username}`);
  return data.data.user;
}

async function resolveUserId(session, target) {
  if (/^\d+$/.test(target)) return target;
  const user = await fetchProfile(session, target);
  return user.id;
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

async function cmdLookup(session, username) {
  if (!username) { console.error('Usage: lookup <username>'); process.exit(1); }
  const user = await fetchProfile(session, username);
  const profile = formatUserProfile(user);
  saveJson(resolve(CACHE_DIR, `user-${profile.username}.json`), profile);
  console.log(JSON.stringify(profile, null, 2));
}

async function cmdLookupId(session, id) {
  if (!id) { console.error('Usage: lookup-id <id>'); process.exit(1); }
  // Resolve ID -> username via i.instagram.com users/<id>/info/
  const data = await apiGet(session, `/api/v1/users/${id}/info/`);
  const u = data.user;
  if (!u) throw new Error(`User not found: ${id}`);
  // Fetch full profile via username for richer fields
  const profile = formatUserProfile(await fetchProfile(session, u.username));
  saveJson(resolve(CACHE_DIR, `user-id-${id}.json`), profile);
  console.log(JSON.stringify(profile, null, 2));
}

async function cmdPosts(session, target, flags) {
  if (!target) { console.error('Usage: posts <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const count = parseInt(flags.count || '12', 10);
  let path = `/api/v1/feed/user/${userId}/?count=${count}`;
  if (flags.cursor) path += `&max_id=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const posts = (data.items || []).map(formatMediaItem);
  const result = { posts, nextCursor: data.next_max_id || null, more_available: !!data.more_available };
  saveJson(resolve(CACHE_DIR, `posts-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdReels(session, target, flags) {
  if (!target) { console.error('Usage: reels <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const count = parseInt(flags.count || '12', 10);
  const form = { target_user_id: userId, page_size: String(count), include_feed_video: 'true' };
  if (flags.cursor) form.max_id = flags.cursor;
  const data = await apiPost(session, '/api/v1/clips/user/', form);
  const reels = (data.items || []).map(formatReel);
  const result = { reels, nextCursor: data.paging_info?.max_id || null, more_available: !!data.paging_info?.more_available };
  saveJson(resolve(CACHE_DIR, `reels-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdHighlights(session, target) {
  if (!target) { console.error('Usage: highlights <username|id>'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const data = await apiGet(session, `/api/v1/highlights/${userId}/highlights_tray/`);
  const highlights = (data.tray || []).map(h => ({
    id: h.id,
    title: h.title,
    media_count: h.media_count,
    cover_image_url: bestImage(h.cover_media?.cropped_image_version ? [h.cover_media.cropped_image_version] : null) || h.cover_media?.cropped_image_version?.url,
    created_at: h.created_at,
  }));
  const result = { highlights };
  saveJson(resolve(CACHE_DIR, `highlights-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdTagged(session, target, flags) {
  if (!target) { console.error('Usage: tagged <username|id> [--count=12] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const count = parseInt(flags.count || '12', 10);
  let path = `/api/v1/usertags/${userId}/feed/?count=${count}`;
  if (flags.cursor) path += `&max_id=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const posts = (data.items || []).map(formatMediaItem);
  const result = { posts, nextCursor: data.next_max_id || null, more_available: !!data.more_available };
  saveJson(resolve(CACHE_DIR, `tagged-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdStories(session, target) {
  if (!target) { console.error('Usage: stories <username|id>'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const data = await apiGet(session, `/api/v1/feed/reels_media/?reel_ids=${userId}`);
  const reel = data.reels?.[userId];
  if (!reel) {
    console.log(JSON.stringify({ stories: [], reel: null }, null, 2));
    return;
  }
  const stories = (reel.items || []).map(formatStoryItem);
  const result = {
    reel: {
      id: reel.id,
      latest_reel_media: reel.latest_reel_media,
      expiring_at: reel.expiring_at,
      seen: reel.seen,
    },
    stories,
  };
  saveJson(resolve(CACHE_DIR, `stories-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdFollowers(session, target, flags) {
  if (!target) { console.error('Usage: followers <username|id> [--count=25] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const count = parseInt(flags.count || '25', 10);
  let path = `/api/v1/friendships/${userId}/followers/?count=${count}`;
  if (flags.cursor) path += `&max_id=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const users = (data.users || []).map(formatUserShort);
  const result = { users, nextCursor: data.next_max_id || null };
  saveJson(resolve(CACHE_DIR, `followers-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdFollowing(session, target, flags) {
  if (!target) { console.error('Usage: following <username|id> [--count=25] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUserId(session, target);
  const count = parseInt(flags.count || '25', 10);
  let path = `/api/v1/friendships/${userId}/following/?count=${count}`;
  if (flags.cursor) path += `&max_id=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const users = (data.users || []).map(formatUserShort);
  const result = { users, nextCursor: data.next_max_id || null };
  saveJson(resolve(CACHE_DIR, `following-${userId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`instagram-user — Instagram user operations

Commands:
  auth                              Extract session from Chrome
  lookup <username>                 Get profile by @username
  lookup-id <id>                    Get profile by numeric user ID
  posts <username|id> [--count=12] [--cursor=X]      Recent posts
  reels <username|id> [--count=12] [--cursor=X]      Recent reels
  highlights <username|id>          Highlight reels tray
  tagged <username|id> [--count=12] [--cursor=X]     Posts user is tagged in
  stories <username|id>             Active 24h stories
  followers <username|id> [--count=25] [--cursor=X]  Followers list
  following <username|id> [--count=25] [--cursor=X]  Following list

Session: ~/.local/share/showrun/data/instagram/session.json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional[1];

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'auth':         await doAuth(); break;
      case 'lookup':       await cmdLookup(loadSession(), arg1); break;
      case 'lookup-id':    await cmdLookupId(loadSession(), arg1); break;
      case 'posts':        await cmdPosts(loadSession(), arg1, flags); break;
      case 'reels':        await cmdReels(loadSession(), arg1, flags); break;
      case 'highlights':   await cmdHighlights(loadSession(), arg1); break;
      case 'tagged':       await cmdTagged(loadSession(), arg1, flags); break;
      case 'stories':      await cmdStories(loadSession(), arg1); break;
      case 'followers':    await cmdFollowers(loadSession(), arg1, flags); break;
      case 'following':    await cmdFollowing(loadSession(), arg1, flags); break;
      default: printUsage();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
