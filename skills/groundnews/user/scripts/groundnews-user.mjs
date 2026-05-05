#!/usr/bin/env node
// groundnews-user.mjs — Ground News user profile & settings from the terminal
//
// Setup (one-time, requires Chrome with Ground News open):
//   node groundnews-user.mjs auth
//
// Commands:
//   node groundnews-user.mjs me                         User profile
//   node groundnews-user.mjs settings                   Feed filter preferences
//   node groundnews-user.mjs plans                      Subscription details
//   node groundnews-user.mjs policies                   Feature entitlements
//   node groundnews-user.mjs my-interests [--limit N]   Followed interests
//   node groundnews-user.mjs interest-count             Count of followed interests
//   node groundnews-user.mjs follow <interest-uuid>     Follow an interest
//   node groundnews-user.mjs unfollow <interest-uuid>   Unfollow an interest
//   node groundnews-user.mjs update-setting <key> <val> Update a user setting
//   node groundnews-user.mjs story-status <event-id>    User interaction with a story
//   node groundnews-user.mjs blindspot-email             Blindspot email sub status
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/groundnews-user');
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
// Auth: extract GROUND_LOGIN_TOKEN cookie from Chrome Ground News tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Ground News tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/my-news', '/interest/', 'ground.news']) {
    for (const line of list.split('\n')) {
      if (line.includes('ground.news') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('ground.news')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No Ground News tab found. Open ground.news in Chrome first.');

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://ground.news'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));

  const token = cookieMap['GROUND_LOGIN_TOKEN'];
  if (!token) throw new Error('GROUND_LOGIN_TOKEN cookie not found. Are you logged in to Ground News?');

  saveJson(SESSION_FILE, { token, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://web-api-cdn.ground.news/api';

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.token) {
    console.error('No auth found. Run: node groundnews-user.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'Authorization': auth.token,
    'x-gn-v': 'web',
    'accept': 'application/json',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 401) {
    console.error('Session expired (401). Run: node groundnews-user.mjs auth');
    process.exit(1);
  }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else {
      const m2 = arg.match(/^--(\w[\w-]*)$/);
      if (m2) flags[m2[1]] = true;
      else positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function fetchMe(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/user/geo`);
  if (!result.ok) throw new Error(`Failed to fetch profile (HTTP ${result.status})`);
  return result.data;
}

async function fetchSettings(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/user/settings`);
  if (!result.ok) throw new Error(`Failed to fetch settings (HTTP ${result.status})`);
  return result.data;
}

async function fetchPlans(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/user/plans`);
  if (!result.ok) throw new Error(`Failed to fetch plans (HTTP ${result.status})`);
  return result.data;
}

async function fetchPolicies(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/account/policies`);
  if (!result.ok) throw new Error(`Failed to fetch policies (HTTP ${result.status})`);
  return result.data;
}

async function fetchMyInterests(auth, { limit = 100, offset = 0 } = {}) {
  const clampedLimit = Math.min(Math.max(1, limit), 500);
  const result = await apiFetch(auth, `${API_BASE}/v04/interests/listMy?limit=${clampedLimit}&offset=${offset}`);
  if (!result.ok) throw new Error(`Failed to fetch interests (HTTP ${result.status})`);
  return result.data;
}

async function fetchInterestCount(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/interests/myFollowedInterestCount`);
  if (!result.ok) throw new Error(`Failed to fetch interest count (HTTP ${result.status})`);
  return result.data;
}

async function updateInterest(auth, interestId, action) {
  const result = await apiFetch(auth, `${API_BASE}/v04/interests/updateMy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interestId, action }),
  });
  if (!result.ok) throw new Error(`Failed to ${action} interest (HTTP ${result.status}): ${JSON.stringify(result.data).substring(0, 300)}`);
  return result.data;
}

