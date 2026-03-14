#!/usr/bin/env node
// linkedin-msg.mjs — Send LinkedIn messages from the terminal
//
// Setup (one-time, requires Chrome with LinkedIn open):
//   node linkedin-msg.mjs auth
//
// Send messages (no browser needed):
//   node linkedin-msg.mjs send https://linkedin.com/in/emrahyalaz "Hello!"
//   node linkedin-msg.mjs send emrahyalaz "Hello!"
//   node linkedin-msg.mjs send ACoAAAB0OpgBZOZ1m040shN_2CxvGsj7uzP70Dc "Hello!"
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory: ~/.local/share/showrun/data/linkedin-msg/
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-msg');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome via CDP (one-time setup)
// ---------------------------------------------------------------------------

function findCdpScript() {
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  const found = candidates.find(p => existsSync(p));
  if (!found) throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.');
  return process.env.CDP_SCRIPT || found;
}

function cdp(...args) {
  const script = findCdpScript();
  return execFileSync('node', [script, ...args], { encoding: 'utf8', timeout: 15000 }).trim();
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

async function doAuth() {
  console.log('Finding LinkedIn tab...');
  const target = findLinkedInTab();
  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.linkedin.com'] }));

  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  if (!csrfToken) throw new Error('JSESSIONID not found. Are you logged in?');
  if (!cookieMap['li_at']) throw new Error('li_at cookie not found. Are you logged in?');

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
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Resolve LinkedIn URL → profile URN
// ---------------------------------------------------------------------------

function parseVanityName(input) {
  const match = input.match(/(?:linkedin\.com\/in\/|^\/in\/|^)([a-zA-Z0-9\-_%]+)\/?$/);
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
      console.error('Usage: node linkedin-msg.mjs send <profile> "message"');
      console.error('  <profile> can be: LinkedIn URL, vanity name, or URN');
      process.exit(1);
    }

    const auth = getAuth();

    let recipientUrn, displayName;
    if (profileInput.startsWith('urn:') || profileInput.startsWith('ACoA')) {
      recipientUrn = profileInput.startsWith('urn:') ? profileInput : `urn:li:fsd_profile:${profileInput}`;
      displayName = recipientUrn;
      console.log(`Using URN directly: ${recipientUrn}`);
    } else {
      const vanityName = parseVanityName(profileInput);
      console.log(`Resolving ${vanityName}...`);
      const profile = await resolveProfileUrn(auth, vanityName);
      recipientUrn = profile.urn;
      displayName = profile.name;
      console.log(`Found: ${displayName} (${recipientUrn})`);
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

  default:
    console.log(`linkedin-msg — Send LinkedIn messages from the terminal

Commands:
  auth                              Authenticate via Chrome (one-time)
  send <profile> <message>          Send a message

Profile formats (all work):
  https://linkedin.com/in/username
  /in/username
  username
  urn:li:fsd_profile:ACoA...
  ACoA...

Data: ${DATA_DIR}/
  session.json    Auth cookies & CSRF token
  profiles.json   Cached vanity name -> URN mappings`);
}
