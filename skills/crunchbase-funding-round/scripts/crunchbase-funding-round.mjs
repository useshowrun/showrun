#!/usr/bin/env node
// crunchbase-funding-round.mjs — Fetch detailed funding round data from Crunchbase
//
// Setup:   node crunchbase-funding-round.mjs auth
// Usage:   node crunchbase-funding-round.mjs view <permalink|uuid>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-funding-round');
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
    console.error('No auth found. Run: node crunchbase-funding-round.mjs auth');
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
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-funding-round.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Funding round not found.');
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

  // Search for the funding round by permalink
  const data = await apiFetch(auth, '/v4/data/searches/funding_rounds?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'funding_rounds',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Funding round not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

// ---------------------------------------------------------------------------
// Funding round detail
// ---------------------------------------------------------------------------

const FUNDING_ROUND_CARDS = [
  'investors_list',
];

const FUNDING_ROUND_FIELDS = [
  'identifier', 'funded_organization_identifier', 'money_raised', 'investment_type',
  'announced_on', 'investor_identifiers', 'num_investors', 'lead_investor_identifiers',
  'pre_money_valuation', 'post_money_valuation', 'short_description', 'closed_on',
  'target_money_raised', 'is_equity',
];

async function viewFundingRound(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  const cardIds = encodeURIComponent(JSON.stringify(FUNDING_ROUND_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(FUNDING_ROUND_FIELDS));
  const data = await apiFetch(auth,
    `/v4/data/entities/funding_rounds/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

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
      console.error('Usage: node crunchbase-funding-round.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching funding round: ${input}...`);
    const data = await viewFundingRound(auth, input);

    const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
    saveJson(cacheFile, data);

    const props = data.properties || {};
    const id = props.identifier || {};
    console.log(`\n${id.value || input}`);
    if (props.short_description) console.log(`  ${props.short_description}`);
    if (props.funded_organization_identifier) {
      console.log(`  Organization: ${props.funded_organization_identifier.value || props.funded_organization_identifier}`);
    }
    if (props.investment_type) console.log(`  Type: ${props.investment_type}`);
    if (props.announced_on) console.log(`  Announced: ${props.announced_on.value || props.announced_on}`);
    if (props.closed_on) console.log(`  Closed: ${props.closed_on.value || props.closed_on}`);
    if (props.money_raised) {
      const mr = props.money_raised;
      console.log(`  Money Raised: $${(mr.value_usd || mr.value || 0).toLocaleString()}`);
    }
    if (props.target_money_raised) {
      const tm = props.target_money_raised;
      console.log(`  Target: $${(tm.value_usd || tm.value || 0).toLocaleString()}`);
    }
    if (props.pre_money_valuation) {
      const pmv = props.pre_money_valuation;
      console.log(`  Pre-Money Valuation: $${(pmv.value_usd || pmv.value || 0).toLocaleString()}`);
    }
    if (props.post_money_valuation) {
      const pmv = props.post_money_valuation;
      console.log(`  Post-Money Valuation: $${(pmv.value_usd || pmv.value || 0).toLocaleString()}`);
    }
    if (props.num_investors) console.log(`  Investors: ${props.num_investors}`);
    if (props.is_equity != null) console.log(`  Equity: ${props.is_equity}`);
    if (props.lead_investor_identifiers?.length) {
      console.log(`  Lead Investors: ${props.lead_investor_identifiers.map(i => i.value).join(', ')}`);
    }
    if (props.investor_identifiers?.length) {
      console.log(`  All Investors: ${props.investor_identifiers.map(i => i.value).join(', ')}`);
    }

    // Show cards summary
    const cards = data.cards || {};
    if (cards.investors_list?.length) {
      console.log(`\n  Investors (${cards.investors_list.length}):`);
      for (const inv of cards.investors_list.slice(0, 10)) {
        const invId = inv.investor_identifier || inv.identifier || {};
        console.log(`    ${invId.value || 'Unknown'}${inv.is_lead_investor ? ' (Lead)' : ''}`);
      }
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`crunchbase-funding-round — Fetch detailed funding round data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full funding round details with all cards

Input formats:
  series-a--abc-company          Funding round permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Funding round UUID

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Funding round data`);
}
