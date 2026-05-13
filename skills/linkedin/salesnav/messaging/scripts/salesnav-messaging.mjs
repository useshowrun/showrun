#!/usr/bin/env node
// salesnav-messaging.mjs — Sales Navigator InMail/messaging: list threads, read, reply, send InMail
//
// Setup:   node salesnav-messaging.mjs auth
// Usage:   node salesnav-messaging.mjs inbox [--count=20] [--filter=INBOX|SENT|ARCHIVED]
//          node salesnav-messaging.mjs thread <threadId>
//          node salesnav-messaging.mjs send <threadId> --body="Hello..."
//          node salesnav-messaging.mjs new-inmail <profileUrn> --subject="..." --body="..."
//          node salesnav-messaging.mjs signature
//          node salesnav-messaging.mjs presence <urn1,urn2,...>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { ensureFreshAuth, fetchAuthed } from '../../../_shared/li-auth.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-messaging');
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
// Auth
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}


const LINKEDIN_COOKIE_URLS = [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/sales/',
  'https://www.linkedin.com/sales/home',
];

function parseCookieResponse(raw, source) {
  try {
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.cookies)) throw new Error('response has no cookies array');
    return data.cookies;
  } catch (err) {
    throw new Error(`${source} cookie extraction failed: ${err.message}`);
  }
}

function cookieMapFrom(cookies) {
  return Object.fromEntries(cookies.map(c => [c.name, c.value]));
}

function linkedInCookieString(cookies) {
  return cookies
    .filter(c => String(c.domain || '').includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function activeTabInfo(target, listText = '') {
  let url = '';
  let title = '';
  try {
    const raw = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    }));
    const parsed = JSON.parse(raw);
    const value = parsed?.result?.value || parsed?.result?.description;
    if (value) {
      const info = JSON.parse(value);
      url = info.url || '';
      title = info.title || '';
    }
  } catch {}
  if (!url) {
    const line = String(listText || '').split('\n').find(l => l.trim().startsWith(`${target} `) || l.includes(target));
    if (line) url = line.trim();
  }
  return { url, title };
}

function readLinkedInCookies(target) {
  const errors = [];
  try {
    const cookies = parseCookieResponse(cdp('evalraw', target, 'Storage.getCookies', '{}'), 'Storage.getCookies');
    return { cookies, source: 'Storage.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  try {
    const cookies = parseCookieResponse(
      cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: LINKEDIN_COOKIE_URLS })),
      'Network.getCookies',
    );
    return { cookies, source: 'Network.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  for (const url of LINKEDIN_COOKIE_URLS) {
    try {
      const cookies = parseCookieResponse(
        cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: [url] })),
        `Network.getCookies ${url}`,
      );
      return { cookies, source: `Network.getCookies ${url}` };
    } catch (err) {
      errors.push(err.message);
    }
  }

  throw new Error(`LinkedIn/Sales Nav cookie extraction failure in active CDP session: ${errors.join(' | ')}`);
}

