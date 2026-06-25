#!/usr/bin/env node
// instagram-msg.mjs — Instagram DM operations
//
// Commands:
//   node instagram-msg.mjs inbox [--count=20] [--cursor=X] [--pending]
//   node instagram-msg.mjs thread <thread_id> [--count=20] [--cursor=X]
//   node instagram-msg.mjs send <username|user_id|thread_id> "text"
//
// Auth is shared with instagram-user.mjs.
//
// `inbox` and `thread` use direct Node fetch against the web API (read-only).
// `send` drives the live Chrome tab via CDP — Instagram moved web DM send off
// REST and onto a WebSocket/GraphQL surface that requires tokens we can't
// reliably replay. Driving the UI (navigate → click Message → type → Enter) is
// the only path that lands real messages without burning the session.
//
// Requires Node 22+ (built-in fetch). chrome-cdp skill must be installed for
// `send`; `inbox`/`thread` work standalone.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
function saveJson(p, d) { ensureDir(resolve(p, '..')); writeFileSync(p, JSON.stringify(d, null, 2)); }

function loadSession() {
  const s = loadJson(SESSION_FILE);
  if (!s || !s.cookie || !s.csrftoken) {
    console.error('No valid session. Run: instagram-user.mjs auth');
    process.exit(1);
  }
  return s;
}

const IG_APP_ID = '936619743392459';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function baseHeaders(session) {
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': session.cookie,
    'referer': 'https://www.instagram.com/direct/inbox/',
    'user-agent': UA,
    'x-asbd-id': '129477',
    'x-csrftoken': session.csrftoken,
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-site': 'same-origin',
  };
}

