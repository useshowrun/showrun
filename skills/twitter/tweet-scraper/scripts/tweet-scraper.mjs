#!/usr/bin/env node
// tweet-scraper.mjs — Twitter/X public data scraper
//
// No account required for: profiles, user tweets, individual tweets
// Account required for:    search, followers, following, likes
//
// Setup (for search):
//   node tweet-scraper.mjs auth
//   Requires Chrome with remote debugging (port 9333 or 9222), logged in to x.com
//
// Usage:
//   node tweet-scraper.mjs profile nasa
//   node tweet-scraper.mjs tweets nasa --count=50
//   node tweet-scraper.mjs tweet 2037551448439787917
//   node tweet-scraper.mjs search "artificial intelligence" --count=20   (requires auth)
//   node tweet-scraper.mjs search "from:NASA" --count=20                 (requires auth)
//
// Node 22+ required (uses built-in fetch).

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/twitter');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

// Public Bearer token embedded in Twitter's web client JS
// This has been stable for years. If you get 401 errors, re-extract from:
// https://abs.twimg.com/responsive-web/client-web/main.<hash>.js
// Search for: queryId:"IGgvgiOx4QZndDHuD3x9TQ" - the Authorization header nearby is the Bearer token
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query IDs (from main.9eef478a.js, 2026-03-28)
// Re-extract if you get 404 errors: grep 'queryId:' the main JS bundle
const QUERY_IDS = {
  UserByScreenName: 'IGgvgiOx4QZndDHuD3x9TQ',
  UserByRestId: 'VQfQ9wwYdk6j_u2O4vt64Q',
  UserTweets: 'FOlovQsiHGDls3c0Q_HaSQ',
  UserTweetsAndReplies: 'EJTxTKSH-byy7X46AhtKeA',
  UserMedia: 'SjiAp7wyuCUBkKAJJObU8w',
  TweetResultByRestId: 'sBoAB5nqJTOyR9sZ5qVLsw',
  TweetResultsByRestIds: 'B3F9uRHu_kwtjyEnZNyVAg',
  SearchTimeline: 'GcXk9vN_d1jUfHNqLacXQA',  // requires auth
};

// Common feature flags (captured from live browser session 2026-03-28)
const FEATURES_USER = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const FEATURES_TWEETS = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const CDP_PORTS = [9333, 9222];

// ─────────────────────────────────────────────────────────
// Filesystem helpers
// ─────────────────────────────────────────────────────────

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────
// CDP (Chrome DevTools Protocol) helpers
// ─────────────────────────────────────────────────────────

/** Find running Chrome CDP port */
async function findCdpPort() {
  for (const port of CDP_PORTS) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return port;
    } catch {}
  }
  return null;
}

/** Simple CDP WebSocket client */
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = new Map(); this.handlers = new Map(); }
  
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
      this.ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
        } else if (msg.method) {
          (this.handlers.get(msg.method) || []).forEach(h => h(msg.params));
        }
      });
    });
  }
  
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 15000);
    });
  }
  
  on(event, handler) { 
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
  
  close() { try { this.ws.close(); } catch {} }
}

