// itch-lib.mjs — shared helpers for the itch.io taskpack
//
// Exports: DATA_DIR, SESSION_FILE, CACHE_DIR, ensureDir, loadJson, saveJson,
//          findCdpScript, cdp, doAuth, getAuth, getAuthOptional, baseHeaders,
//          jsonHeaders, mutationHeaders, apiFetch, postForm, parseGameSlug,
//          parseUserSlug, scrapeFromHtml, extractCsrfFromHtml, printJson,
//          writeCache, dryRunEnabled
//
// Requires Node 22+ (built-in fetch, FormData, Blob).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/itch');
export const SESSION_FILE = resolve(DATA_DIR, 'session.json');
export const CACHE_DIR = resolve(DATA_DIR, 'cache');

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function writeCache(type, id, data) {
  ensureDir(CACHE_DIR);
  const ts = Date.now();
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  const path = resolve(CACHE_DIR, `${type}-${safeId}-${ts}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// CDP bridge (only used by auth)
// ---------------------------------------------------------------------------

export function findCdpScript() {
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../../chrome-cdp/scripts/cdp.mjs'),
  ];
  const found = process.env.CDP_SCRIPT || candidates.find(p => existsSync(p));
  if (!found) throw new Error('chrome-cdp skill not found. Install ~/.claude/skills/chrome-cdp.');
  return found;
}

export function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies + csrf from a logged-in Chrome itch.io tab
// ---------------------------------------------------------------------------

const KEEP_COOKIES = new Set([
  'itchio', 'itchio_token', 'cf_clearance', '__cf_bm', '_ga', '_gid',
  'itch_locale', 'itchio_lock', 'itchio_sub',
]);

export async function doAuth() {
  console.log('Looking for an itch.io tab in Chrome...');
  const listOut = cdp('list');
  let target = process.env.ITCH_TAB || null;
  if (target) {
    console.log(`Using ITCH_TAB override: ${target}`);
  } else {
    // Collect all itch.io tabs with their URLs, then rank
    const itchTabs = [];
    for (const line of listOut.split('\n')) {
      const url = line.slice(60).trim();
      const id = line.trim().split(/\s+/)[0];
      if (/\bitch\.io\b/.test(url) && id) itchTabs.push({ id, url });
    }
    if (itchTabs.length === 0) throw new Error('No itch.io tab found. Open https://itch.io/my-feed in Chrome first.');
    // Rank: prefer /my-* or /user/settings (authenticated surfaces), then itch.io root, then dev subdomains
    const score = t => {
      if (/itch\.io\/my-/.test(t.url)) return 3;
      if (/itch\.io\/user\/settings/.test(t.url)) return 3;
      if (/itch\.io\/dashboard/.test(t.url)) return 3;
      if (/^https?:\/\/itch\.io\//.test(t.url)) return 2;
      return 1; // dev subdomain
    };
    itchTabs.sort((a, b) => score(b) - score(a));
    target = itchTabs[0].id;
    console.log(`Using tab: ${target} (${itchTabs[0].url})`);
    if (itchTabs.length > 1) {
      console.log(`  (${itchTabs.length - 1} other itch.io tabs seen; set ITCH_TAB=<id> to override)`);
    }
  }

  // Pull all cookies (HttpOnly included) from the browser
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://itch.io', 'https://www.itch.io'] }));
  let cookieList;
  try {
    const parsed = JSON.parse(raw);
    cookieList = parsed.cookies || parsed.result?.cookies || [];
  } catch (e) {
    throw new Error(`Failed to parse Network.getCookies output: ${e.message}\nRaw: ${raw.slice(0, 500)}`);
  }
  if (!cookieList.length) throw new Error('No cookies returned from Network.getCookies.');

  const cookieMap = {};
  for (const c of cookieList) {
    // Keep first occurrence (prefer the more specific domain)
    if (cookieMap[c.name] == null) cookieMap[c.name] = c.value;
  }

  if (!cookieMap.itchio) {
    throw new Error('itchio session cookie not found. Are you logged in on itch.io?');
  }
  if (!cookieMap.itchio_token) {
    console.warn('Warning: itchio_token (CSRF cookie) missing — mutations may fail.');
  }

  // Build cookie header string
  const cookieStr = Object.entries(cookieMap)
    .filter(([k]) => KEEP_COOKIES.has(k) || k.startsWith('itchio'))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // Grab csrf_token from the current page's meta or form field
  let csrfToken = '';
  try {
    const csrfRaw = cdp('eval', target,
      '(document.querySelector("meta[name=csrf_token]")||{}).content || ' +
      '(document.querySelector("input[name=csrf_token]")||{}).value || ""');
    csrfToken = (csrfRaw || '').replace(/^"|"$/g, '').trim();
  } catch (e) {
    console.warn(`Warning: failed to pull csrf_token from page: ${e.message}`);
  }
  if (!csrfToken) {
    console.warn('Warning: csrf_token not found on the current page. Navigate the Chrome tab to https://itch.io/my-feed and re-run auth.');
  }

  // Grab username
  let username = '';
  try {
    const userRaw = cdp('eval', target,
      '(document.querySelector(".user_name")||{}).innerText || ' +
      '(document.querySelector("[data-label=user_menu] .user_name")||{}).innerText || ""');
    username = (userRaw || '').replace(/^"|"$/g, '').trim();
  } catch {}

  const session = {
    cookie: cookieStr,
    csrfToken,
    username,
    extractedAt: new Date().toISOString(),
  };
  saveJson(SESSION_FILE, session);
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`  username: ${username || '(unknown)'}`);
  console.log(`  csrf_token: ${csrfToken ? csrfToken.slice(0, 12) + '…' : '(missing)'}`);
  console.log(`  cookies: ${Object.keys(cookieMap).filter(k => KEEP_COOKIES.has(k) || k.startsWith('itchio')).join(', ')}`);
  return session;
}

// ---------------------------------------------------------------------------
// Auth getters
// ---------------------------------------------------------------------------

export function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth || !auth.cookie) {
    console.error('No itch.io session found. Run: node scripts/itch-auth.mjs');
    process.exit(1);
  }
  return auth;
}

export function getAuthOptional() {
  const auth = loadJson(SESSION_FILE);
  if (!auth || !auth.cookie) return null;
  return auth;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export function baseHeaders(auth) {
  const h = {
    'user-agent': CHROME_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'referer': 'https://itch.io/',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
  };
  if (auth?.cookie) h.cookie = auth.cookie;
  return h;
}

export function jsonHeaders(auth, referer) {
  const h = baseHeaders(auth);
  h.accept = 'application/json, text/javascript, */*; q=0.01';
  h['x-requested-with'] = 'XMLHttpRequest';
  h['sec-fetch-dest'] = 'empty';
  h['sec-fetch-mode'] = 'cors';
  if (referer) h.referer = referer;
  return h;
}

export function mutationHeaders(auth, referer, origin) {
  const h = baseHeaders(auth);
  h.accept = 'application/json, text/javascript, */*; q=0.01';
  h['x-requested-with'] = 'XMLHttpRequest';
  h['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  h.origin = origin || 'https://itch.io';
  h['sec-fetch-dest'] = 'empty';
  h['sec-fetch-mode'] = 'cors';
  h['sec-fetch-site'] = 'same-origin';
  if (referer) h.referer = referer;
  return h;
}

export function torEnabled() {
  if (process.env.ITCH_USE_TOR === '1') return true;
  if (process.env.ITCH_USE_TOR === '0') return false;
  return process.argv.includes('--tor');
}

// Route a request through the tor-proxy executor WebSocket
// (https://github.com/.../tor-proxy-project). Each request gets a fresh
// Tor circuit + exit IP via IsolateSOCKSAuth. Executor URL: ITCH_TOR_WS
// (default ws://localhost:8080/ws).
export async function torFetch(url, options = {}) {
  const wsUrl = process.env.ITCH_TOR_WS || 'ws://localhost:8080/ws';
  const id = (globalThis.crypto?.randomUUID?.()) || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;
  const timeoutSec = Number(process.env.ITCH_TOR_TIMEOUT || 60);

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`tor-proxy timeout after ${timeoutSec}s: ${url}`)),
      timeoutSec * 1000,
    );

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'request',
        id, method, url, headers,
        body: typeof body === 'string' ? body : (body == null ? null : String(body)),
        timeout: timeoutSec,
      }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (msg.id && msg.id !== id) return;
      if (msg.type === 'error') {
        return done(reject, new Error(`tor-proxy error: ${msg.error || 'unknown'}`));
      }
      if (msg.type !== 'result') return;

      const text = msg.body ?? '';
      let data = text;
      const ct = String(msg.headers?.['content-type'] || '').toLowerCase();
      if (ct.includes('json') || (text.startsWith('{') && text.endsWith('}'))) {
        try { data = JSON.parse(text); } catch {}
      }
      done(resolve, {
        status: msg.status_code,
        ok: msg.status_code >= 200 && msg.status_code < 300,
        headers: msg.headers || {},
        data,
        text,
      });
    });

    ws.addEventListener('error', (err) => {
      done(reject, new Error(`tor-proxy ws error: ${err?.message || 'connect failed'} (${wsUrl})`));
    });
    ws.addEventListener('close', (ev) => {
      if (!settled) done(reject, new Error(`tor-proxy ws closed before reply (code=${ev?.code})`));
    });
  });
}

export async function apiFetch(url, options = {}) {
  if (torEnabled()) return torFetch(url, options);
  const method = options.method || 'GET';
  const resp = await fetch(url, {
    method,
    headers: options.headers || {},
    body: options.body,
    redirect: options.redirect ?? 'follow',
  });
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buf);
  let data = text;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('json') || (text.startsWith('{') && text.endsWith('}'))) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return {
    status: resp.status,
    ok: resp.ok,
    headers: Object.fromEntries(resp.headers),
    data,
    text,
  };
}

// ---------------------------------------------------------------------------
// Dry-run aware form POST
// ---------------------------------------------------------------------------

export function dryRunEnabled(argv) {
  if (process.env.ITCH_DRY_RUN === '0') return false;
  if (process.env.ITCH_DRY_RUN === '1') return true;
  const hasLive = argv && argv.includes('--live');
  return !hasLive;
}

export async function postForm(auth, url, fields, { referer, origin, dryRun = true } = {}) {
  const body = new URLSearchParams();
  if (auth?.csrfToken) body.set('csrf_token', auth.csrfToken);
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) body.append(k, String(item));
    else body.set(k, String(v));
  }
  const headers = mutationHeaders(auth, referer, origin);

  if (dryRun) {
    console.log('\n[DRY-RUN] would POST (pass --live or set ITCH_DRY_RUN=0 to send):');
    console.log(`  URL:    ${url}`);
    console.log(`  Method: POST`);
    console.log('  Headers:');
    for (const [k, v] of Object.entries(headers)) {
      if (k === 'cookie') console.log(`    ${k}: <${v.length} bytes hidden>`);
      else console.log(`    ${k}: ${v}`);
    }
    console.log('  Body:');
    for (const [k, v] of body.entries()) {
      const show = k === 'csrf_token' ? String(v).slice(0, 12) + '…' : v;
      console.log(`    ${k}=${show}`);
    }
    return { status: 200, ok: true, data: { dryRun: true }, headers: {}, text: '' };
  }

  return apiFetch(url, { method: 'POST', headers, body: body.toString() });
}

// ---------------------------------------------------------------------------
// URL / slug parsers
// ---------------------------------------------------------------------------

export function parseGameSlug(input) {
  if (!input) throw new Error('Game slug required (e.g., dev/game or https://dev.itch.io/game)');
  // URL form
  let m = input.match(/^https?:\/\/([a-z0-9-]+)\.itch\.io\/([a-z0-9-]+)/i);
  if (m) return { dev: m[1].toLowerCase(), slug: m[2].toLowerCase(), url: `https://${m[1]}.itch.io/${m[2]}` };
  // dev.itch.io/slug form (no scheme)
  m = input.match(/^([a-z0-9-]+)\.itch\.io\/([a-z0-9-]+)/i);
  if (m) return { dev: m[1].toLowerCase(), slug: m[2].toLowerCase(), url: `https://${m[1]}.itch.io/${m[2]}` };
  // dev/slug form
  m = input.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/i);
  if (m) return { dev: m[1].toLowerCase(), slug: m[2].toLowerCase(), url: `https://${m[1]}.itch.io/${m[2]}` };
  throw new Error(`Unrecognized game slug: ${input}`);
}

