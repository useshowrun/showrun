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
import { cookieMapFrom, linkedInCookieString, isLinkedInUrl } from '../../../_shared/linkedin-fetch.mjs';
import { searchFlagship } from '../../../_shared/linkedin-search-html.mjs';

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome LinkedIn tab
// ---------------------------------------------------------------------------


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
  const list = cdp('list');
  let target;
  for (const pref of ['/feed', '/in/', 'linkedin.com']) {
    for (const line of list.split('\n')) {
      if (isLinkedInUrl(line.trim().split(/\s+/).pop()) && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (isLinkedInUrl(line.trim().split(/\s+/).pop())) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');

  console.log(`Using tab: ${target}`);

  const { cookieStr, csrfToken, cookieSource } = getLinkedInAuthCookies(target, list);
  console.log(`Extracted LinkedIn cookies via ${cookieSource}`);

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// Auth guard (requests themselves run in Chrome via chromeFetch)
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node linkedin-search.mjs auth');
    process.exit(1);
  }
  return auth;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// LinkedIn's /search/results/* pages are now server-rendered; the voyager
// `voyagerSearchDashClusters` GraphQL query they used to call returns metadata
// with zero result entities. Results come from the server-rendered page itself
// (fetched in-page through Chrome, parsed in Node) — see linkedin-search-html.mjs.
const VALID_TYPES = ['PEOPLE', 'COMPANIES', 'GROUPS', 'SCHOOLS', 'EVENTS', 'PRODUCTS', 'SERVICES', 'POSTS'];
const MAX_COUNT = 50; // 5 result pages per invocation

async function doSearch(keywords, { type = 'PEOPLE', count = 10, page = 1 } = {}) {
  type = type.toUpperCase();
  if (!VALID_TYPES.includes(type)) {
    console.error(`Invalid type: ${type}. Valid types: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }
  if (!Number.isFinite(count) || count < 1) count = 10;
  if (count > MAX_COUNT) {
    console.error(`--count capped at ${MAX_COUNT} (LinkedIn serves 10 results per page; use --page for more).`);
    count = MAX_COUNT;
  }
  if (!Number.isFinite(page) || page < 1) page = 1;

  getAuth();
  const start = (page - 1) * count;
  const { results, total } = await searchFlagship(type, keywords, { start, count });

  // Companies/groups/etc. render an exact "N results" count; people search
  // no longer does (only pagination, capped at 10 pages of 10).
  const totalText = total != null ? `${total.toLocaleString()} results` : 'total not reported by LinkedIn';
  const totalPages = total != null ? Math.ceil(total / count) : null;

  console.log(`\n${type} search: "${keywords}" — ${totalText} (page ${page}/${totalPages || '?'})\n`);

  if (results.length === 0) { console.log('No results found.'); return; }
  for (const r of results) {
    console.log(`  ${r.name}`);
    if (r.subtitle) console.log(`    ${r.subtitle}`);
    if (r.secondary) console.log(`    ${r.secondary}`);
    if (r.summary) console.log(`    ${r.summary.length > 300 ? r.summary.substring(0, 300) + '...' : r.summary}`);
    if (r.distance) console.log(`    [${r.distance} connection]`);
    if (r.url || r.authorUrl) console.log(`    ${r.url || r.authorUrl}`);
    console.log();
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