/** Extract auth session from logged-in Chrome Twitter tab */
async function extractCdpSession(port) {
  const tabsResp = await fetch(`http://localhost:${port}/json`);
  const tabs = await tabsResp.json();
  
  let tab = tabs.find(t => (t.url.includes('x.com') || t.url.includes('twitter.com')) && t.type === 'page');
  
  let createdTab = null;
  if (!tab) {
    // Open a new tab to x.com to trigger session cookies
    const newTabResp = await fetch(`http://localhost:${port}/json/new?${encodeURIComponent('https://x.com')}`, { method: 'PUT' });
    createdTab = await newTabResp.json();
    tab = createdTab;
    await new Promise(r => setTimeout(r, 5000)); // wait for page load
  }
  
  const cdp = new CDP(`ws://localhost:${port}/devtools/page/${tab.id}`);
  await cdp.connect();
  
  try {
    const cookieResult = await cdp.send('Network.getCookies', { urls: ['https://x.com', 'https://twitter.com', 'https://api.x.com'] });
    const cookies = cookieResult.cookies || [];
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    
    const authToken = cookieMap['auth_token'];
    const ct0 = cookieMap['ct0'];
    const guestId = cookieMap['guest_id'];
    
    cdp.close();
    if (createdTab) await fetch(`http://localhost:${port}/json/close/${createdTab.id}`).catch(() => {});
    
    if (!authToken) {
      return { guestId, ct0, isGuest: true };
    }
    
    const cookieStr = cookies
      .filter(c => c.domain.includes('x.com') || c.domain.includes('twitter.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    
    return { authToken, ct0, guestId, cookieStr, isGuest: false };
  } catch (e) {
    cdp.close();
    if (createdTab) await fetch(`http://localhost:${port}/json/close/${createdTab.id}`).catch(() => {});
    throw e;
  }
}

// ─────────────────────────────────────────────────────────
// Auth management
// ─────────────────────────────────────────────────────────

/** Get or refresh guest token via guest/activate endpoint */
async function getGuestToken() {
  const session = loadJson(SESSION_FILE, {});
  
  // Check if we have a valid recent guest token (they last ~15 min)
  if (session.guestToken && session.guestTokenExpiry && Date.now() < session.guestTokenExpiry) {
    return session.guestToken;
  }
  
  // Request new guest token
  const resp = await fetchWithRetry('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: guestHeaders(null),
  });
  
  const data = await resp.json();
  if (!data.guest_token) throw new Error(`Failed to get guest token: ${JSON.stringify(data)}`);
  
  // Cache it for 14 minutes (they're valid ~15 min)
  const updated = { ...session, guestToken: data.guest_token, guestTokenExpiry: Date.now() + 14 * 60 * 1000 };
  ensureDir(DATA_DIR);
  saveJson(SESSION_FILE, updated);
  
  return data.guest_token;
}

function guestHeaders(guestToken) {
  const headers = {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://x.com',
    'Referer': 'https://x.com/',
  };
  if (guestToken) headers['x-guest-token'] = guestToken;
  return headers;
}

function authHeaders(session) {
  const headers = guestHeaders(null);
  if (session.ct0) headers['x-csrf-token'] = session.ct0;
  if (session.cookieStr) headers['Cookie'] = session.cookieStr;
  delete headers['x-guest-token']; // not needed with full auth
  return headers;
}

function loadSession() {
  const session = loadJson(SESSION_FILE, {});
  return session;
}

function hasFullAuth() {
  const session = loadSession();
  return !!(session.authToken && session.ct0 && session.cookieStr);
}

// ─────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    
    if (resp.status === 429) {
      const resetHeader = resp.headers.get('x-rate-limit-reset');
      const resetAt = resetHeader ? parseInt(resetHeader) * 1000 : Date.now() + 60000;
      const waitMs = Math.max(0, resetAt - Date.now()) + 2000;
      console.warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
      await sleep(waitMs);
      continue;
    }
    
    if (resp.status === 401 || resp.status === 403) {
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { message: text }; }
      const errors = data.errors || [];
      
      // Code 326 = account suspended/locked
      if (errors.some(e => e.code === 326)) throw new Error('ACCOUNT_SUSPENDED');
      // Code 215 = bad auth data (guest token on auth-required endpoint)
      if (errors.some(e => e.code === 215)) throw new Error('AUTH_REQUIRED');
      // Code 32 = could not authenticate
      if (errors.some(e => e.code === 32)) throw new Error('SESSION_EXPIRED');
      
      throw new Error(`HTTP ${resp.status}: ${JSON.stringify(data).substring(0, 200)}`);
    }
    
    if (!resp.ok && attempt < retries) {
      await sleep(1000 * attempt);
      continue;
    }
    
    return resp;
  }
}

