#!/usr/bin/env node
// crunchbase-school.mjs — Fetch detailed school data from Crunchbase
//
// Setup:   node crunchbase-school.mjs auth
// Usage:   node crunchbase-school.mjs view <permalink|uuid>
//          node crunchbase-school.mjs alumni <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-school.mjs funding_rounds <permalink|uuid> [--count=50] [--after-id=UUID]
//          node crunchbase-school.mjs investments <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-school.mjs exits <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-school.mjs news <permalink|uuid> [--count=50] [--after-id=UUID]
//          node crunchbase-school.mjs current_employees <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-school.mjs advisors <permalink|uuid> [--count=50] [--after-id=UUID]
//          node crunchbase-school.mjs sub_organizations <permalink|uuid> [--count=50] [--after-id=UUID]
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-school');
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
    console.error('No auth found. Run: node crunchbase-school.mjs auth');
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
    console.error('Session expired. Run: node crunchbase-school.mjs auth');
    process.exit(1);
  }
  if (status === 429) {
    console.error('Rate limited (HTTP 429). Wait a few minutes.');
    process.exit(1);
  }
  if (status === 404) {
    console.error('School not found (HTTP 404).');
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

  // Search for the school by permalink
  const data = apiFetch(session, '/v4/data/searches/organization.schools?source=custom_advanced_search', {
    method: 'POST',
    body: JSON.stringify({
      field_ids: ['identifier', 'short_description'],
      query: [{ type: 'predicate', field_id: 'identifier', operator_id: 'includes', values: [permalink] }],
      collection_id: 'organization.schools',
      limit: 1,
    }),
  });

  if (!data.entities?.length) {
    throw new Error(`School not found: ${permalink}`);
  }
  return data.entities[0].uuid;
}

function resolveToPermalink(session, input) {
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  const data = apiFetch(session,
    `/v4/data/entities/organizations/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
}

// ---------------------------------------------------------------------------
// School detail
// ---------------------------------------------------------------------------

const SCHOOL_CARDS = [
  'overview_fields_extended',
  'overview_company_fields',
];

const SCHOOL_FIELDS = [
  'identifier', 'short_description', 'description', 'operating_status', 'school_type',
  'school_method', 'school_program', 'location_identifiers', 'categories',
  'num_enrollments', 'founded_on', 'website_url', 'num_alumni', 'num_founder_alumni',
  'rank_org_school',
];

function viewSchool(session, input) {
  const uuid = resolvePermalink(session, input);

  const cardIds = encodeURIComponent(JSON.stringify(SCHOOL_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(SCHOOL_FIELDS));
  const data = apiFetch(session,
    `/v4/data/entities/organizations/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}`);

  return data;
}

// ---------------------------------------------------------------------------
// Generic overrides endpoint (powers all section commands)
// ---------------------------------------------------------------------------

// Section configs: section_id -> { listCard, displayFn }
const SECTIONS = {
  alumni: {
    listCard: 'alumni_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const desc = item.short_description ? ` — ${item.short_description.substring(0, 80)}` : '';
      return `${name}${desc}`;
    },
    summary(cards) {
      const h = cards.alumni_headline || {};
      const lines = [];
      if (h.num_alumni) lines.push(`Total alumni: ${h.num_alumni}`);
      return lines;
    },
  },
  funding_rounds: {
    listCard: 'funding_rounds_list',
    defaultCount: 50,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const date = item.announced_on?.value || item.announced_on || '';
      const amount = item.money_raised?.value_usd
        ? ` $${item.money_raised.value_usd.toLocaleString()}`
        : '';
      return `${name} — ${date}${amount}`;
    },
    summary(cards) {
      const h = cards.funding_rounds_headline || {};
      const lines = [];
      if (h.num_funding_rounds) lines.push(`Total rounds: ${h.num_funding_rounds}`);
      if (h.funding_total?.value_usd) lines.push(`Total raised: $${h.funding_total.value_usd.toLocaleString()}`);
      return lines;
    },
  },
  investments: {
    listCard: 'investments_list',
    defaultCount: 100,
    display(item) {
      const org = item.organization_identifier?.value || 'Unknown';
      const round = item.funding_round_identifier?.value || '';
      const date = item.announced_on || '';
      const amount = item.funding_round_money_raised?.value_usd
        ? ` $${item.funding_round_money_raised.value_usd.toLocaleString()}`
        : '';
      const lead = item.is_lead_investor ? ' [LEAD]' : '';
      return `${org} — ${round} — ${date}${amount}${lead}`;
    },
    summary(cards) {
      const h = cards.investments_headline || {};
      const lines = [];
      if (h.num_investments) lines.push(`Total investments: ${h.num_investments}`);
      return lines;
    },
  },
  exits: {
    listCard: 'exits_image_list',
    defaultCount: 100,
    display(item) {
      const name = item.identifier?.value || 'Unknown';
      const desc = item.short_description ? ` — ${item.short_description.substring(0, 80)}` : '';
      return `${name}${desc}`;
    },
    summary(cards) {
      const h = cards.exits_headline || {};
      const lines = [];
      if (h.num_exits) lines.push(`Total exits: ${h.num_exits}`);
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
  current_employees: {
    sectionId: 'current_employees',
    listCard: 'current_employees_image_list',
    defaultCount: 100,
    display(item) {
      const person = item.person_identifier?.value || 'Unknown';
      const title = item.title || '';
      return `${person} — ${title}`;
    },
    summary(cards) {
      const h = cards.current_employees_headline || {};
      const lines = [];
      if (h.num_current_positions) lines.push(`Current employees: ${h.num_current_positions}`);
      return lines;
    },
  },
  advisors: {
    listCard: 'current_advisors_image_list',
    defaultCount: 50,
    display(item) {
      const person = item.person_identifier?.value || 'Unknown';
      const title = item.title || '';
      return `${person} — ${title}`;
    },
    summary(cards) {
      const h = cards.advisors_headline || {};
      const lines = [];
      if (h.num_current_advisor_positions) lines.push(`Current advisors: ${h.num_current_advisor_positions}`);
      return lines;
    },
  },
  sub_organizations: {
    listCard: 'sub_organizations_image_list',
    defaultCount: 50,
    display(item) {
      const name = item.ownee_identifier?.value || item.identifier?.value || 'Unknown';
      const type = item.ownership_type || '';
      return `${name}${type ? ` (${type})` : ''}`;
    },
    summary(cards) {
      const h = cards.sub_organizations_headline || {};
      const lines = [];
      if (h.num_sub_organizations) lines.push(`Sub-organizations: ${h.num_sub_organizations}`);
      return lines;
    },
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
    `/v4/data/entities/organizations/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });
}

