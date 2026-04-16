#!/usr/bin/env node
// twitter-feed.mjs — Twitter/X timeline, notifications, DMs, lists & communities
//
// Setup (one-time, requires Chrome with x.com open):
//   node twitter-feed.mjs auth
//
// Commands:
//   node twitter-feed.mjs timeline [--count=20] [--cursor=X]
//   node twitter-feed.mjs latest [--count=20] [--cursor=X]
//   node twitter-feed.mjs notifications [--type=all|mentions|verified] [--count=20] [--cursor=X]
//   node twitter-feed.mjs dm-inbox [--count=50]
//   node twitter-feed.mjs dm-history <conv_id> [--count=50] [--cursor=X]
//   node twitter-feed.mjs dm-send <user_id> <text>
//   node twitter-feed.mjs lists [--count=20] [--cursor=X]
//   node twitter-feed.mjs list <list_id>
//   node twitter-feed.mjs list-tweets <list_id> [--count=20] [--cursor=X]
//   node twitter-feed.mjs list-members <list_id> [--count=20] [--cursor=X]
//   node twitter-feed.mjs communities [--query=X]
//   node twitter-feed.mjs community <community_id>
//   node twitter-feed.mjs community-tweets <community_id> [--count=20] [--cursor=X]
//   node twitter-feed.mjs geo <query>
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
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

