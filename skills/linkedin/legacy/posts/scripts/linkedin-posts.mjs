#!/usr/bin/env node
// linkedin-posts.mjs — View posts, comments, reactions, and interact with LinkedIn posts
//
// Setup:   node linkedin-posts.mjs auth
// Usage:   node linkedin-posts.mjs feed emrahyalaz
//          node linkedin-posts.mjs details <activityUrn>
//          node linkedin-posts.mjs like <activityUrn>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { applySetCookies, cookieMapFrom, linkedInCookieString, chromeFetch } from '../../../_shared/linkedin-fetch.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-posts');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(path) { if (!existsSync(path)) return {}; return JSON.parse(readFileSync(path, 'utf8')); }
function saveJson(path, data) { ensureDir(resolve(path, '..')); writeFileSync(path, JSON.stringify(data, null, 2)); }

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------


const LINKEDIN_COOKIE_URLS = [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/sales/',
  'https://www.linkedin.com/sales/home',
];

function parseCookieResponse(raw, source) {
  try {
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.cookies)) throw new Error('response has no cookies array');
    return data.cookies;
  } catch (err) {
    throw new Error(`${source} cookie extraction failed: ${err.message}`);
  }
}


function activeTabInfo(target, listText = '') {
  let url = '';
  let title = '';
  try {
    const raw = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    }));
    const parsed = JSON.parse(raw);
    const value = parsed?.result?.value || parsed?.result?.description;
    if (value) {
      const info = JSON.parse(value);
      url = info.url || '';
      title = info.title || '';
    }
  } catch {}
  if (!url) {
    const line = String(listText || '').split('\n').find(l => l.trim().startsWith(`${target} `) || l.includes(target));
    if (line) url = line.trim();
  }
  return { url, title };
}

function readLinkedInCookies(target) {
  const errors = [];
  try {
    const cookies = parseCookieResponse(cdp('evalraw', target, 'Storage.getCookies', '{}'), 'Storage.getCookies');
    return { cookies, source: 'Storage.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  try {
    const cookies = parseCookieResponse(
      cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: LINKEDIN_COOKIE_URLS })),
      'Network.getCookies',
    );
    return { cookies, source: 'Network.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  for (const url of LINKEDIN_COOKIE_URLS) {
    try {
      const cookies = parseCookieResponse(
        cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: [url] })),
        `Network.getCookies ${url}`,
      );
      return { cookies, source: `Network.getCookies ${url}` };
    } catch (err) {
      errors.push(err.message);
    }
  }

  throw new Error(`LinkedIn/Sales Nav cookie extraction failure in active CDP session: ${errors.join(' | ')}`);
}