function printSection(sectionName, data, count) {
  const config = SECTIONS[sectionName];
  const items = data.cards?.[config.listCard] || [];
  const schoolName = data.properties?.identifier?.value || '';

  console.log(`\n${schoolName} — ${sectionName.replace(/_/g, ' ')}`);

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
  const { positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error('Usage: node crunchbase-school.mjs view <permalink|uuid>');
    process.exit(1);
  }

  const session = getSession();
  console.log(`Fetching school: ${input}...`);
  const data = viewSchool(session, input);

  const cacheFile = resolve(CACHE_DIR, `view-${input}.json`);
  saveJson(cacheFile, data);

  const props = data.properties || {};
  const id = props.identifier || {};
  console.log(`\n${id.value || input}`);
  if (props.short_description) console.log(`  ${props.short_description}`);
  if (props.school_type) console.log(`  Type: ${props.school_type}`);
  if (props.school_method) console.log(`  Method: ${props.school_method}`);
  if (props.school_program) console.log(`  Program: ${props.school_program}`);
  if (props.operating_status) console.log(`  Status: ${props.operating_status}`);
  if (props.founded_on) console.log(`  Founded: ${props.founded_on.value || props.founded_on}`);
  if (props.website_url) console.log(`  Website: ${props.website_url.value || props.website_url}`);
  if (props.location_identifiers?.length) {
    console.log(`  Location: ${props.location_identifiers.map(l => l.value).join(', ')}`);
  }
  if (props.num_enrollments) console.log(`  Enrollments: ${props.num_enrollments}`);
  if (props.num_alumni) console.log(`  Alumni: ${props.num_alumni}`);
  if (props.num_founder_alumni) console.log(`  Founder Alumni: ${props.num_founder_alumni}`);
  if (props.rank_org_school) console.log(`  Rank: ${props.rank_org_school}`);
  if (props.categories?.length) {
    console.log(`  Categories: ${props.categories.map(c => c.value).join(', ')}`);
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
    console.error(`Usage: node crunchbase-school.mjs ${command} <permalink|uuid> [--count=N] [--after-id=UUID]`);
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
  console.log(`crunchbase-school — Fetch detailed school data from Crunchbase

Commands:
  auth                                         Authenticate via Chrome (one-time)
  view <permalink|uuid>                        Fetch school overview with cards

Section commands (all support --count=N --after-id=UUID):
  alumni <permalink|uuid>                      Notable alumni
  funding_rounds <permalink|uuid>              Funding rounds received
  investments <permalink|uuid>                 Portfolio investments
  exits <permalink|uuid>                       IPO and acquisition exits
  news <permalink|uuid>                        Press and news articles
  current_employees <permalink|uuid>           Current team members
  advisors <permalink|uuid>                    Advisory board members
  sub_organizations <permalink|uuid>           Owned sub-organizations

Options (for section commands):
  --count=N                                    Number of results (default varies by section)
  --after-id=UUID                              Pagination cursor (UUID of last item)

Examples:
  node crunchbase-school.mjs view stanford-university
  node crunchbase-school.mjs alumni stanford-university --count=50
  node crunchbase-school.mjs funding_rounds massachusetts-institute-of-technology
  node crunchbase-school.mjs news stanford-university --count=20
  node crunchbase-school.mjs current_employees stanford-university

Data: ${DATA_DIR}/
  session.json     Auth session
  cache/           School data`);
}
