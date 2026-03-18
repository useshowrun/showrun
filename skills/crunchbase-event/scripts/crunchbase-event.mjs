#!/usr/bin/env node
// crunchbase-event.mjs — Fetch detailed event data from Crunchbase
//
// Setup:   node crunchbase-event.mjs auth
// Usage:   node crunchbase-event.mjs view <permalink|uuid>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-event');
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
// CDP integration
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Crunchbase tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('crunchbase.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) throw new Error('No Crunchbase tab found. Open crunchbase.com in Chrome first.');

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.crunchbase.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieStr = cookies
    .filter(c => c.domain.includes('crunchbase.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  if (!cookieMap['trustcookie']) throw new Error('trustcookie not found. Are you logged in?');

  const userAgent = cdp('eval', target, 'navigator.userAgent');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userAgent,
    capturedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node crunchbase-event.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'cookie': auth.cookie,
    'user-agent': auth.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `https://www.crunchbase.com${url}`;
  const resp = await fetch(fullUrl, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-event.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Event not found.');
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Resolve permalink to UUID
// ---------------------------------------------------------------------------

async function resolvePermalink(auth, permalink) {
  // If it looks like a UUID, return it directly
  if (permalink.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return permalink;
  }

  // Search for the event by permalink
  const data = await apiFetch(auth, '/v4/data/searches/events?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'events',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Event not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

// ---------------------------------------------------------------------------
// Event detail
// ---------------------------------------------------------------------------

const EVENT_CARDS = [];

const EVENT_FIELDS = [
  'identifier', 'starts_on', 'ends_on', 'location_identifiers', 'short_description',
  'description', 'event_url', 'venue_name', 'categories', 'category_groups',
  'num_speakers', 'num_sponsors', 'num_exhibitors', 'num_contestants',
  'num_organizers', 'organizer_identifiers', 'registration_url', 'event_type',
  'rank_event',
];

async function viewEvent(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  const fieldIds = encodeURIComponent(JSON.stringify(EVENT_FIELDS));
  let url = `/v4/data/entities/events/${uuid}?field_ids=${fieldIds}`;
  if (EVENT_CARDS.length) {
    url += `&card_ids=${encodeURIComponent(JSON.stringify(EVENT_CARDS))}`;
  }
  const data = await apiFetch(auth, url);

  return data;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) flags[m[1]] = m[2]; else positional.push(arg);
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'view': {
    const { positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node crunchbase-event.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching event: ${input}...`);
    const data = await viewEvent(auth, input);

    const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
    saveJson(cacheFile, data);

    const props = data.properties || {};
    const id = props.identifier || {};
    console.log(`\n${id.value || input}`);
    if (props.short_description) console.log(`  ${props.short_description}`);
    if (props.event_type) console.log(`  Type: ${props.event_type}`);
    if (props.starts_on) console.log(`  Starts: ${props.starts_on.value || props.starts_on}`);
    if (props.ends_on) console.log(`  Ends: ${props.ends_on.value || props.ends_on}`);
    if (props.venue_name) console.log(`  Venue: ${props.venue_name}`);
    if (props.location_identifiers?.length) {
      console.log(`  Location: ${props.location_identifiers.map(l => l.value).join(', ')}`);
    }
    if (props.event_url) console.log(`  Event URL: ${props.event_url.value || props.event_url}`);
    if (props.registration_url) console.log(`  Registration: ${props.registration_url.value || props.registration_url}`);
    if (props.num_speakers) console.log(`  Speakers: ${props.num_speakers}`);
    if (props.num_sponsors) console.log(`  Sponsors: ${props.num_sponsors}`);
    if (props.num_exhibitors) console.log(`  Exhibitors: ${props.num_exhibitors}`);
    if (props.num_contestants) console.log(`  Contestants: ${props.num_contestants}`);
    if (props.num_organizers) console.log(`  Organizers: ${props.num_organizers}`);
    if (props.organizer_identifiers?.length) {
      console.log(`  Organized by: ${props.organizer_identifiers.map(o => o.value).join(', ')}`);
    }
    if (props.rank_event) console.log(`  Rank: ${props.rank_event}`);
    if (props.categories?.length) {
      console.log(`  Categories: ${props.categories.map(c => c.value).join(', ')}`);
    }
    if (props.category_groups?.length) {
      console.log(`  Category Groups: ${props.category_groups.map(c => c.value).join(', ')}`);
    }
    if (props.description) {
      console.log(`\n  Description:\n    ${props.description.substring(0, 500)}`);
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`crunchbase-event — Fetch detailed event data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full event details

Input formats:
  techcrunch-disrupt-2024        Event permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Event UUID

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Event data`);
}
