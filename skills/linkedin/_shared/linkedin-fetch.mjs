// Shared helpers for LinkedIn skills.
//
// Two strategies live here:
//
//   1. Direct Node fetch (the historical path) — relies on a saved session.json
//      with extracted cookies. Subject to a cookie-jar drift bug: LinkedIn
//      rotates JSESSIONID via Set-Cookie on most responses, and Chrome's
//      background traffic (realtime client connectivity, lifecycle pings)
//      also rotates the same cookie. When Node and Chrome each hold a
//      different version, LinkedIn's anti-abuse layer flags the parallel
//      sessions and invalidates li_at, logging the user out.
//
//   2. `chromeFetch` — routes the request through the user's logged-in
//      LinkedIn tab via CDP `Runtime.evaluate`. The fetch happens inside
//      the page context with `credentials: 'include'`, so Chrome supplies
//      cookies from its single cookie jar. Set-Cookie responses update
//      Chrome's jar normally. There is no parallel session and no drift.
//      Slower than Node fetch (CDP roundtrip) but fool-proof.
//
// The legacy helpers (dedupeLinkedInCookies, cookieMapFrom,
// linkedInCookieString, applySetCookies) remain exported because the `auth`
// commands still need to capture cookies into session.json — that's the
// one-time extraction step used to bootstrap the saved session, and is
// also where `myUrn` (the user's profile URN) is resolved.

import { execFileSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Cookie helpers (auth / extraction path)
// ---------------------------------------------------------------------------

const ROTATING_COOKIES = new Set([
  'JSESSIONID', 'li_at', 'lidc', 'bcookie', 'bscookie', 'liap', 'li_mc',
]);

// Dedupe by name, preferring the .linkedin.com domain entry (which is the
// "real" one — host-scoped duplicates come from partitioned/page contexts).
export function dedupeLinkedInCookies(cookies) {
  const byName = new Map();
  for (const c of cookies) {
    const domain = String(c.domain || '');
    if (!domain.includes('linkedin.com')) continue;
    const existing = byName.get(c.name);
    if (!existing || (domain.startsWith('.linkedin.com') && !String(existing.domain || '').startsWith('.linkedin.com'))) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

export function cookieMapFrom(cookies) {
  return Object.fromEntries(dedupeLinkedInCookies(cookies).map(c => [c.name, c.value]));
}

export function linkedInCookieString(cookies) {
  return dedupeLinkedInCookies(cookies).map(c => `${c.name}=${c.value}`).join('; ');
}

// Parse a Response's Set-Cookie headers and merge rotating values into the
// in-memory `auth` object. If anything changed, persist to `sessionFile`.
// Returns true if a change was made. Only useful when running Node-side
// fetches; chromeFetch sidesteps this because Chrome handles Set-Cookie.
export function applySetCookies(auth, resp, sessionFile) {
  const setCookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  if (!setCookies.length) return false;

  const map = Object.fromEntries(
    (auth.cookie || '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq), p.slice(eq + 1)];
    })
  );
  let changed = false;
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq < 0) continue;
    const name = sc.slice(0, eq).trim();
    if (!ROTATING_COOKIES.has(name)) continue;
    const semi = sc.indexOf(';');
    const value = (semi < 0 ? sc.slice(eq + 1) : sc.slice(eq + 1, semi)).trim();
    if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc)) {
      if (name in map) { delete map[name]; changed = true; }
    } else if (map[name] !== value) {
      map[name] = value;
      changed = true;
    }
  }
  if (!changed) return false;
  auth.cookie = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
  const newCsrf = (map.JSESSIONID || '').replace(/"/g, '');
  if (newCsrf) auth.csrfToken = newCsrf;
  try { writeFileSync(sessionFile, JSON.stringify(auth, null, 2)); } catch {}
  return true;
}

// ---------------------------------------------------------------------------
// chromeFetch (in-page fetch via CDP)
// ---------------------------------------------------------------------------

function findCdpScript() {
  if (process.env.CDP_SCRIPT) return process.env.CDP_SCRIPT;
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    candidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  if (process.env.SHOWRUN_ROOT) {
    candidates.unshift(resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs'));
  }
  candidates.push(resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'));
  const found = candidates.find(p => existsSync(p));
  if (!found) throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT.');
  return found;
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024,
  }).trim();
}

// Find an existing linkedin.com tab; open one if none exists.
// Caches the tab id within the process so we don't pay the `list` cost
// on every request.
let cachedTabId = null;
export function findOrOpenLinkedInTab({ force = false } = {}) {
  if (cachedTabId && !force) return cachedTabId;
  const list = cdp('list');
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com')) {
      cachedTabId = line.trim().split(/\s+/)[0];
      return cachedTabId;
    }
  }
  // No tab — open one. Wait briefly for it to load before returning.
  const out = cdp('open', 'https://www.linkedin.com/feed/');
  const m = out.match(/[A-F0-9]{8}/);
  if (!m) throw new Error('Could not open LinkedIn tab. Open https://www.linkedin.com in Chrome and retry.');
  cachedTabId = m[0];
  return cachedTabId;
}

// Route a fetch through Chrome's page context. Returns `{ ok, status, headers, body }`
// where body is text (caller parses JSON if needed). Set-Cookie is handled by Chrome.
// The expression also reads the live JSESSIONID from document.cookie so that
// `csrf-token` always matches whatever Chrome currently has.
export async function chromeFetch(url, options = {}) {
  const tabId = findOrOpenLinkedInTab();
  const incomingHeaders = options.headers || {};
  // Strip cookie/csrf headers — Chrome supplies them with credentials: 'include'
  // (cookie) and we re-derive csrf-token in-page from the live JSESSIONID.
  const stripped = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'csrf-token') continue;
    stripped[k] = v;
  }
  const fetchOpts = {
    method: options.method || 'GET',
    headers: stripped,
    body: options.body ?? null,
    credentials: 'include',
  };

  const expr = `(async () => {
    const opts = ${JSON.stringify(fetchOpts)};
    const csrfMatch = document.cookie.match(/(?:^|; )JSESSIONID=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1].replace(/"/g, '') : '';
    if (csrf && !opts.headers['csrf-token'] && !opts.headers['Csrf-Token']) {
      opts.headers['csrf-token'] = csrf;
    }
    try {
      const r = await fetch(${JSON.stringify(url)}, opts);
      const text = await r.text();
      const headers = {};
      for (const [k, v] of r.headers.entries()) headers[k] = v;
      return { ok: r.ok, status: r.status, headers, body: text };
    } catch (e) {
      return { ok: false, status: 0, headers: {}, body: '', error: String(e && e.message || e) };
    }
  })()`;

  let raw;
  try {
    raw = cdp('eval', tabId, expr);
  } catch (err) {
    // Stale tab id (e.g. user closed the tab). Drop cache and retry once.
    if (!cachedTabId) throw err;
    cachedTabId = null;
    const tabId2 = findOrOpenLinkedInTab();
    raw = cdp('eval', tabId2, expr);
  }
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`chromeFetch failed: ${parsed.error}`);
  return parsed;
}
