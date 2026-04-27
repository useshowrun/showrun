#!/usr/bin/env node
// linkedin-search.mjs — LinkedIn search from the terminal
//
// Setup (one-time, requires Chrome with LinkedIn open):
//   node linkedin-search.mjs auth
//
// Commands:
//   node linkedin-search.mjs search <keywords>              Search people (default)
//   node linkedin-search.mjs search <keywords> --type=COMPANIES
//   node linkedin-search.mjs search <keywords> --count=25 --page=2
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-search');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');

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
    resolve(dirname(new URL(import.meta.url).pathname), '../../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome LinkedIn tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding LinkedIn tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/feed', '/in/', 'linkedin.com']) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');

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

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node linkedin-search.mjs auth');
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
    'Csrf-Token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  if (resp.status === 401 || resp.status === 403) {
    console.error('Session expired. Run: node linkedin-search.mjs auth');
    process.exit(1);
  }
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const QUERY_ID = 'voyagerSearchDashClusters.05111e1b90ee7fea15bebe9f9410ced9';
const VALID_TYPES = ['PEOPLE', 'COMPANIES', 'GROUPS', 'SCHOOLS', 'EVENTS', 'PRODUCTS', 'SERVICES', 'POSTS'];

async function doSearch(keywords, { type = 'PEOPLE', count = 10, page = 1 } = {}) {
  type = type.toUpperCase();
  if (!VALID_TYPES.includes(type)) {
    console.error(`Invalid type: ${type}. Valid types: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  const auth = getAuth();
  const start = (page - 1) * count;
  const encodedKeywords = encodeURIComponent(keywords);
  const apiType = type === 'POSTS' ? 'CONTENT' : type;
  const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodedKeywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(${apiType}))),includeFiltersInResponse:false),count:${count})`;
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${QUERY_ID}`;

  const data = await apiFetch(auth, url);

  // Validate response shape
  const meta = data?.data?.data?.searchDashClustersByAll?.metadata;
  if (!meta) {
    console.error('ERROR: Unexpected response shape — LinkedIn may have changed the search API.');
    console.error('Raw keys:', JSON.stringify(Object.keys(data?.data?.data || data?.data || data || {})));
    process.exit(1);
  }

  const included = data?.included || [];
  const total = meta.totalResultCount || 0;
  const totalPages = Math.ceil(total / count);

  console.log(`\n${type} search: "${keywords}" — ${total.toLocaleString()} results (page ${page}/${totalPages || '?'})\n`);

  if (type === 'POSTS') {
    const updates = included.filter(e => e.$type?.includes('feed.Update'));
    if (updates.length === 0) { console.log('No results found.'); return; }
    for (const u of updates) {
      const author = u.actor?.name?.text || '(unknown)';
      const text = (u.commentary?.text?.text || '').substring(0, 300);
      console.log(`  ${author}`);
      if (text) console.log(`    ${text}${text.length >= 300 ? '...' : ''}`);
      console.log();
    }
  } else {
    const entities = included.filter(e => e.$type?.includes('EntityResultViewModel'));
    if (entities.length === 0) { console.log('No results found.'); return; }
    for (const e of entities) {
      const name = e.title?.text || '(unknown)';
      const subtitle = e.primarySubtitle?.text || '';
      const secondary = e.secondarySubtitle?.text || '';
      const summary = e.summary?.text || '';
      const url = e.navigationUrl?.split('?')[0] || '';
      const distance = e.entityCustomTrackingInfo?.memberDistance || '';

      console.log(`  ${name}`);
      if (subtitle) console.log(`    ${subtitle}`);
      if (secondary) console.log(`    ${secondary}`);
      if (summary) console.log(`    ${summary}`);
      if (distance) console.log(`    [${distance.replace('DISTANCE_', '').toLowerCase()} connection]`);
      if (url) console.log(`    ${url}`);
      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name, defaultValue) {
  const prefix = `--${name}=`;
  const arg = args.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : defaultValue;
}

(async () => {
  try {
    if (command === 'auth') {
      await doAuth();
    } else if (command === 'search') {
      const keywords = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
      if (!keywords) {
        console.error('Usage: node linkedin-search.mjs search <keywords> [--type=PEOPLE] [--count=10] [--page=1]');
        process.exit(1);
      }
      await doSearch(keywords, {
        type: getFlag('type', 'PEOPLE'),
        count: parseInt(getFlag('count', '10'), 10),
        page: parseInt(getFlag('page', '1'), 10),
      });
    } else {
      console.log('Usage:');
      console.log('  node linkedin-search.mjs auth');
      console.log('  node linkedin-search.mjs search <keywords> [--type=PEOPLE] [--count=10] [--page=1]');
      console.log(`\nValid types: ${VALID_TYPES.join(', ')}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
