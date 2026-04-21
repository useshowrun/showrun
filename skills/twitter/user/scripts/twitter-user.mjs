#!/usr/bin/env node
// twitter-user.mjs — Twitter/X user operations via GraphQL & v1.1 APIs
//
// Setup (one-time, requires Chrome with x.com open):
//   node twitter-user.mjs auth
//
// Commands:
//   node twitter-user.mjs lookup <handle>                             User profile by @handle
//   node twitter-user.mjs lookup-id <id>                              User profile by numeric ID
//   node twitter-user.mjs tweets <handle|id> [--count=20] [--cursor=X]
//   node twitter-user.mjs replies <handle|id> [--count=20] [--cursor=X]
//   node twitter-user.mjs media <handle|id> [--count=20] [--cursor=X]
//   node twitter-user.mjs likes <handle|id> [--count=20] [--cursor=X]
//   node twitter-user.mjs highlights <handle|id> [--count=20]
//   node twitter-user.mjs follow <handle|id>
//   node twitter-user.mjs unfollow <handle|id>
//   node twitter-user.mjs mute / unmute / block / unblock <handle|id>
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
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
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
    // Try extracting twid from cookies
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

async function v11Post(session, path, formData) {
  const headers = baseHeaders(session);
  headers['content-type'] = 'application/x-www-form-urlencoded';
  const body = new URLSearchParams(formData).toString();
  const resp = await fetch(`https://x.com/i/api/${path}`, { method: 'POST', headers, body });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    if (resp.status === 503) {
      const resp2 = await fetch(`https://x.com/i/api/${path}`, { method: 'POST', headers, body });
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status} after retry`);
      return resp2.json();
    }
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
    url: legacy.url,
    created_at: core.created_at || legacy.created_at,
    followers_count: legacy.followers_count,
    following_count: legacy.friends_count,
    statuses_count: legacy.statuses_count,
    favourites_count: legacy.favourites_count,
    media_count: legacy.media_count,
    listed_count: legacy.listed_count,
    is_blue_verified: result.is_blue_verified,
    profile_image_url: result.avatar?.image_url || legacy.profile_image_url_https,
    profile_banner_url: legacy.profile_banner_url,
  };
}

function formatTweet(tweetResult) {
  const t = tweetResult.result || tweetResult;
  const legacy = t.legacy || {};
  const userLegacy = findAll(t, 'legacy');
  const userCore = findAll(t, 'core');
  return {
    id: t.rest_id,
    text: legacy.full_text,
    created_at: legacy.created_at,
    author: userCore[0]?.screen_name || userLegacy[1]?.screen_name,
    reply_count: legacy.reply_count,
    retweet_count: legacy.retweet_count,
    favorite_count: legacy.favorite_count,
    bookmark_count: legacy.bookmark_count,
    view_count: findAll(t, 'view_count')[0],
    lang: legacy.lang,
    in_reply_to: legacy.in_reply_to_status_id_str,
    is_retweet: !!legacy.retweeted_status_result,
    media: (legacy.entities?.media || []).map(m => ({ type: m.type, url: m.media_url_https })),
  };
}

function parseTimelineEntries(data) {
  const entries = findAll(data, 'entries').find(a => Array.isArray(a) && a.length > 0) || [];
  const tweets = [];
  let nextCursor = null;
  for (const entry of entries) {
    const eid = entry.entryId || '';
    if (eid.startsWith('tweet') || eid.startsWith('profile-conversation') || eid.startsWith('profile-grid')) {
      const tweetResults = findAll(entry, 'tweet_results');
      for (const tr of tweetResults) {
        if (tr.result) tweets.push(formatTweet(tr));
      }
    } else if (eid.startsWith('cursor-bottom') || eid.includes('cursor-bottom')) {
      nextCursor = entry.content?.value || findAll(entry, 'value')[0];
    }
  }
  return { tweets, nextCursor };
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

async function cmdLookup(session, handle) {
  if (!handle) { console.error('Usage: lookup <handle>'); process.exit(1); }
  handle = handle.replace(/^@/, '');

  const cacheFile = resolve(CACHE_DIR, `user-${handle.toLowerCase()}.json`);
  const data = await gqlGet(session, 'NimuplG1OB7Fd2btCLdBOw/UserByScreenName', {
    screen_name: handle, withSafetyModeUserFields: false,
  });
  const result = findAll(data, 'result')[0];
  if (!result?.rest_id) throw new Error(`User not found: ${handle}`);
  const user = formatUser(result);
  saveJson(cacheFile, user);
  console.log(JSON.stringify(user, null, 2));
}

async function cmdLookupId(session, id) {
  if (!id) { console.error('Usage: lookup-id <id>'); process.exit(1); }

  const cacheFile = resolve(CACHE_DIR, `user-id-${id}.json`);
  const data = await gqlGet(session, 'tD8zKvQzwY3kdx5yz6YmOw/UserByRestId', {
    userId: id, withSafetyModeUserFields: true,
  });
  const result = findAll(data, 'result')[0];
  if (!result?.rest_id) throw new Error(`User not found: ${id}`);
  const user = formatUser(result);
  saveJson(cacheFile, user);
  console.log(JSON.stringify(user, null, 2));
}

async function cmdTweets(session, target, flags) {
  if (!target) { console.error('Usage: tweets <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    userId, count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'QWF3SzpHmykQHsQMixG0cg/UserTweets', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `tweets-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdReplies(session, target, flags) {
  if (!target) { console.error('Usage: replies <handle|id> [--count=20] [--cursor=X] [--txn=X] [--hash=X]'); process.exit(1); }

  if (flags.txn) {
    // Direct fetch with user-provided transaction ID (power-user bypass)
    const userId = await resolveUser(session, target);
    const count = parseInt(flags.count || '20', 10);
    const endpointHash = flags.hash || 'Yt1JzwcBsBWYEEi3jMTe2Q';
    const endpointPath = `${endpointHash}/UserTweetsAndReplies`;
    const variables = {
      userId, count,
      includePromotedContent: true,
      withCommunity: true,
      withVoice: true,
    };
    if (flags.cursor) variables.cursor = flags.cursor;

    const qs = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(GQL_FEATURES),
    }).toString();
    const url = `https://x.com/i/api/graphql/${endpointPath}?${qs}`;
    const headers = { ...baseHeaders(session), 'x-client-transaction-id': flags.txn };
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
      if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const { tweets, nextCursor } = parseTimelineEntries(data);
    const cacheFile = resolve(CACHE_DIR, `replies-${userId}-${Date.now()}.json`);
    saveJson(cacheFile, { tweets, nextCursor });
    console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
    return;
  }

  // Intercept response via Chrome CDP
  const screenName = await resolveScreenName(session, target);
  console.error(`Fetching replies for @${screenName} via CDP intercept...`);
  const navigateUrl = `https://x.com/${screenName}/with_replies`;

  try {
    const data = await cdpInterceptResponse('UserTweetsAndReplies', navigateUrl);
    const { tweets, nextCursor } = parseTimelineEntries(data);
    const cacheFile = resolve(CACHE_DIR, `replies-${screenName}-${Date.now()}.json`);
    saveJson(cacheFile, { tweets, nextCursor });
    console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
  } catch (err) {
    console.error(`CDP intercept failed: ${err.message}`);
    console.error('');
    console.error('Make sure Chrome is running with remote debugging enabled and x.com is open.');
    console.error('Alternatively, provide --txn=X from Chrome DevTools Network tab.');
    process.exit(1);
  }
}

