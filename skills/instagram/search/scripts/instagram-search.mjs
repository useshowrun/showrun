#!/usr/bin/env node
// instagram-search.mjs — Instagram top search (users, hashtags, places)
//
// Commands:
//   node instagram-search.mjs top <query>           Blended search (users + hashtags + places)
//   node instagram-search.mjs users <query>         Users-only filter
//   node instagram-search.mjs hashtags <query>      Hashtags-only filter
//   node instagram-search.mjs places <query>        Places-only filter
//
// Auth is shared with instagram-user.mjs (~/.local/share/showrun/data/instagram/session.json).

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
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
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUserHit(entry) {
  const u = entry.user || entry;
  return {
    id: u.pk || u.id,
    username: u.username,
    full_name: u.full_name,
    is_private: u.is_private,
    is_verified: u.is_verified,
    profile_pic_url: u.profile_pic_url,
    follower_count: u.follower_count,
    position: entry.position,
  };
}

function formatHashtagHit(entry) {
  const h = entry.hashtag || entry;
  return {
    id: h.id,
    name: h.name,
    media_count: h.media_count,
    position: entry.position,
  };
}

function formatPlaceHit(entry) {
  const p = entry.place || entry;
  return {
    id: p.location?.pk || p.pk,
    title: p.title,
    subtitle: p.subtitle,
    name: p.location?.name,
    lat: p.location?.lat,
    lng: p.location?.lng,
    city: p.location?.city,
    address: p.location?.address,
    position: entry.position,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdTop(session, query) {
  if (!query) { console.error('Usage: top <query>'); process.exit(1); }
  const data = await apiGet(session, `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(query)}&include_reel=true`);
  const result = {
    users: (data.users || []).map(formatUserHit),
    hashtags: (data.hashtags || []).map(formatHashtagHit),
    places: (data.places || []).map(formatPlaceHit),
  };
  saveJson(resolve(CACHE_DIR, `search-${query.toLowerCase().replace(/\W+/g, '_')}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdScoped(session, query, scope) {
  if (!query) { console.error(`Usage: ${scope} <query>`); process.exit(1); }
  const ctxMap = { users: 'user', hashtags: 'hashtag', places: 'place' };
  const data = await apiGet(session, `/api/v1/web/search/topsearch/?context=${ctxMap[scope]}&query=${encodeURIComponent(query)}`);
  let result;
  if (scope === 'users') result = { users: (data.users || []).map(formatUserHit) };
  else if (scope === 'hashtags') result = { hashtags: (data.hashtags || []).map(formatHashtagHit) };
  else result = { places: (data.places || []).map(formatPlaceHit) };
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main
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

function printUsage() {
  console.log(`instagram-search — Instagram top search

Commands:
  top <query>        Blended (users + hashtags + places)
  users <query>      Users only
  hashtags <query>   Hashtags only
  places <query>     Places only

Auth shared with instagram-user.mjs.`);
}

async function main() {
  const { positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional.slice(1).join(' ');

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'top':       await cmdTop(loadSession(), arg1); break;
      case 'users':     await cmdScoped(loadSession(), arg1, 'users'); break;
      case 'hashtags':  await cmdScoped(loadSession(), arg1, 'hashtags'); break;
      case 'places':    await cmdScoped(loadSession(), arg1, 'places'); break;
      default: printUsage();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
