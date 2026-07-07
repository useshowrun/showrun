#!/usr/bin/env node
// linkedin-msg.mjs — LinkedIn messaging from the terminal
//
// Setup (one-time, requires Chrome with LinkedIn open):
//   node linkedin-msg.mjs auth
//
// Commands:
//   node linkedin-msg.mjs inbox                  List conversations
//   node linkedin-msg.mjs messages <urn|index>    View messages in a conversation
//   node linkedin-msg.mjs search "Name"           Find contacts
//   node linkedin-msg.mjs send <profile> "Hello!" Send a message
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { applySetCookies, cookieMapFrom, linkedInCookieString, chromeFetch } from '../../../_shared/linkedin-fetch.mjs';

// ---------------------------------------------------------------------------
// Data directory: ~/.local/share/showrun/data/linkedin-msg/
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-msg');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const CONVERSATIONS_FILE = resolve(CACHE_DIR, 'conversations.json');

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
// Auth: extract cookies from Chrome via CDP (one-time setup)
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
  const script = findCdpScript();
  return execFileSync('node', [script, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

function findLinkedInTab() {
  const list = cdp('list');
  const lines = list.split('\n');
  for (const pref of ['/messaging', '/feed', 'linkedin.com/in/']) {
    for (const line of lines) {
      if (line.includes('linkedin.com') && line.includes(pref)) {
        return line.trim().split(/\s+/)[0];
      }
    }
  }
  for (const line of lines) {
    if (line.includes('linkedin.com')) return line.trim().split(/\s+/)[0];
  }
  throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');
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
  console.log('Finding LinkedIn tab...');
  const target = findLinkedInTab();
  console.log(`Using tab: ${target}`);

  const { cookieStr, csrfToken, cookieSource } = getLinkedInAuthCookies(target);
  console.log(`Extracted LinkedIn cookies via ${cookieSource}`);

  // Get own profile URN (use application/json to get flat response)
  const meResp = await apiFetch(
    { cookie: cookieStr, csrfToken },
    'https://www.linkedin.com/voyager/api/me',
    { headers: { 'accept': 'application/json' } }
  );
  const myUrn = meResp.data?.miniProfile?.dashEntityUrn || meResp.data?.miniProfile?.entityUrn || '';
  if (!myUrn) throw new Error('Could not determine your profile URN.');

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, myUrn, extractedAt: new Date().toISOString() });

  console.log(`Authenticated as: ${meResp.data?.miniProfile?.firstName} ${meResp.data?.miniProfile?.lastName}`);
  console.log(`Session saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node linkedin-msg.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'X-LI-Lang': 'en_US',
    'X-LI-Track': JSON.stringify({
      clientVersion: '1.13.42849', mpVersion: '1.13.42849', osName: 'web',
      timezoneOffset: new Date().getTimezoneOffset() / -60,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceFormFactor: 'DESKTOP', mpName: 'voyager-web',
      displayDensity: 1, displayWidth: 3440, displayHeight: 1440,
    }),
    'X-li-page-instance': 'urn:li:page:d_flagship3_messaging_conversation_detail;linkedin-msg-cli',
    'Csrf-Token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  // Route every API call through Chrome's logged-in LinkedIn tab so cookies
  // (including JSESSIONID rotation) come from Chrome's single jar — no Node-vs-
  // Chrome drift, no anti-abuse trips, no surprise logouts.
  const resp = await chromeFetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  let data;
  try { data = JSON.parse(resp.body); } catch { data = resp.body; }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Resolve LinkedIn URL → profile URN
// ---------------------------------------------------------------------------

function parseVanityName(input) {
  const match = input.match(/(?:linkedin\.com\/in\/|^\/in\/|^)([^\s/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : input;
}

async function resolveProfileUrn(auth, vanityName) {
  const profiles = loadJson(PROFILES_FILE);
  const cacheKey = vanityName.toLowerCase();

  if (profiles[cacheKey]) return profiles[cacheKey];

  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanityName)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`;
  const result = await apiFetch(auth, url);

  if (!result.ok) {
    throw new Error(`Failed to resolve profile "${vanityName}" (HTTP ${result.status})`);
  }

  // Extract profile URN from response
  const elements = result.data?.data?.['*elements'] || result.data?.['*elements'] || [];
  let profileUrn = elements.find(e => e.includes('fsd_profile'));

  const included = result.data?.included || [];

  if (!profileUrn) {
    const profile = included.find(e => e.entityUrn?.includes('fsd_profile') && e.firstName);
    if (profile) profileUrn = profile.entityUrn;
  }

  if (!profileUrn) throw new Error(`Could not find profile URN for "${vanityName}"`);

  const profileObj = included.find(e => e.entityUrn === profileUrn);
  const name = profileObj
    ? `${profileObj.firstName || ''} ${profileObj.lastName || ''}`.trim()
    : vanityName;

  const profileData = { urn: profileUrn, name, vanityName };
  profiles[cacheKey] = profileData;
  saveJson(PROFILES_FILE, profiles);

  return profileData;
}

// ---------------------------------------------------------------------------
// Conversations API
// ---------------------------------------------------------------------------

function extractConversations(responseData) {
  const included = responseData?.included || [];
  const conversations = included.filter(e => e.$type === 'com.linkedin.messenger.Conversation');
  const participants = included.filter(e => e.$type === 'com.linkedin.messenger.MessagingParticipant');
  const messages = included.filter(e => e.$type === 'com.linkedin.messenger.Message');

  const participantMap = {};
  for (const p of participants) {
    if (p.entityUrn) {
      const member = p.participantType?.member;
      participantMap[p.entityUrn] = {
        entityUrn: p.entityUrn,
        hostIdentityUrn: p.hostIdentityUrn,
        name: member ? `${member.firstName?.text || ''} ${member.lastName?.text || ''}`.trim() : 'Unknown',
        profileUrl: member?.profileUrl || '',
      };
    }
  }

  const messageMap = {};
  for (const m of messages) {
    if (m.entityUrn) {
      messageMap[m.entityUrn] = {
        entityUrn: m.entityUrn,
        text: m.body?.text || '',
        sender: m['*sender'] || '',
        deliveredAt: m.deliveredAt,
      };
    }
  }

  return conversations.map(c => {
    const convParticipantUrns = c['*conversationParticipants'] || [];
    const convParticipants = convParticipantUrns
      .map(urn => participantMap[urn])
      .filter(Boolean);

    const lastMsgUrn = c['*messages']?.[0];
    const lastMsg = lastMsgUrn ? messageMap[lastMsgUrn] : null;

    return {
      entityUrn: c.entityUrn,
      participants: convParticipants,
      lastMessage: lastMsg ? { text: lastMsg.text, deliveredAt: lastMsg.deliveredAt } : null,
      lastActivityAt: c.lastActivityAt,
      unreadCount: c.unreadCount || 0,
      categories: c.categories || [],
    };
  }).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
}

function encodeRestliValue(val) {
  return encodeURIComponent(val).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// LinkedIn's messengerConversations endpoint silently returns an EMPTY result
// for count >= ~30 and exposes no offset param — you page backwards with the
// opaque `nextCursor` token in each response's metadata. So we always request a
// safe page size and follow the cursor. Requesting count=40 (as the old code
// did) returned nothing, which made search/inbox appear empty rather than deep.
const CONVERSATION_PAGE_SIZE = 20;

async function fetchConversationPage(auth, { category = 'PRIMARY_INBOX', cursor = null } = {}) {
  const cursorPart = cursor ? `,nextCursor:${encodeRestliValue(cursor)}` : '';
  const variables = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:${CONVERSATION_PAGE_SIZE}${cursorPart},mailboxUrn:${encodeRestliValue(auth.myUrn)})`;
  const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf&variables=${variables}`;

  const result = await apiFetch(auth, url);
  if (!result.ok) {
    const detail = typeof result.data === 'string' ? result.data.substring(0, 200) : JSON.stringify(result.data).substring(0, 200);
    throw new Error(`Failed to fetch conversations (HTTP ${result.status}): ${detail}`);
  }

  const conversations = extractConversations(result.data);
  const nextCursor = result.data?.data?.data?.messengerConversationsByCategoryQuery?.metadata?.nextCursor || null;
  return { conversations, nextCursor };
}

// Page through conversations newest-first, calling onPage with each fresh
// (de-duplicated) batch. Stops when onPage returns true, the cursor runs out,
// or maxPages is reached — whichever comes first.
async function paginateConversations(auth, { category = 'PRIMARY_INBOX', maxPages = 50, onPage } = {}) {
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const { conversations, nextCursor } = await fetchConversationPage(auth, { category, cursor });
    const fresh = conversations.filter(c => c.entityUrn && !seen.has(c.entityUrn));
    for (const c of fresh) seen.add(c.entityUrn);
    const stop = onPage ? onPage(fresh, page) : false;
    if (stop || !nextCursor || fresh.length === 0) break;
    cursor = nextCursor;
  }
}

