#!/usr/bin/env node
// crunchbase-companies.mjs — Fetch detailed company data from Crunchbase
//
// Setup:   node crunchbase-companies.mjs auth
// Usage:   node crunchbase-companies.mjs view google
//          node crunchbase-companies.mjs view <uuid>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-companies');
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
    console.error('No auth found. Run: node crunchbase-companies.mjs auth');
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
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-companies.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Company not found.');
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

  // Search for the company by permalink
  const data = await apiFetch(auth, '/v4/data/searches/organization.companies?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'organization.companies',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Company not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

// ---------------------------------------------------------------------------
// Company detail
// ---------------------------------------------------------------------------

const COMPANY_CARDS = [
  'overview_fields_extended',
  'overview_company_fields',
  'funding_rounds_list',
  'investments_list',
  'acquisitions_list',
  'investors_list',
  'current_employees_featured_order_field',
  'overview_timeline',
  'semrush_summary',
  'technology_highlights',
];

const COMPANY_FIELDS = [
  'identifier', 'short_description', 'description', 'operating_status', 'company_type',
  'founded_on', 'closed_on', 'num_employees_enum', 'revenue_range', 'ipo_status',
  'website_url', 'facebook', 'linkedin', 'twitter', 'phone_number', 'contact_email',
  'categories', 'category_groups', 'location_identifiers', 'location_group_identifiers',
  'founder_identifiers', 'num_funding_rounds', 'funding_total', 'last_funding_at',
  'last_funding_type', 'last_funding_total', 'equity_funding_total', 'last_equity_funding_type',
  'num_investors', 'investor_identifiers', 'num_acquisitions', 'num_investments',
  'owner_identifier', 'aliases', 'legal_name', 'stock_exchange_symbol', 'stock_symbol',
  'rank_org_company', 'rank_org', 'hubs', 'num_alumni',
];

async function viewCompany(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  // Fetch entity with cards
  const cardIds = encodeURIComponent(JSON.stringify(COMPANY_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(COMPANY_FIELDS));
  const data = await apiFetch(auth,
    `/v4/data/entities/organizations/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

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
      console.error('Usage: node crunchbase-companies.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching company: ${input}...`);
    const data = await viewCompany(auth, input);

    const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
    saveJson(cacheFile, data);

    const props = data.properties || {};
    const id = props.identifier || {};
    console.log(`\n${id.value || input}`);
    if (props.short_description) console.log(`  ${props.short_description}`);
    if (props.website_url) console.log(`  Website: ${props.website_url.value || props.website_url}`);
    if (props.founded_on) console.log(`  Founded: ${props.founded_on.value || props.founded_on}`);
    if (props.location_identifiers?.length) {
      console.log(`  Location: ${props.location_identifiers.map(l => l.value).join(', ')}`);
    }
    if (props.funding_total) {
      const ft = props.funding_total;
      console.log(`  Total Funding: $${(ft.value_usd || ft.value || 0).toLocaleString()} (${props.num_funding_rounds || '?'} rounds)`);
    }
    if (props.num_employees_enum) console.log(`  Employees: ${props.num_employees_enum}`);
    if (props.operating_status) console.log(`  Status: ${props.operating_status}`);
    if (props.categories?.length) {
      console.log(`  Categories: ${props.categories.map(c => c.value).join(', ')}`);
    }

    // Show cards summary
    const cards = data.cards || {};
    if (cards.funding_rounds_list?.length) {
      console.log(`\n  Funding Rounds (${cards.funding_rounds_list.length}):`);
      for (const fr of cards.funding_rounds_list.slice(0, 5)) {
        const frId = fr.identifier || {};
        console.log(`    ${frId.value || 'Round'} — ${fr.announced_on?.value || fr.announced_on || ''} — $${(fr.money_raised?.value_usd || 0).toLocaleString()}`);
      }
    }
    if (cards.acquisitions_list?.length) {
      console.log(`\n  Acquisitions (${cards.acquisitions_list.length}):`);
      for (const a of cards.acquisitions_list.slice(0, 5)) {
        console.log(`    ${a.acquiree_identifier?.value || 'Unknown'} — ${a.announced_on?.value || a.announced_on || ''}`);
      }
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`crunchbase-companies — Fetch detailed company data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full company details with all cards

Input formats:
  google                         Company permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Company UUID

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Company data`);
}
