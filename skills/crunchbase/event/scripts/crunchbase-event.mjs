#!/usr/bin/env node
// crunchbase-event.mjs — Fetch detailed event data from Crunchbase
//
// Setup:   node crunchbase-event.mjs auth
// Usage:   node crunchbase-event.mjs view <permalink|uuid>
//          node crunchbase-event.mjs speakers <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-event.mjs sponsors <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-event.mjs exhibitors <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-event.mjs contestants <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-event.mjs news <permalink|uuid> [--count=50] [--after-id=UUID]
//
// All API requests go through Chrome's browser context via CDP.

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

function findCrunchbaseTab() {
  const list = cdp('list');
  for (const line of list.split('\n')) {
    if (line.includes('crunchbase.com')) return line.trim().split(/\s+/)[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome CDP fetch — all Crunchbase API requests go through Chrome's context
// ---------------------------------------------------------------------------

function cdpFetch(tabId, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `https://www.crunchbase.com${url}`;
  const method = options.method || 'GET';
  const headers = { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json', ...options.headers };
  const hdrs = `,headers:${JSON.stringify(headers)}`;
  const bodyPart = options.body ? `,body:${JSON.stringify(String(options.body))}` : '';

  const result = cdp('eval', tabId,
    `(async()=>{const r=await fetch('${fullUrl}',{method:'${method}',credentials:'include'${hdrs}${bodyPart}});return r.status+'|||'+(await r.text())})()`);

  const sepIdx = result.indexOf('|||');
  const status = parseInt(result.substring(0, sepIdx), 10);
  const body = result.substring(sepIdx + 3);
  return { status, body };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function doAuth() {
  console.log('Finding Crunchbase tab...');
  const target = findCrunchbaseTab();
  if (!target) throw new Error('No Crunchbase tab found. Open crunchbase.com in Chrome first.');

  // Validate login by checking for trustcookie (httpOnly, requires Network.getCookies)
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.crunchbase.com'] }));
  const { cookies } = JSON.parse(raw);
  const hasTrust = cookies.some(c => c.name === 'trustcookie');
  if (!hasTrust) throw new Error('trustcookie not found. Are you logged in?');

  saveJson(SESSION_FILE, { capturedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers — all requests routed through Chrome's browser context
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.capturedAt) {
    console.error('No auth found. Run: node crunchbase-event.mjs auth');
    process.exit(1);
  }
  return session;
}

function apiFetch(session, url, options = {}) {
  const target = findCrunchbaseTab();
  if (!target) {
    console.error('No Crunchbase tab found. Open crunchbase.com in Chrome.');
    process.exit(1);
  }

  const { status, body } = cdpFetch(target, url, options);

  if (status === 401 || status === 403) {
    console.error('Session expired. Run: node crunchbase-event.mjs auth');
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('Event not found (HTTP 404).');
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(body); } catch { data = body; }

  if (status < 200 || status >= 300) {
    console.error(`HTTP ${status}: ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
    process.exit(1);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Resolve permalink to UUID
// ---------------------------------------------------------------------------

function resolvePermalink(auth, permalink) {
  // If it looks like a UUID, return it directly
  if (permalink.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return permalink;
  }

  // Search for the event by permalink
  const data = apiFetch(auth, '/v4/data/searches/events?source=custom_advanced_search', {
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
// Resolve to permalink (for overrides endpoint which uses permalink)
// ---------------------------------------------------------------------------

function resolveToPermalink(auth, input) {
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  const data = apiFetch(auth,
    `/v4/data/entities/events/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
}

// ---------------------------------------------------------------------------
// Generic overrides endpoint (powers all section commands)
// ---------------------------------------------------------------------------

// Section configs: section_id -> { listCard, displayFn }
const SECTIONS = {
  speakers: {
    listCard: 'speakers_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const title = item.primary_job_title || '';
      const org = item.primary_organization?.value || '';
      const suffix = title && org ? ` — ${title} at ${org}` : title ? ` — ${title}` : org ? ` — ${org}` : '';
      return `${name}${suffix}`;
    },
    summary(cards) {
      const h = cards.speakers_headline || {};
      const lines = [];
      if (h.num_speakers) lines.push(`Total speakers: ${h.num_speakers}`);
      return lines;
    },
  },
  sponsors: {
    listCard: 'sponsors_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const desc = item.short_description ? ` — ${item.short_description.substring(0, 80)}` : '';
      return `${name}${desc}`;
    },
    summary() { return []; },
  },
  exhibitors: {
    listCard: 'exhibitors_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const desc = item.short_description ? ` — ${item.short_description.substring(0, 80)}` : '';
      return `${name}${desc}`;
    },
    summary(cards) {
      const h = cards.exhibitors_headline || {};
      const lines = [];
      if (h.num_exhibitors) lines.push(`Total exhibitors: ${h.num_exhibitors}`);
      return lines;
    },
  },
  contestants: {
    listCard: 'contestants_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const desc = item.short_description ? ` — ${item.short_description.substring(0, 80)}` : '';
      return `${name}${desc}`;
    },
    summary(cards) {
      const h = cards.contestants_headline || {};
      const lines = [];
      if (h.num_contestants) lines.push(`Total contestants: ${h.num_contestants}`);
      return lines;
    },
  },
  news: {
    listCard: 'news_list',
    defaultCount: 50,
    display(item) {
      const title = item.identifier?.value || 'Untitled';
      const date = item.posted_on || '';
      const pub = item.publisher || '';
      const url = item.url?.value || '';
      return `[${date}] ${title} (${pub})${url ? `\n      ${url}` : ''}`;
    },
    summary() { return []; },
  },
};

function fetchSection(auth, input, sectionName, { count, afterId } = {}) {
  const config = SECTIONS[sectionName];
  if (!config) throw new Error(`Unknown section: ${sectionName}`);

  const permalink = resolveToPermalink(auth, input);
  const sectionId = config.sectionId || sectionName;
  const limit = count || config.defaultCount;

  const fieldIds = encodeURIComponent(JSON.stringify(
    ['identifier', 'layout_id', 'facet_ids', 'title', 'short_description', 'is_locked']));
  const sectionIds = encodeURIComponent(JSON.stringify([sectionId]));

  const cardLookup = { card_id: config.listCard, limit };
  if (afterId) cardLookup.after_id = afterId;

  return apiFetch(auth,
    `/v4/data/entities/events/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });
}

function printSection(sectionName, data, count) {
  const config = SECTIONS[sectionName];
  const items = data.cards?.[config.listCard] || [];
  const eventName = data.properties?.identifier?.value || '';

  console.log(`\n${eventName} — ${sectionName.replace(/_/g, ' ')}`);

  const summaryLines = config.summary(data.cards || {});
  for (const line of summaryLines) console.log(`  ${line}`);

  console.log(`\n  Showing ${items.length} results:\n`);
  for (const item of items) {
    const line = config.display(item);
    for (const subline of line.split('\n')) {
      console.log(`    ${subline}`);
    }
  }

  if (items.length === count) {
    const lastId = items[items.length - 1]?.identifier?.uuid;
    if (lastId) {
      console.log(`\n  More results available. Use --after-id=${lastId} to get next page.`);
    }
  }
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

function fetchEventForLayout(auth, uuid, layout) {
  const fieldIds = encodeURIComponent(JSON.stringify(EVENT_FIELDS));
  let url = `/v4/data/entities/events/${uuid}?field_ids=${fieldIds}&layout_mode=${layout}`;
  if (EVENT_CARDS.length) {
    url += `&card_ids=${encodeURIComponent(JSON.stringify(EVENT_CARDS))}`;
  }
  return apiFetch(auth, url);
}
function viewEvent(auth, input, view = 'v3') {
  const uuid = resolvePermalink(auth, input);
  if (view === 'both') {
    const v2 = fetchEventForLayout(auth, uuid, 'view_v2');
    const v3 = fetchEventForLayout(auth, uuid, 'view_v3');
    return {
      properties: { ...(v2.properties || {}), ...(v3.properties || {}) },
      cards: { ...(v2.cards || {}), ...(v3.cards || {}) },
    };
  }
  return fetchEventForLayout(auth, uuid, view === 'v2' ? 'view_v2' : 'view_v3');
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

// Check if command is a section command
const sectionCommand = SECTIONS[command];

if (command === 'auth') {
  doAuth();
} else if (command === 'view') {
  const { flags, positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error('Usage: node crunchbase-event.mjs view <permalink|uuid> [--view=v3|v2|both]');
    process.exit(1);
  }
  const view = flags.view || 'v3';
  if (!['v3','v2','both'].includes(view)) {
    console.error(`--view must be one of: v3 (default), v2, both. Got: ${view}`);
    process.exit(1);
  }

  const auth = getSession();
  console.log(`Fetching event: ${input} (view=${view})...`);
  const data = viewEvent(auth, input, view);

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
} else if (sectionCommand) {
  // Generic section command handler
  const { flags, positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error(`Usage: node crunchbase-event.mjs ${command} <permalink|uuid> [--count=N] [--after-id=UUID]`);
    process.exit(1);
  }

  const auth = getSession();
  const count = parseInt(flags.count || String(sectionCommand.defaultCount));
  const afterId = flags['after-id'] || null;

  console.log(`Fetching ${command} for: ${input}...`);
  const data = fetchSection(auth, input, command, { count, afterId });

  const cacheFile = resolve(CACHE_DIR, `${command}-${input}-${Date.now()}.json`);
  saveJson(cacheFile, data);

  printSection(command, data, count);
  console.log(`\nCached to: ${cacheFile}`);
} else {
  console.log(`crunchbase-event — Fetch detailed event data from Crunchbase

Commands:
  auth                                         Authenticate via Chrome (one-time)
  view <permalink|uuid>                        Fetch full event details

Section commands (all support --count=N --after-id=UUID):
  speakers <permalink|uuid>                    Event speakers (name, title, org)
  sponsors <permalink|uuid>                    Event sponsors
  exhibitors <permalink|uuid>                  Event exhibitors
  contestants <permalink|uuid>                 Event contestants
  news <permalink|uuid>                        Press and news articles

Options (for section commands):
  --count=N                                    Number of results (default varies by section)
  --after-id=UUID                              Pagination cursor (UUID of last item)

Examples:
  node crunchbase-event.mjs view techcrunch-disrupt-2024
  node crunchbase-event.mjs speakers techcrunch-disrupt-2024
  node crunchbase-event.mjs sponsors web-summit-2024 --count=50
  node crunchbase-event.mjs news techcrunch-disrupt-2024 --count=20

Input formats:
  techcrunch-disrupt-2024        Event permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Event UUID

Data: ${DATA_DIR}/
  session.json     Auth session
  cache/           Event data`);
}
