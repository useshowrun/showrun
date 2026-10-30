#!/usr/bin/env node
// instagram-msg.mjs — Instagram DM operations
//
// Commands:
//   node instagram-msg.mjs inbox [--count=20] [--cursor=X] [--pending]
//   node instagram-msg.mjs thread <thread_id> [--count=20] [--cursor=X]
//   node instagram-msg.mjs send <username|user_id|thread_id> "text"
//
// All requests run inside the logged-in instagram.com tab in Chrome (in-page
// fetch over CDP, see ../../_shared/instagram-fetch.mjs); no cookies are
// copied out of the browser.
//
// `inbox` and `thread` call the read-only web API in-page.
// `send` drives the live Chrome tab via CDP — Instagram moved web DM send off
// REST and onto a WebSocket/GraphQL surface that requires tokens we can't
// reliably replay. Driving the UI (navigate → click Message → type → Enter) is
// the only path that lands real messages without burning the session.
//
// Requires Node 22+ and the chrome-cdp skill.

import { resolve } from 'path';
import {
  CACHE_DIR, ensureDir, saveJson, cdp,
  igApi, igGraphql, resolveUserPk, checkSession, InstagramStopError, isInstagramUrl,
} from '../../_shared/instagram-fetch.mjs';

// ---------------------------------------------------------------------------
// CDP helpers for `send` (UI driving)
// ---------------------------------------------------------------------------

// Find an instagram.com tab; open one (and wait briefly for load) if missing.
function findOrOpenIgTab() {
  const list = cdp('list');
  // Check the URL column (last), not the whole row: a title or query string can contain "instagram.com".
  for (const line of list.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && isInstagramUrl(cols[cols.length - 1])) return cols[0];
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

function resolveTarget(input) {
  if (typeof input !== 'string') throw new Error('Target must be a string');
  const cleaned = input.replace(/^@/, '');
  if (/^\d+$/.test(cleaned)) {
    if (cleaned.length >= THREAD_ID_MIN_DIGITS) return { kind: 'thread', thread_id: cleaned };
    return { kind: 'user', user_id: cleaned };
  }
  // Username: resolve to user_id (web_profile_info is blocked for web clients).
  const username = cleaned.toLowerCase();
  return { kind: 'user', user_id: resolveUserPk(username), username };
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

function cmdInbox(flags) {
  const count = parseInt(flags.count || '20', 10);
  const which = flags.pending ? 'pending_inbox' : 'inbox';
  let path = `/api/v1/direct_v2/${which}/?visual_message_return_type=unseen&persistentBadging=true&limit=${count}`;
  if (flags.cursor) path += `&cursor=${encodeURIComponent(flags.cursor)}`;
  const data = igApi(path);
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

function cmdThread(threadId, flags) {
  if (!threadId) { console.error('Usage: thread <thread_id> [--count=20] [--cursor=X]'); process.exit(1); }
  const count = parseInt(flags.count || '20', 10);
  let path = `/api/v1/direct_v2/threads/${encodeURIComponent(threadId)}/?visual_message_return_type=unseen&limit=${count}`;
  if (flags.cursor) path += `&cursor=${encodeURIComponent(flags.cursor)}`;
  const data = igApi(path);
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

async function cmdSend(target, text) {
  if (!target || !text) {
    console.error('Usage: send <username|user_id|thread_id> "text"');
    process.exit(1);
  }
  const resolved = resolveTarget(target);
  const tabId = findOrOpenIgTab();

  // 1. Navigate to the right place.
  //   - existing thread: /direct/t/<thread_id>/ opens the composer directly
  //   - user (by username or id): the user's profile, then click their "Message" button
  let username = resolved.username;
  if (resolved.kind === 'user' && !username) {
    // user_id only — resolve to username so we have a profile URL
    const info = igGraphql('PolarisProfilePageContentQuery', { enable_integrity_filters: true, id: String(resolved.user_id) });
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
  //    and whose sender is our own user_id. Polls for ~15s because the inbox
  //    API can lag a beat behind the WebSocket send (each poll is spaced by
  //    the shared request pacing, so this is only a few requests).
  const myId = checkSession().userId || '';
  let confirmed = null;
  let inboxUnavailable = false;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const data = igApi('/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&limit=10');
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
    } catch (err) {
      if (err instanceof InstagramStopError) throw err;
      // The v1 inbox endpoint 404s for web clients now; don't keep hitting it.
      if (/HTTP 404/.test(err.message)) { inboxUnavailable = true; break; }
      /* otherwise keep polling */
    }
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
  if (!confirmed && inboxUnavailable) {
    console.error('WARNING: UI flow completed but the send could not be verified: the web inbox API (/api/v1/direct_v2/inbox/) returns 404 for web clients. Check the thread in Chrome.');
  } else if (!confirmed) {
    console.error('WARNING: UI flow completed but inbox did not show the message within 15s. Could be inbox lag, or the send was silently dropped. Re-run `inbox` after a few seconds to confirm.');
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
\`inbox\` and \`thread\` call the read-only web API inside the same tab.

All commands need a logged-in instagram.com tab in the CDP-connected Chrome;
\`send\` opens one automatically if missing.`);
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0];

  ensureDir(CACHE_DIR);

  try {
    switch (command) {
      case 'inbox':   cmdInbox(flags); break;
      case 'thread':  cmdThread(positional[1], flags); break;
      case 'send':    await cmdSend(positional[1], positional.slice(2).join(' ')); break;
      default: printUsage();
    }
  } catch (err) {
    if (err instanceof InstagramStopError) console.error(`STOP: ${err.message}`);
    else console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
