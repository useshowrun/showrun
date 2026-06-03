// Shared helpers for LinkedIn skills.
//
// Two problems this module fixes, each previously inlined across every legacy
// script with no shared source of truth:
//
//   1. Cookie dedupe — Chrome's `Storage.getCookies '{}'` returns cross-partition
//      duplicate cookie names (one JSESSIONID per host that touched it).
//      Stitched into a single Cookie: header, LinkedIn picks the wrong value
//      for CSRF validation → HTTP 400/403 "CSRF check failed".
//
//   2. Cookie rotation — LinkedIn rotates JSESSIONID (and occasionally li_at)
//      via Set-Cookie on most responses. Node fetch doesn't retain cookies,
//      so without writing them back the next call keeps using the stale
//      value while the browser tab moves on. LinkedIn's anti-abuse layer
//      flags the parallel sessions and eventually invalidates li_at,
//      logging the user out.

import { writeFileSync } from 'fs';

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
// Returns true if a change was made.
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