async function listConversations(auth, { count = 20, category = 'PRIMARY_INBOX' } = {}) {
  const conversations = [];
  await paginateConversations(auth, {
    category,
    maxPages: Math.ceil(count / CONVERSATION_PAGE_SIZE) + 1,
    onPage: (fresh) => {
      conversations.push(...fresh);
      return conversations.length >= count;
    },
  });
  const sliced = conversations.slice(0, count);

  // Save to cache
  saveJson(CONVERSATIONS_FILE, {
    fetchedAt: new Date().toISOString(),
    category,
    conversations: sliced,
  });

  return sliced;
}

async function listMessages(auth, conversationUrn) {
  const variables = `(conversationUrn:${encodeRestliValue(conversationUrn)})`;
  const url = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314&variables=${variables}`;

  const result = await apiFetch(auth, url);
  if (!result.ok) {
    const detail = typeof result.data === 'string' ? result.data.substring(0, 200) : JSON.stringify(result.data).substring(0, 200);
    throw new Error(`Failed to fetch messages (HTTP ${result.status}): ${detail}`);
  }

  const included = result.data?.included || [];
  const msgs = included.filter(e => e.$type === 'com.linkedin.messenger.Message');
  const participants = included.filter(e => e.$type === 'com.linkedin.messenger.MessagingParticipant');

  const participantMap = {};
  for (const p of participants) {
    if (p.entityUrn) {
      const member = p.participantType?.member;
      participantMap[p.entityUrn] = member
        ? `${member.firstName?.text || ''} ${member.lastName?.text || ''}`.trim()
        : 'Unknown';
    }
  }

  const messages = msgs.map(m => ({
    text: m.body?.text || '',
    sender: participantMap[m['*sender']] || m['*sender'] || 'Unknown',
    deliveredAt: m.deliveredAt,
  })).sort((a, b) => (a.deliveredAt || 0) - (b.deliveredAt || 0));

  // Save to cache
  const convId = conversationUrn.split(':').pop();
  saveJson(resolve(CACHE_DIR, `messages_${convId}.json`), {
    fetchedAt: new Date().toISOString(),
    conversationUrn,
    messages,
  });

  return messages;
}

function resolveConversationUrn(input) {
  // Full URN
  if (input.startsWith('urn:li:')) return input;
  // Numeric index from last inbox output
  if (/^\d+$/.test(input)) {
    const cache = loadJson(CONVERSATIONS_FILE);
    const conversations = cache.conversations || [];
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= conversations.length) {
      throw new Error(`Index ${input} out of range. Run 'inbox' first. Have ${conversations.length} conversations cached.`);
    }
    return conversations[idx].entityUrn;
  }
  // Assume it's a thread/conversation ID
  return `urn:li:msg_conversation:${input}`;
}

async function searchConversations(auth, query, { maxPages = 40 } = {}) {
  // Page through conversations by participant name. A thread with no reply is
  // sorted by its last activity, so old outreach falls far down the list —
  // hence we page (and fall through to INMAIL/OTHER) instead of a single fetch,
  // otherwise we'd falsely report "no conversation" for anyone messaged a while
  // ago. Stops as soon as a category yields a hit.
  const q = query.toLowerCase();
  const matches = [];
  const seenUrns = new Set();
  for (const category of ['PRIMARY_INBOX', 'INMAIL', 'OTHER']) {
    await paginateConversations(auth, {
      category,
      maxPages,
      onPage: (fresh) => {
        for (const c of fresh) {
          if (seenUrns.has(c.entityUrn)) continue;
          if (c.participants.some(p => p.name.toLowerCase().includes(q))) {
            seenUrns.add(c.entityUrn);
            matches.push({ ...c, category });
          }
        }
        return matches.length > 0;
      },
    });
    if (matches.length) break;
  }
  return matches;
}

async function resolveProfileFromConversations(auth, nameQuery) {
  const q = nameQuery.toLowerCase();
  const cache = loadJson(CONVERSATIONS_FILE);
  let conversations = cache.conversations || [];

  // If cache is empty or stale (>1 hour), fetch fresh
  if (!conversations.length || (cache.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() > 3600000)) {
    conversations = await listConversations(auth, { count: 40 });
  }

  for (const conv of conversations) {
    for (const p of conv.participants) {
      if (p.name.toLowerCase().includes(q) && p.hostIdentityUrn) {
        return { urn: p.hostIdentityUrn, name: p.name, conversationUrn: conv.entityUrn };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

async function sendMessage(auth, recipientUrn, messageText) {
  const body = {
    message: {
      body: { attributes: [], text: messageText },
      renderContentUnions: [],
      originToken: crypto.randomUUID(),
    },
    mailboxUrn: auth.myUrn,
    trackingId: String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    dedupeByClientGeneratedToken: false,
    hostRecipientUrns: [recipientUrn],
  };

  return await apiFetch(
    auth,
    'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'accept': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'send': {
    const [profileInput, ...msgParts] = args;
    const message = msgParts.join(' ');
    if (!profileInput || !message) {
      console.error('Usage: node linkedin-msg.mjs send <profile|conversationUrn> "message"');
      console.error('  <profile> can be: LinkedIn URL, vanity name, URN, or person\'s name');
      process.exit(1);
    }

    const auth = getAuth();

    let recipientUrn, displayName;
    if (profileInput.startsWith('urn:li:fsd_profile:') || profileInput.startsWith('ACoA')) {
      // Direct URN
      recipientUrn = profileInput.startsWith('urn:') ? profileInput : `urn:li:fsd_profile:${profileInput}`;
      displayName = recipientUrn;
      console.log(`Using URN directly: ${recipientUrn}`);
    } else if (profileInput.startsWith('urn:li:msg_conversation:')) {
      // Conversation URN — send as reply
      recipientUrn = profileInput;
      displayName = profileInput;
      console.log(`Replying to conversation: ${recipientUrn}`);
    } else {
      // Try vanity name resolution first, fall back to conversation search
      const vanityName = parseVanityName(profileInput);
      console.log(`Resolving ${vanityName}...`);
      let profile;
      try {
        profile = await resolveProfileUrn(auth, vanityName);
        recipientUrn = profile.urn;
        displayName = profile.name;
        console.log(`Found: ${displayName} (${recipientUrn})`);
      } catch (err) {
        console.log(`Profile API failed: ${err.message}`);
        console.log(`Searching conversations for "${profileInput}"...`);
        const match = await resolveProfileFromConversations(auth, profileInput);
        if (match) {
          recipientUrn = match.urn;
          displayName = match.name;
          console.log(`Found in conversations: ${displayName} (${recipientUrn})`);
        } else {
          console.error(`Could not resolve "${profileInput}" via profile API or conversation search.`);
          console.error('Try: node linkedin-msg.mjs search "<name>" to find contacts');
          process.exit(1);
        }
      }
    }

    const result = await sendMessage(auth, recipientUrn, message);

    if (result.ok) {
      console.log(`Sent to ${displayName}: "${message}"`);
    } else {
      console.error(`Failed (HTTP ${result.status}):`, JSON.stringify(result.data).substring(0, 300));
      if (result.status === 401 || result.status === 403) {
        console.error('Session expired. Run: node linkedin-msg.mjs auth');
      }
      process.exit(1);
    }
    break;
  }

  case 'inbox': {
    const auth = getAuth();
    const countFlag = args.find(a => a.startsWith('--count='));
    const catFlag = args.find(a => a.startsWith('--category='));
    const count = countFlag ? parseInt(countFlag.split('=')[1], 10) : 20;
    const category = catFlag ? catFlag.split('=')[1] : 'PRIMARY_INBOX';

    console.log(`Fetching ${count} conversations (${category})...`);
    const conversations = await listConversations(auth, { count, category });

    if (!conversations.length) {
      console.log('No conversations found.');
      break;
    }

    for (let i = 0; i < conversations.length; i++) {
      const c = conversations[i];
      const names = c.participants.map(p => p.name).join(', ');
      const time = c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : 'unknown';
      const preview = c.lastMessage?.text?.substring(0, 80) || '(no preview)';
      const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : '';
      console.log(`\n${i + 1}. ${names}${unread}`);
      console.log(`   ${time}`);
      console.log(`   ${preview}`);
      console.log(`   ${c.entityUrn}`);
    }
    console.log(`\nCached to: ${CONVERSATIONS_FILE}`);
    break;
  }

  case 'messages': {
    const auth = getAuth();
    const [convInput] = args;
    if (!convInput) {
      console.error('Usage: node linkedin-msg.mjs messages <conversationUrn|index>');
      console.error('  Use a conversation URN or numeric index from last "inbox" output');
      process.exit(1);
    }

    const conversationUrn = resolveConversationUrn(convInput);
    console.log(`Fetching messages for ${conversationUrn}...`);
    const messages = await listMessages(auth, conversationUrn);

    if (!messages.length) {
      console.log('No messages found.');
      break;
    }

    for (const m of messages) {
      const time = m.deliveredAt ? new Date(m.deliveredAt).toLocaleString() : 'unknown';
      console.log(`\n[${time}] ${m.sender}:`);
      console.log(`  ${m.text}`);
    }
    console.log(`\n${messages.length} messages shown.`);
    break;
  }

  case 'search': {
    const auth = getAuth();
    const query = args.join(' ');
    if (!query) {
      console.error('Usage: node linkedin-msg.mjs search <name>');
      process.exit(1);
    }

    console.log(`Searching conversations for "${query}"...`);
    const matches = await searchConversations(auth, query);

    if (!matches.length) {
      console.log('No matching conversations found.');
      break;
    }

    for (const c of matches) {
      const names = c.participants.map(p => p.name).join(', ');
      const preview = c.lastMessage?.text?.substring(0, 80) || '(no preview)';
      const time = c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : 'unknown';
      console.log(`\n${names}`);
      console.log(`  ${time} — ${preview}`);
      console.log(`  ${c.entityUrn}`);
      // Show URNs for participants matching the query
      const q = query.toLowerCase();
      for (const p of c.participants) {
        if (p.name.toLowerCase().includes(q) && p.hostIdentityUrn) {
          console.log(`  Profile URN: ${p.hostIdentityUrn}`);
        }
      }
    }
    console.log(`\n${matches.length} conversation(s) found.`);
    break;
  }

  default:
    console.log(`linkedin-msg — LinkedIn messaging from the terminal

Commands:
  auth                              Authenticate via Chrome (one-time)
  inbox [--count=20] [--category=PRIMARY_INBOX]
                                    List conversations
  messages <conversationUrn|index>  View messages in a conversation
  search <name>                     Find contacts in conversations
  send <profile> <message>          Send a message

Profile formats for send:
  https://linkedin.com/in/username  LinkedIn URL
  username                          Vanity name
  "First Last"                      Name (searches conversations as fallback)
  urn:li:fsd_profile:ACoA...        Direct profile URN
  ACoA...                           Profile URN ID
  urn:li:msg_conversation:...       Reply to conversation

Data: ${DATA_DIR}/
  session.json    Auth cookies & CSRF token
  profiles.json   Cached vanity name -> URN mappings
  cache/          Conversation & message cache`);
}
