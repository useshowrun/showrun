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
// Requires Node 22+ and the chrome-cdp skill. Requests run inside your logged-in
// Chrome tab (via CDP), so keep a Sales Navigator tab open.

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { apiFetch, doAuth as cdpDoAuth, requireAuth } from '../../_shared/salesnav-cdp.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-messaging');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_CMD = 'node salesnav-messaging.mjs auth';

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

async function listThreads({ count = 20, filter = 'INBOX', pageStartsAt = null } = {}) {
  // pageStartsAt is required by the API — use current timestamp for the first page
  const cursor = pageStartsAt || Date.now();
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads`
    + `?decoration=${encodeDecoration(THREAD_DECORATION)}`
    + `&count=${count}`
    + `&filter=${filter}`
    + `&pageStartsAt=${cursor}`
    + `&q=filter`;

  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
}

// ---------------------------------------------------------------------------
// API: Get a single thread
// ---------------------------------------------------------------------------

async function getThread(threadId) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads/${encodeURIComponent(threadId)}`
    + `?decoration=${encodeDecoration(THREAD_DECORATION)}`
    + `&count=1&messageCount=10`;
  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
}

// ---------------------------------------------------------------------------
// API: Send reply to existing thread
// ---------------------------------------------------------------------------

async function sendReply(threadId, body) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads/${encodeURIComponent(threadId)}/messages`;
  // softErrors: let the CLI's try/catch surface the "inferred endpoint" guidance.
  return await apiFetch(url, {
    method: 'POST',
    headers: { 'x-restli-method': 'create' },
    body: JSON.stringify({ body }),
  }, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Send new InMail
// ---------------------------------------------------------------------------

async function sendNewInmail(profileUrn, subject, body) {
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingThreads`;
  // softErrors: let the CLI's try/catch surface the "inferred endpoint" guidance.
  return await apiFetch(url, {
    method: 'POST',
    headers: { 'x-restli-method': 'create' },
    body: JSON.stringify({
      subject,
      body,
      recipients: [profileUrn],
    }),
  }, { authCmd: AUTH_CMD, softErrors: true });
}

// ---------------------------------------------------------------------------
// API: Inbox signature
// ---------------------------------------------------------------------------

async function getSignature() {
  const url = `https://www.linkedin.com/sales-api/salesApiInboxSignature/USER_SIGNATURE`;
  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
}

// ---------------------------------------------------------------------------
// API: Presence statuses
// ---------------------------------------------------------------------------

async function getPresence(urns) {
  const urnList = urns.join(',');
  const url = `https://www.linkedin.com/sales-api/salesApiMessagingPresenceStatuses?ids=List(${urnList})`;
  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
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
    cdpDoAuth(SESSION_FILE, saveJson);
    break;
  }

  case 'inbox': {
    const { flags } = parseFlags(args);
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    const count = parseInt(flags.count || '20');
    const filter = (flags.filter || 'INBOX').toUpperCase();
    const pageStartsAt = flags.page || null;

    console.log(`Fetching ${filter} threads (count=${count})...`);
    const data = await listThreads({ count, filter, pageStartsAt });
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
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching thread: ${threadId}...`);
    const thread = await getThread(threadId);
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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);

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
      const result = await sendReply(threadId, body);
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

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);

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
      const result = await sendNewInmail(profileUrn, subject, body);
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
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log('Fetching inbox signature...');
    const data = await getSignature();
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
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Checking presence for ${rawUrns.length} URN(s)...`);
    const data = await getPresence(rawUrns);

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
