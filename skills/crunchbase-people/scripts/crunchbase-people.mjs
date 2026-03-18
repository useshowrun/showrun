#!/usr/bin/env node
// crunchbase-people.mjs — Fetch detailed people data from Crunchbase
//
// Setup:   node crunchbase-people.mjs auth
// Usage:   node crunchbase-people.mjs view <permalink|uuid>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-people');
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
    console.error('No auth found. Run: node crunchbase-people.mjs auth');
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
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-people.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Person not found.');
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

  // Search for the person by permalink
  const data = await apiFetch(auth, '/v4/data/searches/people?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'people',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Person not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

// ---------------------------------------------------------------------------
// Person detail
// ---------------------------------------------------------------------------

const PERSON_CARDS = [
  'overview_fields',
];

const PERSON_FIELDS = [
  'identifier', 'first_name', 'last_name', 'primary_job_title', 'primary_organization',
  'location_identifiers', 'short_description', 'description', 'gender', 'linkedin',
  'twitter', 'facebook', 'num_founded_organizations', 'num_investments_funding_rounds',
  'num_exits', 'num_current_jobs', 'num_past_jobs', 'born_on', 'died_on',
  'rank_person', 'current_organizations', 'attended_schools', 'featured_job',
];

async function viewPerson(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  const cardIds = encodeURIComponent(JSON.stringify(PERSON_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(PERSON_FIELDS));
  const data = await apiFetch(auth,
    `/v4/data/entities/people/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

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
      console.error('Usage: node crunchbase-people.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching person: ${input}...`);
    const data = await viewPerson(auth, input);

    const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
    saveJson(cacheFile, data);

    const props = data.properties || {};
    const id = props.identifier || {};
    const name = [props.first_name, props.last_name].filter(Boolean).join(' ') || id.value || input;
    console.log(`\n${name}`);
    if (props.primary_job_title) {
      const org = props.primary_organization?.value || '';
      console.log(`  ${props.primary_job_title}${org ? ` at ${org}` : ''}`);
    }
    if (props.short_description) console.log(`  ${props.short_description}`);
    if (props.gender) console.log(`  Gender: ${props.gender}`);
    if (props.location_identifiers?.length) {
      console.log(`  Location: ${props.location_identifiers.map(l => l.value).join(', ')}`);
    }
    if (props.born_on) console.log(`  Born: ${props.born_on.value || props.born_on}`);
    if (props.died_on) console.log(`  Died: ${props.died_on.value || props.died_on}`);
    if (props.num_founded_organizations) console.log(`  Founded Organizations: ${props.num_founded_organizations}`);
    if (props.num_investments_funding_rounds) console.log(`  Investments: ${props.num_investments_funding_rounds}`);
    if (props.num_exits) console.log(`  Exits: ${props.num_exits}`);
    if (props.num_current_jobs) console.log(`  Current Jobs: ${props.num_current_jobs}`);
    if (props.num_past_jobs) console.log(`  Past Jobs: ${props.num_past_jobs}`);
    if (props.linkedin) console.log(`  LinkedIn: ${props.linkedin.value || props.linkedin}`);
    if (props.twitter) console.log(`  Twitter: ${props.twitter.value || props.twitter}`);
    if (props.facebook) console.log(`  Facebook: ${props.facebook.value || props.facebook}`);
    if (props.rank_person) console.log(`  Rank: ${props.rank_person}`);
    if (props.current_organizations?.length) {
      console.log(`\n  Current Organizations:`);
      for (const org of props.current_organizations) {
        console.log(`    ${org.value || org}`);
      }
    }
    if (props.attended_schools?.length) {
      console.log(`\n  Schools:`);
      for (const school of props.attended_schools) {
        console.log(`    ${school.value || school}`);
      }
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`crunchbase-people — Fetch detailed people data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full person details with all cards

Input formats:
  mark-zuckerberg                Person permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Person UUID

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           People data`);
}
