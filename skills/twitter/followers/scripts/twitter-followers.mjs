#!/usr/bin/env node
// twitter-followers.mjs — Twitter/X follower & following operations via GraphQL & v1.1 APIs
//
// Setup (one-time, requires Chrome with x.com open):
//   node twitter-followers.mjs auth
//
// Commands:
//   node twitter-followers.mjs following <handle|id> [--count=20] [--cursor=X]
//   node twitter-followers.mjs followers <handle|id> [--count=20] [--cursor=X] [--txn=X] [--hash=X]
//   node twitter-followers.mjs followers-ids <handle|id> [--count=5000] [--cursor=X]
//   node twitter-followers.mjs following-ids <handle|id> [--count=5000] [--cursor=X]
//   node twitter-followers.mjs verified <handle|id> [--count=20] [--cursor=X]
//   node twitter-followers.mjs mutuals <handle|id> [--count=20] [--cursor=X]
//   node twitter-followers.mjs fetch-all <handle|id> [--type=following] [--max-pages=50]
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/twitter');
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
  if (!s || !s.cookie || !s.ct0) {
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
// CDP WebSocket client for endpoint capture
// ---------------------------------------------------------------------------

class MiniCDP {
  #ws; #id = 0; #pending = new Map(); #listeners = [];
  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WS error: ' + (e.message || e.type)));
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          this.#pending.get(msg.id)(msg);
          this.#pending.delete(msg.id);
        }
        if (msg.method) {
          for (const [m, cb] of this.#listeners) if (msg.method === m) cb(msg.params, msg.sessionId);
        }
      };
    });
  }
  async send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      this.#pending.set(id, res);
      this.#ws.send(JSON.stringify(msg));
    });
  }
  on(method, cb) { this.#listeners.push([method, cb]); }
  off(method, cb) { this.#listeners = this.#listeners.filter(([m, c]) => !(m === method && c === cb)); }
  close() { this.#ws.close(); }
}

function getBrowserWsUrl() {
  const candidates = [
    resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    resolve(homedir(), '.config/google-chrome/DevToolsActivePort'),
  ];
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) return null;
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

/**
 * Navigate Chrome to a URL and intercept a GraphQL response.
 * This is needed for endpoints that require x-client-transaction-id,
 * which is single-use and cannot be replayed.
 */
async function cdpInterceptResponse(endpointPattern, navigateUrl) {
  const browserWsUrl = getBrowserWsUrl();
  if (!browserWsUrl) throw new Error('Chrome DevToolsActivePort not found. Is Chrome running with debugging?');

  const cdpWs = new MiniCDP();
  await cdpWs.connect(browserWsUrl);

  // Find existing x.com tab or create one
  const { result: { targetInfos } } = await cdpWs.send('Target.getTargets');
  const xTab = targetInfos.find(t => t.url?.includes('x.com') && t.type === 'page');

  let targetId, createdTab = false;
  if (xTab) {
    targetId = xTab.targetId;
  } else {
    const r = await cdpWs.send('Target.createTarget', { url: 'https://x.com' });
    targetId = r.result.targetId;
    createdTab = true;
    await new Promise(r => setTimeout(r, 5000)); // wait for page load
  }

  const { result: { sessionId } } = await cdpWs.send('Target.attachToTarget', { targetId, flatten: true });
  await cdpWs.send('Network.enable', {}, sessionId);

  const responseBody = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${endpointPattern} response`)), 25000);
    let targetRequestId = null;

    const reqHandler = (params, sid) => {
      if (sid !== sessionId) return;
      const url = params.request?.url || '';
      if (url.includes('/graphql/') && url.includes(endpointPattern)) {
        targetRequestId = params.requestId;
      }
    };

    const doneHandler = (params, sid) => {
      if (sid !== sessionId || params.requestId !== targetRequestId) return;
      cdpWs.send('Network.getResponseBody', { requestId: targetRequestId }, sessionId)
        .then(result => {
          clearTimeout(timeout);
          cdpWs.off('Network.requestWillBeSent', reqHandler);
          cdpWs.off('Network.loadingFinished', doneHandler);
          resolve(result.result.body);
        })
        .catch(reject);
    };

    cdpWs.on('Network.requestWillBeSent', reqHandler);
    cdpWs.on('Network.loadingFinished', doneHandler);
    cdpWs.send('Page.navigate', { url: navigateUrl }, sessionId);
  });

  await cdpWs.send('Network.disable', {}, sessionId);
  await cdpWs.send('Target.detachFromTarget', { sessionId });
  if (createdTab) await cdpWs.send('Target.closeTarget', { targetId });
  cdpWs.close();

  return JSON.parse(responseBody);
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome x.com tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.error('Finding x.com tab...');
  const list = cdp('list');
  let tabId;
  for (const line of list.split('\n')) {
    if (line.includes('x.com') || line.includes('twitter.com')) {
      tabId = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!tabId) {
    console.error('No x.com / twitter.com tab found. Open x.com in Chrome first.');
    process.exit(1);
  }
  console.error(`Found tab: ${tabId}`);

  const raw = cdp('evalraw', tabId, 'Network.getCookies', JSON.stringify({ urls: ['https://x.com'] }));
  const parsed = JSON.parse(raw);
  const cookies = parsed.cookies || [];

  let authToken = '', ct0 = '';
  for (const c of cookies) {
    if (c.name === 'auth_token') authToken = c.value;
    if (c.name === 'ct0') ct0 = c.value;
  }
  if (!authToken || !ct0) {
    console.error('Could not find auth_token and ct0 cookies. Are you logged in to x.com?');
    process.exit(1);
  }

  // Get current user ID from the page
  let userId = '';
  try {
    const metatag = cdp('eval', tabId, 'document.cookie');
    const twidMatch = metatag.match(/twid=u%3D(\d+)/);
    if (twidMatch) userId = twidMatch[1];
  } catch { /* optional */ }

  const session = {
    cookie: `auth_token=${authToken}; ct0=${ct0}`,
    ct0,
    userId,
    capturedAt: new Date().toISOString(),
  };

  ensureDir(DATA_DIR);
  saveJson(SESSION_FILE, session);
  console.error('Session saved.');

  console.log(JSON.stringify({ ok: true, userId, capturedAt: session.capturedAt }));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function baseHeaders(session) {
  return {
    'accept': '*/*',
    'authorization': BEARER,
    'content-type': 'application/json',
    'cookie': session.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'x-csrf-token': session.ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
  };
}

const GQL_FEATURES = {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false};

async function gqlGet(session, path, variables, features = GQL_FEATURES) {
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  }).toString();
  const url = `https://x.com/i/api/graphql/${path}?${qs}`;
  const resp = await fetch(url, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

async function v11Get(session, path, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://x.com/i/api/${path}?${qs}`;
  const headers = baseHeaders(session);
  delete headers['content-type'];
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function findAll(obj, key) {
  const results = [];
  if (obj && typeof obj === 'object') {
    if (key in obj) results.push(obj[key]);
    for (const v of Object.values(obj)) results.push(...findAll(v, key));
  }
  return results;
}

async function resolveUser(session, handleOrId) {
  if (/^\d+$/.test(handleOrId)) return handleOrId;
  const handle = handleOrId.replace(/^@/, '');
  const data = await gqlGet(session, 'NimuplG1OB7Fd2btCLdBOw/UserByScreenName', {
    screen_name: handle, withSafetyModeUserFields: false,
  });
  const result = findAll(data, 'result')[0];
  if (!result?.rest_id) throw new Error(`User not found: ${handle}`);
  return result.rest_id;
}

async function resolveScreenName(session, handleOrId) {
  if (/^\d+$/.test(handleOrId)) {
    // Look up screen_name from user ID
    const data = await gqlGet(session, 'tD8zKvQzwY3kdx5yz6YmOw/UserByRestId', {
      userId: handleOrId, withSafetyModeUserFields: true,
    });
    const result = findAll(data, 'result')[0];
    if (!result?.legacy?.screen_name) throw new Error(`User not found: ${handleOrId}`);
    return result.legacy.screen_name;
  }
  return handleOrId.replace(/^@/, '');
}

function formatUser(result) {
  const legacy = result.legacy || {};
  const core = result.core || {};
  return {
    id: result.rest_id,
    name: core.name || legacy.name,
    screen_name: core.screen_name || legacy.screen_name,
    description: legacy.description,
    location: legacy.location,
    followers_count: legacy.followers_count,
    following_count: legacy.friends_count,
    statuses_count: legacy.statuses_count,
    is_blue_verified: result.is_blue_verified,
    profile_image_url: result.avatar?.image_url || legacy.profile_image_url_https,
  };
}

function parseUserEntries(data) {
  const entries = findAll(data, 'entries').find(a => Array.isArray(a) && a.length > 0) || [];
  const users = [];
  let nextCursor = null;
  for (const entry of entries) {
    const eid = entry.entryId || '';
    if (eid.startsWith('user')) {
      const userResults = findAll(entry, 'user_results');
      for (const ur of userResults) {
        if (ur.result && ur.result.__typename !== 'UserUnavailable') {
          users.push(formatUser(ur.result));
        }
      }
    } else if (eid.includes('cursor-bottom')) {
      nextCursor = entry.content?.value || findAll(entry, 'value')[0];
    }
  }
  return { users, nextCursor };
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

async function cmdFollowing(session, target, flags) {
  if (!target) { console.error('Usage: following <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = { userId, count, includePromotedContent: false };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, '2vUj-_Ek-UmBVDNtd8OnQA/Following', variables);
  const { users, nextCursor } = parseUserEntries(data);

  const cacheFile = resolve(CACHE_DIR, `following-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { users, nextCursor });
  console.log(JSON.stringify({ users, nextCursor }, null, 2));
}

async function cmdFollowers(session, target, flags) {
  if (!target) { console.error('Usage: followers <handle|id> [--count=20] [--cursor=X] [--txn=X] [--hash=X]'); process.exit(1); }

  if (flags.txn) {
    // Direct fetch with user-provided transaction ID (power-user bypass)
    const userId = await resolveUser(session, target);
    const count = parseInt(flags.count || '20', 10);
    const hash = flags.hash || '-WcGoRt8IQuPm-l1ymgy6g';
    const path = `${hash}/Followers`;
    const variables = { userId, count, includePromotedContent: false };
    if (flags.cursor) variables.cursor = flags.cursor;

    const qs = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(GQL_FEATURES),
    }).toString();
    const url = `https://x.com/i/api/graphql/${path}?${qs}`;
    const headers = { ...baseHeaders(session), 'x-client-transaction-id': flags.txn };
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
      if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const { users, nextCursor } = parseUserEntries(data);

    const cacheFile = resolve(CACHE_DIR, `followers-${userId}-${Date.now()}.json`);
    saveJson(cacheFile, { users, nextCursor });
    console.log(JSON.stringify({ users, nextCursor }, null, 2));
    return;
  }

  // Intercept response via Chrome CDP
  const screenName = await resolveScreenName(session, target);
  console.error(`Fetching followers for @${screenName} via CDP intercept...`);
  const navigateUrl = `https://x.com/${screenName}/followers`;

  try {
    const data = await cdpInterceptResponse('Followers', navigateUrl);
    const { users, nextCursor } = parseUserEntries(data);

    const cacheFile = resolve(CACHE_DIR, `followers-${screenName}-${Date.now()}.json`);
    saveJson(cacheFile, { users, nextCursor });
    console.log(JSON.stringify({ users, nextCursor }, null, 2));
  } catch (err) {
    console.error(`CDP intercept failed: ${err.message}`);
    console.error('Falling back to followers-ids (returns numeric IDs only)...');
    console.error('');
    const count = parseInt(flags.count || '20', 10);
    await cmdFollowerIds(session, target, { count: String(count), ...flags });
  }
}

async function cmdFollowerIds(session, target, flags) {
  if (!target) { console.error('Usage: followers-ids <handle|id> [--count=5000] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '5000', 10);
  const params = { user_id: userId, count: String(count), stringify_ids: 'true' };
  if (flags.cursor) params.cursor = flags.cursor;

  try {
    const data = await v11Get(session, '1.1/followers/ids.json', params);

    const result = {
      ids: data.ids || [],
      next_cursor: String(data.next_cursor || '0'),
    };

    const cacheFile = resolve(CACHE_DIR, `follower-ids-${userId}-${Date.now()}.json`);
    saveJson(cacheFile, result);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err.message.includes('404')) {
      console.error('The v1.1 followers/ids endpoint is no longer available (404).');
      console.error('Use the "followers" command instead, which uses Chrome CDP intercept.');
      console.error('  Example: node twitter-followers.mjs followers ' + target);
      process.exit(1);
    }
    throw err;
  }
}

async function cmdFollowingIds(session, target, flags) {
  if (!target) { console.error('Usage: following-ids <handle|id> [--count=5000] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '5000', 10);
  const params = { user_id: userId, count: String(count), stringify_ids: 'true' };
  if (flags.cursor) params.cursor = flags.cursor;

  try {
    const data = await v11Get(session, '1.1/friends/ids.json', params);

    const result = {
      ids: data.ids || [],
      next_cursor: String(data.next_cursor || '0'),
    };

    const cacheFile = resolve(CACHE_DIR, `following-ids-${userId}-${Date.now()}.json`);
    saveJson(cacheFile, result);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err.message.includes('404')) {
      console.error('The v1.1 friends/ids endpoint is no longer available (404).');
      console.error('Use the "following" command instead, which works via GraphQL.');
      console.error('  Example: node twitter-followers.mjs following ' + target);
      process.exit(1);
    }
    throw err;
  }
}

async function cmdVerified(session, target, flags) {
  if (!target) { console.error('Usage: verified <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = { userId, count, includePromotedContent: false };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'VmIlPJNEDVQ29HfzIhV4mw/BlueVerifiedFollowers', variables);
  const { users, nextCursor } = parseUserEntries(data);

  const cacheFile = resolve(CACHE_DIR, `verified-followers-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { users, nextCursor });
  console.log(JSON.stringify({ users, nextCursor }, null, 2));
}

async function cmdMutuals(session, target, flags) {
  if (!target) { console.error('Usage: mutuals <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = { userId, count, includePromotedContent: false };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'f2tbuGNjfOE8mNUO5itMew/FollowersYouKnow', variables);
  const { users, nextCursor } = parseUserEntries(data);

  const cacheFile = resolve(CACHE_DIR, `mutuals-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { users, nextCursor });
  console.log(JSON.stringify({ users, nextCursor }, null, 2));
}

async function cmdFetchAll(session, target, flags) {
  if (!target) { console.error('Usage: fetch-all <handle|id> [--type=following] [--max-pages=50]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const type = flags.type || 'following';
  const maxPages = parseInt(flags['max-pages'] || '50', 10);

  const validTypes = ['following', 'followers-ids', 'verified', 'mutuals', 'following-ids'];
  if (!validTypes.includes(type)) {
    console.error(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  // For full followers data, require --txn
  if (type === 'followers' && !flags.txn) {
    console.error('fetch-all with --type=followers requires --txn flag. Use --type=followers-ids instead.');
    process.exit(1);
  }

  let allItems = [];
  let cursor = flags.cursor || null;
  let page = 0;

  console.error(`Fetching all ${type} for user ${userId}...`);

  while (page < maxPages) {
    page++;
    console.error(`  Page ${page}...`);

    if (type === 'following') {
      const count = 20;
      const variables = { userId, count, includePromotedContent: false };
      if (cursor) variables.cursor = cursor;
      const data = await gqlGet(session, '2vUj-_Ek-UmBVDNtd8OnQA/Following', variables);
      const { users, nextCursor } = parseUserEntries(data);
      allItems.push(...users);
      cursor = nextCursor;
      console.error(`    Got ${users.length} users (total: ${allItems.length})`);
    } else if (type === 'followers-ids') {
      const params = { user_id: userId, count: '5000', stringify_ids: 'true' };
      if (cursor) params.cursor = cursor;
      const data = await v11Get(session, '1.1/followers/ids.json', params);
      const ids = data.ids || [];
      allItems.push(...ids);
      cursor = String(data.next_cursor || '0');
      console.error(`    Got ${ids.length} IDs (total: ${allItems.length})`);
      if (cursor === '0') cursor = null;
    } else if (type === 'following-ids') {
      const params = { user_id: userId, count: '5000', stringify_ids: 'true' };
      if (cursor) params.cursor = cursor;
      const data = await v11Get(session, '1.1/friends/ids.json', params);
      const ids = data.ids || [];
      allItems.push(...ids);
      cursor = String(data.next_cursor || '0');
      console.error(`    Got ${ids.length} IDs (total: ${allItems.length})`);
      if (cursor === '0') cursor = null;
    } else if (type === 'verified') {
      const count = 20;
      const variables = { userId, count, includePromotedContent: false };
      if (cursor) variables.cursor = cursor;
      const data = await gqlGet(session, 'VmIlPJNEDVQ29HfzIhV4mw/BlueVerifiedFollowers', variables);
      const { users, nextCursor } = parseUserEntries(data);
      allItems.push(...users);
      cursor = nextCursor;
      console.error(`    Got ${users.length} users (total: ${allItems.length})`);
    } else if (type === 'mutuals') {
      const count = 20;
      const variables = { userId, count, includePromotedContent: false };
      if (cursor) variables.cursor = cursor;
      const data = await gqlGet(session, 'f2tbuGNjfOE8mNUO5itMew/FollowersYouKnow', variables);
      const { users, nextCursor } = parseUserEntries(data);
      allItems.push(...users);
      cursor = nextCursor;
      console.error(`    Got ${users.length} users (total: ${allItems.length})`);
    }

    if (!cursor) {
      console.error('  No more pages.');
      break;
    }

    // Respectful delay between pages
    if (page < maxPages) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (page >= maxPages && cursor) {
    console.error(`  Stopped at max-pages (${maxPages}). More data available.`);
  }

  const cacheFile = resolve(CACHE_DIR, `${type}-all-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, allItems);
  console.error(`Saved ${allItems.length} items to ${cacheFile}`);
  console.log(JSON.stringify({ total: allItems.length, type, userId, cacheFile }, null, 2));
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`twitter-followers — Twitter/X follower & following operations

Commands:
  auth                                            Extract session from Chrome
  following <handle|id> [--count=20] [--cursor=X] Who user follows
  followers <handle|id> [--count=20] [--cursor=X] Followers (needs --txn)
    --txn=X                                       Transaction ID from Chrome
    --hash=X                                      Override endpoint hash
  followers-ids <handle|id> [--count=5000]         Follower IDs (no Chrome needed)
  following-ids <handle|id> [--count=5000]         Following IDs (no Chrome needed)
  verified <handle|id> [--count=20]               Verified followers
  mutuals <handle|id> [--count=20]                Followers you know
  fetch-all <handle|id> [--type=following]        Paginate through all pages
    --type=following|followers-ids|verified|mutuals
    --max-pages=50

Session: ~/.local/share/showrun/data/twitter/session.json`);
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
      case 'auth':
        await doAuth();
        break;

      case 'following': {
        const session = loadSession();
        await cmdFollowing(session, arg1, flags);
        break;
      }

      case 'followers': {
        const session = loadSession();
        await cmdFollowers(session, arg1, flags);
        break;
      }

      case 'followers-ids': {
        const session = loadSession();
        await cmdFollowerIds(session, arg1, flags);
        break;
      }

      case 'following-ids': {
        const session = loadSession();
        await cmdFollowingIds(session, arg1, flags);
        break;
      }

      case 'verified': {
        const session = loadSession();
        await cmdVerified(session, arg1, flags);
        break;
      }

      case 'mutuals': {
        const session = loadSession();
        await cmdMutuals(session, arg1, flags);
        break;
      }

      case 'fetch-all': {
        const session = loadSession();
        await cmdFetchAll(session, arg1, flags);
        break;
      }

      default:
        printUsage();
        break;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
