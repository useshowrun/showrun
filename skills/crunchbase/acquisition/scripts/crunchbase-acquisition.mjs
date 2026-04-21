#!/usr/bin/env node
// crunchbase-acquisition.mjs — Fetch detailed acquisition data from Crunchbase
//
// Setup:   node crunchbase-acquisition.mjs auth
// Usage:   node crunchbase-acquisition.mjs view <permalink|uuid>
//          node crunchbase-acquisition.mjs news <permalink|uuid> [--count=50] [--after-id=UUID]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-acquisition');
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
    console.error('No auth found. Run: node crunchbase-acquisition.mjs auth');
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
    console.error('Session expired. Run: node crunchbase-acquisition.mjs auth');
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('Not found (HTTP 404).');
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

function resolvePermalink(session, permalink) {
  // If it looks like a UUID, return it directly
  if (permalink.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return permalink;
  }

  // Search for the acquisition by permalink
  const data = apiFetch(session, '/v4/data/searches/acquisitions?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'acquisitions',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Acquisition not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

function resolveToPermalink(session, input) {
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  const data = apiFetch(session,
    `/v4/data/entities/acquisitions/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
}

// ---------------------------------------------------------------------------
// Acquisition detail
// ---------------------------------------------------------------------------

const ACQUISITION_CARDS = [
  'overview_fields',
];

const ACQUISITION_FIELDS = [
  'identifier', 'acquiree_identifier', 'acquirer_identifier', 'announced_on',
  'price', 'acquisition_type', 'status', 'terms', 'disposition_of_acquired',
  'completed_on', 'acquiree_categories', 'acquirer_categories',
  'acquiree_short_description', 'acquirer_short_description', 'acquiree_locations',
  'acquirer_locations', 'short_description', 'acquiree_funding_total',
  'acquirer_funding_total', 'acquiree_num_funding_rounds', 'acquirer_num_funding_rounds',
];

function fetchAcquisitionForLayout(session, uuid, layout) {
  const cardIds = encodeURIComponent(JSON.stringify(ACQUISITION_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(ACQUISITION_FIELDS));
  return apiFetch(session,
    `/v4/data/entities/acquisitions/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}&layout_mode=${layout}`);
}
function viewAcquisition(session, input, view = 'v3') {
  const uuid = resolvePermalink(session, input);
  if (view === 'both') {
    const v2 = fetchAcquisitionForLayout(session, uuid, 'view_v2');
    const v3 = fetchAcquisitionForLayout(session, uuid, 'view_v3');
    return {
      properties: { ...(v2.properties || {}), ...(v3.properties || {}) },
      cards: { ...(v2.cards || {}), ...(v3.cards || {}) },
    };
  }
  return fetchAcquisitionForLayout(session, uuid, view === 'v2' ? 'view_v2' : 'view_v3');
}

// ---------------------------------------------------------------------------
// Generic overrides endpoint (powers all section commands)
// ---------------------------------------------------------------------------

// Section configs: section_id -> { listCard, displayFn }
const SECTIONS = {
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

function fetchSection(session, input, sectionName, { count, afterId } = {}) {
  const config = SECTIONS[sectionName];
  if (!config) throw new Error(`Unknown section: ${sectionName}`);

  const permalink = resolveToPermalink(session, input);
  const sectionId = config.sectionId || sectionName;
  const limit = count || config.defaultCount;

  const fieldIds = encodeURIComponent(JSON.stringify(
    ['identifier', 'layout_id', 'facet_ids', 'title', 'short_description', 'is_locked']));
  const sectionIds = encodeURIComponent(JSON.stringify([sectionId]));

  const cardLookup = { card_id: config.listCard, limit };
  if (afterId) cardLookup.after_id = afterId;

  return apiFetch(session,
    `/v4/data/entities/acquisitions/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });
}

