// salesnav-cdp.mjs — shared CDP request layer for the Sales Navigator skills.
//
// All sales-api requests run INSIDE the logged-in Chrome tab via `cdp eval`,
// the same mechanism the Crunchbase skill uses. The browser issues
// the request with its real HTTP/2 connection, TLS fingerprint, header order,
// origin, and httpOnly cookies — so LinkedIn's sales-api edge sees a normal
// first-party call instead of a Node-shaped one (which it rejects with HTTP 400).
//
// Requires Node 22+ and the chrome-cdp skill. Zero dependencies.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const LINKEDIN_BASE = 'https://www.linkedin.com';
const COOKIE_URLS = [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/sales/',
  'https://www.linkedin.com/sales/home',
];
const OPEN_TAB_HINT =
  'node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com/sales/home';

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

export function findCdpScript() {
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

export function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// Prefer a Sales Navigator tab so the in-page Referer/Origin matches /sales/;
// fall back to any LinkedIn tab (still same-origin for sales-api requests).
export function findSalesnavTab() {
  const list = cdp('list');
  const lines = list.split('\n');
  for (const line of lines) {
    if (line.includes('linkedin.com/sales')) return line.trim().split(/\s+/)[0];
  }
  for (const line of lines) {
    if (line.includes('linkedin.com')) return line.trim().split(/\s+/)[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-page fetch — runs in the tab's context with the browser's real session
// ---------------------------------------------------------------------------

export function cdpFetch(tabId, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${LINKEDIN_BASE}${url}`;
  const method = options.method || 'GET';
  const headers = {
    'accept': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
  };

  // JSON.stringify the URL so any literal quote/backslash in it is safely
  // escaped inside the eval string (closes raw-apostrophe injection holes).
  const urlLiteral = JSON.stringify(fullUrl);
  const hdrsLiteral = JSON.stringify(headers);
  const bodyPart = options.body ? `,body:${JSON.stringify(String(options.body))}` : '';

  // sales-api requires the csrf-token header to equal the JSESSIONID value.
  // The browser's app code adds it; a bare fetch() does not, so derive it from
  // document.cookie in-page. Caller-supplied headers win if they set it.
  //
  // redirect:'manual' keeps a session-kill / checkpoint redirect visible as an
  // opaqueredirect (status 0) instead of silently following it to a login page.
  const result = cdp('eval', tabId,
    `(async()=>{` +
    `const m=document.cookie.match(/JSESSIONID="?([^";]+)"?/);` +
    `const h=Object.assign({'csrf-token':m?m[1]:''},${hdrsLiteral});` +
    `const r=await fetch(${urlLiteral},{method:'${method}',credentials:'include',redirect:'manual',headers:h${bodyPart}});` +
    `const hd={};r.headers.forEach((v,k)=>{hd[k]=v});` +
    `return JSON.stringify({status:r.status,type:r.type,redirected:r.redirected,headers:hd,body:await r.text()})})()`);

  let parsed;
  try { parsed = JSON.parse(result); }
  catch { throw new Error(`Unexpected CDP fetch response: ${String(result).substring(0, 300)}`); }
  return {
    status: parsed.status,
    type: parsed.type,
    redirected: parsed.redirected,
    headers: parsed.headers || {},
    body: parsed.body ?? '',
  };
}

// ---------------------------------------------------------------------------
// Rate-limit backoff + session-kill detection
// ---------------------------------------------------------------------------

// Synchronous sleep. These are one-shot CLI scripts, so blocking is fine and it
// keeps apiFetch synchronous (its many call sites need no await).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms)));
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
export function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// Ground-truth session check: is li_at still in the browser's cookie jar? This
// is how we detect a LinkedIn session kill from in-page fetch — the browser
// hides the Set-Cookie "li_at=delete me" marker that li-auth.mjs reads over
// Node fetch, but a wiped li_at is observable directly via CDP.
function authCookiesPresent(tabId) {
  try {
    return new Set(readLinkedInCookies(tabId).map(c => c.name)).has('li_at');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request wrapper — finds the tab, runs the in-page fetch, maps error statuses,
// backs off on 429 (Retry-After), and surfaces session kills / anti-automation
// blocks rather than masquerading them as ordinary errors.
// ---------------------------------------------------------------------------

// softErrors: when true, ordinary HTTP failures (404 and other non-2xx) THROW
// instead of exiting, so callers can fetch optional/enrichment sections and
// degrade gracefully per-section. Genuinely global failures — 999, session
// kill, 401/403, and 429-over-cap — stay fatal regardless, since they doom
// every subsequent request, not just the one section.
export function apiFetch(url, options = {}, { authCmd, maxRetries = 2, maxRetryWaitMs = 60_000, softErrors = false } = {}) {
  const tabId = findSalesnavTab();
  if (!tabId) {
    console.error('No LinkedIn/Sales Navigator tab found in Chrome.');
    console.error(`Open one with: ${OPEN_TAB_HINT}`);
    process.exit(1);
  }

  let attempt = 0;
  while (true) {
    const { status, type, headers, body } = cdpFetch(tabId, url, options);

    // LinkedIn's classic anti-automation block — back off hard, do not retry.
    if (status === 999) {
      console.error('LinkedIn returned HTTP 999 (anti-automation block). Stop and let the account rest before retrying.');
      process.exit(1);
    }

    // redirect:'manual' surfaces a kill/checkpoint redirect as an opaqueredirect
    // (status 0) instead of following it to a login page.
    if (status === 0 || type === 'opaqueredirect') {
      const killed = !authCookiesPresent(tabId);
      console.error(killed
        ? 'LinkedIn session was terminated (redirected to login; li_at cleared). Re-open Sales Navigator in Chrome, log in, then re-run auth.'
        : 'Request was redirected (likely a checkpoint/CAPTCHA). Open Sales Navigator in Chrome, clear the prompt, then retry.');
      process.exit(1);
    }

    if (status === 429) {
      const retryMs = parseRetryAfterMs(headers['retry-after']);
      if (attempt < maxRetries && retryMs != null && retryMs <= maxRetryWaitMs) {
        attempt++;
        const waitMs = Math.max(1000, retryMs);
        console.error(`Rate limited (HTTP 429). Waiting ${Math.round(waitMs / 1000)}s (Retry-After), then retrying (${attempt}/${maxRetries})...`);
        sleepSync(waitMs);
        continue;
      }
      console.error(retryMs != null
        ? `Rate limited (HTTP 429). Retry-After ${Math.round(retryMs / 1000)}s exceeds the ${Math.round(maxRetryWaitMs / 1000)}s cap — stopping. Wait and try later.`
        : 'Rate limited (HTTP 429). Wait a few minutes before retrying.');
      process.exit(1);
    }

    if (status === 401 || status === 403) {
      const killed = !authCookiesPresent(tabId);
      console.error(killed
        ? `LinkedIn session was terminated (li_at cleared). Re-open Sales Navigator in Chrome, log in, then re-run: ${authCmd || 'auth'}`
        : `Session expired. Run: ${authCmd || 'auth'}`);
      process.exit(1);
    }
    if (status === 404) {
      if (softErrors) throw new Error('Not found (HTTP 404).');
      console.error('Not found (HTTP 404).');
      process.exit(1);
    }

    let data;
    try { data = JSON.parse(body); } catch { data = body; }

    if (status < 200 || status >= 300) {
      const detail = typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300);
      if (softErrors) throw new Error(`API error (HTTP ${status}): ${detail}`);
      console.error(`API error (HTTP ${status}): ${detail}`);
      process.exit(1);
    }

    return data;
  }
}

// ---------------------------------------------------------------------------
// Auth — validate the logged-in session, no cookies copied out of the browser
// ---------------------------------------------------------------------------

function parseCookieResponse(raw, source) {
  try {
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.cookies)) throw new Error('response has no cookies array');
    return data.cookies;
  } catch (err) {
    throw new Error(`${source} cookie read failed: ${err.message}`);
  }
}

function readLinkedInCookies(target) {
  const errors = [];
  try {
    return parseCookieResponse(cdp('evalraw', target, 'Storage.getCookies', '{}'), 'Storage.getCookies');
  } catch (err) { errors.push(err.message); }
  try {
    return parseCookieResponse(
      cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: COOKIE_URLS })),
      'Network.getCookies',
    );
  } catch (err) { errors.push(err.message); }
  for (const url of COOKIE_URLS) {
    try {
      return parseCookieResponse(
        cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: [url] })),
        `Network.getCookies ${url}`,
      );
    } catch (err) { errors.push(err.message); }
  }
  throw new Error(`Sales Navigator cookie read failed in active CDP session: ${errors.join(' | ')}`);
}