async function updateSetting(auth, key, value) {
  // Try to parse value as JSON (for booleans, numbers, etc.)
  let parsed = value;
  try { parsed = JSON.parse(value); } catch { /* keep as string */ }

  const result = await apiFetch(auth, `${API_BASE}/v04/user/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: parsed }),
  });
  if (!result.ok) throw new Error(`Failed to update setting (HTTP ${result.status}): ${JSON.stringify(result.data).substring(0, 300)}`);
  return result.data;
}

async function fetchStoryStatus(auth, eventId) {
  const result = await apiFetch(auth, `${API_BASE}/v04/eventRoom/feedUserData/${eventId}`);
  if (!result.ok) throw new Error(`Failed to fetch story status (HTTP ${result.status})`);
  return result.data;
}

async function fetchBlindspotEmail(auth) {
  const result = await apiFetch(auth, `${API_BASE}/v04/mailing/isSubscribed/blindspot`);
  if (!result.ok) throw new Error(`Failed to fetch blindspot email status (HTTP ${result.status})`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayMe(data) {
  console.log('\n--- User Profile ---');
  const name = data.fullname || data.name || data.displayName || '(not set)';
  console.log(`  Name:           ${name}`);
  console.log(`  Email:          ${data.email || '(not set)'}`);
  const sub = data.accountStatus || data.subscriptionStatus || data.subscription || '(unknown)';
  console.log(`  Subscription:   ${sub.replace(/\n/g, ' ').trim()}`);
  console.log(`  Sub info:       ${data.subscriptionInfoText || '(none)'}`);
  console.log(`  Edition:        ${data.topFeedEdition || data.edition || '(not set)'}`);
  console.log(`  Timezone:       ${data.timeZoneId || data.timezone || '(not set)'}`);
  if (data.registeredAt || data.registered || data.createdAt) {
    console.log(`  Registered:     ${data.registeredAt || data.registered || data.createdAt}`);
  }
  if (data.subscribedUntil) {
    console.log(`  Sub until:      ${data.subscribedUntil}`);
  }
  if (data.subscriptionWillRenew !== undefined) {
    console.log(`  Will renew:     ${data.subscriptionWillRenew}`);
  }
  console.log(`  Following:      ${data.followUserCount ?? data.followCount ?? data.followingCount ?? 0}`);
  console.log(`  Followers:      ${data.userFollowCount ?? data.followerCount ?? data.followersCount ?? 0}`);
  if (data.pnLevel !== undefined) {
    console.log(`  Notifications:  level=${data.pnLevel}, sound=${data.pnSound}`);
  }
  if (data.filterViewed !== undefined) {
    console.log(`  Filter viewed:  ${data.filterViewed}`);
  }
  if (data.filterPaywalls !== undefined) {
    console.log(`  Filter paywalls: ${data.filterPaywalls}`);
  }
}

function displaySettings(data) {
  console.log('\n--- Feed Settings ---');
  const keys = ['blindspotFilter', 'sourceSort', 'paywallFilter', 'ownershipFilter',
    'factualityFilter', 'localityFilter'];
  for (const k of keys) {
    if (data[k] !== undefined) {
      console.log(`  ${k}: ${JSON.stringify(data[k])}`);
    }
  }
  // Show any additional settings not in the known list
  for (const [k, v] of Object.entries(data)) {
    if (keys.includes(k)) continue;
    if (v === null || v === undefined) continue;
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

function displayPlans(data) {
  console.log('\n--- Subscription Plans ---');
  const plans = Array.isArray(data) ? data : (data.plans || data.subscriptions || [data]);
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') continue;
    const planName = (plan.name || plan.planName || plan.title || '(unknown)').replace(/\n/g, ' ').trim();
    console.log(`  Plan:       ${planName}`);
    console.log(`  Plan ID:    ${plan.planId || '(unknown)'}`);
    console.log(`  Source:     ${plan.source || plan.storeId || '(unknown)'}`);
    console.log(`  Active:     ${plan.currentlyActive ?? '(unknown)'}`);
    if (plan.isTrial !== undefined) console.log(`  Trial:      ${plan.isTrial}`);
    if (plan.start || plan.startDate) console.log(`  Start:      ${plan.start || plan.startDate}`);
    if (plan.endOrRenewDate) console.log(`  End/Renew:  ${plan.endOrRenewDate}`);
    if (plan.willRenew !== undefined) console.log(`  Will renew: ${plan.willRenew}`);
    if (plan.canRenew !== undefined) console.log(`  Can renew:  ${plan.canRenew}`);
    if (plan.isCancellable !== undefined) console.log(`  Cancellable: ${plan.isCancellable}`);
    if (plan.canUpgrade !== undefined) console.log(`  Can upgrade: ${plan.canUpgrade}`);
    if (plan.type) console.log(`  Type:       ${plan.type}`);
    if (plan.productId) console.log(`  Product:    ${plan.productId}`);
    if (plan.managementUrl) console.log(`  Manage URL: ${plan.managementUrl}`);
    console.log();
  }
}

function displayPolicies(data) {
  console.log('\n--- Feature Policies ---');
  const policies = Array.isArray(data) ? data : (data.policies || data.features || []);
  if (Array.isArray(policies) && policies.length > 0) {
    for (const p of policies) {
      if (typeof p === 'object') {
        const name = p.name || p.feature || p.policy || p.id || Object.keys(p)[0];
        if (p.type === 'both') {
          console.log(`  ${name}: ${p.enabled ? 'ENABLED' : 'disabled'} (limit: ${p.limit})`);
        } else if (p.type === 'binary') {
          console.log(`  ${name}: ${p.enabled ? 'ENABLED' : 'disabled'}`);
        } else if (p.type === 'limit') {
          console.log(`  ${name}: ${p.limit ?? p.value ?? '(unknown)'}`);
        } else {
          const limit = p.limit ?? p.value ?? p.allowed ?? JSON.stringify(p);
          console.log(`  ${name}: ${limit}`);
        }
      } else {
        console.log(`  ${p}`);
      }
    }
  } else if (typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'object' && v !== null) {
        const name = v.name || k;
        if (v.type === 'binary') {
          console.log(`  ${name}: ${v.enabled ? 'ENABLED' : 'disabled'}`);
        } else if (v.type === 'limit') {
          console.log(`  ${name}: ${v.limit ?? v.value ?? '(unknown)'}`);
        } else {
          console.log(`  ${k}: ${JSON.stringify(v)}`);
        }
      } else {
        console.log(`  ${k}: ${v}`);
      }
    }
  }
}

function displayInterests(data) {
  console.log('\n--- My Interests ---');
  const interests = Array.isArray(data) ? data : (data.interests || data.items || data.results || []);
  if (!interests.length) {
    console.log('  (no interests found)');
    return;
  }
  console.log(`  Count: ${interests.length}\n`);
  for (const item of interests) {
    const name = item.name || item.title || '(unnamed)';
    const type = item.type || item.interestType || '';
    const slug = item.slug || '';
    const pinned = item.pinned ? ' [PINNED]' : '';
    const notif = item.notificationSubscription || item.notificationSub;
    const notifStr = notif !== undefined ? ` | notify: ${notif}` : '';
    console.log(`  ${name} (${type})${pinned}${notifStr}`);
    if (slug) console.log(`    slug: ${slug}`);
    if (item.id || item.uuid) console.log(`    id: ${item.id || item.uuid}`);
  }
}

function displayStoryStatus(data) {
  console.log('\n--- Story Status ---');
  if (data.commentCount !== undefined) console.log(`  Comment count:  ${data.commentCount}`);
  if (data.youFollow !== undefined) console.log(`  You follow:     ${data.youFollow}`);
  if (data.proInteractionLimit !== undefined) console.log(`  Pro limit:      ${JSON.stringify(data.proInteractionLimit)}`);
  if (data.interests) {
    console.log('  Interests:');
    const interests = Array.isArray(data.interests) ? data.interests : [];
    for (const i of interests) {
      const name = i.name || i.title || '(unnamed)';
      const follow = i.youFollow !== undefined ? ` | follow: ${i.youFollow}` : '';
      console.log(`    ${name}${follow}`);
    }
  }
  // Print any remaining keys
  const skipKeys = new Set(['commentCount', 'youFollow', 'proInteractionLimit', 'interests']);
  for (const [k, v] of Object.entries(data)) {
    if (skipKeys.has(k)) continue;
    if (v === null || v === undefined) continue;
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'me': {
    const auth = getAuth();
    console.log('Fetching user profile...');
    const data = await fetchMe(auth);
    const outFile = resolve(CACHE_DIR, 'me.json');
    saveJson(outFile, data);
    displayMe(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'settings': {
    const auth = getAuth();
    console.log('Fetching feed settings...');
    const data = await fetchSettings(auth);
    const outFile = resolve(CACHE_DIR, 'settings.json');
    saveJson(outFile, data);
    displaySettings(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'plans': {
    const auth = getAuth();
    console.log('Fetching subscription plans...');
    const data = await fetchPlans(auth);
    const outFile = resolve(CACHE_DIR, 'plans.json');
    saveJson(outFile, data);
    displayPlans(data);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'policies': {
    const auth = getAuth();
    console.log('Fetching feature policies...');
    const data = await fetchPolicies(auth);
    const outFile = resolve(CACHE_DIR, 'policies.json');
    saveJson(outFile, data);
    displayPolicies(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'my-interests': {
    const { flags } = parseFlags(args);
    const auth = getAuth();
    const limit = parseInt(flags.limit || '100');
    const offset = parseInt(flags.offset || '0');
    console.log(`Fetching interests (limit=${limit}, offset=${offset})...`);
    const data = await fetchMyInterests(auth, { limit, offset });
    const outFile = resolve(CACHE_DIR, 'my-interests.json');
    saveJson(outFile, data);
    displayInterests(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'interest-count': {
    const auth = getAuth();
    console.log('Fetching interest count...');
    const data = await fetchInterestCount(auth);
    const outFile = resolve(CACHE_DIR, 'interest-count.json');
    saveJson(outFile, data);
    console.log(`\n--- Interest Count ---`);
    if (typeof data === 'object') {
      console.log(`  Count: ${data.count ?? data.total ?? JSON.stringify(data)}`);
    } else {
      console.log(`  Count: ${data}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'follow': {
    const interestId = args[0];
    if (!interestId) {
      console.error('Usage: node groundnews-user.mjs follow <interest-uuid>');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Following interest ${interestId}...`);
    const data = await updateInterest(auth, interestId, 'follow');
    const outFile = resolve(CACHE_DIR, `follow-${interestId}.json`);
    saveJson(outFile, data);
    console.log(`\n--- Follow Result ---`);
    if (data && typeof data === 'object') {
      if (data.name) console.log(`  Name: ${data.name}`);
      if (data.youFollow !== undefined) console.log(`  You follow: ${data.youFollow}`);
    }
    console.log(`  Result: ${JSON.stringify(data)}`);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'unfollow': {
    const interestId = args[0];
    if (!interestId) {
      console.error('Usage: node groundnews-user.mjs unfollow <interest-uuid>');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Unfollowing interest ${interestId}...`);
    const data = await updateInterest(auth, interestId, 'unfollow');
    const outFile = resolve(CACHE_DIR, `unfollow-${interestId}.json`);
    saveJson(outFile, data);
    console.log(`\n--- Unfollow Result ---`);
    console.log(`  Result: ${JSON.stringify(data)}`);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'update-setting': {
    const key = args[0];
    const value = args[1];
    if (!key || value === undefined) {
      console.error('Usage: node groundnews-user.mjs update-setting <key> <value>');
      console.error('Known keys: topFeedEdition, filterViewed, etc.');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Updating setting ${key} = ${value}...`);
    const data = await updateSetting(auth, key, value);
    const outFile = resolve(CACHE_DIR, 'update-setting.json');
    saveJson(outFile, data);
    console.log(`\n--- Updated Profile ---`);
    if (data && typeof data === 'object') {
      displayMe(data);
    } else {
      console.log(`  Result: ${JSON.stringify(data)}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'story-status': {
    const eventId = args[0];
    if (!eventId) {
      console.error('Usage: node groundnews-user.mjs story-status <event-id>');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Fetching story status for ${eventId}...`);
    const data = await fetchStoryStatus(auth, eventId);
    const outFile = resolve(CACHE_DIR, `story-status-${eventId}.json`);
    saveJson(outFile, data);
    displayStoryStatus(data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'blindspot-email': {
    const auth = getAuth();
    console.log('Checking blindspot email subscription...');
    const data = await fetchBlindspotEmail(auth);
    const outFile = resolve(CACHE_DIR, 'blindspot-email.json');
    saveJson(outFile, data);
    console.log(`\n--- Blindspot Email ---`);
    if (typeof data === 'object') {
      console.log(`  Subscribed: ${data.isSubscribed ?? data.subscribed ?? JSON.stringify(data)}`);
    } else {
      console.log(`  Subscribed: ${data}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  default:
    console.log(`groundnews-user — Ground News user profile & settings

Commands:
  auth                              Authenticate via Chrome (one-time)
  me                                User profile (name, email, subscription)
  settings                          Feed filter preferences
  plans                             Subscription plan details
  policies                          Feature entitlements for your tier
  my-interests [--limit=N] [--offset=N]
                                    List followed interests (default limit: 100)
  interest-count                    Count of followed interests
  follow <interest-uuid>            Follow an interest
  unfollow <interest-uuid>          Unfollow an interest
  update-setting <key> <value>      Update a user setting
  story-status <event-id>           Your interaction with a story
  blindspot-email                   Blindspot email subscription status

Data: ${DATA_DIR}/
  session.json     Auth token
  cache/           Cached API responses`);
}
