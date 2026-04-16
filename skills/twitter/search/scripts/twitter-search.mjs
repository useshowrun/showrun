#!/usr/bin/env node
// twitter-search.mjs — Twitter/X search & discovery
//
// Commands:
//   node twitter-search.mjs auth                          Extract session from Chrome
//   node twitter-search.mjs tweets <query> [flags]        Search tweets (via CDP intercept or --txn)
//   node twitter-search.mjs users <query> [--count=10]    Search users (no Chrome needed)
//   node twitter-search.mjs trends [--woeid=1]            Trending topics
//   node twitter-search.mjs typeahead <query> [--types=users,topics,events,lists]
//
// Requires Node 22+ (built-in fetch). No external dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory & session
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
// CDP integration
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Twitter constants & helpers
// ---------------------------------------------------------------------------

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const GQL_FEATURES = {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false};

const DEFAULT_SEARCH_HASH = 'n0vzau71jvBmSJzo48XTEA';

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

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function formatTweet(tweet) {
  if (!tweet) return null;
  const legacy = tweet.legacy || tweet;
  const userResult = tweet.core?.user_results?.result;
  const userCore = userResult?.core || {};
  const userLegacy = userResult?.legacy || {};
  const screenName = userCore.screen_name || userLegacy.screen_name || legacy.user?.screen_name || '';
  const displayName = userCore.name || userLegacy.name || legacy.user?.name || '';
  return {
    id: legacy.id_str || tweet.rest_id,
    text: legacy.full_text || legacy.text || '',
    author: screenName,
    authorName: displayName,
    createdAt: legacy.created_at || '',
    retweetCount: legacy.retweet_count || 0,
    likeCount: legacy.favorite_count || 0,
    replyCount: legacy.reply_count || 0,
    quoteCount: legacy.quote_count || 0,
    bookmarkCount: legacy.bookmark_count || 0,
    viewCount: tweet.views?.count ? parseInt(tweet.views.count, 10) : null,
    lang: legacy.lang || '',
    isRetweet: !!legacy.retweeted_status_result,
    isReply: !!legacy.in_reply_to_status_id_str,
    url: screenName && legacy.id_str
      ? `https://x.com/${screenName}/status/${legacy.id_str}` : '',
  };
}

function parseTimelineEntries(data) {
  const tweets = [];
  let nextCursor = null;

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }

    if (obj.entryType === 'TimelineTimelineItem' || obj.__typename === 'TimelineTimelineItem') {
      const result = obj.itemContent?.tweet_results?.result;
      if (result) {
        const inner = result.__typename === 'TweetWithVisibilityResults'
          ? result.tweet : result;
        const t = formatTweet(inner);
        if (t) tweets.push(t);
      }
    }

    if (obj.entryType === 'TimelineTimelineCursor' || obj.__typename === 'TimelineTimelineCursor') {
      if (obj.cursorType === 'Bottom') nextCursor = obj.value;
    }

    // Recurse into known container keys + search-specific keys
    for (const key of ['entries', 'instructions', 'content', 'items', 'itemContent',
      'tweet_results', 'result', 'timeline', 'timeline_v2', 'data',
      'search_by_raw_query', 'search_timeline', 'user']) {
      if (obj[key]) walk(obj[key]);
    }
  }

  walk(data);
  return { tweets, nextCursor };
}

function findAll(obj, key) {
  const results = [];
  function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o[key] !== undefined) results.push(o[key]);
    for (const v of Object.values(o)) walk(v);
  }
  walk(obj);
  return results;
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
// Auth: extract session from Chrome x.com tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding x.com tab in Chrome...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('x.com') || line.includes('twitter.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) throw new Error('No x.com tab found. Open x.com in Chrome first.');
  console.log(`Using tab: ${target}`);

  // Extract cookies
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://x.com', 'https://twitter.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const ct0 = cookieMap['ct0'] || '';
  const authToken = cookieMap['auth_token'] || '';

  if (!ct0) throw new Error('ct0 cookie not found. Make sure you are logged in to x.com.');
  if (!authToken) console.warn('Warning: auth_token cookie not found. Session may not work.');

  const cookieStr = cookies
    .filter(c => c.domain.includes('x.com') || c.domain.includes('twitter.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const session = {
    ct0,
    authToken,
    cookie: cookieStr,
    extractedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
  };
  saveJson(SESSION_FILE, session);
  console.error(`Session saved to: ${SESSION_FILE}`);
  console.error(`ct0: ${ct0.slice(0, 8)}...`);
  console.log(JSON.stringify({ ok: true, sessionFile: SESSION_FILE }));
}

// ---------------------------------------------------------------------------
// Session loader
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.ct0 || !session.cookie) {
    console.error('No session found. Run: node twitter-search.mjs auth');
    process.exit(1);
  }
  return session;
}

// ---------------------------------------------------------------------------
// GraphQL GET helper
// ---------------------------------------------------------------------------