// Confirms a logged-in Sales Navigator session exists and writes a marker
// session.json. Cookies stay in Chrome — every request runs in-page.
// `saveJson(path, data)` is passed in so this module stays free of per-skill
// data-directory knowledge.
export function doAuth(sessionFile, saveJson) {
  console.log('Finding Sales Navigator tab...');
  const target = findSalesnavTab();
  if (!target) {
    throw new Error(
      'No LinkedIn/Sales Navigator tab found. Open one and log in:\n  ' + OPEN_TAB_HINT,
    );
  }
  console.log(`Using tab: ${target}`);

  const cookies = readLinkedInCookies(target);
  const names = new Set(cookies.map(c => c.name));
  const missing = ['li_at', 'JSESSIONID'].filter(n => !names.has(n));
  if (missing.length) {
    throw new Error(
      `Sales Navigator auth cookies missing (${missing.join(', ')}). ` +
      `Log in to Sales Navigator in the Chrome window, then re-run auth.`,
    );
  }

  const now = new Date().toISOString();
  // capturedAt is the real marker; the legacy keys are harmless sentinels that
  // keep any older session.json reader from crashing.
  saveJson(sessionFile, { capturedAt: now, cookie: 'cdp', csrfToken: 'cdp', extractedAt: now });
  console.log(`Auth saved to: ${sessionFile}`);
}

// Guards "no auth → exit 1". Accepts the new marker shape or an older
// cookie-based session.json so no user is forced to re-auth.
export function requireAuth(sessionFile, loadJson, authCmd) {
  const session = loadJson(sessionFile);
  if (!session.capturedAt && !session.cookie) {
    console.error(`No auth found. Run: ${authCmd}`);
    process.exit(1);
  }
  return session;
}
