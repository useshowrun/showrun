#!/usr/bin/env node
// crunchbase-investor.mjs — Fetch detailed investor data from Crunchbase
//
// Setup:   node crunchbase-investor.mjs auth
// Usage:   node crunchbase-investor.mjs view <permalink|uuid>
//          node crunchbase-investor.mjs investments <permalink|uuid> [--count=100] [--after-id=UUID]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-investor');
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
    console.error('No auth found. Run: node crunchbase-investor.mjs auth');
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
    if (resp.status === 401 || resp.status === 403) console.error('Session expired. Run: node crunchbase-investor.mjs auth');
    else if (resp.status === 429) console.error('Rate limited. Wait a few minutes.');
    else if (resp.status === 404) console.error('Investor not found.');
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

  // Search for the investor by permalink
  const data = await apiFetch(auth, '/v4/data/searches/principal.investors?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'principal.investors',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`Investor not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

// ---------------------------------------------------------------------------
// Investor detail
// ---------------------------------------------------------------------------

const INVESTOR_CARDS = [
  'overview_fields_extended',
  'investments_list',
  'overview_company_fields',
  'funding_rounds_list',
];

const INVESTOR_FIELDS = [
  'identifier', 'short_description', 'investor_type', 'investor_stage',
  'num_investments_funding_rounds', 'num_exits', 'num_portfolio_organizations',
  'num_lead_investments', 'funding_total', 'location_identifiers', 'categories',
  'num_funds', 'funds_total', 'num_exits_ipo',
];

async function viewInvestor(auth, input) {
  const uuid = await resolvePermalink(auth, input);

  const cardIds = encodeURIComponent(JSON.stringify(INVESTOR_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(INVESTOR_FIELDS));
  const data = await apiFetch(auth,
    `/v4/data/entities/organizations/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

  return data;
}

// ---------------------------------------------------------------------------
// Investments list (paginated via overrides endpoint)
// ---------------------------------------------------------------------------

async function resolveToPermalink(auth, input) {
  // If it's already a permalink (no dashes pattern of UUID), use directly
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  // Resolve UUID to permalink via entity lookup
  const data = await apiFetch(auth,
    `/v4/data/entities/organizations/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
}

async function fetchInvestments(auth, input, { count = 100, afterId = null } = {}) {
  const permalink = await resolveToPermalink(auth, input);

  const fieldIds = encodeURIComponent(JSON.stringify(
    ['identifier', 'layout_id', 'facet_ids', 'title', 'short_description', 'is_locked']));
  const sectionIds = encodeURIComponent(JSON.stringify(['investments']));

  const cardLookup = { card_id: 'investments_list', limit: count };
  if (afterId) cardLookup.after_id = afterId;

  const data = await apiFetch(auth,
    `/v4/data/entities/organizations/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });

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
      console.error('Usage: node crunchbase-investor.mjs view <permalink|uuid>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching investor: ${input}...`);
    const data = await viewInvestor(auth, input);

    const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
    saveJson(cacheFile, data);

    const props = data.properties || {};
    const id = props.identifier || {};
    console.log(`\n${id.value || input}`);
    if (props.short_description) console.log(`  ${props.short_description}`);
    if (props.investor_type?.length) console.log(`  Investor Type: ${props.investor_type.join(', ')}`);
    if (props.investor_stage?.length) console.log(`  Stage: ${props.investor_stage.join(', ')}`);
    if (props.location_identifiers?.length) {
      console.log(`  Location: ${props.location_identifiers.map(l => l.value).join(', ')}`);
    }
    if (props.num_investments_funding_rounds) console.log(`  Investments: ${props.num_investments_funding_rounds}`);
    if (props.num_lead_investments) console.log(`  Lead Investments: ${props.num_lead_investments}`);
    if (props.num_portfolio_organizations) console.log(`  Portfolio Orgs: ${props.num_portfolio_organizations}`);
    if (props.num_exits) console.log(`  Exits: ${props.num_exits}`);
    if (props.num_exits_ipo) console.log(`  IPO Exits: ${props.num_exits_ipo}`);
    if (props.num_funds) console.log(`  Funds: ${props.num_funds}`);
    if (props.funds_total) {
      const ft = props.funds_total;
      console.log(`  Funds Total: $${(ft.value_usd || ft.value || 0).toLocaleString()}`);
    }
    if (props.funding_total) {
      const ft = props.funding_total;
      console.log(`  Funding Total: $${(ft.value_usd || ft.value || 0).toLocaleString()}`);
    }
    if (props.categories?.length) {
      console.log(`  Categories: ${props.categories.map(c => c.value).join(', ')}`);
    }

    // Show cards summary
    const cards = data.cards || {};
    if (cards.investments_list?.length) {
      console.log(`\n  Recent Investments (${cards.investments_list.length}):`);
      for (const inv of cards.investments_list.slice(0, 10)) {
        const org = inv.organization_identifier || inv.funding_round_identifier || {};
        console.log(`    ${org.value || 'Unknown'} — ${inv.announced_on?.value || inv.announced_on || ''}`);
      }
    }
    if (cards.funding_rounds_list?.length) {
      console.log(`\n  Funding Rounds (${cards.funding_rounds_list.length}):`);
      for (const fr of cards.funding_rounds_list.slice(0, 5)) {
        const frId = fr.identifier || {};
        console.log(`    ${frId.value || 'Round'} — ${fr.announced_on?.value || fr.announced_on || ''} — $${(fr.money_raised?.value_usd || 0).toLocaleString()}`);
      }
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  case 'investments': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node crunchbase-investor.mjs investments <permalink|uuid> [--count=100] [--after-id=UUID]');
      process.exit(1);
    }

    const auth = getAuth();
    const count = parseInt(flags.count || '100');
    const afterId = flags['after-id'] || null;

    console.log(`Fetching investments for: ${input}...`);
    const data = await fetchInvestments(auth, input, { count, afterId });

    const cacheFile = resolve(CACHE_DIR, `investments-${input}-${Date.now()}.json`);
    saveJson(cacheFile, data);

    const investments = data.cards?.investments_list || [];
    const summary = data.cards?.investments_headline || {};
    const invSummary = data.cards?.investments_summary || {};

    console.log(`\n${data.properties?.identifier?.value || input} — Investments`);
    if (summary.num_investments) console.log(`  Total investments: ${summary.num_investments}`);
    if (summary.num_lead_investments) console.log(`  Lead investments: ${summary.num_lead_investments}`);
    if (summary.num_portfolio_organizations) console.log(`  Portfolio orgs: ${summary.num_portfolio_organizations}`);

    console.log(`\n  Showing ${investments.length} investments:\n`);
    for (const inv of investments) {
      const org = inv.organization_identifier?.value || 'Unknown';
      const round = inv.funding_round_identifier?.value || '';
      const date = inv.announced_on || '';
      const amount = inv.funding_round_money_raised?.value_usd
        ? `$${inv.funding_round_money_raised.value_usd.toLocaleString()}`
        : '';
      const lead = inv.is_lead_investor ? ' [LEAD]' : '';
      console.log(`    ${org} — ${round} — ${date} ${amount}${lead}`);
    }

    if (investments.length === count) {
      const lastId = investments[investments.length - 1]?.identifier?.uuid;
      if (lastId) {
        console.log(`\n  More results available. Use --after-id=${lastId} to get next page.`);
      }
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  default:
    console.log(`crunchbase-investor — Fetch detailed investor data from Crunchbase

Commands:
  auth                                         Authenticate via Chrome (one-time)
  view <permalink|uuid>                        Fetch full investor details with all cards
  investments <permalink|uuid> [options]       Fetch paginated investments list

Investment options:
  --count=N                                    Number of results (default: 100)
  --after-id=UUID                              Pagination cursor (UUID of last investment)

Examples:
  node crunchbase-investor.mjs view y-combinator
  node crunchbase-investor.mjs investments y-combinator --count=50
  node crunchbase-investor.mjs investments y-combinator --after-id=<uuid>

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Investor data`);
}
