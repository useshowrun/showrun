#!/usr/bin/env node
// crunchbase-funding-round.mjs — Fetch detailed funding round data from Crunchbase
//
// Setup:   node crunchbase-funding-round.mjs auth
// Usage:   node crunchbase-funding-round.mjs view <permalink|uuid>
//          node crunchbase-funding-round.mjs investors <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-funding-round.mjs news <permalink|uuid> [--count=50] [--after-id=UUID]
//          node crunchbase-funding-round.mjs timeline <permalink|uuid> [--count=50] [--after-id=UUID]
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
    console.error('No auth found. Run: node crunchbase-funding-round.mjs auth');
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
    console.error('Session expired. Run: node crunchbase-funding-round.mjs auth');
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('Funding round not found (HTTP 404).');
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

async function resolveToPermalink(auth, input) {
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  const data = await apiFetch(auth,
    `/v4/data/entities/funding_rounds/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
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
// Generic overrides endpoint (powers all section commands)
// ---------------------------------------------------------------------------

const SECTIONS = {
  investors: {
    listCard: 'investors_list',
    defaultCount: 100,
    display(item) {
      const name = item.investor_identifier?.value || item.identifier?.value || 'Unknown';
      return name;
    },
    summary(cards) {
      const h = cards.investors_headline || {};
      const lines = [];
      if (h.num_investors) lines.push(`Total investors: ${h.num_investors}`);
      if (h.num_partners) lines.push(`Partners: ${h.num_partners}`);
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
  timeline: {
    listCard: 'timeline',
    defaultCount: 50,
    // `timeline` exists as a card on the direct entity endpoint but not as a
    // section on the overrides endpoint — use card_ids fetch instead.
    useCardEndpoint: true,
    display(item) {
      const title = item.properties?.identifier?.value || 'Untitled';
      const kind = item.properties?.entity_def_id || '';
      const url = item.activity_properties?.url?.value || '';
      const date = item.activity_properties?.posted_on || '';
      return `[${date || kind}] ${title}${url ? `\n      ${url}` : ''}`;
    },
    summary(cards) {
      const count = cards.timeline_meta?.count;
      return count != null ? [`Timeline events: ${count}`] : [];
    },
  },
};

async function fetchSection(auth, input, sectionName, { count, afterId } = {}) {
  const config = SECTIONS[sectionName];
  if (!config) throw new Error(`Unknown section: ${sectionName}`);

  const permalink = await resolveToPermalink(auth, input);
  const limit = count || config.defaultCount;

  if (config.useCardEndpoint) {
    const uuid = await resolvePermalink(auth, input);
    const cardIds = encodeURIComponent(JSON.stringify([config.listCard]));
    const data = await apiFetch(auth,
      `/v4/data/entities/funding_rounds/${uuid}?card_ids=${cardIds}`);
    // Normalize to the shape `printSection` expects: cards[listCard] = items[]
    const card = data.cards?.[config.listCard];
    const entities = card?.entities || card || [];
    const trimmed = entities.slice(0, limit);
    return {
      properties: data.properties,
      cards: { [config.listCard]: trimmed, ...(card?.count != null ? { [config.listCard + '_meta']: { count: card.count } } : {}) },
    };
  }

  const sectionId = config.sectionId || sectionName;
  const fieldIds = encodeURIComponent(JSON.stringify(
    ['identifier', 'layout_id', 'facet_ids', 'title', 'short_description', 'is_locked']));
  const sectionIds = encodeURIComponent(JSON.stringify([sectionId]));

  const cardLookup = { card_id: config.listCard, limit };
  if (afterId) cardLookup.after_id = afterId;

  return apiFetch(auth,
    `/v4/data/entities/funding_rounds/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });
}

function printSection(sectionName, data, count) {
  const config = SECTIONS[sectionName];
  const items = data.cards?.[config.listCard] || [];
  const roundName = data.properties?.identifier?.value || '';

  console.log(`\n${roundName} — ${sectionName.replace(/_/g, ' ')}`);

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
  await doAuth();
} else if (command === 'view') {
  const { positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error('Usage: node crunchbase-funding-round.mjs view <permalink|uuid>');
    process.exit(1);
  }

  const session = getSession();
  console.log(`Fetching funding round: ${input}...`);
  const data = await viewFundingRound(session, input);

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
} else if (sectionCommand) {
  // Generic section command handler
  const { flags, positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error(`Usage: node crunchbase-funding-round.mjs ${command} <permalink|uuid> [--count=N] [--after-id=UUID]`);
    process.exit(1);
  }

  const session = getSession();
  const count = parseInt(flags.count || String(sectionCommand.defaultCount));
  const afterId = flags['after-id'] || null;

  console.log(`Fetching ${command} for: ${input}...`);
  const data = await fetchSection(session, input, command, { count, afterId });

  const cacheFile = resolve(CACHE_DIR, `${command}-${input}-${Date.now()}.json`);
  saveJson(cacheFile, data);

  printSection(command, data, count);
  console.log(`\nCached to: ${cacheFile}`);
} else {
  console.log(`crunchbase-funding-round — Fetch detailed funding round data from Crunchbase

Commands:
  auth                           Authenticate via Chrome (one-time)
  view <permalink|uuid>          Fetch full funding round details with all cards

Section commands (all support --count=N --after-id=UUID):
  investors <permalink|uuid>     Investors in this round
  news <permalink|uuid>          Press and news articles
  timeline <permalink|uuid>      Timeline events

Input formats:
  series-a--abc-company          Funding round permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...         Funding round UUID

Options (for section commands):
  --count=N                      Number of results (default varies by section)
  --after-id=UUID                Pagination cursor (UUID of last item)

Examples:
  node crunchbase-funding-round.mjs view series-a--abc-company
  node crunchbase-funding-round.mjs investors series-a--abc-company --count=50
  node crunchbase-funding-round.mjs news series-a--abc-company --count=20
  node crunchbase-funding-round.mjs timeline series-a--abc-company

Data: ${DATA_DIR}/
  session.json     Auth session
  cache/           Funding round data`);
}