function getLinkedInAuthCookies(target, listText = '') {
  const { cookies, source } = readLinkedInCookies(target);
  const cookieMap = cookieMapFrom(cookies);
  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  const missing = ['li_at', 'JSESSIONID'].filter(name => !cookieMap[name]);
  if (missing.length) {
    const info = activeTabInfo(target, listText);
    const activeUrl = info.url || '';
    const activeTitle = info.title || '';
    if (/\/login(?:[/?#]|$)|\/sales\/login(?:[/?#]|$)/i.test(activeUrl)) {
      throw new Error('LinkedIn/Sales Nav is showing login page in the active CDP session; log in through the same live Browser Use URL or pass the exact live CDP endpoint.');
    }
    throw new Error(
      `LinkedIn/Sales Nav auth cookies missing (${missing.join(', ')}) after ${source}. ` +
      `Active tab URL/title: ${activeUrl || '<unknown>'}${activeTitle ? ` / ${activeTitle}` : ''}. ` +
      'This is not enough to claim generic logged-out state: distinguish wrong CDP session/profile, actual logged-out state, or cookie extraction failure. For human login handoff, use the exact live Browser Use CDP endpoint.',
    );
  }
  return { cookieStr: linkedInCookieString(cookies), csrfToken, cookieSource: source };
}

async function doAuth() {
  console.log('Finding Sales Navigator tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com/sales')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn/Sales Navigator tab found.');

  console.log(`Using tab: ${target}`);

  const { cookieStr, csrfToken, cookieSource } = getLinkedInAuthCookies(target, list);
  console.log(`Extracted LinkedIn cookies via ${cookieSource}`);

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  try {
    const auth = ensureFreshAuth({ sessionFile: SESSION_FILE });
    if (!auth.cookie) {
      console.error('No auth found. Run: node salesnav-messaging.mjs auth');
      process.exit(1);
    }
    return auth;
  } catch (err) {
    console.error(`Could not refresh auth from Chrome: ${err.message}`);
    const cached = loadJson(SESSION_FILE);
    if (cached.cookie) {
      console.error('Falling back to cached session.json (may be stale).');
      return cached;
    }
    process.exit(1);
  }
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'csrf-token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetchAuthed(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-messaging.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Percent-encode REST-li decoration strings for the decoration= query param
// ---------------------------------------------------------------------------

function encodeDecoration(str) {
  return str
    .replace(/%/g, '%25').replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/,/g, '%2C').replace(/\*/g, '%2A').replace(/~/g, '%7E')
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/ /g, '%20');
}

// ---------------------------------------------------------------------------
// Thread decoration string
// ---------------------------------------------------------------------------

const THREAD_DECORATION =
  '(id,restrictions,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,'
  + 'messages*(id,type,contentFlag,deliveredAt,lastEditedAt,subject,body,footerText,blockCopy,attachments,author,systemMessageContent),'
  + 'participants*~fs_salesProfile(entityUrn,firstName,lastName,fullName,degree,profilePictureDisplayImage,objectUrn,inmailRestriction))';

// ---------------------------------------------------------------------------
// API: List inbox threads
// ---------------------------------------------------------------------------

async function listThreads(auth, { count = 20, filter = 'INBOX', pageStartsAt = null } = {}) {
  // pageStartsAt is required by the API — use current timestamp for the first page
  const cursor = pageStartsAt || Date.now();
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads`
    + `?decoration=${encodeDecoration(THREAD_DECORATION)}`
    + `&count=${count}`
    + `&filter=${filter}`
    + `&pageStartsAt=${cursor}`
    + `&q=filter`;

  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Get a single thread
// ---------------------------------------------------------------------------

async function getThread(auth, threadId) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads/${encodeURIComponent(threadId)}`
    + `?decoration=${encodeDecoration(THREAD_DECORATION)}`
    + `&count=1&messageCount=10`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Send reply to existing thread
// ---------------------------------------------------------------------------

async function sendReply(auth, threadId, body) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads/${encodeURIComponent(threadId)}/messages`;
  return apiFetch(auth, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-restli-method': 'create',
    },
    body: JSON.stringify({ body }),
  });
}

// ---------------------------------------------------------------------------
// API: Send new InMail
// ---------------------------------------------------------------------------

async function sendNewInmail(auth, profileUrn, subject, body) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads`;
  return apiFetch(auth, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-restli-method': 'create',
    },
    body: JSON.stringify({
      subject,
      body,
      recipients: [profileUrn],
    }),
  });
}

// ---------------------------------------------------------------------------
// API: Inbox signature
// ---------------------------------------------------------------------------

