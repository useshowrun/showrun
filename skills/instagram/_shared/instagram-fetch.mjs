// instagram-fetch.mjs — shared in-page request layer for the Instagram skills.
//
// Every Instagram request runs INSIDE the user's logged-in instagram.com tab
// via `cdp eval` (fetch with credentials:'include'). Chrome supplies cookies
// from its single jar, handles Set-Cookie, and sends its real TLS/HTTP2
// fingerprint. Nothing is replayed from Node with copied cookies — that
// parallel-cookie-jar pattern is what got LinkedIn sessions killed (see the
// LinkedIn chromeFetch commit) and Instagram's anti-abuse is no softer.
//
// Three request kinds:
//
//   igGraphql(name, variables)  POST /api/graphql the way the web app does it.
//       doc_id      -> require('<name>_instagramRelayOperation') in the page
//                      (falls back to the DOC_IDS table below)
//       provided    -> require('<name>.graphql').params.providedVariables
//       variables      (__relay_internal__pv__*), evaluated in the page
//       form params -> require('getAsyncParams')('POST'): fb_dtsg, lsd,
//                      jazoest, __dyn, __csr, __hs, __rev, __spin_*, ...
//                      plus av = CurrentUserInitialData.NON_FACEBOOK_USER_ID
//       headers     -> X-CSRFToken (csrftoken cookie), X-FB-LSD,
//                      X-IG-App-ID (CurrentUserInitialData.APP_ID),
//                      X-ASBD-ID (BDHeaderConfig.ASBD_ID), X-FB-Friendly-Name
//   igApi(path)                 Legacy /api/v1/* REST, same headers minus LSD.
//   resolveUserPk(username)     GET /<username>/ and read "profile_id" from
//                               the HTML (cached in cache/user-ids.json).
//
// Tokens (fb_dtsg, lsd, csrftoken, ASBD id, app id) are never hardcoded: they
// are read from the live page on every call. doc_ids and provided variables
// come from the page's module registry when the query module is loaded (true
// on the home feed for profile, posts, highlights, stories and search). The
// DOC_IDS / PROVIDED tables are fallbacks captured from the web app on
// 2026-10-30; the Reels/Tagged tab queries are only bundled once such a tab
// has been opened, so they normally run on the fallback. Set
// INSTAGRAM_DEBUG=1 to log which source each call used.
//
// Pacing: consecutive requests (across processes) are spaced by at least
// INSTAGRAM_MIN_INTERVAL_MS (default 5000 ms) using a timestamp file.
//
// Requires Node 22+ and the chrome-cdp skill. Zero dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

export const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
export const CACHE_DIR = resolve(DATA_DIR, 'cache');
const PACE_FILE = resolve(DATA_DIR, '.last-request');
const ID_CACHE_FILE = resolve(CACHE_DIR, 'user-ids.json');
const OPEN_TAB_HINT = 'node skills/chrome-cdp/scripts/cdp.mjs open https://www.instagram.com/';

const IG_APP_ID_FALLBACK = '936619743392459';

// Fallbacks captured 2026-10-30 from the live web app. Used only when the
// tab's module registry does not have the operation loaded.
export const DOC_IDS = {
  PolarisProfilePageContentQuery: '40158838120366999',
  PolarisProfilePostsQuery: '28853197790995760',
  PolarisProfileStoryHighlightsTrayContentQuery: '26970053832668570',
  PolarisSearchBoxRefetchableQuery: '27706427925724183',
  PolarisAPILocationSearchQuery: '28700062289635266',
  PolarisStoriesV3ReelPageStandaloneQuery: '29170422829314651',
  // Profile-tab queries: only in the page's registry after a profile's
  // Reels/Tagged tab has been opened, so these fallbacks are the usual path.
  PolarisProfileReelsTabContentQuery: '29274814152148198',
  PolarisProfileReelsTabContentQuery_connection: '39544804838467783',
  PolarisProfileTaggedTabContentQuery: '28497994709883703',
};