async function gqlGet(session, hash, operationName, variables, extraHeaders = {}) {
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GQL_FEATURES),
  }).toString();
  const url = `https://x.com/i/api/graphql/${hash}/${operationName}?${qs}`;
  const headers = { ...baseHeaders(session), ...extraHeaders };
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: node twitter-search.mjs auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// v1.1 REST API GET helper
// ---------------------------------------------------------------------------

async function v11Get(session, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://x.com/i/api/${path}?${qs}`;
  const resp = await fetch(url, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: node twitter-search.mjs auth'); process.exit(1); }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}


// ---------------------------------------------------------------------------
// Command: tweets <query>
// ---------------------------------------------------------------------------

async function searchTweets(query, flags) {
  const session = getSession();
  const type = flags.type || 'Latest';
  const count = Math.min(Math.max(parseInt(flags.count || '20', 10), 1), 50);
  const cursor = flags.cursor || '';
  const hash = flags.hash || DEFAULT_SEARCH_HASH;

  let data;

  if (flags.txn) {
    // Direct fetch with user-provided transaction ID (power-user bypass)
    console.error(`Searching tweets for "${query}" (type=${type}, txn provided)...`);
    const variables = { rawQuery: query, count, querySource: 'typed_query', product: type };
    if (cursor) variables.cursor = cursor;
    const qs = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(GQL_FEATURES),
    }).toString();
    const url = `https://x.com/i/api/graphql/${hash}/SearchTimeline?${qs}`;
    const headers = { ...baseHeaders(session), 'x-client-transaction-id': flags.txn };
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if (resp.status === 429) { console.error('Rate limited. Wait 15 minutes.'); process.exit(1); }
      if (resp.status === 401 || resp.status === 403) { console.error('Session expired. Run: node twitter-search.mjs auth'); process.exit(1); }
      if (resp.status === 404) { console.error('404 — transaction ID may be invalid or expired.'); process.exit(1); }
      throw new Error(`HTTP ${resp.status}`);
    }
    data = await resp.json();
  } else {
    // Intercept response via Chrome CDP (navigate and grab the real response)
    console.error(`Searching tweets for "${query}" (type=${type}, via CDP intercept)...`);
    let navigateUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
    if (type === 'Latest') navigateUrl += '&f=live';
    else if (type === 'Media') navigateUrl += '&f=image';
    // Top is the default (no &f= param)

    try {
      data = await cdpInterceptResponse('SearchTimeline', navigateUrl);
    } catch (err) {
      console.error(`CDP intercept failed: ${err.message}`);
      console.error('');
      console.error('Make sure Chrome is running with remote debugging enabled and x.com is open.');
      console.error('Alternatively, provide --txn=X from Chrome DevTools Network tab.');
      process.exit(1);
    }
  }

  const { tweets, nextCursor } = parseTimelineEntries(data);

  console.log(`\n--- Tweet search: "${query}" (${tweets.length} results, type=${type}) ---\n`);

  for (const t of tweets) {
    const text = t.text.replace(/\n+/g, ' ').trim();
    const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
    console.log(`  @${t.author} (${t.authorName})`);
    console.log(`    ${preview}`);
    console.log(`    ${t.createdAt}  |  RT: ${t.retweetCount}  Likes: ${t.likeCount}  Replies: ${t.replyCount}${t.viewCount !== null ? '  Views: ' + t.viewCount.toLocaleString() : ''}`);
    console.log(`    ${t.url}`);
    console.log('');
  }

  if (nextCursor) {
    console.log(`${tweets.length} results shown. Next page: --cursor=${nextCursor}`);
  } else {
    console.log(`${tweets.length} results shown. No more pages.`);
  }

  // Cache
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'tweets',
    query,
    type,
    count,
    results: tweets,
    nextCursor,
    fetchedAt: new Date().toISOString(),
  });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// Command: users <query>
// ---------------------------------------------------------------------------

async function searchUsers(query, flags) {
  const session = getSession();
  const count = Math.min(Math.max(parseInt(flags.count || '10', 10), 1), 50);

  console.log(`Searching users for "${query}"...`);

  const data = await v11Get(session, '1.1/search/typeahead.json', {
    q: query,
    src: 'search_box',
    result_type: 'users',
    count: String(count),
  });

  const users = data.users || [];

  console.log(`\n--- User search: "${query}" (${users.length} results) ---\n`);

  for (const u of users) {
    console.log(`  @${u.screen_name}  (${u.name})`);
    if (u.verified || u.is_blue_verified) console.log(`    Verified`);
    if (u.followers_count !== undefined) console.log(`    Followers: ${u.followers_count.toLocaleString()}`);
    if (u.bio) {
      const bio = u.bio.replace(/\n+/g, ' ').trim();
      console.log(`    Bio: ${bio.length > 150 ? bio.slice(0, 150) + '...' : bio}`);
    }
    console.log(`    https://x.com/${u.screen_name}`);
    console.log('');
  }

  console.log(`${users.length} results shown.`);
}