export function parseUserSlug(input) {
  if (!input) throw new Error('Username required');
  let s = String(input).trim();
  s = s.replace(/^@/, '');
  s = s.replace(/^https?:\/\/itch\.io\/profile\//i, '');
  s = s.replace(/^https?:\/\/([a-z0-9-]+)\.itch\.io\/?.*$/i, '$1');
  s = s.replace(/\/$/, '');
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Tiny HTML helpers
// ---------------------------------------------------------------------------

export function extractCsrfFromHtml(html) {
  if (!html) return null;
  let m = html.match(/<meta\s+name=["']csrf_token["']\s+content=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<input[^>]+name=["']csrf_token["'][^>]+value=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']csrf_token["']/i);
  if (m) return m[1];
  return null;
}

export function decodeHtml(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function stripTags(s) {
  if (!s) return s;
  return decodeHtml(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Parse game_cell fragments returned by /games?format=json
export function parseGameCells(html) {
  if (!html) return [];
  const cells = [];
  const parts = html.split(/(?=<div[^>]*class="[^"]*\bgame_cell\b)/);
  for (const part of parts) {
    if (!/game_cell/.test(part)) continue;
    const idMatch = part.match(/data-game_id="(\d+)"/);
    // Title and URL live inside <div class="game_title"><a href="URL" class="title game_link">TITLE</a></div>
    const gameTitleDiv = part.match(/<div[^>]*class="[^"]*\bgame_title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    let title = null, url = null;
    if (gameTitleDiv) {
      const anchorUrl = gameTitleDiv[1].match(/<a[^>]*\bhref="([^"]+)"/);
      const anchorText = gameTitleDiv[1].match(/<a[^>]*>([^<]+)<\/a>/);
      url = anchorUrl ? anchorUrl[1] : null;
      title = anchorText ? decodeHtml(anchorText[1].trim()) : null;
    }
    // Fallback URL: any game_link / thumb_link anchor
    if (!url) {
      const u = part.match(/<a[^>]*\bhref="([^"]+)"[^>]*class="[^"]*\bgame_link\b/)
             || part.match(/<a[^>]*class="[^"]*\bgame_link\b[^"]*"[^>]*\bhref="([^"]+)"/);
      url = u ? u[1] : null;
    }
    const authorMatch = part.match(/class="[^"]*\bgame_author\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)</);
    const priceMatch = part.match(/class="[^"]*\bprice_value\b[^"]*"[^>]*>([^<]+)</);
    const coverMatch = part.match(/data-lazy_src="([^"]+)"/) || part.match(/\bsrc="(https:\/\/img[^"]+)"/);
    const descMatch = part.match(/class="[^"]*\bgame_text\b[^"]*"[^>]*>([^<]+)</)
                   || part.match(/class="[^"]*\bgame_short_text\b[^"]*"[^>]*>([^<]+)</);
    if (idMatch || title || url) {
      cells.push({
        id: idMatch ? Number(idMatch[1]) : null,
        title,
        url,
        author: authorMatch ? decodeHtml(authorMatch[1].trim()) : null,
        price: priceMatch ? decodeHtml(priceMatch[1].trim()) : null,
        cover: coverMatch ? coverMatch[1] : null,
        description: descMatch ? decodeHtml(descMatch[1].trim()) : null,
      });
    }
  }
  return cells;
}

// Parse event rows in my-feed / my-notifications HTML fragments
// Rows are wrapped in <div class="event_row">; id is in the event_time anchor href (/event/ID)
export function parseEventCells(html) {
  if (!html) return [];
  const events = [];
  const parts = html.split(/(?=<div[^>]*class="[^"]*\bevent_row\b)/);
  for (const part of parts) {
    if (!/event_row/.test(part)) continue;
    const idMatch = part.match(/<a[^>]*\bclass="[^"]*\bevent_time\b[^"]*"[^>]*\bhref="\/event\/(\d+)"/)
                 || part.match(/\bhref="\/event\/(\d+)"[^>]*class="[^"]*\bevent_time\b/);
    const userAnchor = part.match(/<a[^>]*\bclass="[^"]*\bevent_source_user\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([^<]+)<\/a>/);
    const actionMatch = part.match(/<strong>([^<]+)<\/strong>/);
    const timeAnchor = part.match(/<a[^>]*\bclass="[^"]*\bevent_time\b[^"]*"[^>]*\btitle="([^"]+)"[^>]*>([^<]+)<\/a>/);
    // Target object (game, post, etc.) — the first object_title anchor in event_content
    const targetMatch = part.match(/<a[^>]*\bclass="[^"]*\bobject_title\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([^<]+)<\/a>/);
    events.push({
      id: idMatch ? Number(idMatch[1]) : null,
      user: userAnchor ? {
        url: userAnchor[1],
        name: decodeHtml(userAnchor[2].trim()),
      } : null,
      action: actionMatch ? decodeHtml(actionMatch[1].trim()) : null,
      timestamp: timeAnchor ? timeAnchor[1] : null,
      relative_time: timeAnchor ? decodeHtml(timeAnchor[2].trim()) : null,
      permalink: idMatch ? `https://itch.io/event/${idMatch[1]}` : null,
      target: targetMatch ? {
        url: targetMatch[1],
        title: decodeHtml(targetMatch[2].trim()),
      } : null,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Quick arg parser (flag → value)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        // bare flag — next token may be value or another flag
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
