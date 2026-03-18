#!/usr/bin/env node
// crunchbase-acquisition.mjs — Fetch detailed acquisition data from Crunchbase
//
// Setup:   node crunchbase-acquisition.mjs auth
// Usage:   node crunchbase-acquisition.mjs view <permalink|uuid>
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
    console.error('No auth found. Run: node crunchbase-acquisition.mjs auth');
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
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-acquisition.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Acquisition not found.');
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

  // Search for the acquisition by permalink
  const data = await apiFetch(auth, '/v4/data/searches/acquisitions?source=custom_advanced_search', {
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

async function viewAcquisition(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  const cardIds = encodeURIComponent(JSON.stringify(ACQUISITION_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(ACQUISITION_FIELDS));
  const data = await apiFetch(auth,
    `/v4/data/entities/acquisitions/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

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
      console.error('Usage: node crunchbase-acquisition.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching acquisition: ${input}...`);
    const data = await viewAcquisition(auth, input);

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
    break;
  }

  default:
    console.log(`crunchbase-acquisition — Fetch detailed acquisition data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full acquisition details with all cards

Input formats:
  google-acquires-fitbit         Acquisition permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Acquisition UUID

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Acquisition data`);
}
