// li-auth.mjs — shared LinkedIn auth + fetch helpers for the linkedin skill.
//
// Solves two recurring failure modes:
//
// 1. Stale on-disk cookies look identical to abuse-flag kills.
//    LinkedIn returns Set-Cookie: li_at=delete me + Clear-Site-Data: "storage"
//    for BOTH "your cookie is no longer valid" AND "we flagged your request
//    as scraping." Without freshness checking, every cookie rotation looks
//    like an abuse incident and drives operators to stop using working
//    endpoints. ensureFreshAuth() reads Chrome's current cookies via CDP
//    and rewrites session.json whenever they have diverged.
//
// 2. The base apiFetch helpers in each script discard response headers,
//    so a real abuse-flag kill is observationally identical to a benign
//    400/401. apiFetchSafe() surfaces kill markers explicitly so callers
//    can stop on the first real kill rather than retrying into a ban.
//
// Design notes:
// - No automatic retry on kill markers. After a real abuse kill, every
//   further call deepens the hole — see project_connections_burst_kill.
// - ensureFreshAuth refreshes at most once per process (cached) — call it
//   at script startup, not per-request.
// - Falls back to the cdp.mjs helper shared by all the linkedin scripts,
//   so this module has no node_modules dependency.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const LINKEDIN_COOKIE_URLS = [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/sales/',
  'https://www.linkedin.com/sales/home',
];

function findCdpScript() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (process.env.CDP_SCRIPT) candidates.push(process.env.CDP_SCRIPT);
  if (process.env.SHOWRUN_ROOT) candidates.push(resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs'));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    candidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  candidates.push(resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'));
  const found = candidates.find(p => p && existsSync(p));
  if (!found) throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.');
  return found;
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 100 * 1024 * 1024,
  }).trim();
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function findLinkedInTab() {
  const list = cdp('list');
  const lines = list.split('\n');
  for (const pref of ['/messaging', '/feed', 'linkedin.com/in/', '/sales/', 'linkedin.com']) {
    for (const line of lines) {
      if (line.includes('linkedin.com') && (pref === 'linkedin.com' || line.includes(pref))) {
        return { target: line.trim().split(/\s+/)[0], listText: list };
      }
    }
  }
  throw new Error('No LinkedIn tab found in Chrome. Open https://www.linkedin.com/feed/ in a Chrome tab attached to the active CDP session, then retry.');
}

function readLinkedInCookies(target) {
  const errors = [];
  const tries = [
    () => cdp('evalraw', target, 'Storage.getCookies', '{}'),
    () => cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: LINKEDIN_COOKIE_URLS })),
    ...LINKEDIN_COOKIE_URLS.map(u => () =>
      cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: [u] }))),
  ];
  for (const fn of tries) {
    try {
      const raw = fn();
      const data = JSON.parse(raw || '{}');
      if (Array.isArray(data.cookies) && data.cookies.length) return data.cookies;
      errors.push('empty cookie array');
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`Could not read LinkedIn cookies from Chrome: ${errors.join(' | ')}`);
}