function getLinkedInAuthCookies(target, listText = '') {
  const { cookies, source } = readLinkedInCookies(target);
  const cookieMap = cookieMapFrom(cookies);
  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  const missing = ['li_at', 'JSESSIONID'].filter(name => !cookieMap[name]);
  if (missing.length) {
    const info = activeTabInfo(target, listText);
    const activeUrl = info.url || '';
    const activeTitle = info.title || '';
    if (/\/login(?:[/?#]|$)|\/sales\/login(?:[/?#]|$)/i.test(activeUrl)) {
      throw new Error('LinkedIn/Sales Nav is showing login page in the active CDP session; log in through the same live Browser Use URL or pass the exact live CDP endpoint.');
    }
    throw new Error(
      `LinkedIn/Sales Nav auth cookies missing (${missing.join(', ')}) after ${source}. ` +
      `Active tab URL/title: ${activeUrl || '<unknown>'}${activeTitle ? ` / ${activeTitle}` : ''}. ` +
      'This is not enough to claim generic logged-out state: distinguish wrong CDP session/profile, actual logged-out state, or cookie extraction failure. For human login handoff, use the exact live Browser Use CDP endpoint.',
    );
  }
  return { cookieStr: linkedInCookieString(cookies), csrfToken, cookieSource: source };
}

async function doAuth() {
  console.log('Finding LinkedIn tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No LinkedIn tab found.');

  const { cookieStr, csrfToken, cookieSource } = getLinkedInAuthCookies(target, list);
  console.log(`Extracted LinkedIn cookies via ${cookieSource}`);

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) { console.error('No auth found. Run: node linkedin-posts.mjs auth'); process.exit(1); }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'X-LI-Lang': 'en_US',
    'Csrf-Token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  // Route every API call through Chrome's logged-in LinkedIn tab so cookies
  // (including JSESSIONID rotation) come from Chrome's single jar — no Node-vs-
  // Chrome drift, no anti-abuse trips, no surprise logouts.
  const resp = await chromeFetch(url, { ...options, headers: { ...baseHeaders(auth), ...options.headers } });
  if (resp.status === 201 || resp.status === 204) return { status: resp.status, data: null };
  let data; try { data = JSON.parse(resp.body); } catch { data = resp.body; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node linkedin-posts.mjs auth');
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Profile resolution (for feed command)
// ---------------------------------------------------------------------------

function parseVanityName(input) {
  const match = input.match(/(?:linkedin\.com\/in\/|^\/in\/|^)([^\s/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : input;
}

async function resolveProfileUrn(auth, vanityName) {
  const profiles = loadJson(PROFILES_FILE);
  const key = vanityName.toLowerCase();
  if (profiles[key]) return profiles[key];

  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanityName)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`;
  const { data } = await apiFetch(auth, url, { headers: { 'accept': 'application/vnd.linkedin.normalized+json+2.1' } });

  const included = data?.included || [];
  const profile = included.find(e => e.entityUrn?.includes('fsd_profile') && e.firstName);
  if (!profile) throw new Error(`Could not find profile for "${vanityName}"`);

  const result = { urn: profile.entityUrn, name: `${profile.firstName} ${profile.lastName}`.trim(), vanityName };
  profiles[key] = result;
  saveJson(PROFILES_FILE, profiles);
  return result;
}

// ---------------------------------------------------------------------------
// Activity URN parsing
// ---------------------------------------------------------------------------

function parseActivityUrn(input) {
  // Accept: full URN, activity URL, or just the numeric ID
  if (input.startsWith('urn:li:activity:')) return input;
  const urlMatch = input.match(/activity[:/](\d+)/);
  if (urlMatch) return `urn:li:activity:${urlMatch[1]}`;
  if (/^\d+$/.test(input)) return `urn:li:activity:${input}`;
  return input;
}

function activityId(urn) {
  return urn.match(/\d+$/)?.[0] || urn;
}

// ---------------------------------------------------------------------------
// Feed: fetch user posts
// ---------------------------------------------------------------------------

async function fetchFeed(auth, profileUrn, { count = 10 } = {}) {
  const encodedUrn = encodeURIComponent(profileUrn);
  const url = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?profileUrn=${encodedUrn}&q=memberShareFeed&moduleKey=member-shares_your-posts&count=${count}`;
  const { data } = await apiFetch(auth, url);

  return (data?.elements || []).map(el => {
    const socialCounts = el.socialDetail?.totalSocialActivityCounts || {};
    return {
      activityUrn: el.updateMetadata?.urn,
      text: el.commentary?.text?.text || el.resharedUpdate?.commentary?.text?.text || '',
      created: el.actor?.subDescription?.text?.replace(/\s*•\s*$/, '').trim(),
      likes: socialCounts.numLikes || 0,
      comments: socialCounts.numComments || 0,
      shares: socialCounts.numShares || 0,
      liked: socialCounts.liked || false,
      reactionTypes: socialCounts.reactionTypeCounts?.map(r => ({ type: r.reactionType, count: r.count })) || [],
    };
  });
}

// ---------------------------------------------------------------------------
// My feed: fetch home feed
// ---------------------------------------------------------------------------

const MAIN_FEED_QUERY_ID = 'voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475';

async function fetchMyFeed(auth, { count = 10, start = 0, sort = 'relevant' } = {}) {
  const sortOrder = sort === 'recent' ? 'REV_CHRON' : 'RELEVANCE';
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=(start:${start},count:${count},sortOrder:${sortOrder})&queryId=${MAIN_FEED_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const feed = data?.data?.feedDashMainFeedByMainFeed || {};
  const elements = feed.elements || [];

  return elements
    .filter(el => el.metadata?.backendUrn?.includes('activity')) // skip ads/promos
    .map(el => {
      const socialCounts = el.socialDetail?.totalSocialActivityCounts || {};
      return {
        activityUrn: el.metadata?.backendUrn,
        shareUrn: el.metadata?.shareUrn,
        author: el.actor?.name?.text,
        authorHeadline: el.actor?.description?.text,
        text: el.commentary?.text?.text || el.resharedUpdate?.commentary?.text?.text || '',
        created: el.actor?.subDescription?.text?.replace(/\s*•\s*$/, '').trim(),
        likes: socialCounts.numLikes || 0,
        comments: socialCounts.numComments || 0,
        shares: socialCounts.numShares || 0,
        liked: socialCounts.liked || false,
        reactionTypes: socialCounts.reactionTypeCounts?.map(r => ({ type: r.reactionType, count: r.count })) || [],
        isReshare: !!el.resharedUpdate,
      };
    });
}

// ---------------------------------------------------------------------------
// Post details: fetch a single post with full data
// ---------------------------------------------------------------------------

async function fetchPostDetails(auth, activityUrn) {
  // Use the feed update endpoint for a single post
  const encodedUrn = encodeURIComponent(activityUrn);
  const url = `https://www.linkedin.com/voyager/api/feed/updates/${encodedUrn}`;
  const { data } = await apiFetch(auth, url);

  const update = data?.value?.['com.linkedin.voyager.feed.render.UpdateV2'] || data || {};
  const socialCounts = update.socialDetail?.totalSocialActivityCounts || {};
  const actor = update.actor || {};
  const content = update.content || {};

  return {
    activityUrn,
    author: actor.name?.text,
    authorHeadline: actor.description?.text,
    text: update.commentary?.text?.text || '',
    created: actor.subDescription?.text,
    likes: socialCounts.numLikes || 0,
    comments: socialCounts.numComments || 0,
    shares: socialCounts.numShares || 0,
    liked: socialCounts.liked || false,
    reactionTypes: socialCounts.reactionTypeCounts?.map(r => ({ type: r.reactionType, count: r.count })) || [],
    article: content.articleComponent ? {
      title: content.articleComponent.title?.text,
      subtitle: content.articleComponent.subtitle?.text,
      url: content.articleComponent.navigationContext?.actionTarget,
    } : undefined,
    reshared: update.resharedUpdate ? {
      text: update.resharedUpdate.commentary?.text?.text,
      author: update.resharedUpdate.actor?.name?.text,
    } : undefined,
    link: `https://www.linkedin.com/feed/update/${activityUrn}/`,
  };
}

// ---------------------------------------------------------------------------
// Comments: fetch comments on a post
// ---------------------------------------------------------------------------

const COMMENTS_QUERY_ID = 'voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87';

async function fetchComments(auth, activityUrn, { count = 10, start = 0 } = {}) {
  const encodedActivity = encodeURIComponent(activityUrn);
  const socialDetailUrn = `urn%3Ali%3Afsd_socialDetail%3A%28${encodedActivity}%2C${encodedActivity}%2Curn%3Ali%3AhighlightedReply%3A-%29`;
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${count},numReplies:1,socialDetailUrn:${socialDetailUrn},sortOrder:RELEVANCE,start:${start})&queryId=${COMMENTS_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const result = data?.data?.socialDashCommentsBySocialDetail || {};
  const elements = result.elements || [];
  const total = result.paging?.total || elements.length;

  const comments = elements.map(el => ({
    commentUrn: el.entityUrn,
    author: el.commenter?.title?.text,
    authorHeadline: el.commenter?.subtitle,
    text: el.commentary?.text || '',
    likes: el.socialDetail?.totalSocialActivityCounts?.numLikes || 0,
    replies: el.socialDetail?.totalSocialActivityCounts?.numComments || 0,
  }));

  return { total, comments };
}

// ---------------------------------------------------------------------------
// Reactions: fetch who reacted to a post
// ---------------------------------------------------------------------------

const REACTIONS_QUERY_ID = 'voyagerSocialDashReactions.41ebf31a9f4c4a84e35a49d5abc9010b';

async function resolveReactionsThreadUrn(auth, activityUrn) {
  const encodedUrn = encodeURIComponent(activityUrn);
  const { data } = await apiFetch(auth, `https://www.linkedin.com/voyager/api/feed/updates/${encodedUrn}`);
  const update = data?.value?.['com.linkedin.voyager.feed.render.UpdateV2'] || data || {};
  // socialDetail.entityUrn = "urn:li:fs_socialDetail:urn:li:ugcPost:..." or "urn:li:fs_socialDetail:urn:li:activity:..."
  const sdUrn = update.socialDetail?.entityUrn;
  if (sdUrn) {
    const inner = sdUrn.replace('urn:li:fs_socialDetail:', '');
    if (inner !== sdUrn) return inner;
  }
  return update.updateMetadata?.shareUrn || activityUrn;
}

async function fetchReactions(auth, activityUrn, { count = 10, start = 0 } = {}) {
  const shareUrn = await resolveReactionsThreadUrn(auth, activityUrn);
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${count},start:${start},threadUrn:${encodeURIComponent(shareUrn)})&queryId=${REACTIONS_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const result = data?.data?.socialDashReactionsByReactionType || data?.data?.socialDashReactionsByReactedOnEntityAndReactionType || {};
  const elements = result.elements || [];
  const total = result.paging?.total || elements.length;

  const reactions = elements.map(el => ({
    name: el.reactorLockup?.title?.text,
    headline: el.reactorLockup?.subtitle?.text,
    type: el.reactionType,
    profileUrn: el.actorUrn,
  }));

  return { total, reactions };
}

// ---------------------------------------------------------------------------
// Like / Unlike a post
// ---------------------------------------------------------------------------

const REACT_QUERY_ID = 'voyagerSocialDashReactions.b731222600772fd42464c0fe19bd722b';

async function likePost(auth, activityUrn, reactionType = 'LIKE') {
  const url = `https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=${REACT_QUERY_ID}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      variables: { entity: { reactionType }, threadUrn: activityUrn },
      queryId: REACT_QUERY_ID,
      includeWebMetadata: true,
    }),
  });
}

const UNREACT_QUERY_ID = 'voyagerSocialDashReactions.f68b48ae5bc0085d7a45c7003b772a39';

async function unlikePost(auth, activityUrn) {
  const url = `https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=${UNREACT_QUERY_ID}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({ variables: { threadUrn: activityUrn }, queryId: UNREACT_QUERY_ID, includeWebMetadata: true }),
  });
}

// ---------------------------------------------------------------------------
// Comment on a post
// ---------------------------------------------------------------------------

async function commentOnPost(auth, activityUrn, text) {
  const url = 'https://www.linkedin.com/voyager/api/voyagerSocialDashComments';
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      threadUrn: activityUrn,
      commentary: { text, attributesV2: [] },
    }),
  });
}