async function apiGet(session, path) {
  const resp = await fetch(`https://www.instagram.com${path}`, { headers: baseHeaders(session) });
  if (!resp.ok) {
    if (resp.status === 429) { console.error('Rate limited.'); process.exit(1); }
    if (resp.status === 401 || resp.status === 403) {
      console.error(`HTTP ${resp.status}. Re-auth: instagram-user.mjs auth`);
      process.exit(1);
    }
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// CDP integration (for `send` only)
//
// We don't reinvent the chrome-cdp client — we shell out to its CLI so the
// already-debugged daemon model (one persistent socket per tab, "Allow
// debugging?" prompt fires once per tab) keeps working unchanged.
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

// Find an instagram.com tab; open one (and wait briefly for load) if missing.
function findOrOpenIgTab() {
  const list = cdp('list');
  for (const line of list.split('\n')) {
    if (line.includes('instagram.com')) return line.trim().split(/\s+/)[0];
  }
  const out = cdp('open', 'https://www.instagram.com/');
  const m = out.match(/[A-F0-9]{8}/);
  if (!m) throw new Error('Could not open instagram.com tab. Is Chrome running with CDP?');
  // Brief settle so the next nav doesn't race the new-tab handshake.
  const start = Date.now();
  while (Date.now() - start < 4000) {
    try { cdp('eval', m[0], '(() => location.href)()'); break; } catch { /* keep waiting */ }
  }
  return m[0];
}

// Poll an eval predicate until it returns the literal string "true" or timeout.
async function pollEval(tabId, exprReturningBool, { timeoutMs = 15000, intervalMs = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let raw = '';
    try { raw = cdp('eval', tabId, exprReturningBool); } catch { /* tab may be navigating */ }
    if (raw.trim() === 'true') return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function dispatchEnter(tabId) {
  const payload = (type) => JSON.stringify({
    type, key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  cdp('evalraw', tabId, 'Input.dispatchKeyEvent', payload('keyDown'));
  cdp('evalraw', tabId, 'Input.dispatchKeyEvent', payload('keyUp'));
}

// ---------------------------------------------------------------------------
// Resolve target: username -> user_id; auto-detect thread_id vs user_id
// ---------------------------------------------------------------------------

// Instagram thread_ids are long numeric strings (typically 17-20 digits); user_ids
// are typically 8-12 digits. Treat anything 14+ digits as a thread_id.
const THREAD_ID_MIN_DIGITS = 14;

async function resolveTarget(session, input) {
  if (typeof input !== 'string') throw new Error('Target must be a string');
  const cleaned = input.replace(/^@/, '');
  if (/^\d+$/.test(cleaned)) {
    if (cleaned.length >= THREAD_ID_MIN_DIGITS) return { kind: 'thread', thread_id: cleaned };
    return { kind: 'user', user_id: cleaned };
  }
  // Username: resolve to user_id
  const data = await apiGet(session, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleaned.toLowerCase())}`);
  const user = data?.data?.user;
  if (!user?.id) throw new Error(`User not found: ${cleaned}`);
  return { kind: 'user', user_id: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatThreadSummary(t) {
  const others = (t.users || []).map(u => u.username);
  const lastItem = t.items?.[0];
  return {
    thread_id: t.thread_id,
    thread_v2_id: t.thread_v2_id,
    title: t.thread_title || null,
    is_group: (t.users || []).length > 1,
    users: others,
    last_activity_at: t.last_activity_at,
    has_unread: !!t.read_state,
    muted: !!t.muted,
    pending: !!t.pending,
    archived: !!t.archived,
    last_message: lastItem
      ? {
          item_id: lastItem.item_id,
          item_type: lastItem.item_type,
          timestamp: lastItem.timestamp,
          text: lastItem.text || lastItem.message_item_state || null,
          sender_id: lastItem.user_id,
        }
      : null,
  };
}

function formatItem(item) {
  return {
    item_id: item.item_id,
    item_type: item.item_type,
    timestamp: item.timestamp,
    sender_id: item.user_id,
    text: item.text || null,
    reactions: item.reactions || null,
    is_sent_by_viewer: item.is_sent_by_viewer ?? null,
    replied_to_message: item.replied_to_message?.item_id || null,
    media: item.media ? { type: item.media.media_type, url: item.media.image_versions2?.candidates?.[0]?.url } : null,
  };
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInbox(session, flags) {
  const count = parseInt(flags.count || '20', 10);
  const which = flags.pending ? 'pending_inbox' : 'inbox';
  let path = `/api/v1/direct_v2/${which}/?visual_message_return_type=unseen&persistentBadging=true&limit=${count}`;
  if (flags.cursor) path += `&cursor=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const inbox = data.inbox || {};
  const threads = (inbox.threads || []).map(formatThreadSummary);
  const result = {
    viewer: data.viewer?.username,
    threads,
    nextCursor: inbox.oldest_cursor || null,
    has_older: !!inbox.has_older,
    unseen_count: data.inbox?.unseen_count ?? 0,
  };
  saveJson(resolve(CACHE_DIR, `${which}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdThread(session, threadId, flags) {
  if (!threadId) { console.error('Usage: thread <thread_id> [--count=20] [--cursor=X]'); process.exit(1); }
  const count = parseInt(flags.count || '20', 10);
  let path = `/api/v1/direct_v2/threads/${encodeURIComponent(threadId)}/?visual_message_return_type=unseen&limit=${count}`;
  if (flags.cursor) path += `&cursor=${encodeURIComponent(flags.cursor)}`;
  const data = await apiGet(session, path);
  const t = data.thread || {};
  const result = {
    thread_id: t.thread_id,
    title: t.thread_title || null,
    users: (t.users || []).map(u => ({ id: u.pk, username: u.username, full_name: u.full_name })),
    messages: (t.items || []).map(formatItem),
    nextCursor: t.oldest_cursor || null,
    has_older: !!t.has_older,
  };
  saveJson(resolve(CACHE_DIR, `thread-${threadId}-${Date.now()}.json`), result);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSend(session, target, text) {
  if (!target || !text) {
    console.error('Usage: send <username|user_id|thread_id> "text"');
    process.exit(1);
  }
  const resolved = await resolveTarget(session, target);
  const tabId = findOrOpenIgTab();

  // 1. Navigate to the right place.
  //   - existing thread: /direct/t/<thread_id>/ opens the composer directly
  //   - user (by username or id): the user's profile, then click their "Message" button
  let username = resolved.username;
  if (resolved.kind === 'user' && !username) {
    // user_id only — resolve to username so we have a profile URL
    const info = await apiGet(session, `/api/v1/users/${resolved.user_id}/info/`);
    username = info?.user?.username;
    if (!username) throw new Error(`Could not resolve user_id ${resolved.user_id} to a username`);
  }
  const navUrl = resolved.kind === 'thread'
    ? `https://www.instagram.com/direct/t/${encodeURIComponent(resolved.thread_id)}/`
    : `https://www.instagram.com/${encodeURIComponent(username)}/`;
  cdp('nav', tabId, navUrl);

  // 2. For user targets, click the profile-level "Message" button.
  if (resolved.kind === 'user') {
    const hasMsgBtn = await pollEval(tabId, `(() => {
      const btns = [...document.querySelectorAll('div[role=button], button')];
      return !!btns.find(b => b.innerText.trim() === 'Message');
    })()`, { timeoutMs: 12000 });
    if (!hasMsgBtn) {
      throw new Error(`No "Message" button on @${username}'s profile. They likely don't allow DMs from accounts that don't follow them (or you don't follow each other). Follow them first and retry, or send through an existing thread.`);
    }
    const coordsRaw = cdp('eval', tabId, `(() => {
      const btns = [...document.querySelectorAll('div[role=button], button')];
      const m = btns.find(b => b.innerText.trim() === 'Message');
      m.scrollIntoView({ block: 'center' });
      const r = m.getBoundingClientRect();
      return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2);
    })()`).trim();
    const [bx, by] = coordsRaw.split(',').map(Number);
    cdp('clickxy', tabId, String(bx), String(by));
  }

  // 3. Wait for the composer to render, then click it to focus and type.
  const hasComposer = await pollEval(tabId,
    `!!document.querySelector('div[contenteditable=true]')`,
    { timeoutMs: 12000 });
  if (!hasComposer) throw new Error('DM composer did not appear within 12s.');

  const composerCoords = cdp('eval', tabId, `(() => {
    const c = document.querySelector('div[contenteditable=true]');
    c.focus();
    const r = c.getBoundingClientRect();
    return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2);
  })()`).trim();
  const [cx, cy] = composerCoords.split(',').map(Number);
  cdp('clickxy', tabId, String(cx), String(cy));

  // Small breath before typing so focus settles in the contenteditable.
  await new Promise(r => setTimeout(r, 300));
  cdp('type', tabId, text);
  await new Promise(r => setTimeout(r, 400));

  // 4. Press Enter to send.
  dispatchEnter(tabId);

  // 5. Wait for composer to clear (the UI's own "send succeeded" signal).
  const cleared = await pollEval(tabId, `(() => {
    const c = document.querySelector('div[contenteditable=true]');
    return !c || !c.innerText.trim();
  })()`, { timeoutMs: 8000 });

  // 6. Verify via inbox: look for a thread whose last_message.text matches
  //    and whose sender is our own user_id. Polls for ~6s because the inbox
  //    API can lag a beat behind the WebSocket send.
  const myId = session.userId || '';
  let confirmed = null;
  const start = Date.now();
  while (Date.now() - start < 6000) {
    try {
      const data = await apiGet(session, '/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&limit=10');
      const threads = data?.inbox?.threads || [];
      const match = threads.find(t => {
        const last = t.items?.[0];
        if (!last) return false;
        if (last.text !== text) return false;
        if (myId && String(last.user_id) !== String(myId)) return false;
        if (resolved.kind === 'thread') return t.thread_id === resolved.thread_id;
        if (resolved.kind === 'user') {
          return (t.users || []).some(u => String(u.pk) === String(resolved.user_id) || u.username === username);
        }
        return false;
      });
      if (match) { confirmed = match; break; }
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 800));
  }

  const result = {
    ok: !!confirmed,
    target: resolved,
    username,
    text,
    composer_cleared: cleared,
    thread_id: confirmed?.thread_id || null,
    item_id: confirmed?.items?.[0]?.item_id || null,
    timestamp: confirmed?.items?.[0]?.timestamp || null,
  };
  if (!confirmed) {
    console.error('WARNING: UI flow completed but inbox did not show the message within 6s. Could be inbox lag, or the send was silently dropped. Re-run `inbox` after a few seconds to confirm.');
  }
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`instagram-msg — Instagram DM operations

Commands:
  inbox [--count=20] [--cursor=X] [--pending]   List conversations
  thread <thread_id> [--count=20] [--cursor=X]  Messages in a thread
  send <username|user_id|thread_id> "text"      Send a text DM

Target auto-detection: numeric ≥14 digits = thread_id; ≤12 digits = user_id;
non-numeric = username (resolved to user_id automatically).

\`send\` drives the live Chrome tab via CDP (chrome-cdp skill required), because
Instagram moved web DM send onto a WebSocket surface that REST cannot reach.
\`inbox\` and \`thread\` use the read-only web API directly.

Auth shared with instagram-user.mjs. \`send\` needs an instagram.com tab open in
the CDP-connected Chrome — it opens one automatically if missing.`);
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'inbox':   await cmdInbox(loadSession(), flags); break;
      case 'thread':  await cmdThread(loadSession(), positional[1], flags); break;
      case 'send':    await cmdSend(loadSession(), positional[1], positional.slice(2).join(' ')); break;
      default: printUsage();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
