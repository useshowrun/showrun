#!/usr/bin/env node
// reddit-messaging.mjs — View inbox, send messages, and manage Reddit private messages
//
// Setup (one-time, requires Chrome with reddit.com open):
//   node reddit-messaging.mjs auth
//
// Commands:
//   node reddit-messaging.mjs inbox [--limit=25] [--after=cursor]
//   node reddit-messaging.mjs unread [--limit=25] [--after=cursor]
//   node reddit-messaging.mjs sent [--limit=25] [--after=cursor]
//   node reddit-messaging.mjs read <id>
//   node reddit-messaging.mjs send <user> <subject> <body>
//   node reddit-messaging.mjs reply <message_id> <body>
//
// Requires Node 22+ (built-in fetch). All commands require auth.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/reddit-messaging');
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
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies + bearer token from Chrome Reddit tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Reddit tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/r/', 'reddit.com']) {
    for (const line of list.split('\n')) {
      if (line.includes('reddit.com') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('reddit.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No Reddit tab found. Open Reddit in Chrome first.');
  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.reddit.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('reddit.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
  const csrfToken = cookieMap['csrf_token'] || '';

  // Bearer token is the token_v2 cookie (RS256 JWT)
  const bearerToken = cookieMap['token_v2'] || '';
  if (bearerToken) {
    console.log('Bearer token extracted from token_v2 cookie.');
  } else {
    console.error('Warning: token_v2 cookie not found. OAuth endpoints will not work.');
  }

  // Extract Matrix chat credentials from localStorage (requires chat tab to have been opened)
  let matrixToken = '';
  let matrixUserId = '';
  try {
    matrixToken = cdp('eval', target, "localStorage.getItem('chat:matrix-access-token') || ''").replace(/^"|"$/g, '');
    matrixUserId = cdp('eval', target, "localStorage.getItem('chat:matrix-user-id') || ''").replace(/^"|"$/g, '');
    if (matrixToken) {
      console.log(`Matrix chat token extracted (user: ${matrixUserId}).`);
    } else {
      console.log('No Matrix chat token found. Open chat.reddit.com once to enable chat commands.');
    }
  } catch { /* chat localStorage may not be available */ }

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, bearerToken, matrixToken, matrixUserId, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node reddit-messaging.mjs auth');
    process.exit(1);
  }
  return auth;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function oauthHeaders(auth) {
  return {
    'accept': 'application/json',
    'user-agent': UA,
    'cookie': auth.cookie,
    ...(auth.bearerToken ? { 'authorization': `Bearer ${auth.bearerToken}` } : {}),
  };
}

async function oauthFetch(url, auth, options = {}) {
  const resp = await fetch(url, { ...options, headers: { ...oauthHeaders(auth), ...options.headers } });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 401 || resp.status === 403) {
    console.error('Session expired. Run: node reddit-messaging.mjs auth');
  }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Utility helpers
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

function formatDate(utc) {
  if (!utc) return 'unknown';
  return new Date(utc * 1000).toISOString().split('T')[0];
}

function ensureFullname(id, prefix = 't4_') {
  if (id.startsWith('t1_') || id.startsWith('t3_') || id.startsWith('t4_')) return id;
  return prefix + id;
}

function preview(text, maxLen = 200) {
  if (!text) return '';
  const clean = text.replace(/\n+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

// ---------------------------------------------------------------------------
// Matrix chat helpers
// ---------------------------------------------------------------------------

const MATRIX_BASE = 'https://matrix.redditspace.com/_matrix/client/v3';

function getMatrixAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.matrixToken) {
    console.error('No Matrix chat token. Open chat.reddit.com in Chrome, then re-run: node reddit-messaging.mjs auth');
    process.exit(1);
  }
  return auth;
}

async function matrixFetch(path, auth, options = {}) {
  const resp = await fetch(`${MATRIX_BASE}${path}`, {
    ...options,
    headers: {
      'authorization': `Bearer ${auth.matrixToken}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (resp.status === 401) {
    console.error('Matrix token expired. Open chat.reddit.com in Chrome, then re-run: node reddit-messaging.mjs auth');
  }
  return { status: resp.status, ok: resp.ok, data };
}

async function resolveRedditUserId(auth, username) {
  // Get the user's t2_ ID from Reddit API
  const resp = await fetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json?raw_json=1`, {
    headers: { 'accept': 'application/json', 'user-agent': UA, 'cookie': auth.cookie },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const id = data?.data?.id;
  return id ? `@t2_${id}:reddit.com` : null;
}

// ---------------------------------------------------------------------------
// API: Chat commands (Matrix)
// ---------------------------------------------------------------------------

async function cmdChat(username, message) {
  const auth = getMatrixAuth();

  console.log(`Resolving u/${username}...`);
  const matrixId = await resolveRedditUserId(auth, username);
  if (!matrixId) {
    console.error(`User u/${username} not found.`);
    return;
  }

  console.log(`Creating/finding DM room with ${matrixId}...`);
  const roomResult = await matrixFetch('/createRoom', auth, {
    method: 'POST',
    body: JSON.stringify({
      invite: [matrixId],
      is_direct: true,
      preset: 'trusted_private_chat',
    }),
  });

  if (!roomResult.ok) {
    console.error(`Failed to create chat room (${roomResult.status}): ${JSON.stringify(roomResult.data).substring(0, 200)}`);
    return;
  }

  const roomId = roomResult.data.room_id;
  const txnId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  console.log(`Sending message to ${roomId}...`);
  const sendResult = await matrixFetch(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, auth, {
    method: 'PUT',
    body: JSON.stringify({ msgtype: 'm.text', body: message }),
  });

  if (!sendResult.ok) {
    console.error(`Failed to send message (${sendResult.status}): ${JSON.stringify(sendResult.data).substring(0, 200)}`);
    return;
  }

  console.log(`Chat message sent to u/${username} (event: ${sendResult.data.event_id}).`);
}

async function cmdChats() {
  const auth = getMatrixAuth();

  console.log('Fetching chat rooms...');
  const roomsResult = await matrixFetch('/joined_rooms', auth);

  if (!roomsResult.ok) {
    console.error(`Failed to fetch rooms (${roomsResult.status})`);
    return;
  }

  const rooms = roomsResult.data.joined_rooms || [];
  console.log(`\nChat rooms (${rooms.length}):\n`);

  for (const roomId of rooms) {
    // Get room name/members
    const stateResult = await matrixFetch(`/rooms/${encodeURIComponent(roomId)}/state`, auth);
    const events = Array.isArray(stateResult.data) ? stateResult.data : [];

    const nameEvent = events.find(e => e.type === 'm.room.name');
    const members = events.filter(e => e.type === 'm.room.member' && e.content?.membership === 'join');
    const roomName = nameEvent?.content?.name || members.map(m => m.content?.displayname || m.state_key).filter(n => n !== auth.matrixUserId).join(', ') || roomId;

    // Get last message
    const msgsResult = await matrixFetch(`/rooms/${encodeURIComponent(roomId)}/messages?limit=1&dir=b`, auth);
    const lastMsg = msgsResult.data?.chunk?.[0];
    const lastBody = lastMsg?.content?.body || '(no messages)';
    const lastTime = lastMsg?.origin_server_ts ? new Date(lastMsg.origin_server_ts).toISOString().split('T')[0] : '';

    console.log(`  ${roomName}`);
    console.log(`    Room: ${roomId}`);
    console.log(`    Last: ${preview(lastBody, 100)} ${lastTime ? `(${lastTime})` : ''}`);
    console.log(`    Members: ${members.map(m => m.content?.displayname || m.state_key).join(', ')}`);
    console.log('');
  }

  const cacheFile = resolve(CACHE_DIR, `chats-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'chats', rooms });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Inbox messages
// ---------------------------------------------------------------------------

async function cmdInbox(flags) {
  const auth = getAuth();
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';

  console.log('Fetching inbox...');

  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);

  const url = `https://oauth.reddit.com/message/inbox?${params}`;
  const { status, ok, data } = await oauthFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nInbox (${children.length} messages):\n`);

  for (const child of children) {
    const d = child.data;
    const unread = d.new ? '[NEW] ' : '';
    console.log(`  ${unread}From: ${d.author || 'unknown'} \u00b7 ${formatDate(d.created_utc)}`);
    console.log(`  Subject: ${d.subject || '(no subject)'}`);
    console.log(`  ${preview(d.body)}`);
    console.log(`  ID: ${d.name}`);
    if (d.context) console.log(`  Context: https://www.reddit.com${d.context}`);
    if (d.subreddit) console.log(`  Subreddit: r/${d.subreddit}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} messages shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} messages shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `inbox-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'inbox', limit, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Unread messages
// ---------------------------------------------------------------------------

async function cmdUnread(flags) {
  const auth = getAuth();
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';

  console.log('Fetching unread messages...');

  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);

  const url = `https://oauth.reddit.com/message/unread?${params}`;
  const { status, ok, data } = await oauthFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nUnread messages (${children.length} total):\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  [NEW] From: ${d.author || 'unknown'} \u00b7 ${formatDate(d.created_utc)}`);
    console.log(`  Subject: ${d.subject || '(no subject)'}`);
    console.log(`  ${preview(d.body)}`);
    console.log(`  ID: ${d.name}`);
    if (d.context) console.log(`  Context: https://www.reddit.com${d.context}`);
    if (d.subreddit) console.log(`  Subreddit: r/${d.subreddit}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} messages shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} messages shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `unread-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'unread', limit, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Sent messages
// ---------------------------------------------------------------------------

async function cmdSent(flags) {
  const auth = getAuth();
  const limit = Math.min(Math.max(parseInt(flags.limit || '25', 10), 1), 100);
  const after = flags.after || '';

  console.log('Fetching sent messages...');

  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (after) params.set('after', after);

  const url = `https://oauth.reddit.com/message/sent?${params}`;
  const { status, ok, data } = await oauthFetch(url, auth);

  if (!ok) {
    console.error(`API error (HTTP ${status})`);
    return;
  }

  const children = data?.data?.children || [];
  const afterCursor = data?.data?.after || null;

  console.log(`\nSent messages (${children.length}):\n`);

  for (const child of children) {
    const d = child.data;
    console.log(`  To: ${d.dest || 'unknown'} \u00b7 ${formatDate(d.created_utc)}`);
    console.log(`  Subject: ${d.subject || '(no subject)'}`);
    console.log(`  ${preview(d.body)}`);
    console.log(`  ID: ${d.name}`);
    console.log('');
  }

  if (afterCursor) {
    console.log(`${children.length} messages shown. Next page: --after=${afterCursor}`);
  } else {
    console.log(`${children.length} messages shown. No more pages.`);
  }

  const cacheFile = resolve(CACHE_DIR, `sent-${Date.now()}.json`);
  saveJson(cacheFile, { command: 'sent', limit, results: children.map(c => c.data), after: afterCursor });
  console.log(`Cached: ${cacheFile}`);
}

// ---------------------------------------------------------------------------
// API: Mark message as read
// ---------------------------------------------------------------------------

async function cmdRead(id) {
  const auth = getAuth();
  const fullname = ensureFullname(id);

  console.log(`Marking ${fullname} as read...`);

  const body = new URLSearchParams({ id: fullname });
  const { status, ok, data } = await oauthFetch('https://oauth.reddit.com/api/read_message', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    console.error(`Failed to mark as read (HTTP ${status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
    return;
  }

  console.log(`Marked ${fullname} as read.`);
}

// ---------------------------------------------------------------------------
// API: Send private message
// ---------------------------------------------------------------------------

async function cmdSend(user, subject, messageBody) {
  const auth = getAuth();

  console.log(`Sending message to u/${user}...`);

  const body = new URLSearchParams({
    to: user,
    subject,
    text: messageBody,
    api_type: 'json',
  });
  const { status, ok, data } = await oauthFetch('https://oauth.reddit.com/api/compose', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    const errors = data?.json?.errors || [];
    if (errors.length > 0) {
      for (const err of errors) {
        const code = err[0] || '';
        const msg = err[1] || '';
        if (code === 'USER_DOESNT_EXIST') {
          console.error(`User u/${user} does not exist.`);
        } else if (code === 'NOT_WHITELISTED_BY_USER_MESSAGE') {
          console.error(`u/${user} has messaging disabled or has blocked you.`);
        } else if (code === 'RATELIMIT') {
          console.error(`Rate limited: ${msg}`);
        } else {
          console.error(`Error: ${code} — ${msg}`);
        }
      }
    } else {
      console.error(`Failed to send message (HTTP ${status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
    }
    return;
  }

  // Check for errors in successful response (Reddit returns 200 with errors in body)
  const errors = data?.json?.errors || [];
  if (errors.length > 0) {
    for (const err of errors) {
      const code = err[0] || '';
      const msg = err[1] || '';
      if (code === 'USER_DOESNT_EXIST') {
        console.error(`User u/${user} does not exist.`);
      } else if (code === 'RESTRICTED_TO_PM' || code === 'NOT_WHITELISTED_BY_USER_MESSAGE') {
        console.log(`u/${user} has legacy PMs restricted. Falling back to chat...`);
        await cmdChat(user, `[${subject}] ${messageBody}`);
        return;
      } else if (code === 'RATELIMIT') {
        console.error(`Rate limited: ${msg}`);
      } else {
        console.error(`Error: ${code} — ${msg}`);
      }
    }
    return;
  }

  console.log(`Message sent to u/${user}.`);
}

// ---------------------------------------------------------------------------
// API: Reply to a message
// ---------------------------------------------------------------------------

async function cmdReply(messageId, replyBody) {
  const auth = getAuth();
  const fullname = ensureFullname(messageId);

  console.log(`Replying to ${fullname}...`);

  const body = new URLSearchParams({
    thing_id: fullname,
    text: replyBody,
    api_type: 'json',
  });
  const { status, ok, data } = await oauthFetch('https://oauth.reddit.com/api/comment', auth, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    const errors = data?.json?.errors || [];
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`Error: ${err[0] || ''} — ${err[1] || ''}`);
      }
    } else {
      console.error(`Failed to reply (HTTP ${status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
    }
    return;
  }

  // Check for errors in successful response
  const errors = data?.json?.errors || [];
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`Error: ${err[0] || ''} — ${err[1] || ''}`);
    }
    return;
  }

  console.log('Reply sent.');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] || '';
const { flags, positional } = parseFlags(args.slice(1));

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'inbox': {
      await cmdInbox(flags);
      break;
    }

    case 'unread': {
      await cmdUnread(flags);
      break;
    }

    case 'sent': {
      await cmdSent(flags);
      break;
    }

    case 'read': {
      const id = positional[0];
      if (!id) { console.error('Usage: node reddit-messaging.mjs read <id>'); process.exit(1); }
      await cmdRead(id);
      break;
    }

    case 'send': {
      const user = positional[0];
      const subject = positional[1];
      const body = positional[2];
      if (!user || !subject || !body) { console.error('Usage: node reddit-messaging.mjs send <user> <subject> <body>'); process.exit(1); }
      await cmdSend(user, subject, body);
      break;
    }

    case 'reply': {
      const messageId = positional[0];
      const body = positional[1];
      if (!messageId || !body) { console.error('Usage: node reddit-messaging.mjs reply <message_id> <body>'); process.exit(1); }
      await cmdReply(messageId, body);
      break;
    }

    case 'chat': {
      const user = positional[0];
      const message = positional.slice(1).join(' ');
      if (!user || !message) { console.error('Usage: node reddit-messaging.mjs chat <user> <message>'); process.exit(1); }
      await cmdChat(user, message);
      break;
    }

    case 'chats': {
      await cmdChats();
      break;
    }

    default: {
      const script = 'reddit-messaging.mjs';
      console.log(`
reddit-messaging — Reddit private messages + chat from the terminal

Setup (one-time, requires Chrome with reddit.com open):
  node ${script} auth                              Extract cookies, bearer token + chat token

Private Messages (legacy PM system):
  node ${script} inbox [--limit=25] [--after=cursor]     View inbox messages
  node ${script} unread [--limit=25] [--after=cursor]    View unread messages
  node ${script} sent [--limit=25] [--after=cursor]      View sent messages
  node ${script} read <id>                               Mark message as read
  node ${script} send <user> <subject> <body>            Send PM (auto-falls back to chat if PM blocked)
  node ${script} reply <message_id> <body>               Reply to a message

Chat (Matrix-based, requires chat.reddit.com opened once):
  node ${script} chat <user> <message>                   Send a chat message
  node ${script} chats                                   List chat conversations

Examples:
  node ${script} auth
  node ${script} inbox --limit=10
  node ${script} send username "Subject line" "Message body text"
  node ${script} chat anilseyrek "Hey, what's up?"
  node ${script} chats

All commands require auth. For chat, open chat.reddit.com once before auth.
Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