const PV = '__relay_internal__pv__';
const PROVIDED = {
  PolarisProfilePageContentQuery: {
    [`${PV}PolarisCannesGuardianExperienceEnabledrelayprovider`]: true,
    [`${PV}PolarisCASB976ProfileEnabledrelayprovider`]: false,
    [`${PV}PolarisProfileInformTreatmentBannerEnabledrelayprovider`]: false,
    [`${PV}PolarisWebSchoolsEnabledrelayprovider`]: false,
    [`${PV}PolarisProfileRingsGradientEnabledrelayprovider`]: true,
    [`${PV}PolarisRepostsConsumptionEnabledrelayprovider`]: true,
    [`${PV}PolarisShortDramaEnabledrelayprovider`]: true,
  },
  PolarisProfilePostsQuery: {
    [`${PV}PolarisMultiCaptionCarouselEnabledrelayprovider`]: false,
    [`${PV}PolarisShortDramaEnabledrelayprovider`]: true,
    [`${PV}PolarisSEOIsCrawlerrelayprovider`]: false,
    [`${PV}PolarisThreadsStyleCommentsEnabledrelayprovider`]: false,
    [`${PV}PolarisReelsRecoDebugOverlayEnabledrelayprovider`]: false,
  },
  PolarisStoriesV3ReelPageStandaloneQuery: {
    [`${PV}PolarisCommunityNoteStoriesLabelEnabledrelayprovider`]: true,
  },
  PolarisProfileReelsTabContentQuery: {
    [`${PV}PolarisShortDramaEnabledrelayprovider`]: true,
  },
  PolarisProfileReelsTabContentQuery_connection: {
    [`${PV}PolarisShortDramaEnabledrelayprovider`]: true,
  },
  PolarisProfileTaggedTabContentQuery: {
    [`${PV}PolarisShortDramaEnabledrelayprovider`]: true,
    [`${PV}PolarisSEOIsCrawlerrelayprovider`]: false,
  },
};

// Thrown when Instagram signals that we must stop (JSON rate limit,
// checkpoint/challenge, login wall). Callers should exit, not retry.
export class InstagramStopError extends Error {
  constructor(message) { super(message); this.name = 'InstagramStopError'; }
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

export function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
export function loadJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } }
export function saveJson(p, d) { ensureDir(resolve(p, '..')); writeFileSync(p, JSON.stringify(d, null, 2)); }

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

export function findCdpScript() {
  if (process.env.CDP_SCRIPT) return process.env.CDP_SCRIPT;
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [];
  if (process.env.SHOWRUN_ROOT) candidates.push(resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs'));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    candidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  candidates.push(resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'));
  const found = candidates.find(p => existsSync(p));
  if (!found) throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT.');
  return found;
}

export function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 200 * 1024 * 1024,
  }).trim();
}

let cachedTabId = null;
// First instagram.com tab in the CDP-connected Chrome. Does not open one:
// a fresh tab is an extra page load on the user's account, so ask instead.
const INSTAGRAM_ORIGINS = ['https://www.instagram.com', 'https://instagram.com'];