function printSection(sectionName, data, count) {
  const config = SECTIONS[sectionName];
  const items = data.cards?.[config.listCard] || [];
  const acquisitionName = data.properties?.identifier?.value || '';

  console.log(`\n${acquisitionName} — ${sectionName.replace(/_/g, ' ')}`);

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
    console.error('Usage: node crunchbase-acquisition.mjs view <permalink|uuid> [--view=v3|v2|both]');
    process.exit(1);
  }
  const view = flags.view || 'v3';
  if (!['v3','v2','both'].includes(view)) {
    console.error(`--view must be one of: v3 (default), v2, both. Got: ${view}`);
    process.exit(1);
  }

  const session = getSession();
  console.log(`Fetching acquisition: ${input} (view=${view})...`);
  const data = viewAcquisition(session, input, view);

  const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
  saveJson(cacheFile, data);

  const props = data.properties || {};
  const id = props.identifier || {};
  console.log(`\n${id.value || input}`);
  if (props.short_description) console.log(`  ${props.short_description}`);

  if (props.acquirer_identifier) {
    console.log(`  Acquirer: ${props.acquirer_identifier.value || props.acquirer_identifier}`);
  }
  if (props.acquirer_short_description) console.log(`    ${props.acquirer_short_description}`);
  if (props.acquirer_locations?.length) {
    console.log(`    Location: ${props.acquirer_locations.map(l => l.value).join(', ')}`);
  }
  if (props.acquirer_funding_total) {
    const ft = props.acquirer_funding_total;
    console.log(`    Total Funding: $${(ft.value_usd || ft.value || 0).toLocaleString()} (${props.acquirer_num_funding_rounds || '?'} rounds)`);
  }

  if (props.acquiree_identifier) {
    console.log(`  Acquiree: ${props.acquiree_identifier.value || props.acquiree_identifier}`);
  }
  if (props.acquiree_short_description) console.log(`    ${props.acquiree_short_description}`);
  if (props.acquiree_locations?.length) {
    console.log(`    Location: ${props.acquiree_locations.map(l => l.value).join(', ')}`);
  }
  if (props.acquiree_funding_total) {
    const ft = props.acquiree_funding_total;
    console.log(`    Total Funding: $${(ft.value_usd || ft.value || 0).toLocaleString()} (${props.acquiree_num_funding_rounds || '?'} rounds)`);
  }

  if (props.announced_on) console.log(`  Announced: ${props.announced_on.value || props.announced_on}`);
  if (props.completed_on) console.log(`  Completed: ${props.completed_on.value || props.completed_on}`);
  if (props.price) {
    const p = props.price;
    console.log(`  Price: $${(p.value_usd || p.value || 0).toLocaleString()}`);
  }
  if (props.acquisition_type) console.log(`  Type: ${props.acquisition_type}`);
  if (props.status) console.log(`  Status: ${props.status}`);
  if (props.terms) console.log(`  Terms: ${props.terms}`);
  if (props.disposition_of_acquired) console.log(`  Disposition: ${props.disposition_of_acquired}`);
  if (props.acquiree_categories?.length) {
    console.log(`  Acquiree Categories: ${props.acquiree_categories.map(c => c.value).join(', ')}`);
  }
  if (props.acquirer_categories?.length) {
    console.log(`  Acquirer Categories: ${props.acquirer_categories.map(c => c.value).join(', ')}`);
  }

  console.log(`\nCached to: ${cacheFile}`);
} else if (sectionCommand) {
  // Generic section command handler
  const { flags, positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error(`Usage: node crunchbase-acquisition.mjs ${command} <permalink|uuid> [--count=N] [--after-id=UUID]`);
    process.exit(1);
  }

  const session = getSession();
  const count = parseInt(flags.count || String(sectionCommand.defaultCount));
  const afterId = flags['after-id'] || null;

  console.log(`Fetching ${command} for: ${input}...`);
  const data = fetchSection(session, input, command, { count, afterId });

  const cacheFile = resolve(CACHE_DIR, `${command}-${input}-${Date.now()}.json`);
  saveJson(cacheFile, data);

  printSection(command, data, count);
  console.log(`\nCached to: ${cacheFile}`);
} else {
  console.log(`crunchbase-acquisition — Fetch detailed acquisition data from Crunchbase

Commands:
  auth                                         Authenticate via Chrome (one-time)
  view <permalink|uuid>                        Fetch acquisition overview with cards

Section commands (all support --count=N --after-id=UUID):
  news <permalink|uuid>                        Press and news articles

Options (for section commands):
  --count=N                                    Number of results (default varies by section)
  --after-id=UUID                              Pagination cursor (UUID of last item)

Examples:
  node crunchbase-acquisition.mjs view google-acquires-fitbit
  node crunchbase-acquisition.mjs news google-acquires-fitbit --count=20

Data: ${DATA_DIR}/
  session.json     Auth session
  cache/           Acquisition data`);
}