async function cmdMedia(session, target, flags) {
  if (!target) { console.error('Usage: media <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    userId, count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, '2tLOJWwGuCTytDrGBg8VwQ/UserMedia', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `media-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdLikes(session, target, flags) {
  if (!target) { console.error('Usage: likes <handle|id> [--count=20] [--cursor=X]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    userId, count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'IohM3gxQHfvWePH5E3KuNA/Likes', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `likes-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdHighlights(session, target, flags) {
  if (!target) { console.error('Usage: highlights <handle|id> [--count=20]'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    userId, count,
    includePromotedContent: true,
    withVoice: true,
  };

  const data = await gqlGet(session, 'tHFm_XZc_NNi-CfUThwbNw/UserHighlightsTweets', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `highlights-${userId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdFollow(session, target) {
  if (!target) { console.error('Usage: follow <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/friendships/create.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

async function cmdUnfollow(session, target) {
  if (!target) { console.error('Usage: unfollow <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/friendships/destroy.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

async function cmdMute(session, target) {
  if (!target) { console.error('Usage: mute <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/mutes/users/create.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

async function cmdUnmute(session, target) {
  if (!target) { console.error('Usage: unmute <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/mutes/users/destroy.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

async function cmdBlock(session, target) {
  if (!target) { console.error('Usage: block <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/blocks/create.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

async function cmdUnblock(session, target) {
  if (!target) { console.error('Usage: unblock <handle|id>'); process.exit(1); }
  const userId = await resolveUser(session, target);
  const data = await v11Post(session, '1.1/blocks/destroy.json', { user_id: userId });
  console.log(JSON.stringify({ ok: true, user_id: userId, screen_name: data.screen_name }, null, 2));
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`twitter-user — Twitter/X user operations

Commands:
  auth                              Extract session from Chrome
  lookup <handle>                   Get user profile by @handle
  lookup-id <id>                    Get user profile by numeric ID
  tweets <handle|id> [--count=20] [--cursor=X]    User tweets
  replies <handle|id> [--count=20] [--cursor=X]   Tweets + replies (via CDP intercept)
  media <handle|id> [--count=20] [--cursor=X]     Media tweets
  likes <handle|id> [--count=20] [--cursor=X]     Liked tweets
  highlights <handle|id> [--count=20]              Highlighted tweets
  follow <handle|id>               Follow user (15/15min limit)
  unfollow <handle|id>             Unfollow user
  mute <handle|id>                 Mute user
  unmute <handle|id>               Unmute user
  block <handle|id>                Block user
  unblock <handle|id>              Unblock user

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

      case 'lookup': {
        const session = loadSession();
        await cmdLookup(session, arg1);
        break;
      }

      case 'lookup-id': {
        const session = loadSession();
        await cmdLookupId(session, arg1);
        break;
      }

      case 'tweets': {
        const session = loadSession();
        await cmdTweets(session, arg1, flags);
        break;
      }

      case 'replies': {
        const session = loadSession();
        await cmdReplies(session, arg1, flags);
        break;
      }

      case 'media': {
        const session = loadSession();
        await cmdMedia(session, arg1, flags);
        break;
      }

      case 'likes': {
        const session = loadSession();
        await cmdLikes(session, arg1, flags);
        break;
      }

      case 'highlights': {
        const session = loadSession();
        await cmdHighlights(session, arg1, flags);
        break;
      }

      case 'follow': {
        const session = loadSession();
        await cmdFollow(session, arg1);
        break;
      }

      case 'unfollow': {
        const session = loadSession();
        await cmdUnfollow(session, arg1);
        break;
      }

      case 'mute': {
        const session = loadSession();
        await cmdMute(session, arg1);
        break;
      }

      case 'unmute': {
        const session = loadSession();
        await cmdUnmute(session, arg1);
        break;
      }

      case 'block': {
        const session = loadSession();
        await cmdBlock(session, arg1);
        break;
      }

      case 'unblock': {
        const session = loadSession();
        await cmdUnblock(session, arg1);
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