// ---------------------------------------------------------------------------
// Command: trends
// ---------------------------------------------------------------------------

async function fetchTrends(flags) {
  const session = getSession();
  const woeid = flags.woeid || '1';

  console.log(`Fetching trends (WOEID=${woeid})...`);

  const data = await v11Get(session, '1.1/trends/place.json', {
    id: woeid,
  });

  const location = data[0]?.locations?.[0]?.name || 'Unknown';
  const trends = data[0]?.trends || [];

  console.log(`\n--- Trends for ${location} (${trends.length} topics) ---\n`);

  for (let i = 0; i < trends.length; i++) {
    const t = trends[i];
    const vol = t.tweet_volume ? `  (${t.tweet_volume.toLocaleString()} tweets)` : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${t.name}${vol}`);
  }
  console.log('');

  // Cache
  const cacheFile = resolve(CACHE_DIR, `trends-${woeid}-${Date.now()}.json`);
  saveJson(cacheFile, {
    command: 'trends',
    woeid,
    location,
    trends,
    fetchedAt: new Date().toISOString(),
  });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// Command: typeahead <query>
// ---------------------------------------------------------------------------

async function typeahead(query, flags) {
  const session = getSession();
  const types = flags.types || 'users,topics,events,lists';

  console.log(`Typeahead for "${query}" (types=${types})...`);

  const data = await v11Get(session, '1.1/search/typeahead.json', {
    q: query,
    src: 'search_box',
    result_type: types,
  });

  // Users
  if (data.users && data.users.length > 0) {
    console.log(`\n--- Users (${data.users.length}) ---\n`);
    for (const u of data.users) {
      console.log(`  @${u.screen_name}  (${u.name})  Followers: ${(u.followers_count || 0).toLocaleString()}`);
    }
  }

  // Topics
  if (data.topics && data.topics.length > 0) {
    console.log(`\n--- Topics (${data.topics.length}) ---\n`);
    for (const t of data.topics) {
      console.log(`  ${t.topic || t.name || JSON.stringify(t)}`);
    }
  }

  // Events
  if (data.events && data.events.length > 0) {
    console.log(`\n--- Events (${data.events.length}) ---\n`);
    for (const e of data.events) {
      console.log(`  ${e.title || e.name || JSON.stringify(e)}`);
    }
  }

  // Lists
  if (data.lists && data.lists.length > 0) {
    console.log(`\n--- Lists (${data.lists.length}) ---\n`);
    for (const l of data.lists) {
      console.log(`  ${l.name || JSON.stringify(l)}  (${(l.member_count || 0).toLocaleString()} members)`);
    }
  }

  const total = (data.users?.length || 0) + (data.topics?.length || 0)
    + (data.events?.length || 0) + (data.lists?.length || 0);
  if (total === 0) {
    console.log('\nNo results found.');
  }

  console.log('');
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

    case 'tweets': {
      const query = positional.join(' ');
      if (!query) {
        console.error('Usage: twitter-search.mjs tweets <query> [--type=Latest|Top|Media] [--count=20] [--cursor=X] [--hash=X] [--txn=X]');
        process.exit(1);
      }
      await searchTweets(query, flags);
      break;
    }

    case 'users': {
      const query = positional.join(' ');
      if (!query) {
        console.error('Usage: twitter-search.mjs users <query> [--count=10]');
        process.exit(1);
      }
      await searchUsers(query, flags);
      break;
    }

    case 'trends': {
      await fetchTrends(flags);
      break;
    }

    case 'typeahead': {
      const query = positional.join(' ');
      if (!query) {
        console.error('Usage: twitter-search.mjs typeahead <query> [--types=users,topics,events,lists]');
        process.exit(1);
      }
      await typeahead(query, flags);
      break;
    }

    default: {
      const s = 'twitter-search.mjs';
      console.log(`
twitter-search — Twitter/X search & discovery

Commands:
  auth                              Extract session from Chrome
  tweets <query> [flags]            Search tweets (via CDP intercept or --txn)
    --type=Latest|Top|Media         Search type (default: Latest)
    --count=20                      Results per page
    --cursor=X                      Pagination cursor
    --hash=X                        Override endpoint hash
    --txn=X                         Transaction ID (power-user bypass)
  users <query> [--count=10]        Search users (no Chrome needed)
  trends [--woeid=1]                Trending topics (1=world, 23424977=US)
  typeahead <query> [--types=...]   Typeahead suggestions

Common WOEIDs: 1=Worldwide, 23424977=US, 23424969=Turkey, 23424975=UK

Examples:
  node ${s} auth
  node ${s} tweets "AI startups" --type=Latest --count=10
  node ${s} tweets "from:elonmusk" --txn=abc123xyz
  node ${s} users "openai"
  node ${s} trends --woeid=23424977
  node ${s} typeahead "machine learning"

Session: ~/.local/share/showrun/data/twitter/session.json
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