async function gqlPost(session, path, variables, features = GQL_FEATURES) {
  const queryId = path.split('/')[0];
  const payload = JSON.stringify({ variables, queryId, features });
  const resp = await fetch(`https://x.com/i/api/graphql/${path}`, {
    method: 'POST',
    headers: baseHeaders(session),
    body: payload,
  });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

async function v11Get(session, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://x.com/i/api/${path}?${qs}`;
  const resp = await fetch(url, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

async function v11Post(session, path, jsonBody) {
  const resp = await fetch(`https://x.com/i/api/${path}`, {
    method: 'POST',
    headers: baseHeaders(session),
    body: JSON.stringify(jsonBody),
  });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
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
    if (eid.startsWith('tweet') || eid.startsWith('profile-conversation') || eid.startsWith('profile-grid') || eid.startsWith('list-conversation') || eid.startsWith('community-conversation')) {
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

async function cmdTimeline(session, flags) {
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    count,
    includePromotedContent: true,
    latestControlAvailable: true,
    requestContext: 'launch',
    withCommunity: true,
    seenTweetIds: [],
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlPost(session, '-X_hcgQzmHGl29-UXxz4sw/HomeTimeline', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `timeline-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdLatest(session, flags) {
  const count = parseInt(flags.count || '20', 10);
  const variables = {
    count,
    includePromotedContent: true,
    latestControlAvailable: true,
    requestContext: 'launch',
    withCommunity: true,
    seenTweetIds: [],
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlPost(session, 'U0cdisy7QFIoTfu3-Okw0A/HomeLatestTimeline', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `latest-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdNotifications(session, flags) {
  const type = flags.type || 'all';
  const count = parseInt(flags.count || '20', 10);

  const endpointMap = {
    all: '2/notifications/all.json',
    mentions: '2/notifications/mentions.json',
    verified: '2/notifications/verified.json',
  };
  const endpoint = endpointMap[type];
  if (!endpoint) {
    console.error(`Invalid notification type: ${type}. Use: all, mentions, verified`);
    process.exit(1);
  }

  const params = { count: String(count) };
  if (flags.cursor) params.cursor = flags.cursor;

  const data = await v11Get(session, endpoint, params);

  // Parse globalObjects for tweets, users, notifications
  const globalObjects = data.globalObjects || {};
  const rawTweets = globalObjects.tweets || {};
  const rawUsers = globalObjects.users || {};
  const rawNotifications = globalObjects.notifications || {};

  const notifications = [];
  for (const [id, notif] of Object.entries(rawNotifications)) {
    const item = {
      id,
      message: notif.message?.text || '',
      timestamp_ms: notif.timestampMs,
      icon: notif.icon?.id,
    };

    // Attach associated users
    if (notif.template?.aggregateUserActionsV1?.fromUsers) {
      const userIds = findAll(notif.template.aggregateUserActionsV1.fromUsers, 'userId');
      item.from_users = userIds.map(uid => {
        const u = rawUsers[uid];
        return u ? { id: uid, name: u.name, screen_name: u.screen_name } : { id: uid };
      });
    }

    // Attach associated tweet
    if (notif.template?.aggregateUserActionsV1?.targetObjects) {
      const tweetIds = findAll(notif.template.aggregateUserActionsV1.targetObjects, 'tweetId');
      if (tweetIds.length > 0) {
        const tw = rawTweets[tweetIds[0]];
        if (tw) {
          item.tweet = {
            id: tw.id_str,
            text: tw.full_text,
            user: rawUsers[tw.user_id_str]?.screen_name,
          };
        }
      }
    }

    notifications.push(item);
  }

  // Sort by timestamp descending
  notifications.sort((a, b) => (b.timestamp_ms || '0').localeCompare(a.timestamp_ms || '0'));

  // Extract cursor for pagination
  const timeline = data.timeline || {};
  const instructions = timeline.instructions || [];
  let nextCursor = null;
  for (const instr of instructions) {
    const entries = instr.addEntries?.entries || [];
    for (const entry of entries) {
      if (entry.entryId?.includes('cursor-bottom')) {
        nextCursor = entry.content?.operation?.cursor?.value;
      }
    }
  }

  const result = { notifications, nextCursor };
  const cacheFile = resolve(CACHE_DIR, `notifications-${type}-${Date.now()}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDmInbox(session, flags) {
  const count = parseInt(flags.count || '50', 10);
  const data = await v11Get(session, '1.1/dm/inbox_initial_state.json', {});

  const state = data.inbox_initial_state || {};
  const conversations = state.conversations || {};
  const entries = state.entries || [];
  const users = state.users || {};

  const convList = [];
  for (const [convId, conv] of Object.entries(conversations)) {
    const participants = (conv.participants || []).map(p => {
      const u = users[p.user_id];
      return {
        user_id: p.user_id,
        name: u?.name,
        screen_name: u?.screen_name,
      };
    });

    // Find last message for this conversation
    let lastMessage = null;
    for (const entry of entries) {
      const msg = entry.message;
      if (msg && msg.conversation_id === convId) {
        if (!lastMessage || (msg.time > (lastMessage.time || ''))) {
          lastMessage = {
            id: msg.id,
            time: msg.time,
            sender_id: msg.message_data?.sender_id,
            text: msg.message_data?.text,
          };
        }
      }
    }

    convList.push({
      conversation_id: convId,
      type: conv.type,
      name: conv.name || undefined,
      sort_timestamp: conv.sort_timestamp,
      participants,
      last_message: lastMessage,
      unread: conv.status !== 'HAS_BEEN_ACCEPTED' ? conv.status : undefined,
    });
  }

  // Sort by sort_timestamp descending
  convList.sort((a, b) => (b.sort_timestamp || '0').localeCompare(a.sort_timestamp || '0'));

  const result = { conversations: convList.slice(0, count) };
  const cacheFile = resolve(CACHE_DIR, `dm-inbox-${Date.now()}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDmHistory(session, conversationId, flags) {
  if (!conversationId) {
    console.error('Usage: dm-history <conversation_id> [--count=50] [--cursor=X]');
    process.exit(1);
  }

  const count = parseInt(flags.count || '50', 10);
  const params = { count: String(count) };
  if (flags.cursor) params.max_id = flags.cursor;

  const data = await v11Get(session, `1.1/dm/conversation/${conversationId}.json`, params);

  const state = data.conversation_timeline || {};
  const entries = state.entries || [];
  const users = state.users || {};

  const messages = [];
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg) continue;
    const md = msg.message_data || {};
    const sender = users[md.sender_id];
    messages.push({
      id: msg.id,
      time: msg.time,
      sender_id: md.sender_id,
      sender_name: sender?.name,
      sender_screen_name: sender?.screen_name,
      text: md.text,
      media: md.attachment?.media ? {
        type: md.attachment.media.type,
        url: md.attachment.media.media_url_https,
      } : undefined,
    });
  }

  // Extract cursor
  let nextCursor = null;
  const status = state.status;
  if (status === 'HAS_MORE') {
    // min_entry_id is the cursor for older messages
    nextCursor = state.min_entry_id;
  }

  const result = { messages, nextCursor };
  const cacheFile = resolve(CACHE_DIR, `dm-history-${conversationId}-${Date.now()}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDmSend(session, target, text) {
  if (!target || !text) {
    console.error('Usage: dm-send <user_id|conversation_id> <text>');
    process.exit(1);
  }

  const myId = session.userId;
  if (!myId) {
    console.error('Session missing userId. Re-run: auth');
    process.exit(1);
  }

  // Detect if target is a conversation ID (group DM) or a user ID
  // Group conversation IDs are long numeric strings (not containing '-')
  // 1-on-1 conversation IDs are built from two user IDs: "lower-higher"
  let conversationId;
  const isGroupOrConvId = target.includes('-') || target.length > 16;
  if (target.includes('-')) {
    // Already a conversation ID (e.g. "173806600-123456789")
    conversationId = target;
  } else if (target.length > 16) {
    // Likely a group conversation ID (long numeric)
    conversationId = target;
  } else {
    // User ID — build 1-on-1 conversation ID
    const ids = [myId, target].sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : 1;
    });
    conversationId = `${ids[0]}-${ids[1]}`;
  }

  const body = {
    conversation_id: conversationId,
    recipient_ids: false,
    request_id: `${randomUUID()}-${Date.now()}`,
    text,
    cards_platform: 'Web-12',
    include_cards: 1,
    include_quote_count: true,
    dm_users: false,
  };

  const data = await v11Post(session, '1.1/dm/new2.json', body);

  const result = {
    ok: true,
    conversation_id: conversationId,
    target,
  };

  // Extract message details from response if available
  const entries = data.entries || [];
  if (entries.length > 0) {
    const msg = entries[0].message;
    if (msg) {
      result.message_id = msg.id;
      result.time = msg.time;
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

async function cmdLists(session, flags) {
  const count = parseInt(flags.count || '20', 10);
  const variables = { count };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, '47170qwZCt5aFo9cBwFoNA/ListsManagementPageTimeline', variables);

  // Parse list entries
  const entries = findAll(data, 'entries').find(a => Array.isArray(a) && a.length > 0) || [];
  const lists = [];
  let nextCursor = null;
  for (const entry of entries) {
    const eid = entry.entryId || '';
    if (eid.includes('cursor-bottom')) {
      nextCursor = entry.content?.value || findAll(entry, 'value')[0];
    } else {
      const listResults = findAll(entry, 'list');
      for (const l of listResults) {
        if (l.id_str || l.id) {
          lists.push({
            id: l.id_str || l.id,
            name: l.name,
            description: l.description,
            member_count: l.member_count,
            subscriber_count: l.subscriber_count,
            mode: l.mode,
            created_at: l.created_at,
          });
        }
      }
    }
  }

  const result = { lists, nextCursor };
  const cacheFile = resolve(CACHE_DIR, `lists-${Date.now()}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdList(session, listId) {
  if (!listId) {
    console.error('Usage: list <list_id>');
    process.exit(1);
  }

  const data = await gqlGet(session, '9hbYpeVBMq8-yB8slayGWQ/ListByRestId', { listId });

  const list = findAll(data, 'list')[0];
  if (!list) throw new Error(`List not found: ${listId}`);

  const result = {
    id: list.id_str || list.id,
    name: list.name,
    description: list.description,
    member_count: list.member_count,
    subscriber_count: list.subscriber_count,
    mode: list.mode,
    created_at: list.created_at,
    following: list.following,
  };

  // Include owner info if available
  const userResults = findAll(data, 'user_results');
  if (userResults.length > 0 && userResults[0].result) {
    const owner = userResults[0].result;
    result.owner = {
      id: owner.rest_id,
      name: owner.legacy?.name,
      screen_name: owner.legacy?.screen_name,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `list-${listId}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdListTweets(session, listId, flags) {
  if (!listId) {
    console.error('Usage: list-tweets <list_id> [--count=20] [--cursor=X]');
    process.exit(1);
  }

  const count = parseInt(flags.count || '20', 10);
  const variables = { listId, count };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'HjsWc-nwwHKYwHenbHm-tw/ListLatestTweetsTimeline', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `list-tweets-${listId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdListMembers(session, listId, flags) {
  if (!listId) {
    console.error('Usage: list-members <list_id> [--count=20] [--cursor=X]');
    process.exit(1);
  }

  const count = parseInt(flags.count || '20', 10);
  const variables = { listId, count };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'BQp2IEYkgxuSxqbTAr1e1g/ListMembers', variables);
  const { users, nextCursor } = parseUserEntries(data);

  const cacheFile = resolve(CACHE_DIR, `list-members-${listId}-${Date.now()}.json`);
  saveJson(cacheFile, { users, nextCursor });
  console.log(JSON.stringify({ users, nextCursor }, null, 2));
}

async function cmdCommunities(session, flags) {
  const communityFeatures = {
    ...GQL_FEATURES,
    c9s_list_members_action_api_enabled: false,
    c9s_superc9s_indication_enabled: false,
  };

  let data;
  if (flags.query) {
    data = await gqlGet(session, 'daVUkhfHn7-Z8llpYVKJSw/CommunitiesSearchQuery', { query: flags.query }, communityFeatures);
  } else {
    data = await gqlGet(session, '4-4iuIdaLPpmxKnA3mr2LA/CommunitiesMainPageTimeline', { count: 20, withCommunity: true }, communityFeatures);
  }

  // Parse communities from response
  // Search: data.communities_search_slice.items_results[].result
  // Main page: uses timeline entries with community_results
  const communities = [];
  const itemsResults = findAll(data, 'items_results').find(a => Array.isArray(a) && a.length > 0) || [];
  for (const item of itemsResults) {
    const c = item.result || item;
    if (c.id_str || c.rest_id || c.name) {
      communities.push({
        id: c.id_str || c.rest_id,
        name: c.name,
        description: c.description,
        member_count: c.member_count,
        created_at: c.created_at,
        role: c.role,
        is_member: c.is_member,
      });
    }
  }
  // Fallback: try community_results key (for main page timeline)
  if (communities.length === 0) {
    const communityResults = findAll(data, 'community_results');
    for (const cr of communityResults) {
      const c = cr.result || cr;
      if (c.id_str || c.rest_id) {
        communities.push({
          id: c.id_str || c.rest_id,
          name: c.name,
          description: c.description,
          member_count: c.member_count,
        });
      }
    }
  }

  const result = { communities };
  const cacheFile = resolve(CACHE_DIR, `communities-${Date.now()}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCommunity(session, communityId) {
  if (!communityId) {
    console.error('Usage: community <community_id>');
    process.exit(1);
  }

  const communityFeatures = {
    ...GQL_FEATURES,
    c9s_list_members_action_api_enabled: false,
    c9s_superc9s_indication_enabled: false,
  };

  const data = await gqlGet(session, 'lUBKrilodgg9Nikaw3cIiA/CommunityQuery', { communityId }, communityFeatures);

  const communityResults = findAll(data, 'community_results');
  const c = communityResults[0]?.result || communityResults[0] || {};

  const result = {
    id: c.id_str || c.rest_id,
    name: c.name,
    description: c.description,
    member_count: c.member_count,
    moderator_count: c.moderator_count,
    created_at: c.created_at,
    role: c.role,
    is_member: c.is_member,
    rules: c.rules,
  };

  // Include admin info if available
  const adminResults = findAll(c, 'admin_results');
  if (adminResults.length > 0 && adminResults[0].result) {
    const admin = adminResults[0].result;
    result.admin = {
      id: admin.rest_id,
      name: admin.legacy?.name,
      screen_name: admin.legacy?.screen_name,
    };
  }

  const cacheFile = resolve(CACHE_DIR, `community-${communityId}.json`);
  saveJson(cacheFile, result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCommunityTweets(session, communityId, flags) {
  if (!communityId) {
    console.error('Usage: community-tweets <community_id> [--count=20] [--cursor=X]');
    process.exit(1);
  }

  const count = parseInt(flags.count || '20', 10);
  const variables = {
    communityId,
    count,
    withCommunity: true,
    rankingMode: 'Recency',
  };
  if (flags.cursor) variables.cursor = flags.cursor;

  const data = await gqlGet(session, 'mhwSsmub4JZgHcs0dtsjrw/CommunityTweetsTimeline', variables);
  const { tweets, nextCursor } = parseTimelineEntries(data);

  const cacheFile = resolve(CACHE_DIR, `community-tweets-${communityId}-${Date.now()}.json`);
  saveJson(cacheFile, { tweets, nextCursor });
  console.log(JSON.stringify({ tweets, nextCursor }, null, 2));
}

async function cmdGeo(session, query) {
  if (!query) {
    console.error('Usage: geo <query>');
    process.exit(1);
  }

  const data = await v11Get(session, '1.1/geo/search.json', {
    query,
    granularity: 'city',
  });

  const places = (data.result?.places || []).map(p => ({
    id: p.id,
    name: p.name,
    full_name: p.full_name,
    country: p.country,
    country_code: p.country_code,
    place_type: p.place_type,
    centroid: p.centroid,
    bounding_box: p.bounding_box,
  }));

  console.log(JSON.stringify({ places }, null, 2));
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`twitter-feed — Twitter/X timeline, notifications, DMs, lists & communities

Commands:
  auth                                      Extract session from Chrome
  timeline [--count=20] [--cursor=X]        Home timeline (algorithmic)
  latest [--count=20] [--cursor=X]          Latest timeline (chronological)
  notifications [--type=all] [--count=20]   Notifications (all|mentions|verified)
  dm-inbox                                  DM inbox overview
  dm-history <conv_id> [--count=50]         DM conversation
  dm-send <user_id|conv_id> <text>           Send DM (user ID or group conv ID)
  lists [--count=20]                        Your lists
  list <list_id>                            List info
  list-tweets <list_id> [--count=20]        Tweets in a list
  list-members <list_id> [--count=20]       List members
  communities [--query=X]                   Search/browse communities
  community <community_id>                  Community details
  community-tweets <community_id>           Community tweets
  geo <query>                               Search places

Session: ~/.local/share/showrun/data/twitter/session.json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const arg1 = positional[1];
  const arg2 = positional.slice(2).join(' ');

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'auth':
        await doAuth();
        break;

      case 'timeline': {
        const session = loadSession();
        await cmdTimeline(session, flags);
        break;
      }

      case 'latest': {
        const session = loadSession();
        await cmdLatest(session, flags);
        break;
      }

      case 'notifications': {
        const session = loadSession();
        await cmdNotifications(session, flags);
        break;
      }

      case 'dm-inbox': {
        const session = loadSession();
        await cmdDmInbox(session, flags);
        break;
      }

      case 'dm-history': {
        const session = loadSession();
        await cmdDmHistory(session, arg1, flags);
        break;
      }

      case 'dm-send': {
        const session = loadSession();
        await cmdDmSend(session, arg1, arg2);
        break;
      }

      case 'lists': {
        const session = loadSession();
        await cmdLists(session, flags);
        break;
      }

      case 'list': {
        const session = loadSession();
        await cmdList(session, arg1);
        break;
      }

      case 'list-tweets': {
        const session = loadSession();
        await cmdListTweets(session, arg1, flags);
        break;
      }

      case 'list-members': {
        const session = loadSession();
        await cmdListMembers(session, arg1, flags);
        break;
      }

      case 'communities': {
        const session = loadSession();
        await cmdCommunities(session, flags);
        break;
      }

      case 'community': {
        const session = loadSession();
        await cmdCommunity(session, arg1);
        break;
      }

      case 'community-tweets': {
        const session = loadSession();
        await cmdCommunityTweets(session, arg1, flags);
        break;
      }

      case 'geo': {
        const session = loadSession();
        const query = positional.slice(1).join(' ');
        await cmdGeo(session, query);
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
