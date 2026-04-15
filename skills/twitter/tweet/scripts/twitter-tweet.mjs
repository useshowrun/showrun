#!/usr/bin/env node
// twitter-tweet.mjs — Twitter/X tweet operations via internal GraphQL + v1.1 REST APIs
//
// Setup (one-time):
//   node twitter-tweet.mjs auth
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory & session (shared across all twitter skills)
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/twitter');
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
    resolve(dirname(new URL(import.meta.url).pathname), '../../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const GQL_FEATURES = {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

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
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'referer': 'https://x.com/',
    'origin': 'https://x.com',
  };
}

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.cookie || !session.ct0) {
    console.error('No session found. Run: node twitter-tweet.mjs auth');
    process.exit(1);
  }
  return session;
}

// ---------------------------------------------------------------------------
// GQL GET helper
// ---------------------------------------------------------------------------

async function gqlGet(session, path, variables, features = GQL_FEATURES) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });
  const url = `https://x.com/i/api/graphql/${path}?${params}`;
  const resp = await fetch(url, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// GQL POST helper (for mutations)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CLI helpers
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
// Deep-find utility (recursively search objects for matching keys/values)
// ---------------------------------------------------------------------------

function findAll(obj, predicate, results = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (predicate(obj)) results.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') findAll(v, predicate, results);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tweet formatting
// ---------------------------------------------------------------------------

function formatTweet(result) {
  if (!result) return null;
  // Handle tombstone / unavailable
  const typename = result.__typename;
  if (typename === 'TweetTombstone') return { unavailable: true, tombstone: result.tombstoneText?.text || 'Unavailable' };
  if (typename === 'TweetUnavailable') return { unavailable: true, reason: result.reason || 'Unknown' };

  // Unwrap TweetWithVisibilityResults
  const tweet = result.tweet || result;
  const core = tweet.core?.user_results?.result;
  const legacy = tweet.legacy || {};
  const user = core?.legacy || {};
  const note = tweet.note_tweet?.note_tweet_results?.result;

  // Full text: prefer note_tweet for long tweets, then legacy
  let fullText = legacy.full_text || '';
  if (note?.text) fullText = note.text;

  const media = legacy.entities?.media || legacy.extended_entities?.media || [];
  const urls = legacy.entities?.urls || [];

  // Expand t.co links in text
  let expandedText = fullText;
  for (const u of urls) {
    if (u.url && u.expanded_url) expandedText = expandedText.replace(u.url, u.expanded_url);
  }
  // Remove trailing media URLs
  for (const m of media) {
    if (m.url) expandedText = expandedText.replace(m.url, '').trim();
  }

  const out = {
    id: legacy.id_str || tweet.rest_id,
    text: expandedText,
    created_at: legacy.created_at,
    user: {
      id: core?.rest_id,
      name: user.name,
      screen_name: user.screen_name,
      verified: user.verified || core?.is_blue_verified,
    },
    metrics: {
      replies: legacy.reply_count,
      retweets: legacy.retweet_count,
      likes: legacy.favorite_count,
      quotes: legacy.quote_count,
      bookmarks: legacy.bookmark_count,
      views: tweet.views?.count ? parseInt(tweet.views.count, 10) : undefined,
    },
    lang: legacy.lang,
    source: tweet.source,
  };

  if (legacy.in_reply_to_status_id_str) {
    out.in_reply_to = {
      tweet_id: legacy.in_reply_to_status_id_str,
      user_id: legacy.in_reply_to_user_id_str,
      screen_name: legacy.in_reply_to_screen_name,
    };
  }

  if (legacy.is_quote_status && tweet.quoted_status_result?.result) {
    out.quoted_tweet = formatTweet(tweet.quoted_status_result.result);
  }

  if (media.length > 0) {
    out.media = media.map(m => ({
      type: m.type,
      url: m.media_url_https || m.url,
      expanded_url: m.expanded_url,
    }));
  }

  if (legacy.retweeted_status_result?.result) {
    out.retweeted_tweet = formatTweet(legacy.retweeted_status_result.result);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Timeline entry parsing (for thread/bookmarks/retweeters/likers)
// ---------------------------------------------------------------------------

function parseTimelineEntries(data, path = 'data.tweetResult') {
  // Generic: find all timeline entries in the response
  const entries = findAll(data, o =>
    o.entryId && (o.entryId.startsWith('tweet-') || o.entryId.startsWith('user-') || o.entryId.startsWith('cursor-'))
  );

  const tweets = [];
  const users = [];
  let nextCursor = null;
  let previousCursor = null;

  for (const entry of entries) {
    const entryId = entry.entryId || '';

    // Cursor entries
    if (entryId.startsWith('cursor-bottom') || entryId.includes('cursor-bottom')) {
      nextCursor = entry.content?.value
        || entry.content?.itemContent?.value
        || entry.content?.operation?.cursor?.value
        || nextCursor;
      continue;
    }
    if (entryId.startsWith('cursor-top') || entryId.includes('cursor-top')) {
      previousCursor = entry.content?.value
        || entry.content?.itemContent?.value
        || entry.content?.operation?.cursor?.value
        || previousCursor;
      continue;
    }

    // Tweet entries
    if (entryId.startsWith('tweet-')) {
      const result = entry.content?.itemContent?.tweet_results?.result;
      if (result) {
        const formatted = formatTweet(result);
        if (formatted) tweets.push(formatted);
      }
      continue;
    }

    // User entries (for retweeters/likers)
    if (entryId.startsWith('user-')) {
      const userResult = entry.content?.itemContent?.user_results?.result;
      if (userResult) {
        const legacy = userResult.legacy || {};
        users.push({
          id: userResult.rest_id,
          name: legacy.name,
          screen_name: legacy.screen_name,
          verified: legacy.verified || userResult.is_blue_verified,
          followers_count: legacy.followers_count,
          description: legacy.description,
        });
      }
      continue;
    }

    // Conversation thread entries (thread command)
    if (entryId.startsWith('conversationthread-')) {
      const items = entry.content?.items || [];
      for (const item of items) {
        const result = item.item?.itemContent?.tweet_results?.result;
        if (result) {
          const formatted = formatTweet(result);
          if (formatted) tweets.push(formatted);
        }
      }
      continue;
    }
  }

  return { tweets, users, nextCursor, previousCursor };
}

// ---------------------------------------------------------------------------
// Auth: extract session from Chrome
// ---------------------------------------------------------------------------

async function doAuth() {
  console.error('Finding Twitter/X tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['x.com/home', 'x.com/', 'twitter.com']) {
    for (const line of list.split('\n')) {
      if (line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('x.com') || line.includes('twitter.com')) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
  }
  if (!target) throw new Error('No Twitter/X tab found. Open x.com in Chrome first.');
  console.error(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://x.com', 'https://twitter.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('x.com') || c.domain.includes('twitter.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const ct0 = cookieMap['ct0'] || '';
  if (!ct0) throw new Error('ct0 cookie not found. Make sure you are logged in to x.com.');

  const authToken = cookieMap['auth_token'] || '';
  if (!authToken) throw new Error('auth_token cookie not found. Make sure you are logged in to x.com.');

  // Extract userId from the page
  let userId = '';
  try {
    const evalResult = cdp('eval', target,
      'document.cookie.match(/twid=u%3D(\\d+)/)?.[1] || document.querySelector("[data-testid=AppTabBar_Profile_Link]")?.href?.match(/\\/([^/]+)$/)?.[1] || ""');
    userId = evalResult.replace(/^"|"$/g, '');
  } catch { /* optional */ }

  const session = {
    cookie: cookieStr,
    ct0,
    userId,
    capturedAt: new Date().toISOString(),
  };

  saveJson(SESSION_FILE, session);
  console.error(`Auth saved to: ${SESSION_FILE}`);

  console.log(JSON.stringify({ ok: true, sessionFile: SESSION_FILE, userId }));
}

// ---------------------------------------------------------------------------
// Command: get <tweet_id>
// ---------------------------------------------------------------------------

async function getTweet(tweetId) {
  const session = getSession();
  const data = await gqlGet(session, 'Xl5pC_lBk_gcO2ItU39DQw/TweetResultByRestId', {
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  });

  const result = data?.data?.tweetResult?.result;
  if (!result) {
    console.error('Tweet not found.');
    process.exit(1);
  }

  const formatted = formatTweet(result);
  const cacheFile = resolve(CACHE_DIR, `tweet-${tweetId}.json`);
  saveJson(cacheFile, formatted);
  console.log(JSON.stringify(formatted, null, 2));
}

// ---------------------------------------------------------------------------
// Command: get-many <id1,id2,...>
// ---------------------------------------------------------------------------

async function getManyTweets(idsStr) {
  const session = getSession();
  const tweetIds = idsStr.split(',').map(s => s.trim()).filter(Boolean);
  if (tweetIds.length === 0) {
    console.error('No tweet IDs provided.');
    process.exit(1);
  }

  const data = await gqlGet(session, 'PTN9HhBAlpoCTHfspDgqLA/TweetResultsByRestIds', {
    tweetIds,
    includePromotedContent: true,
    withBirdwatchNotes: true,
    withVoice: true,
    withCommunity: true,
  });

  const results = data?.data?.tweetResult || [];
  const tweets = [];
  for (const item of results) {
    const result = item?.result;
    if (result) {
      const formatted = formatTweet(result);
      if (formatted) tweets.push(formatted);
    }
  }

  console.log(JSON.stringify(tweets, null, 2));
}

// ---------------------------------------------------------------------------
// Command: thread <tweet_id> [--cursor=X]
// ---------------------------------------------------------------------------

async function getThread(tweetId, cursor) {
  const session = getSession();
  const variables = {
    focalTweetId: tweetId,
    with_rux_injections: false,
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;

  const data = await gqlGet(session, 'U0HTv-bAWTBYylwEMT7x5A/TweetDetail', variables);

  const { tweets, nextCursor } = parseTimelineEntries(data);

  const output = { focalTweetId: tweetId, tweets };
  if (nextCursor) output.nextCursor = nextCursor;

  const cacheFile = resolve(CACHE_DIR, `thread-${tweetId}.json`);
  saveJson(cacheFile, output);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: post <text> [--reply-to=tweet_id]
// ---------------------------------------------------------------------------

async function postTweet(text, replyTo) {
  const session = getSession();
  const variables = {
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
  };

  if (replyTo) {
    variables.reply = {
      in_reply_to_tweet_id: replyTo,
      exclude_reply_user_ids: [],
    };
  }

  const data = await gqlPost(session, 'SiM_cAu83R0wnrpmKQQSEw/CreateTweet', variables);

  const result = data?.data?.create_tweet?.tweet_results?.result;
  let tweetId = result?.rest_id || result?.legacy?.id_str;
  const tweetText = result?.legacy?.full_text || text;

  // Twitter sometimes returns empty tweet_results — fetch the user's latest tweet to get the ID
  if (!tweetId && session.userId) {
    console.error('Tweet posted but ID not in response. Fetching latest tweet to confirm...');
    try {
      const userTweets = await gqlGet(session, 'QWF3SzpHmykQHsQMixG0cg/UserTweets', {
        userId: session.userId,
        count: 1,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      });
      const restIds = findAll(userTweets, o => o.rest_id && o.legacy);
      if (restIds.length > 0) {
        tweetId = restIds[0].rest_id;
      }
    } catch (e) {
      console.error(`  Could not fetch latest tweet: ${e.message}`);
    }
  }

  const output = { id: tweetId, text: tweetText };
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: delete <tweet_id>
// ---------------------------------------------------------------------------

async function deleteTweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'VaenaVgh5q5ih7kvyVjgtg/DeleteTweet', {
    tweet_id: tweetId,
    dark_request: false,
  });

  console.log(JSON.stringify({ ok: true, deleted: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: like <tweet_id>
// ---------------------------------------------------------------------------

async function likeTweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'lI07N6Otwv1PhnEgXILM7A/FavoriteTweet', {
    tweet_id: tweetId,
  });

  console.log(JSON.stringify({ ok: true, liked: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: unlike <tweet_id>
// ---------------------------------------------------------------------------

async function unlikeTweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'ZYKSe-w7KEslx3JhSIk5LA/UnfavoriteTweet', {
    tweet_id: tweetId,
  });

  console.log(JSON.stringify({ ok: true, unliked: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: retweet <tweet_id>
// ---------------------------------------------------------------------------

async function retweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'ojPdsZsimiJrUGLR1sjUtA/CreateRetweet', {
    tweet_id: tweetId,
    dark_request: false,
  });

  const retweetId = data?.data?.create_retweet?.retweet_results?.result?.rest_id;
  console.log(JSON.stringify({ ok: true, retweeted: tweetId, retweet_id: retweetId }));
}

// ---------------------------------------------------------------------------
// Command: unretweet <tweet_id>
// ---------------------------------------------------------------------------

async function unretweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'iQtK4dl5hBmXewYZuEOKVw/DeleteRetweet', {
    source_tweet_id: tweetId,
    dark_request: false,
  });

  console.log(JSON.stringify({ ok: true, unretweeted: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: bookmark <tweet_id>
// ---------------------------------------------------------------------------

async function bookmarkTweet(tweetId) {
  const session = getSession();
  const headers = baseHeaders(session);
  headers['content-type'] = 'application/x-www-form-urlencoded';

  const resp = await fetch('https://x.com/i/api/2/timeline/bookmark.json', {
    method: 'POST',
    headers,
    body: `tweet_id=${tweetId}`,
  });

  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }

  console.log(JSON.stringify({ ok: true, bookmarked: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: unbookmark <tweet_id>
// ---------------------------------------------------------------------------

async function unbookmarkTweet(tweetId) {
  const session = getSession();
  const data = await gqlPost(session, 'Wlmlj2-xzyS1GN3a6cj-mQ/DeleteBookmark', {
    tweet_id: tweetId,
  });

  console.log(JSON.stringify({ ok: true, unbookmarked: tweetId }));
}

// ---------------------------------------------------------------------------
// Command: bookmarks [--count=20] [--cursor=X]
// ---------------------------------------------------------------------------

async function listBookmarks(count, cursor) {
  const session = getSession();
  const variables = {
    count: parseInt(count, 10) || 20,
    includePromotedContent: true,
  };
  if (cursor) variables.cursor = cursor;

  const features = { ...GQL_FEATURES, graphql_timeline_v2_bookmark_timeline: true };
  const data = await gqlGet(session, 'qToeLeMs43Q8cr7tRYXmaQ/Bookmarks', variables, features);

  const { tweets, nextCursor } = parseTimelineEntries(data);

  const output = { tweets };
  if (nextCursor) output.nextCursor = nextCursor;

  const cacheFile = resolve(CACHE_DIR, `bookmarks-${Date.now()}.json`);
  saveJson(cacheFile, output);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: retweeters <tweet_id> [--count=20] [--cursor=X]
// ---------------------------------------------------------------------------

async function getRetweeters(tweetId, count, cursor) {
  const session = getSession();
  const variables = {
    tweetId,
    count: parseInt(count, 10) || 20,
    includePromotedContent: true,
  };
  if (cursor) variables.cursor = cursor;

  const data = await gqlGet(session, 'X-XEqG5qHQSAwmvy00xfyQ/Retweeters', variables);

  const { users, nextCursor } = parseTimelineEntries(data);

  const output = { tweetId, users };
  if (nextCursor) output.nextCursor = nextCursor;

  const cacheFile = resolve(CACHE_DIR, `retweeters-${tweetId}.json`);
  saveJson(cacheFile, output);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: likers <tweet_id> [--count=20] [--cursor=X]
// ---------------------------------------------------------------------------

async function getLikers(tweetId, count, cursor) {
  const session = getSession();
  const variables = {
    tweetId,
    count: parseInt(count, 10) || 20,
    includePromotedContent: true,
  };
  if (cursor) variables.cursor = cursor;

  const data = await gqlGet(session, 'LLkw5EcVutJL6y-2gkz22A/Favoriters', variables);

  const { users, nextCursor } = parseTimelineEntries(data);

  const output = { tweetId, users };
  if (nextCursor) output.nextCursor = nextCursor;

  const cacheFile = resolve(CACHE_DIR, `likers-${tweetId}.json`);
  saveJson(cacheFile, output);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Command: similar <tweet_id>
// ---------------------------------------------------------------------------

async function getSimilar(tweetId) {
  const session = getSession();
  const data = await gqlGet(session, 'EToazR74i0rJyZYalfVEAQ/SimilarPosts', {
    tweet_id: tweetId,
  });

  const { tweets } = parseTimelineEntries(data);

  const output = { tweetId, tweets };
  const cacheFile = resolve(CACHE_DIR, `similar-${tweetId}.json`);
  saveJson(cacheFile, output);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// CLI router
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

    case 'get': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs get <tweet_id>'); process.exit(1); }
      await getTweet(tweetId);
      break;
    }

    case 'get-many': {
      const ids = positional[0];
      if (!ids) { console.error('Usage: twitter-tweet.mjs get-many <id1,id2,...>'); process.exit(1); }
      await getManyTweets(ids);
      break;
    }

    case 'thread': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs thread <tweet_id> [--cursor=X]'); process.exit(1); }
      await getThread(tweetId, flags.cursor);
      break;
    }

    case 'post': {
      const text = positional.join(' ');
      if (!text) { console.error('Usage: twitter-tweet.mjs post <text> [--reply-to=tweet_id]'); process.exit(1); }
      await postTweet(text, flags['reply-to']);
      break;
    }

    case 'delete': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs delete <tweet_id>'); process.exit(1); }
      await deleteTweet(tweetId);
      break;
    }

    case 'like': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs like <tweet_id>'); process.exit(1); }
      await likeTweet(tweetId);
      break;
    }

    case 'unlike': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs unlike <tweet_id>'); process.exit(1); }
      await unlikeTweet(tweetId);
      break;
    }

    case 'retweet': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs retweet <tweet_id>'); process.exit(1); }
      await retweet(tweetId);
      break;
    }

    case 'unretweet': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs unretweet <tweet_id>'); process.exit(1); }
      await unretweet(tweetId);
      break;
    }

    case 'bookmark': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs bookmark <tweet_id>'); process.exit(1); }
      await bookmarkTweet(tweetId);
      break;
    }

    case 'unbookmark': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs unbookmark <tweet_id>'); process.exit(1); }
      await unbookmarkTweet(tweetId);
      break;
    }

    case 'bookmarks': {
      await listBookmarks(flags.count || '20', flags.cursor);
      break;
    }

    case 'retweeters': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs retweeters <tweet_id> [--count=20] [--cursor=X]'); process.exit(1); }
      await getRetweeters(tweetId, flags.count || '20', flags.cursor);
      break;
    }

    case 'likers': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs likers <tweet_id> [--count=20] [--cursor=X]'); process.exit(1); }
      await getLikers(tweetId, flags.count || '20', flags.cursor);
      break;
    }

    case 'similar': {
      const tweetId = positional[0];
      if (!tweetId) { console.error('Usage: twitter-tweet.mjs similar <tweet_id>'); process.exit(1); }
      await getSimilar(tweetId);
      break;
    }

    default: {
      console.log(`twitter-tweet — Twitter/X tweet operations

Commands:
  auth                              Extract session from Chrome
  get <tweet_id>                    Get single tweet
  get-many <id1,id2,...>            Batch get tweets
  thread <tweet_id> [--cursor=X]   Get tweet thread + replies
  post <text> [--reply-to=id]      Create tweet or reply
  delete <tweet_id>                Delete tweet
  like <tweet_id>                  Like tweet
  unlike <tweet_id>                Unlike tweet
  retweet <tweet_id>               Retweet
  unretweet <tweet_id>             Remove retweet
  bookmark <tweet_id>              Bookmark tweet
  unbookmark <tweet_id>            Remove bookmark
  bookmarks [--count=20]           List bookmarks
  retweeters <tweet_id>            Who retweeted
  likers <tweet_id>                Who liked
  similar <tweet_id>               Similar posts

Session: ~/.local/share/showrun/data/twitter/session.json`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
