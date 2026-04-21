#!/usr/bin/env node
// crunchbase-people.mjs — Fetch detailed people data from Crunchbase
//
// Setup:   node crunchbase-people.mjs auth
// Usage:   node crunchbase-people.mjs view <permalink|uuid>
//          node crunchbase-people.mjs investments <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-people.mjs exits <permalink|uuid> [--count=100] [--after-id=UUID]
//          node crunchbase-people.mjs education <permalink|uuid> [--count=50] [--after-id=UUID]
//          node crunchbase-people.mjs news <permalink|uuid> [--count=50] [--after-id=UUID]
//
// Requires Node 22+ and Chrome with crunchbase.com open.

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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

function findCrunchbaseTab() {
  const list = cdp('list');
  for (const line of list.split('\n')) {
    if (line.includes('crunchbase.com')) return line.trim().split(/\s+/)[0];
  }
  return null;
}

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

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.crunchbase.com'] }));
  const { cookies } = JSON.parse(raw);
  const hasTrust = cookies.some(c => c.name === 'trustcookie');
  if (!hasTrust) throw new Error('trustcookie not found. Are you logged in?');

  saveJson(SESSION_FILE, { capturedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getSession() {
  const session = loadJson(SESSION_FILE);
  if (!session.capturedAt) {
    console.error('No auth found. Run: node crunchbase-people.mjs auth');
    process.exit(1);
  }
  return session;
}

function apiFetch(session, url, options = {}) {
  const target = findCrunchbaseTab();
  if (!target) { console.error('No Crunchbase tab found. Open crunchbase.com in Chrome.'); process.exit(1); }
  const { status, body } = cdpFetch(target, url, options);
  if (status === 401 || status === 403) { console.error('Session expired. Run auth.'); process.exit(1); }
  if (status === 429) { console.error('Rate limited (HTTP 429). Wait a few minutes.'); process.exit(1); }
  if (status === 404) { console.error('Not found (HTTP 404).'); process.exit(1); }
  let data; try { data = JSON.parse(body); } catch { data = body; }
  if (status < 200 || status >= 300) { console.error(`HTTP ${status}: ${JSON.stringify(data).substring(0, 300)}`); process.exit(1); }
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

  // Search for the person by permalink
  const data = apiFetch(session, '/v4/data/searches/people?source=custom_advanced_search', {
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
// Resolve UUID -> permalink (for overrides endpoint)
// ---------------------------------------------------------------------------

function resolveToPermalink(session, input) {
  if (!input.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
    return input;
  }
  const data = apiFetch(session,
    `/v4/data/entities/people/${input}?field_ids=${encodeURIComponent('["identifier"]')}`);
  return data.properties?.identifier?.permalink || input;
}

// ---------------------------------------------------------------------------
// Generic overrides endpoint (powers all section commands)
// ---------------------------------------------------------------------------

const SECTIONS = {
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
  education: {
    listCard: 'education_image_list',
    defaultCount: 50,
    // Crunchbase rejects a `limit` on this card ("could not override limit").
    noLimit: true,
    display(item) {
      const degree = item.type_name || '';
      const subject = item.subject || '';
      const school = item.school_identifier?.value || 'Unknown';
      const year = item.completed_on?.value || item.completed_on || '';
      const parts = [degree, subject].filter(Boolean).join(' ');
      return `${parts ? parts + ' @ ' : ''}${school}${year ? ` (${year})` : ''}`;
    },
    summary(cards) {
      const h = cards.education_summary || {};
      return [];
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

function fetchSection(session, input, sectionName, { count, afterId } = {}) {
  const config = SECTIONS[sectionName];
  if (!config) throw new Error(`Unknown section: ${sectionName}`);

  const permalink = resolveToPermalink(session, input);
  const sectionId = config.sectionId || sectionName;
  const limit = count || config.defaultCount;

  const fieldIds = encodeURIComponent(JSON.stringify(
    ['identifier', 'layout_id', 'facet_ids', 'title', 'short_description', 'is_locked']));
  const sectionIds = encodeURIComponent(JSON.stringify([sectionId]));

  const cardLookup = { card_id: config.listCard };
  if (!config.noLimit) cardLookup.limit = limit;
  if (afterId) cardLookup.after_id = afterId;

  return apiFetch(session,
    `/v4/data/entities/people/${permalink}/overrides?field_ids=${fieldIds}&section_ids=${sectionIds}`, {
      method: 'POST',
      body: JSON.stringify({ card_lookups: [cardLookup] }),
    });
}

function printSection(sectionName, data, count) {
  const config = SECTIONS[sectionName];
  const items = data.cards?.[config.listCard] || [];
  const personName = data.properties?.identifier?.value || '';

  console.log(`\n${personName} — ${sectionName.replace(/_/g, ' ')}`);

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
// Person detail
// ---------------------------------------------------------------------------

// `layout_mode=view_v3` (sent below in viewPerson) triggers the server's
// full profile-page layout for people (~31 cards: bio, investments, exits,
// education, news, predictions, etc.). This list is additive — use it for
// any card that isn't in the view_v3 default set.
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

function viewPerson(session, input) {
  const uuid = resolvePermalink(session, input);

  const cardIds = encodeURIComponent(JSON.stringify(PERSON_CARDS));
  const fieldIds = encodeURIComponent(JSON.stringify(PERSON_FIELDS));
  const data = apiFetch(session,
    `/v4/data/entities/people/${uuid}?card_ids=${cardIds}&field_ids=${fieldIds}&layout_mode=view_v3`);

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

// Check if command is a section command
const sectionCommand = SECTIONS[command];

if (command === 'auth') {
  doAuth();
} else if (command === 'view') {
  const { positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error('Usage: node crunchbase-people.mjs view <permalink|uuid>');
    process.exit(1);
  }

  const session = getSession();
  console.log(`Fetching person: ${input}...`);
  const data = viewPerson(session, input);

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
} else if (sectionCommand) {
  // Generic section command handler
  const { flags, positional } = parseFlags(args);
  const input = positional[0];
  if (!input) {
    console.error(`Usage: node crunchbase-people.mjs ${command} <permalink|uuid> [--count=N] [--after-id=UUID]`);
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
  console.log(`crunchbase-people — Fetch detailed people data from Crunchbase

Commands:
  auth                                         Authenticate via Chrome (one-time)
  view <permalink|uuid>                        Fetch full person details with all cards

Section commands (all support --count=N --after-id=UUID):
  investments <permalink|uuid>                 Personal investments (org, round, amount, lead)
  exits <permalink|uuid>                       IPO and acquisition exits
  education <permalink|uuid>                   Education history (degree, school, year)
  news <permalink|uuid>                        Press and news articles

Options (for section commands):
  --count=N                                    Number of results (default varies by section)
  --after-id=UUID                              Pagination cursor (UUID of last item)

Input formats:
  mark-zuckerberg                              Person permalink (from Crunchbase URL)
  6acfa7da-1dbd-936e-...                       Person UUID

Examples:
  node crunchbase-people.mjs view mark-zuckerberg
  node crunchbase-people.mjs investments marc-andreessen --count=50
  node crunchbase-people.mjs exits elon-musk
  node crunchbase-people.mjs education mark-zuckerberg
  node crunchbase-people.mjs news elon-musk --count=20

Data: ${DATA_DIR}/
  session.json     Auth session
  cache/           People data`);
}