// ---------------------------------------------------------------------------
// Like / Unlike a comment
// ---------------------------------------------------------------------------

function buildCommentThreadUrn(activityUrn, commentId) {
  const actId = activityUrn.replace('urn:li:activity:', '');
  return `urn:li:comment:(activity:${actId},${commentId})`;
}

async function likeComment(auth, activityUrn, commentId, reactionType = 'LIKE') {
  const threadUrn = buildCommentThreadUrn(activityUrn, commentId);
  const url = `https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=${REACT_QUERY_ID}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      variables: { entity: { reactionType }, threadUrn },
      queryId: REACT_QUERY_ID,
      includeWebMetadata: true,
    }),
  });
}

async function unlikeComment(auth, activityUrn, commentId) {
  const threadUrn = buildCommentThreadUrn(activityUrn, commentId);
  const url = `https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=${UNREACT_QUERY_ID}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({ variables: { threadUrn }, queryId: UNREACT_QUERY_ID }),
  });
}

// ---------------------------------------------------------------------------
// Reply to a comment
// ---------------------------------------------------------------------------

async function replyToComment(auth, activityUrn, commentId, text) {
  const parentCommentUrn = buildCommentThreadUrn(activityUrn, commentId);
  const url = 'https://www.linkedin.com/voyager/api/voyagerSocialDashComments';
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      threadUrn: activityUrn,
      parentCommentUrn,
      commentary: { text, attributesV2: [] },
    }),
  });
}