async function getSignature(auth) {
  const url = `https://www.linkedin.com/sales-api/salesApiInboxSignature/USER_SIGNATURE`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// API: Presence statuses
// ---------------------------------------------------------------------------

async function getPresence(auth, urns) {
  const urnList = urns.join(',');
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingPresenceStatuses?ids=List(${urnList})`;
  return apiFetch(auth, url);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

function resolveParticipants(thread) {
  const map = {};
  const resolutions = thread.participantsResolutionResults || {};
  for (const [urn, profile] of Object.entries(resolutions)) {
    map[urn] = profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || urn;
  }
  // Fallback: if participants are listed but not resolved, use the URN
  for (const urn of (thread.participants || [])) {
    if (!map[urn]) map[urn] = urn;
  }
  return map;
}

function printThreadSummary(thread) {
  const participants = resolveParticipants(thread);
  const names = Object.values(participants).join(', ');
  const lastMsg = (thread.messages || []).sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0))[0];
  const preview = lastMsg?.body?.substring(0, 80)?.replace(/\n/g, ' ') || '';
  const unread = thread.unreadMessageCount > 0 ? ` [${thread.unreadMessageCount} unread]` : '';
  const archived = thread.archived ? ' [archived]' : '';

  console.log(`  ${thread.id}${unread}${archived}`);
  console.log(`    With: ${names}`);
  if (lastMsg?.subject) console.log(`    Subject: ${lastMsg.subject}`);
  console.log(`    Last: ${formatTimestamp(lastMsg?.deliveredAt)} — ${preview}${preview.length >= 80 ? '...' : ''}`);
  console.log(`    Messages: ${thread.totalMessageCount || (thread.messages || []).length}`);
}

function printThreadFull(thread) {
  const participants = resolveParticipants(thread);
  const names = Object.values(participants).join(', ');

  console.log(`Thread: ${thread.id}`);
  console.log(`Participants: ${names}`);
  console.log(`Total messages: ${thread.totalMessageCount || (thread.messages || []).length}`);
  if (thread.archived) console.log(`Status: ARCHIVED`);
  console.log('---');

  const messages = (thread.messages || []).sort((a, b) => (a.deliveredAt || 0) - (b.deliveredAt || 0));
  for (const msg of messages) {
    const authorName = participants[msg.author] || msg.author || 'System';
    const time = formatTimestamp(msg.deliveredAt);
    if (msg.subject) console.log(`\n[${time}] ${authorName} — Subject: ${msg.subject}`);
    else console.log(`\n[${time}] ${authorName}`);
    if (msg.type === 'SYSTEM_MESSAGE' || msg.systemMessageContent) {
      console.log(`  (system) ${msg.systemMessageContent || msg.body || ''}`);
    } else {
      console.log(`  ${msg.body || ''}`);
    }
    if (msg.attachments?.length) {
      console.log(`  Attachments: ${msg.attachments.length}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) flags[match[1]] = match[2];
    else if (arg.startsWith('--')) {
      // Boolean flag like --dry-run
      const key = arg.replace(/^--/, '');
      flags[key] = 'true';
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'inbox': {
    const { flags } = parseFlags(args);
    const auth = getAuth();
    const count = parseInt(flags.count || '20');
    const filter = (flags.filter || 'INBOX').toUpperCase();
    const pageStartsAt = flags.page || null;

    console.log(`Fetching ${filter} threads (count=${count})...`);
    const data = await listThreads(auth, { count, filter, pageStartsAt });
    const threads = data.elements || [];

    if (threads.length === 0) {
      console.log('No threads found.');
      break;
    }

    console.log(`Showing ${threads.length} threads:\n`);
    for (const thread of threads) {
      // Merge resolution results from top-level into each thread
      if (data.participantsResolutionResults && !thread.participantsResolutionResults) {
        thread.participantsResolutionResults = data.participantsResolutionResults;
      }
      printThreadSummary(thread);
      console.log();
    }

    // Pagination hint
    const nextCursor = threads[threads.length - 1]?.nextPageStartsAt;
    if (nextCursor) {
      console.log(`Next page: node salesnav-messaging.mjs inbox --filter=${filter} --page=${nextCursor}`);
    }

    // Save to cache
    const outFile = resolve(CACHE_DIR, `inbox-${filter.toLowerCase()}-${Date.now()}.json`);
    saveJson(outFile, data);
    console.log(`Raw data saved to: ${outFile}`);
    break;
  }

  case 'thread': {
    const threadId = args.find(a => !a.startsWith('--'));
    if (!threadId) {
      console.error('Usage: node salesnav-messaging.mjs thread <threadId>');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Fetching thread: ${threadId}...`);
    const thread = await getThread(auth, threadId);
    printThreadFull(thread);

    const outFile = resolve(CACHE_DIR, `thread-${threadId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`);
    saveJson(outFile, thread);
    console.log(`\nRaw data saved to: ${outFile}`);
    break;
  }

  case 'send': {
    const { flags, positional } = parseFlags(args);
    const threadId = positional[0];
    const body = flags.body;
    if (!threadId || !body) {
      console.error('Usage: node salesnav-messaging.mjs send <threadId> --body="Your message"');
      process.exit(1);
    }

    const auth = getAuth();

    if (flags['dry-run'] === 'true') {
      console.log('DRY RUN — would send:');
      console.log(`  Thread: ${threadId}`);
      console.log(`  Body: ${body}`);
      console.log(`  URL: POST /sales-api/salesApiMessagingThreads/${threadId}/messages`);
      console.log(`  Payload: ${JSON.stringify({ body })}`);
      break;
    }

    console.log(`Sending reply to thread: ${threadId}...`);
    console.log('NOTE: Send endpoint is inferred and may need adjustment if it fails.');
    try {
      const result = await sendReply(auth, threadId, body);
      console.log('Reply sent successfully.');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Failed to send reply: ${err.message}`);
      console.error('The send endpoint is inferred. If this fails consistently, the API format may differ.');
      console.error('Try --dry-run to inspect the request that would be made.');
      process.exit(1);
    }
    break;
  }

  case 'new-inmail': {
    const { flags, positional } = parseFlags(args);
    const profileUrn = positional[0];
    const subject = flags.subject;
    const body = flags.body;
    if (!profileUrn || !subject || !body) {
      console.error('Usage: node salesnav-messaging.mjs new-inmail <profileUrn> --subject="..." --body="..."');
      console.error('  profileUrn: e.g. urn:li:fs_salesProfile:(ACwAAABxyz,NAME_SEARCH,abc)');
      process.exit(1);
    }

    const auth = getAuth();

    if (flags['dry-run'] === 'true') {
      console.log('DRY RUN — would send:');
      console.log(`  To: ${profileUrn}`);
      console.log(`  Subject: ${subject}`);
      console.log(`  Body: ${body}`);
      console.log(`  URL: POST /sales-api/salesApiMessagingThreads`);
      console.log(`  Payload: ${JSON.stringify({ subject, body, recipients: [profileUrn] })}`);
      break;
    }

    console.log(`Sending new InMail to: ${profileUrn}...`);
    console.log('NOTE: New InMail endpoint is inferred and may need adjustment if it fails.');
    try {
      const result = await sendNewInmail(auth, profileUrn, subject, body);
      console.log('InMail sent successfully.');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Failed to send InMail: ${err.message}`);
      console.error('The InMail endpoint is inferred. If this fails consistently, the API format may differ.');
      console.error('Try --dry-run to inspect the request that would be made.');
      process.exit(1);
    }
    break;
  }

  case 'signature': {
    const auth = getAuth();
    console.log('Fetching inbox signature...');
    const data = await getSignature(auth);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'presence': {
    const rawUrns = args[0]?.split(',').filter(Boolean);
    if (!rawUrns?.length) {
      console.error('Usage: node salesnav-messaging.mjs presence <urn1,urn2,...>');
      console.error('  e.g. presence urn:li:fs_salesProfile:ACwAAA...,urn:li:fs_salesProfile:ACwBBB...');
      process.exit(1);
    }
    const auth = getAuth();
    console.log(`Checking presence for ${rawUrns.length} URN(s)...`);
    const data = await getPresence(auth, rawUrns);

    const results = data.results || data;
    if (typeof results === 'object' && !Array.isArray(results)) {
      for (const [urn, status] of Object.entries(results)) {
        console.log(`  ${urn}: ${JSON.stringify(status)}`);
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    break;
  }

  default:
    console.log(`salesnav-messaging — Sales Navigator InMail/messaging

Commands:
  auth                                          Authenticate via Chrome (one-time)
  inbox [--count=20] [--filter=INBOX]           List inbox threads
  thread <threadId>                             View a specific thread with all messages
  send <threadId> --body="Hello..."             Send a reply to an existing thread
  new-inmail <profileUrn> --subject --body      Send a new InMail
  signature                                     Get your inbox signature
  presence <urn1,urn2,...>                       Check online presence status

Inbox filters:
  --filter=INBOX       Default — incoming messages
  --filter=SENT        Sent messages
  --filter=ARCHIVED    Archived messages

Pagination:
  --count=20           Threads per page (default: 20)
  --page=<timestamp>   Cursor for next page (from previous response)

Send options:
  --dry-run            Show the request without executing (send & new-inmail)

Notes:
  - Send and new-inmail endpoints are inferred (not directly observed).
    Use --dry-run first to verify the request shape.
  - Thread IDs come from the inbox listing.
  - Profile URNs come from search results or thread participants.

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Thread and inbox data`);
}