function cookieString(cookies) {
  return cookies
    .filter(c => String(c.domain || '').includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function valueOf(cookies, name) {
  const c = cookies.find(x => x.name === name);
  return c ? c.value : null;
}

function parseCookieValue(cookieStr, name) {
  if (!cookieStr) return null;
  const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

let _freshenedThisProcess = false;

// Reads Chrome's current cookies, compares against session.json, rewrites
// session.json when they differ. Returns the auth bundle either way.
// Pass force=true to force a Chrome read even if we've already done one
// in this process (e.g., after a Killed response).
export function ensureFreshAuth({ sessionFile, force = false } = {}) {
  if (!sessionFile) throw new Error('ensureFreshAuth: sessionFile is required');
  const cached = loadJson(sessionFile);

  if (_freshenedThisProcess && !force && cached?.cookie) {
    return { ...cached, refreshed: false };
  }

  let chromeCookies;
  try {
    const { target } = findLinkedInTab();
    chromeCookies = readLinkedInCookies(target);
  } catch (err) {
    if (cached?.cookie) {
      console.warn(`[li-auth] Could not refresh auth from Chrome (${err.message}); using cached session.json.`);
      _freshenedThisProcess = true;
      return { ...cached, refreshed: false, refreshError: err.message };
    }
    throw err;
  }

  const chromeLiAt = valueOf(chromeCookies, 'li_at');
  const chromeJSESS = valueOf(chromeCookies, 'JSESSIONID');
  if (!chromeLiAt || !chromeJSESS) {
    throw new Error('Chrome session is missing li_at or JSESSIONID — log into LinkedIn in the attached Chrome tab.');
  }

  const cachedLiAt = parseCookieValue(cached?.cookie, 'li_at');
  const stale = !cached || cachedLiAt !== chromeLiAt;

  if (!stale) {
    _freshenedThisProcess = true;
    return { ...cached, refreshed: false };
  }

  const cookieStr = cookieString(chromeCookies);
  const csrfToken = chromeJSESS.replace(/"/g, '');
  const next = {
    ...(cached || {}),
    cookie: cookieStr,
    csrfToken,
    extractedAt: new Date().toISOString(),
  };
  ensureDir(dirname(sessionFile));
  writeFileSync(sessionFile, JSON.stringify(next, null, 2));
  _freshenedThisProcess = true;
  return { ...next, refreshed: true };
}

export function baseHeaders(auth, extra = {}) {
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'cookie': auth.cookie,
    'csrf-token': auth.csrfToken,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    ...extra,
  };
}

// Inspects a fetch Response for the standard LinkedIn session-kill signals.
// These signals fire for BOTH stale-cookie responses AND abuse-flag kills —
// distinguish by whether the on-disk cookie was just refreshed from Chrome.
// Callers that have just refreshed via ensureFreshAuth should treat killed=true
// as a real abuse signal and stop all LinkedIn calls.
export function detectKillMarkers(resp) {
  const setCookies = (typeof resp.headers.getSetCookie === 'function')
    ? resp.headers.getSetCookie()
    : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  const liAtDeleted = setCookies.some(c => /li_at=delete\s*me/i.test(c));
  const csd = resp.headers.get('clear-site-data') || '';
  const clearStorage = /storage/i.test(csd);
  if (liAtDeleted || clearStorage) {
    return {
      killed: true,
      killReason: [
        liAtDeleted ? 'Set-Cookie: li_at=delete me' : null,
        clearStorage ? `Clear-Site-Data: ${csd}` : null,
      ].filter(Boolean).join(' + '),
    };
  }
  return { killed: false, killReason: null };
}

// Wraps fetch with explicit kill-marker detection. Returns the same shape
// the existing per-script apiFetch helpers return, plus { killed, killReason,
// retryAfter } so callers can stop on the first real abuse signal.
//
// IMPORTANT: this does not auto-retry on killed=true. After an abuse-flag
// response, every subsequent LinkedIn call deepens the hole.
export async function apiFetchSafe(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...(options.headers || {}) },
    redirect: 'manual',
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const { killed, killReason } = detectKillMarkers(resp);
  const retryAfter = resp.headers.get('retry-after') || null;
  return { status: resp.status, ok: resp.ok, data, killed, killReason, retryAfter, headers: resp.headers };
}

// Convenience: build a friendly error message for a killed response so
// callers can throw with consistent wording.
export function killedErrorMessage(url, killReason) {
  return [
    `LinkedIn returned session-kill markers (${killReason}).`,
    `URL: ${url}`,
    'Auth was just refreshed from Chrome before this call, so the cause is NOT stale cookies —',
    'this is an abuse-flag signal on the request itself. Stop all LinkedIn calls for the rest of this session.',
    'Investigate the URL shape against captures in /home/eyup/Projects/linkedin/captures/ before retrying.',
  ].join(' ');
}