async function graphqlGet(queryId, variables, features, fieldToggles, useAuth = false) {
  let headers;
  if (useAuth) {
    const session = loadSession();
    if (!session.cookieStr) throw new Error('AUTH_REQUIRED: Run `node tweet-scraper.mjs auth` first.');
    headers = authHeaders(session);
  } else {
    const guestToken = await getGuestToken();
    headers = guestHeaders(guestToken);
  }
  
  const params = new URLSearchParams();
  params.set('variables', JSON.stringify(variables));
  params.set('features', JSON.stringify(features));
  if (fieldToggles) params.set('fieldToggles', JSON.stringify(fieldToggles));
  
  const url = `https://api.x.com/graphql/${queryId}/${findOperationName(queryId)}?${params.toString()}`;
  
  const resp = await fetchWithRetry(url, { headers });
  const text = await resp.text();
  
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`); }
  
  if (data.errors?.length > 0 && !data.data) {
    const err = data.errors[0];
    if (err.code === 215) throw new Error('AUTH_REQUIRED: Search requires login. Run `node tweet-scraper.mjs auth`.');
    if (err.code === 32) throw new Error('SESSION_EXPIRED: Run `node tweet-scraper.mjs auth`');
    throw new Error(`API error: ${err.message} (code ${err.code})`);
  }
  
  return data;
}

function findOperationName(queryId) {
  return Object.entries(QUERY_IDS).find(([, id]) => id === queryId)?.[0] || queryId;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────
// Auth command
// ─────────────────────────────────────────────────────────

async function doAuth() {
  console.log('Looking for Chrome with remote debugging...');
  
  const port = await findCdpPort();
  if (!port) {
    console.error('Chrome with remote debugging not found on ports 9333 or 9222.');
    console.error('Start Chrome with: google-chrome --remote-debugging-port=9333');
    process.exit(1);
  }
  
  console.log(`Found Chrome on port ${port}`);
  console.log('Extracting session from x.com...');
  
  const session = await extractCdpSession(port);
  
  if (session.isGuest) {
    console.warn('WARNING: Chrome is not logged in to x.com.');
    console.warn('You are now using guest-only mode (no search).');
    console.warn('To enable search: log in to x.com in Chrome, then re-run auth.');
    
    saveJson(SESSION_FILE, {
      isGuest: true,
      guestId: session.guestId,
      extractedAt: new Date().toISOString(),
    });
    console.log(`Session saved (guest mode): ${SESSION_FILE}`);
  } else {
    saveJson(SESSION_FILE, {
      authToken: session.authToken,
      ct0: session.ct0,
      guestId: session.guestId,
      cookieStr: session.cookieStr,
      isGuest: false,
      extractedAt: new Date().toISOString(),
    });
    console.log(`Auth saved: ${SESSION_FILE}`);
    console.log('Full auth enabled — search is available.');
  }
}

// ─────────────────────────────────────────────────────────
// API: User profile
// ─────────────────────────────────────────────────────────

function parseUserLegacy(result) {
  if (!result) return null;
  const leg = result.legacy || {};
  // Twitter API v2 (2025+): name/screen_name/created_at moved to result.core
  // location moved to result.location.location
  const core = result.core || {};
  const locationObj = result.location || {};
  
  const screenName = core.screen_name || leg.screen_name;
  const name = core.name || leg.name;
  const createdAt = core.created_at || leg.created_at;
  const location = locationObj.location || leg.location || '';
  
  // Profile image: avatar.image_url or profile_image_url_https in legacy
  const rawImageUrl = result.avatar?.image_url || leg.profile_image_url_https || '';
  const profileImageUrl = rawImageUrl.replace('_normal.', '_400x400.').replace('_normal', '_400x400');
  
  // Description: profile_bio.description or legacy.description
  const description = result.profile_bio?.description || leg.description || '';
  
  // Website: from legacy entities URL
  const website = leg.entities?.url?.urls?.[0]?.expanded_url || null;
  
  return {
    id: result.rest_id || leg.id_str,
    screen_name: screenName,
    name,
    description,
    location,
    url: leg.url,
    website,
    followers_count: leg.followers_count,
    following_count: leg.friends_count,
    tweet_count: leg.statuses_count,
    like_count: leg.favourites_count,
    listed_count: leg.listed_count,
    media_count: leg.media_count,
    verified: result.verification?.verified || leg.verified || false,
    is_blue_verified: result.is_blue_verified || false,
    created_at: createdAt,
    profile_image_url: profileImageUrl,
    profile_banner_url: leg.profile_banner_url || null,
    pinned_tweet_ids: leg.pinned_tweet_ids_str || [],
  };
}

async function getProfile(screenName) {
  screenName = screenName.replace(/^@/, '');
  
  const data = await graphqlGet(
    QUERY_IDS.UserByScreenName,
    { screen_name: screenName, withGrokTranslatedBio: false },
    FEATURES_USER,
    { withPayments: false, withAuxiliaryUserLabels: true }
  );
  
  const result = data.data?.user?.result;
  if (!result) throw new Error(`User not found: @${screenName}`);
  if (result.__typename === 'UserUnavailable') throw new Error(`User unavailable: @${screenName}`);
  
  return parseUserLegacy(result);
}

// ─────────────────────────────────────────────────────────
// API: User tweets
// ─────────────────────────────────────────────────────────

function parseTweetResult(result) {
  if (!result) return null;
  
  // Handle tombstones (deleted/restricted tweets)
  if (result.__typename === 'TweetTombstone') {
    return { tombstone: true, text: result.tombstone?.text?.text || 'Content not available' };
  }
  
  const tweet = result.tweet || result; // handle nested retweeted_status_result
  const leg = tweet.legacy || {};
  // Twitter API v2 (2025+): user name/screen_name are in user.core, not user.legacy
  const userResult = tweet.core?.user_results?.result;
  const userCore = userResult?.core || {};
  const user = userResult?.legacy || {};
  
  // For retweets, get the original tweet
  let retweetedTweet = null;
  if (leg.retweeted_status_id_str && tweet.retweeted_status_result?.result) {
    retweetedTweet = parseTweetResult(tweet.retweeted_status_result.result);
  }
  
  // Extract media
  const media = (leg.entities?.media || leg.extended_entities?.media || []).map(m => ({
    type: m.type,
    url: m.media_url_https,
    expanded_url: m.expanded_url,
    video_info: m.video_info || null,
  }));
  
  return {
    id: leg.id_str || tweet.rest_id,
    text: leg.full_text || leg.text,
    created_at: leg.created_at,
    lang: leg.lang,
    author: {
      id: userResult?.rest_id || user.id_str || leg.user_id_str,
      screen_name: userCore.screen_name || user.screen_name,
      name: userCore.name || user.name,
      verified: userResult?.verification?.verified || user.verified || false,
      is_blue_verified: userResult?.is_blue_verified || false,
    },
    metrics: {
      like_count: leg.favorite_count || 0,
      retweet_count: leg.retweet_count || 0,
      reply_count: leg.reply_count || 0,
      quote_count: leg.quote_count || 0,
      bookmark_count: leg.bookmark_count || 0,
      view_count: tweet.views?.count ? parseInt(tweet.views.count) : null,
    },
    is_retweet: leg.full_text?.startsWith('RT @') || false,
    is_reply: !!(leg.in_reply_to_status_id_str),
    reply_to_tweet_id: leg.in_reply_to_status_id_str || null,
    reply_to_user: leg.in_reply_to_screen_name || null,
    conversation_id: leg.conversation_id_str,
    hashtags: (leg.entities?.hashtags || []).map(h => h.text),
    urls: (leg.entities?.urls || []).map(u => ({ url: u.url, expanded_url: u.expanded_url, display_url: u.display_url })),
    mentions: (leg.entities?.user_mentions || []).map(m => ({ id: m.id_str, screen_name: m.screen_name, name: m.name })),
    media,
    retweeted_tweet: retweetedTweet,
  };
}

function extractTimelineEntries(data, userPath) {
  // Navigate to timeline
  let timeline;
  if (userPath) {
    // UserTweets path: data.user.result.timeline.timeline
    timeline = data?.data?.user?.result?.timeline?.timeline;
  } else {
    // SearchTimeline path: data.search_by_raw_query.search_timeline.timeline
    timeline = data?.data?.search_by_raw_query?.search_timeline?.timeline;
  }
  
  if (!timeline) return { tweets: [], cursors: {} };
  
  const instructions = timeline.instructions || [];
  const addEntries = instructions.find(i => i.type === 'TimelineAddEntries');
  if (!addEntries) return { tweets: [], cursors: {} };
  
  const entries = addEntries.entries || [];
  const tweets = [];
  const cursors = {};
  
  for (const entry of entries) {
    const id = entry.entryId || '';
    
    if (id.startsWith('cursor-top-')) {
      cursors.top = entry.content?.value;
    } else if (id.startsWith('cursor-bottom-') || id.startsWith('sq-cursor-bottom')) {
      cursors.bottom = entry.content?.value;
    } else if (id.startsWith('tweet-')) {
      const tweetResult = entry.content?.itemContent?.tweet_results?.result;
      if (tweetResult) {
        const parsed = parseTweetResult(tweetResult);
        if (parsed && !parsed.tombstone) tweets.push(parsed);
      }
    } else if (id.startsWith('profile-conversation-')) {
      // Thread/conversation module
      const items = entry.content?.items || [];
      for (const item of items) {
        const tweetResult = item.item?.itemContent?.tweet_results?.result;
        if (tweetResult) {
          const parsed = parseTweetResult(tweetResult);
          if (parsed && !parsed.tombstone) tweets.push(parsed);
        }
      }
    }
  }
  
  return { tweets, cursors };
}

async function getUserTweets(screenName, opts = {}) {
  const { count = 20, cursor = null, includeReplies = false, pages = 1 } = opts;
  
  // First resolve screen_name to user ID
  const profile = await getProfile(screenName);
  if (!profile) throw new Error(`User not found: @${screenName}`);
  
  const queryId = includeReplies ? QUERY_IDS.UserTweetsAndReplies : QUERY_IDS.UserTweets;
  
  const allTweets = [];
  let currentCursor = cursor;
  
  for (let page = 0; page < pages; page++) {
    const variables = {
      userId: profile.id,
      count: Math.min(count, 40),
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true,
    };
    if (currentCursor) variables.cursor = currentCursor;
    
    const data = await graphqlGet(queryId, variables, FEATURES_TWEETS);
    const { tweets, cursors } = extractTimelineEntries(data, true);
    
    allTweets.push(...tweets);
    
    if (!cursors.bottom || tweets.length === 0) break;
    currentCursor = cursors.bottom;
    
    if (page < pages - 1) await sleep(500); // be polite
  }
  
  return { user: profile, tweets: allTweets.slice(0, count) };
}

// ─────────────────────────────────────────────────────────
// API: Single tweet
// ─────────────────────────────────────────────────────────

async function getTweet(tweetId) {
  const data = await graphqlGet(
    QUERY_IDS.TweetResultByRestId,
    { tweetId, withCommunity: false, includePromotedContent: false, withVoice: false },
    FEATURES_TWEETS
  );
  
  const result = data?.data?.tweetResult?.result;
  if (!result) throw new Error(`Tweet not found: ${tweetId}`);
  
  return parseTweetResult(result);
}

// ─────────────────────────────────────────────────────────
// API: Search (requires auth)
// ─────────────────────────────────────────────────────────

async function searchTweets(query, opts = {}) {
  const { count = 20, cursor = null, product = 'Latest', pages = 1 } = opts;
  // product: 'Top', 'Latest', 'People', 'Photos', 'Videos'
  
  if (!hasFullAuth()) {
    throw new Error('AUTH_REQUIRED: Search requires a logged-in session.\nRun: node tweet-scraper.mjs auth\n(Chrome must be open and logged in to x.com)');
  }
  
  const allTweets = [];
  let currentCursor = cursor;
  
  for (let page = 0; page < pages; page++) {
    const variables = {
      rawQuery: query,
      count: Math.min(count, 20),
      querySource: 'typed_query',
      product,
    };
    if (currentCursor) variables.cursor = currentCursor;
    
    const data = await graphqlGet(QUERY_IDS.SearchTimeline, variables, FEATURES_TWEETS, null, true);
    const { tweets, cursors } = extractTimelineEntries(data, false);
    
    allTweets.push(...tweets);
    
    if (!cursors.bottom || tweets.length === 0) break;
    currentCursor = cursors.bottom;
    
    if (page < pages - 1) await sleep(500);
  }
  
  return { query, product, tweets: allTweets.slice(0, count) };
}

// ─────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────

function printTweet(t, idx) {
  const d = new Date(t.created_at);
  const dateStr = d.toISOString ? d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : t.created_at;
  console.log(`\n[${idx + 1}] @${t.author?.screen_name || '?'} · ${dateStr}`);
  console.log(`    ${(t.text || '').substring(0, 200)}`);
  console.log(`    ❤️ ${t.metrics?.like_count} | 🔁 ${t.metrics?.retweet_count} | 💬 ${t.metrics?.reply_count} | 👁️ ${t.metrics?.view_count ?? '?'}`);
  if (t.media?.length > 0) console.log(`    📎 ${t.media.length} media attachment(s)`);
}

// ─────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  // Parse flags
  const flags = {};
  const positional = [];
  for (const arg of args.slice(1)) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(arg);
    }
  }
  
  const count = parseInt(flags.count) || 20;
  const pages = parseInt(flags.pages) || 1;
  const output = flags.output || 'text'; // text | json
  
  function printResult(data) {
    if (output === 'json') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      return data;
    }
  }
  
  try {
    switch (cmd) {
      case 'auth': {
        await doAuth();
        break;
      }
      
      case 'profile': {
        const screenName = positional[0];
        if (!screenName) { console.error('Usage: tweet-scraper.mjs profile <username>'); process.exit(1); }
        
        const profile = await getProfile(screenName);
        
        if (output === 'json') {
          console.log(JSON.stringify(profile, null, 2));
        } else {
          console.log(`\n@${profile.screen_name} (${profile.name})`);
          console.log(`ID: ${profile.id}`);
          console.log(`Bio: ${profile.description}`);
          console.log(`Location: ${profile.location || 'N/A'}`);
          console.log(`Website: ${profile.website || 'N/A'}`);
          console.log(`Followers: ${profile.followers_count?.toLocaleString()}`);
          console.log(`Following: ${profile.following_count?.toLocaleString()}`);
          console.log(`Tweets: ${profile.tweet_count?.toLocaleString()}`);
          console.log(`Verified: ${profile.is_blue_verified ? '✓ Blue' : profile.verified ? '✓ Legacy' : 'No'}`);
          console.log(`Joined: ${profile.created_at}`);
          
          const cachePath = resolve(CACHE_DIR, `profile-${screenName}.json`);
          saveJson(cachePath, profile);
          console.error(`Saved: ${cachePath}`);
        }
        break;
      }
      
      case 'tweets': {
        const screenName = positional[0];
        if (!screenName) { console.error('Usage: tweet-scraper.mjs tweets <username> [--count=N] [--pages=N] [--replies]'); process.exit(1); }
        
        const includeReplies = !!flags.replies;
        if (output !== 'json') console.log(`Fetching tweets for @${screenName}...`);
        const result = await getUserTweets(screenName, { count, pages, includeReplies });
        
        if (output === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n@${result.user.screen_name} — ${result.tweets.length} tweets`);
          result.tweets.forEach((t, i) => printTweet(t, i));
          
          const cachePath = resolve(CACHE_DIR, `tweets-${screenName}.json`);
          saveJson(cachePath, result);
          console.error(`Saved: ${cachePath}`);
        }
        break;
      }
      
      case 'tweet': {
        const tweetId = positional[0];
        if (!tweetId) { console.error('Usage: tweet-scraper.mjs tweet <tweet_id>'); process.exit(1); }
        
        const tweet = await getTweet(tweetId);
        
        if (output === 'json') {
          console.log(JSON.stringify(tweet, null, 2));
        } else {
          printTweet(tweet, 0);
          const cachePath = resolve(CACHE_DIR, `tweet-${tweetId}.json`);
          saveJson(cachePath, tweet);
          console.error(`Saved: ${cachePath}`);
        }
        break;
      }
      
      case 'search': {
        const query = positional.join(' ');
        if (!query) { console.error('Usage: tweet-scraper.mjs search "<query>" [--count=N] [--pages=N] [--product=Latest|Top]'); process.exit(1); }
        
        const product = flags.product || 'Latest';
        if (output !== 'json') console.log(`Searching: "${query}" (${product})...`);
        const result = await searchTweets(query, { count, pages, product });
        
        if (output === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\nSearch: "${result.query}" — ${result.tweets.length} results`);
          result.tweets.forEach((t, i) => printTweet(t, i));
          
          const safeQuery = query.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
          const cachePath = resolve(CACHE_DIR, `search-${safeQuery}.json`);
          saveJson(cachePath, result);
          console.error(`Saved: ${cachePath}`);
        }
        break;
      }
      
      case 'check-session': {
        const session = loadSession();
        if (!session || Object.keys(session).length === 0) {
          console.log('No session found. Run: node tweet-scraper.mjs auth');
        } else if (session.isGuest) {
          console.log('Guest session (no full auth)');
          console.log('Features: profile, tweets, tweet lookup');
          console.log('Missing: search, followers, likes');
          console.log('Tip: Log in to x.com in Chrome, then re-run auth');
        } else {
          console.log('Full auth session active');
          console.log(`Extracted: ${session.extractedAt}`);
          console.log('Features: profile, tweets, tweet lookup, search');
        }
        break;
      }
      
      default: {
        console.log(`
tweet-scraper.mjs — Twitter/X public data scraper

USAGE:
  node tweet-scraper.mjs <command> [args] [options]

COMMANDS:
  auth                        Extract session from Chrome (for search)
  check-session               Check auth status
  profile <username>          Get user profile
  tweets <username>           Get user's tweets
  tweet <tweet_id>            Get a single tweet by ID
  search "<query>"            Search tweets (requires auth)

OPTIONS:
  --count=N                   Number of results (default: 20)
  --pages=N                   Number of pages to fetch (default: 1)
  --replies                   Include replies (tweets command)
  --product=Latest|Top        Search product type (default: Latest)
  --output=json               Output as JSON

EXAMPLES:
  node tweet-scraper.mjs profile NASA
  node tweet-scraper.mjs tweets elonmusk --count=50 --pages=3
  node tweet-scraper.mjs tweet 2037551448439787917
  node tweet-scraper.mjs search "climate change" --count=20 --product=Top
  node tweet-scraper.mjs tweets NASA --output=json > nasa.json

DATA STORED AT:
  ${DATA_DIR}
`);
        process.exit(0);
      }
    }
  } catch (err) {
    if (err.message === 'AUTH_REQUIRED' || err.message?.startsWith('AUTH_REQUIRED:')) {
      console.error(`\n❌ Authentication required.`);
      console.error(err.message.includes(':') ? err.message.split(':').slice(1).join(':').trim() : '');
      console.error('\nRun: node tweet-scraper.mjs auth');
      console.error('(Chrome must be open and logged in to x.com)');
      process.exit(2);
    }
    
    if (err.message === 'SESSION_EXPIRED' || err.message?.startsWith('SESSION_EXPIRED:')) {
      console.error(`\n❌ Session expired.`);
      console.error('Re-run: node tweet-scraper.mjs auth');
      process.exit(2);
    }
    
    if (err.message === 'ACCOUNT_SUSPENDED') {
      console.error(`\n❌ Account suspended or locked.`);
      process.exit(2);
    }
    
    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