// True only for a real https instagram.com page. Matching the raw `cdp list` line would also accept a
// tab whose title or query string merely contains "https://www.instagram.com/" (and run our code there).
export function isInstagramUrl(url) {
  try {
    return INSTAGRAM_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export function findInstagramTab() {
  if (cachedTabId) return cachedTabId;
  // `cdp list` rows are "<targetId>  <title>  <url>"; the URL is the last column.
  for (const line of cdp('list').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && isInstagramUrl(cols[cols.length - 1])) {
      cachedTabId = cols[0];
      return cachedTabId;
    }
  }
  throw new Error(`No instagram.com tab found in Chrome. Open one and log in:\n  ${OPEN_TAB_HINT}`);
}

// Wrap a page expression so it refuses to run unless the tab is still on instagram.com
// (the tab may have navigated since it was picked).
function guarded(expr) {
  return `(${JSON.stringify(INSTAGRAM_ORIGINS)}.includes(location.origin) ? (${expr}) : ` +
    `JSON.stringify({ pageError: 'wrong-origin', href: location.href }))`;
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

function minIntervalMs() {
  const v = Number(process.env.INSTAGRAM_MIN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 5000;
}

// Space requests out across processes so back-to-back CLI calls can't burst.
function pace() {
  ensureDir(DATA_DIR);
  let last = 0;
  try { last = Number(readFileSync(PACE_FILE, 'utf8')) || 0; } catch {}
  const wait = last + minIntervalMs() - Date.now();
  if (wait > 0) sleepSync(wait);
  writeFileSync(PACE_FILE, String(Date.now()));
}

// Run a self-contained page function in the Instagram tab and parse its JSON
// string result. `fn` must not reference anything outside its own body.
function runInPage(fn, args) {
  const tabId = findInstagramTab();
  pace();
  const raw = cdp('eval', tabId, guarded(`(${fn.toString()})(${JSON.stringify(args)})`));
  let res;
  try { res = JSON.parse(raw); } catch { throw new Error(`Unexpected CDP result: ${raw.slice(0, 300)}`); }
  if (res.pageError === 'wrong-origin') {
    cachedTabId = null;
    throw new InstagramStopError(`Tab ${tabId} is no longer on instagram.com (${res.href}); not running there.`);
  }
  if (res.pageError) {
    if (res.pageError === 'not-logged-in') {
      throw new InstagramStopError(`Instagram tab (${res.href || tabId}) is not logged in. Log in to instagram.com in Chrome and retry.`);
    }
    throw new Error(`Instagram tab not ready: ${res.pageError}${res.href ? ` (${res.href})` : ''}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Page functions (serialized with toString and evaluated inside the tab)
// ---------------------------------------------------------------------------

/* eslint-disable no-undef */
function pageState() {
  const href = location.href;
  if (/\/(accounts\/login|challenge|checkpoint)\b/.test(location.pathname)) return { pageError: 'not-logged-in', href };
  if (!/(?:^|;\s*)ds_user_id=/.test(document.cookie)) return { pageError: 'not-logged-in', href };
  return null;
}

async function pageRequest(a) {
  const href = location.href;
  if (/\/(accounts\/login|challenge|checkpoint)\b/.test(location.pathname)) return JSON.stringify({ pageError: 'not-logged-in', href });
  if (!/(?:^|;\s*)ds_user_id=/.test(document.cookie)) return JSON.stringify({ pageError: 'not-logged-in', href });
  const R = typeof window.require === 'function' ? window.require : null;
  const tryReq = (m) => { try { return R ? R(m) : undefined; } catch (e) { return undefined; } };
  const cu = tryReq('CurrentUserInitialData') || {};
  const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
  const headers = {
    'X-CSRFToken': csrf,
    'X-IG-App-ID': cu.APP_ID || a.appIdFallback,
    'X-IG-Max-Touch-Points': String(navigator.maxTouchPoints || 0),
  };
  const asbd = (tryReq('BDHeaderConfig') || {}).ASBD_ID;
  if (asbd) headers['X-ASBD-ID'] = String(asbd);
  const meta = {};
  let url = a.path;
  let method = a.method || 'GET';
  let body;

  if (a.kind === 'graphql') {
    if (!R) return JSON.stringify({ pageError: 'Instagram web app not loaded in tab (no window.require)', href });
    method = 'POST';
    url = '/api/graphql';
    let docId = tryReq(a.name + '_instagramRelayOperation');
    meta.docIdSource = docId ? 'page' : 'fallback';
    if (!docId) docId = a.fallbackDocId;
    if (!docId) return JSON.stringify({ pageError: 'no doc_id for ' + a.name, href });
    const vars = Object.assign({}, a.variables);
    const op = tryReq(a.name + '.graphql');
    const pv = op && op.params && op.params.providedVariables;
    if (pv) {
      meta.providedSource = 'page';
      for (const k of Object.keys(pv)) if (!(k in vars)) { try { vars[k] = pv[k].get(); } catch (e) {} }
    } else if (a.fallbackProvided) {
      meta.providedSource = 'fallback';
      for (const k of Object.keys(a.fallbackProvided)) if (!(k in vars)) vars[k] = a.fallbackProvided[k];
    }
    let params = {};
    try { params = R('getAsyncParams')('POST') || {}; } catch (e) {}
    if (!params.fb_dtsg) { const d = tryReq('DTSGInitialData'); if (d && d.token) params.fb_dtsg = d.token; }
    if (!params.lsd) { const l = tryReq('LSD'); if (l && l.token) params.lsd = l.token; }
    if (!params.fb_dtsg) return JSON.stringify({ pageError: 'no fb_dtsg in page (reload the Instagram tab)', href });
    if (!params.jazoest) { let s = 0; for (const ch of params.fb_dtsg) s += ch.charCodeAt(0); params.jazoest = '2' + s; }
    const form = new URLSearchParams();
    if (cu.NON_FACEBOOK_USER_ID) form.set('av', cu.NON_FACEBOOK_USER_ID);
    for (const k of Object.keys(params)) form.set(k, String(params[k]));
    form.set('fb_api_caller_class', 'RelayModern');
    form.set('fb_api_req_friendly_name', a.name);
    form.set('server_timestamps', 'true');
    form.set('variables', JSON.stringify(vars));
    form.set('doc_id', String(docId));
    body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['X-FB-Friendly-Name'] = a.name;
    if (params.lsd) headers['X-FB-LSD'] = params.lsd;
    meta.docId = String(docId);
  } else if (a.kind === 'api') {
    headers['X-Requested-With'] = 'XMLHttpRequest';
    let claim = null;
    try { claim = sessionStorage.getItem('www-claim-v2'); } catch (e) {}
    if (claim) headers['X-IG-WWW-Claim'] = claim;
    if (a.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(a.form).toString();
    }
  } else if (a.kind === 'html') {
    for (const k of Object.keys(headers)) delete headers[k];
    headers.Accept = 'text/html,application/xhtml+xml';
  }

  let r;
  try {
    r = await fetch(url, { method, headers, body, credentials: 'include' });
  } catch (e) {
    return JSON.stringify({ status: 0, error: String(e && e.message || e), href });
  }
  const text = await r.text();
  const out = {
    status: r.status, url: r.url, redirected: r.redirected,
    contentType: r.headers.get('content-type') || '', meta,
  };
  if (a.kind === 'html') {
    const m = text.match(/"profile_id":"(\d+)"/);
    out.profileId = m ? m[1] : null;
    out.bytes = text.length;
  } else {
    out.body = text;
  }
  return JSON.stringify(out);
}
/* eslint-enable no-undef */

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

function parseBody(text) {
  const t = String(text || '').replace(/^for \(;;\);/, '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function checkStopSignals(res, json) {
  const finalUrl = res.url || '';
  if (/\/accounts\/login\b/.test(finalUrl)) {
    throw new InstagramStopError(`Instagram redirected to the login page (${finalUrl}). The session in Chrome is logged out — stop and log in again.`);
  }
  if (/\/(challenge|checkpoint)\b/.test(finalUrl)) {
    throw new InstagramStopError(`Instagram redirected to a checkpoint/challenge (${finalUrl}). Stop and clear it in Chrome before retrying.`);
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const msg = String(json.message || '');
    if (json.checkpoint_url || /checkpoint_required|challenge_required/.test(msg)) {
      throw new InstagramStopError(`Instagram checkpoint/challenge: ${msg || json.checkpoint_url}. Stop and clear it in Chrome before retrying.`);
    }
    if (json.require_login || /login_required/.test(msg)) {
      throw new InstagramStopError(`Instagram asked to log in (${msg || 'require_login'}). Often a soft block after too many requests — stop and wait.`);
    }
    if (res.status === 429 || /please wait a few minutes/i.test(msg)) {
      throw new InstagramStopError(`Instagram rate limit: ${msg || 'HTTP 429'}. Stop and wait before retrying.`);
    }
    // GraphQL can report throttling as HTTP 200 with an errors[] entry.
    const gqlErr = (json.errors || []).map(e => `${e.message || ''} ${e.summary || ''} ${e.description || ''}`).join(' ');
    if (/please wait a few minutes|rate limit|too many requests/i.test(gqlErr)) {
      throw new InstagramStopError(`Instagram rate limit (GraphQL): ${gqlErr.trim().slice(0, 200)}. Stop and wait before retrying.`);
    }
  }
}

function httpError(res, json, label) {
  const status = res.status;
  if (status === 429) {
    // JSON 429s are handled above as stop signals. An HTML 429 ("Page Not
    // Found") is what Instagram serves for retired/blocked web endpoints such
    // as /api/v1/users/web_profile_info/ — the account itself is fine.
    return new Error(`${label}: HTTP 429 with a non-JSON body — Instagram has blocked/retired this endpoint for the web client (not an account rate limit).`);
  }
  if (status === 401 || status === 403) {
    return new InstagramStopError(`${label}: HTTP ${status}. The Chrome session may be logged out or restricted — stop and check the Instagram tab.`);
  }
  if (status === 404) return new Error(`${label}: not found (HTTP 404).`);
  const detail = json ? JSON.stringify(json).slice(0, 300) : String(res.body || '').slice(0, 200).replace(/\s+/g, ' ');
  return new Error(`${label}: HTTP ${status}${res.error ? ` (${res.error})` : ''} ${detail}`.trim());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Legacy REST call (/api/v1/...). Returns parsed JSON.
export function igApi(path, { method = 'GET', form = null } = {}) {
  const res = runInPage(pageRequest, { kind: 'api', path, method, form, appIdFallback: IG_APP_ID_FALLBACK });
  const json = parseBody(res.body);
  checkStopSignals(res, json);
  if (res.status < 200 || res.status >= 300) throw httpError(res, json, `GET ${path.split('?')[0]}`);
  if (!json) throw new Error(`${path.split('?')[0]}: expected JSON, got ${String(res.contentType)} (${String(res.body || '').slice(0, 120).replace(/\s+/g, ' ')})`);
  if (json.status === 'fail') throw new Error(`${path.split('?')[0]}: ${json.message || 'status fail'}`);
  return json;
}

// Relay persisted query, exactly as the web app sends it. Returns `data`.
export function igGraphql(name, variables) {
  const res = runInPage(pageRequest, {
    kind: 'graphql', name, variables,
    fallbackDocId: DOC_IDS[name] || null,
    fallbackProvided: PROVIDED[name] || null,
    appIdFallback: IG_APP_ID_FALLBACK,
  });
  const json = parseBody(res.body);
  checkStopSignals(res, json);
  if (res.status < 200 || res.status >= 300) throw httpError(res, json, name);
  if (!json) throw new Error(`${name}: expected JSON, got ${String(res.contentType)} (${String(res.body || '').slice(0, 120).replace(/\s+/g, ' ')})`);
  if (process.env.INSTAGRAM_DEBUG) {
    console.error(`[instagram] ${name} doc_id=${res.meta?.docId} (${res.meta?.docIdSource}), provided vars: ${res.meta?.providedSource || 'none'}`);
  }
  if (json.errors?.length && !json.data) {
    const e = json.errors[0];
    throw new Error(`${name}: ${e.message || e.summary || JSON.stringify(e).slice(0, 200)}`);
  }
  if (!json.data) throw new Error(`${name}: response has no data (${JSON.stringify(json).slice(0, 200)})`);
  return json.data;
}

function loadIdCache() { return loadJson(ID_CACHE_FILE) || {}; }

export function rememberUserPk(username, pk) {
  if (!username || !pk) return;
  const cache = loadIdCache();
  const key = String(username).toLowerCase();
  if (cache[key] === String(pk)) return;
  cache[key] = String(pk);
  saveJson(ID_CACHE_FILE, cache);
}

// username -> numeric user pk. Uses the local cache, else loads /<username>/
// in-page (same request a browser makes for the profile) and reads
// "profile_id" from the HTML. The JSON lookup endpoints are blocked for web.
export function resolveUserPk(username, { refresh = false } = {}) {
  const u = String(username || '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new Error(`Invalid Instagram username: ${username}`);
  if (!refresh) {
    const hit = loadIdCache()[u];
    if (hit) return hit;
  }
  const res = runInPage(pageRequest, { kind: 'html', path: `/${u}/`, appIdFallback: IG_APP_ID_FALLBACK });
  checkStopSignals(res, null);
  if (res.status === 404) throw new Error(`User not found: ${u}`);
  if (res.status < 200 || res.status >= 300) throw httpError(res, null, `GET /${u}/`);
  if (!res.profileId) throw new Error(`User not found: ${u} (profile page has no profile_id; account may not exist or be unavailable)`);
  rememberUserPk(u, res.profileId);
  return res.profileId;
}

// No-network check that the tab exists and is logged in. Returns
// { tabId, href, userId }.
export function checkSession() {
  const tabId = findInstagramTab();
  const fn = `(() => { const s = (${pageState.toString()})(); if (s) return JSON.stringify(s); ` +
    `const m = document.cookie.match(/(?:^|;\\s*)ds_user_id=(\\d+)/); ` +
    `return JSON.stringify({ href: location.href, userId: m ? m[1] : null, appLoaded: typeof window.require === 'function' }); })()`;
  const res = JSON.parse(cdp('eval', tabId, guarded(fn)));
  if (res.pageError === 'wrong-origin') throw new InstagramStopError(`Tab ${tabId} is not on instagram.com (${res.href}).`);
  if (res.pageError) throw new InstagramStopError(`Instagram tab (${res.href}) is not logged in. Log in to instagram.com in Chrome.`);
  return { tabId, ...res };
}