// ---------------------------------------------------------------------------
// Repost
// ---------------------------------------------------------------------------

const REPOST_QUERY_ID = 'voyagerFeedDashReposts.a0663ae5c654123343da36617d2dbfde';

async function repost(auth, activityUrn) {
  // Simple repost needs the share URN (derived from activity URN)
  // activity URN -> share URN: activity ID - 1 is typically the share ID
  // But we need the actual rootContentUrn. Let's get it from the post details.
  const encodedUrn = encodeURIComponent(activityUrn);
  const detailResp = await apiFetch(auth, `https://www.linkedin.com/voyager/api/feed/updates/${encodedUrn}`);
  const update = detailResp.data?.value?.['com.linkedin.voyager.feed.render.UpdateV2'] || detailResp.data || {};
  const rootUrn = update.updateMetadata?.shareUrn || update.updateMetadata?.urn;

  if (!rootUrn) throw new Error('Could not determine share URN for this post.');

  const url = `https://www.linkedin.com/voyager/api/graphql?action=execute&queryId=${REPOST_QUERY_ID}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      variables: { entity: { rootContentUrn: rootUrn } },
      queryId: REPOST_QUERY_ID,
      includeWebMetadata: true,
    }),
  });
}

async function repostWithThoughts(auth, activityUrn, commentary) {
  // Repost with thoughts creates a new UGC post that references the original
  const encodedUrn = encodeURIComponent(activityUrn);
  const detailResp = await apiFetch(auth, `https://www.linkedin.com/voyager/api/feed/updates/${encodedUrn}`);
  const update = detailResp.data?.value?.['com.linkedin.voyager.feed.render.UpdateV2'] || detailResp.data || {};
  const shareUrn = update.updateMetadata?.shareUrn || update.updateMetadata?.urn;

  if (!shareUrn) throw new Error('Could not determine share URN for this post.');

  const url = 'https://www.linkedin.com/voyager/api/feed/shares';
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/vnd.linkedin.normalized+json+2.1' },
    body: JSON.stringify({
      commentary: { text: commentary, attributesV2: [] },
      resharedUpdate: shareUrn,
      visibility: 'PUBLIC',
      origin: 'FEED',
    }),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'my-feed': {
    const { flags } = parseFlags(args);
    const auth = getAuth();
    const count = parseInt(flags.count || '10');
    const start = parseInt(flags.start || '0');
    const sort = flags.sort || 'relevant';

    console.log(`Fetching your feed (${sort === 'recent' ? 'most recent' : 'most relevant'})...`);
    const posts = await fetchMyFeed(auth, { count, start, sort });

    const outFile = resolve(CACHE_DIR, 'my-feed.json');
    saveJson(outFile, posts);

    console.log(`\n${posts.length} posts in your feed\n`);
    for (const post of posts) {
      const engagement = [
        post.likes ? `${post.likes} likes` : null,
        post.comments ? `${post.comments} comments` : null,
      ].filter(Boolean).join(', ') || 'no engagement';

      console.log(`  ${post.author || '(unknown)'}${post.isReshare ? ' (reshared)' : ''} — ${post.created || ''}`);
      console.log(`    ${post.text.substring(0, 120)}${post.text.length > 120 ? '...' : ''}`);
      console.log(`    ${engagement}${post.liked ? ' (liked by you)' : ''}`);
      console.log(`    ${post.activityUrn}`);
      console.log();
    }
    if (posts.length === count) console.log(`More posts. Use --start=${start + count}`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'feed': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node linkedin-posts.mjs feed <vanityName|url> [--count=10]');
      process.exit(1);
    }

    const auth = getAuth();
    const vanityName = parseVanityName(input);
    const count = parseInt(flags.count || '10');

    console.log(`Resolving ${vanityName}...`);
    const profile = await resolveProfileUrn(auth, vanityName);
    console.log(`Fetching posts for ${profile.name}...`);
    const posts = await fetchFeed(auth, profile.urn, { count });

    const outFile = resolve(CACHE_DIR, `feed-${vanityName}.json`);
    saveJson(outFile, { profile: profile.name, profileUrn: profile.urn, posts });

    console.log(`\n${profile.name} — ${posts.length} posts\n`);
    for (const post of posts) {
      const engagement = [
        post.likes ? `${post.likes} likes` : null,
        post.comments ? `${post.comments} comments` : null,
        post.shares ? `${post.shares} shares` : null,
      ].filter(Boolean).join(', ') || 'no engagement';

      console.log(`  [${post.created || ''}] ${post.text.substring(0, 120)}${post.text.length > 120 ? '...' : ''}`);
      console.log(`    ${engagement}${post.liked ? ' (liked by you)' : ''}`);
      console.log(`    ${post.activityUrn}`);
      console.log();
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'details': {
    const activityInput = args[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs details <activityUrn|url|id>');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    console.log(`Fetching post ${activityId(urn)}...`);
    const details = await fetchPostDetails(auth, urn);

    const outFile = resolve(CACHE_DIR, `post-${activityId(urn)}.json`);
    saveJson(outFile, details);

    console.log(`\n${details.author || '(unknown)'}`);
    if (details.authorHeadline) console.log(`  ${details.authorHeadline}`);
    console.log(`  ${details.created || ''}`);
    console.log();
    if (details.text) console.log(`  ${details.text.substring(0, 500)}${details.text.length > 500 ? '...' : ''}`);
    if (details.article) {
      console.log(`\n  Article: ${details.article.title || ''}`);
      if (details.article.url) console.log(`    ${details.article.url}`);
    }
    if (details.reshared) {
      console.log(`\n  Reshared from ${details.reshared.author || ''}:`);
      if (details.reshared.text) console.log(`    ${details.reshared.text.substring(0, 200)}`);
    }
    console.log();
    const engagement = [
      details.likes ? `${details.likes} likes` : null,
      details.comments ? `${details.comments} comments` : null,
      details.shares ? `${details.shares} shares` : null,
    ].filter(Boolean).join(' | ') || 'no engagement';
    console.log(`  ${engagement}${details.liked ? ' | liked by you' : ''}`);
    if (details.reactionTypes.length) {
      console.log(`  Reactions: ${details.reactionTypes.map(r => `${r.type}(${r.count})`).join(', ')}`);
    }
    console.log(`\n  ${details.link}`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'comments': {
    const { flags, positional } = parseFlags(args);
    const activityInput = positional[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs comments <activityUrn|url|id> [--count=10] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    const count = parseInt(flags.count || '10');
    const start = parseInt(flags.start || '0');

    console.log(`Fetching comments on ${activityId(urn)}...`);
    const result = await fetchComments(auth, urn, { count, start });

    const outFile = resolve(CACHE_DIR, `comments-${activityId(urn)}.json`);
    saveJson(outFile, result);

    console.log(`\n${result.comments.length} comments (${result.total} total)\n`);
    for (const c of result.comments) {
      console.log(`  ${c.author || '(anonymous)'}`);
      console.log(`    ${c.text.substring(0, 200)}${c.text.length > 200 ? '...' : ''}`);
      const meta = [c.likes ? `${c.likes} likes` : null, c.replies ? `${c.replies} replies` : null].filter(Boolean).join(', ');
      if (meta) console.log(`    ${meta}`);
      console.log();
    }
    if (result.total > start + count) console.log(`More comments. Use --start=${start + count}`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'reactions': {
    const { flags, positional } = parseFlags(args);
    const activityInput = positional[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs reactions <activityUrn|url|id> [--count=10] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    const count = parseInt(flags.count || '10');
    const start = parseInt(flags.start || '0');

    console.log(`Fetching reactions on ${activityId(urn)}...`);
    const result = await fetchReactions(auth, urn, { count, start });

    const outFile = resolve(CACHE_DIR, `reactions-${activityId(urn)}.json`);
    saveJson(outFile, result);

    console.log(`\n${result.reactions.length} reactions (${result.total} total)\n`);
    for (const r of result.reactions) {
      console.log(`  ${r.type} — ${r.name || '(anonymous)'}${r.headline ? ' (' + r.headline.substring(0, 50) + ')' : ''}`);
    }
    if (result.total > start + count) console.log(`\nMore reactions. Use --start=${start + count}`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'like': {
    const { flags, positional } = parseFlags(args);
    const activityInput = positional[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs like <activityUrn|url|id> [--type=LIKE]');
      console.error('  Reaction types: LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    const type = flags.type || 'LIKE';

    console.log(`Reacting ${type} on ${activityId(urn)}...`);
    await likePost(auth, urn, type);
    console.log(`Reacted with ${type}.`);
    break;
  }

  case 'unlike': {
    const activityInput = args[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs unlike <activityUrn|url|id>');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);

    console.log(`Removing reaction on ${activityId(urn)}...`);
    await unlikePost(auth, urn);
    console.log('Reaction removed.');
    break;
  }

  case 'comment': {
    const { positional } = parseFlags(args);
    const activityInput = positional[0];
    const text = positional.slice(1).join(' ');
    if (!activityInput || !text) {
      console.error('Usage: node linkedin-posts.mjs comment <activityUrn|url|id> "Your comment text"');
      process.exit(1);
    }

    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);

    console.log(`Commenting on ${activityId(urn)}...`);
    await commentOnPost(auth, urn, text);
    console.log(`Comment posted: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    break;
  }

  case 'like-comment': {
    const { flags, positional } = parseFlags(args);
    const activityInput = positional[0];
    const commentId = positional[1];
    if (!activityInput || !commentId) {
      console.error('Usage: node linkedin-posts.mjs like-comment <activityUrn|id> <commentId> [--type=LIKE]');
      process.exit(1);
    }
    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    const type = flags.type || 'LIKE';
    console.log(`Reacting ${type} on comment ${commentId}...`);
    await likeComment(auth, urn, commentId, type);
    console.log(`Reacted with ${type} on comment.`);
    break;
  }

  case 'unlike-comment': {
    const activityInput = args[0];
    const commentId = args[1];
    if (!activityInput || !commentId) {
      console.error('Usage: node linkedin-posts.mjs unlike-comment <activityUrn|id> <commentId>');
      process.exit(1);
    }
    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    console.log(`Removing reaction on comment ${commentId}...`);
    await unlikeComment(auth, urn, commentId);
    console.log('Reaction removed from comment.');
    break;
  }

  case 'reply': {
    const { positional } = parseFlags(args);
    const activityInput = positional[0];
    const commentId = positional[1];
    const text = positional.slice(2).join(' ');
    if (!activityInput || !commentId || !text) {
      console.error('Usage: node linkedin-posts.mjs reply <activityUrn|id> <commentId> "Your reply text"');
      process.exit(1);
    }
    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    console.log(`Replying to comment ${commentId}...`);
    await replyToComment(auth, urn, commentId, text);
    console.log(`Reply posted: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    break;
  }

  case 'repost': {
    const { positional } = parseFlags(args);
    const activityInput = positional[0];
    if (!activityInput) {
      console.error('Usage: node linkedin-posts.mjs repost <activityUrn|id>');
      process.exit(1);
    }
    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    console.log(`Reposting ${activityId(urn)}...`);
    await repost(auth, urn);
    console.log('Reposted.');
    break;
  }

  case 'repost-with-thoughts': {
    const { positional } = parseFlags(args);
    const activityInput = positional[0];
    const text = positional.slice(1).join(' ');
    if (!activityInput || !text) {
      console.error('Usage: node linkedin-posts.mjs repost-with-thoughts <activityUrn|id> "Your thoughts"');
      process.exit(1);
    }
    const auth = getAuth();
    const urn = parseActivityUrn(activityInput);
    console.log(`Reposting with thoughts...`);
    await repostWithThoughts(auth, urn, text);
    console.log(`Reposted with: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    break;
  }

  default:
    console.log(`linkedin-posts — View and interact with LinkedIn posts

Commands:
  auth                                    Authenticate via Chrome (one-time)
  my-feed [--sort=relevant|recent]         Your LinkedIn home feed
  feed <vanityName|url> [--count=10]      Fetch a specific user's posts
  details <activity>                      View full post details
  comments <activity> [--count] [--start] View post comments
  reactions <activity> [--count] [--start] View who reacted
  like <activity> [--type=LIKE]           React to a post
  unlike <activity>                       Remove your reaction
  comment <activity> "text"               Comment on a post
  like-comment <activity> <commentId>     React to a comment
  unlike-comment <activity> <commentId>   Remove reaction from comment
  reply <activity> <commentId> "text"     Reply to a comment
  repost <activity>                       Instant repost
  repost-with-thoughts <activity> "text"  Repost with your thoughts

Activity input formats (all work):
  urn:li:activity:7437485807881453568     Full URN
  7437485807881453568                     Activity ID
  https://linkedin.com/feed/update/urn:li:activity:7437485807881453568/

Comment IDs: get from the "comments" command output (numeric part of commentUrn)

Reaction types: LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT

Data: ${DATA_DIR}/
  session.json    Auth cookies & CSRF token
  profiles.json   Cached profile URN lookups
  cache/          Posts, comments, and reactions`);
}
