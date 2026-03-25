#!/usr/bin/env node
// crunchbase-advanced-search.mjs — Advanced search across all Crunchbase entity types
//
// Setup:   node crunchbase-advanced-search.mjs auth
// Usage:   node crunchbase-advanced-search.mjs search companies --query='[{"type":"predicate","field_id":"categories","operator_id":"includes","values":["artificial-intelligence"]}]'
//          node crunchbase-advanced-search.mjs search funding_rounds --count=10
//          node crunchbase-advanced-search.mjs fields companies
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/crunchbase-advanced-search');
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
// Collection IDs and default field_ids per entity type
// ---------------------------------------------------------------------------

const COLLECTIONS = {
  companies: {
    collection_id: 'organization.companies',
    field_ids: ['identifier', 'short_description', 'operating_status', 'company_type',
      'last_funding_at', 'last_funding_type', 'categories', 'location_identifiers',
      'rank_org_company', 'founded_on', 'num_employees_enum', 'funding_total',
      'num_funding_rounds', 'investor_identifiers', 'revenue_range', 'website_url',
      'founder_identifiers', 'ipo_status', 'num_acquisitions'],
    order: [{ field_id: 'rank_org_company', sort: 'asc' }],
  },
  people: {
    collection_id: 'people',
    field_ids: ['identifier', 'first_name', 'last_name', 'primary_job_title',
      'primary_organization', 'location_identifiers', 'rank_person',
      'num_founded_organizations', 'num_investments_funding_rounds', 'gender',
      'linkedin', 'short_description'],
    order: [{ field_id: 'rank_person', sort: 'asc' }],
  },
  investors: {
    collection_id: 'principal.investors',
    field_ids: ['identifier', 'num_investments_funding_rounds', 'num_exits',
      'location_identifiers', 'investor_type', 'investor_stage',
      'num_portfolio_organizations', 'num_lead_investments', 'num_diversity_spotlight_investments',
      'short_description', 'rank_principal_investor', 'funding_total'],
    order: [{ field_id: 'num_investments_funding_rounds', sort: 'desc' }],
  },
  funding_rounds: {
    collection_id: 'funding_rounds',
    field_ids: ['identifier', 'funded_organization_identifier', 'investor_identifiers',
      'investment_type', 'money_raised', 'announced_on', 'num_investors',
      'lead_investor_identifiers', 'pre_money_valuation', 'funded_organization_categories',
      'funded_organization_location', 'short_description'],
    order: [{ field_id: 'announced_on', sort: 'desc' }],
  },
  acquisitions: {
    collection_id: 'acquisitions',
    field_ids: ['identifier', 'acquiree_identifier', 'acquirer_identifier',
      'announced_on', 'price', 'acquisition_type', 'status', 'terms',
      'acquiree_categories', 'acquirer_categories', 'acquiree_locations', 'acquirer_locations',
      'short_description'],
    order: [{ field_id: 'announced_on', sort: 'desc' }],
  },
  schools: {
    collection_id: 'organization.schools',
    field_ids: ['identifier', 'short_description', 'operating_status', 'school_type',
      'school_method', 'school_program', 'location_identifiers', 'categories',
      'num_enrollments', 'rank_org_school', 'founded_on', 'website_url',
      'num_alumni', 'num_founder_alumni'],
    order: [{ field_id: 'rank_org_school', sort: 'asc' }],
  },
  events: {
    collection_id: 'events',
    field_ids: ['identifier', 'starts_on', 'ends_on', 'location_identifiers',
      'short_description', 'event_url', 'venue_name', 'categories',
      'num_speakers', 'num_sponsors', 'num_exhibitors', 'num_contestants',
      'organizer_identifiers', 'rank_event', 'event_type'],
    order: [{ field_id: 'starts_on', sort: 'desc' }],
  },
};

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome Crunchbase tab
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

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.crunchbase.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieStr = cookies
    .filter(c => c.domain.includes('crunchbase.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  if (!cookieMap['trustcookie']) throw new Error('trustcookie not found. Are you logged in to Crunchbase?');

  // Get user agent
  const userAgent = cdp('eval', target, 'navigator.userAgent');

  // Get the x-cb-client-app-instance-id if present
  const appInstanceId = cdp('eval', target,
    'document.cookie.match(/cb_client_app_instance_id=([^;]+)/)?.[1] || crypto.randomUUID()');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userAgent,
    appInstanceId,
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
    console.error('No auth found. Run: node crunchbase-advanced-search.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-cb-client-app-instance-id': auth.appInstanceId || '',
    'cookie': auth.cookie,
    'user-agent': auth.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node crunchbase-advanced-search.mjs auth');
    } else if (resp.status === 429) {
      console.error('Rate limited. Wait a few minutes and try again.');
    } else if (resp.status === 404) {
      console.error('Not found. Check your entity type or query parameters.');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function doSearch(entityType, { query = [], count = 15, afterId = null, fieldIds = null, order = null } = {}) {
  const config = COLLECTIONS[entityType];
  if (!config) {
    console.error(`Unknown entity type: ${entityType}`);
    console.error(`Available types: ${Object.keys(COLLECTIONS).join(', ')}`);
    process.exit(1);
  }

  const auth = getAuth();
  const body = {
    field_ids: fieldIds || config.field_ids,
    order: order || config.order,
    query,
    field_aggregators: [],
    collection_id: config.collection_id,
    limit: count,
  };
  if (afterId) body.after_id = afterId;

  const data = await apiFetch(auth, `/v4/data/searches/${config.collection_id}?source=custom_advanced_search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return data;
}

// ---------------------------------------------------------------------------
// List available fields
// ---------------------------------------------------------------------------

async function listFields(entityType) {
  const auth = getAuth();
  const data = await apiFetch(auth, '/v4/md/applications/crunchbase?lang=en');

  // Map entity type to entity_def id
  const defMap = {
    companies: 'organization',
    people: 'person',
    investors: 'organization', // investors use organization entity def
    funding_rounds: 'funding_round',
    acquisitions: 'acquisition',
    schools: 'organization',
    events: 'event',
  };

  const defId = defMap[entityType] || entityType;
  const entityDef = data.entity_defs?.find(e => e.id === defId);
  if (!entityDef) {
    console.error(`No entity definition found for: ${defId}`);
    process.exit(1);
  }

  return entityDef.fields.map(f => ({
    id: f.id,
    label: f.label,
    type: f.type,
  }));
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

  case 'search': {
    const { flags, positional } = parseFlags(args);
    const entityType = positional[0];
    if (!entityType) {
      console.error('Usage: node crunchbase-advanced-search.mjs search <entity-type> [options]');
      console.error(`Entity types: ${Object.keys(COLLECTIONS).join(', ')}`);
      process.exit(1);
    }

    let query = [];
    if (flags.query) {
      try { query = JSON.parse(flags.query); } catch (e) {
        console.error('Invalid --query JSON:', e.message);
        process.exit(1);
      }
    }

    const count = parseInt(flags.count || '15');
    const afterId = flags['after-id'] || null;
    let fieldIds = null;
    if (flags['field-ids']) {
      try { fieldIds = JSON.parse(flags['field-ids']); } catch {
        fieldIds = flags['field-ids'].split(',');
      }
    }
    let order = null;
    if (flags.order) {
      try { order = JSON.parse(flags.order); } catch {
        const [field_id, sort = 'asc'] = flags.order.split(':');
        order = [{ field_id, sort }];
      }
    }

    const data = await doSearch(entityType, { query, count, afterId, fieldIds, order });

    // Cache the results
    const cacheKey = `search-${entityType}-${Date.now()}`;
    const cacheFile = resolve(CACHE_DIR, `${cacheKey}.json`);
    saveJson(cacheFile, data);

    console.log(`Total results: ${data.count}`);
    console.log(`Returned: ${data.entities?.length || 0}`);
    if (data.entities?.length) {
      const lastEntity = data.entities[data.entities.length - 1];
      console.log(`Last UUID (for pagination): ${lastEntity.uuid}`);
    }
    console.log();

    for (const entity of (data.entities || [])) {
      const id = entity.properties?.identifier;
      const name = id?.value || entity.uuid;
      const permalink = id?.permalink || '';
      console.log(`  ${name} (${permalink}) [${entity.uuid}]`);
    }

    console.log(`\nCached to: ${cacheFile}`);
    break;
  }

  case 'fields': {
    const { positional } = parseFlags(args);
    const entityType = positional[0];
    if (!entityType) {
      console.error('Usage: node crunchbase-advanced-search.mjs fields <entity-type>');
      console.error(`Entity types: ${Object.keys(COLLECTIONS).join(', ')}`);
      process.exit(1);
    }

    const fields = await listFields(entityType);
    console.log(`Fields for ${entityType} (${fields.length}):\n`);
    for (const f of fields) {
      console.log(`  ${f.id} (${f.type || 'unknown'})`);
    }
    break;
  }

  default:
    console.log(`crunchbase-advanced-search — Search across all Crunchbase entity types

Commands:
  auth                                  Authenticate via Chrome (one-time)
  search <type> [options]               Run advanced search
  fields <type>                         List available fields for entity type

Entity types: ${Object.keys(COLLECTIONS).join(', ')}

Search options:
  --count=N                             Number of results (default: 15, max: 200)
  --after-id=UUID                       Pagination cursor (UUID of last result)
  --query='[...]'                       JSON array of filter predicates
  --field-ids='[...]'                   JSON array or comma-separated field IDs
  --order='field:asc|desc'              Sort order (or JSON array)

Query predicate format:
  {"type":"predicate","field_id":"<field>","operator_id":"<op>","values":[...]}

Operators: eq, not_eq, contains, not_contains, gte, lte, gt, lt,
           between, includes, not_includes, blank, not_blank,
           starts, domain_eq

Examples:
  # AI companies founded in the last year
  node crunchbase-advanced-search.mjs search companies \\
    --query='[{"type":"predicate","field_id":"categories","operator_id":"includes","values":["c4d8caf3-5fe7-359b-f9f2-2d708378e4ee"]},{"type":"predicate","field_id":"founded_on","operator_id":"gte","values":["365 days ago"]}]'

  # Series A funding rounds over $10M
  node crunchbase-advanced-search.mjs search funding_rounds \\
    --query='[{"type":"predicate","field_id":"investment_type","operator_id":"includes","values":["series_a"]},{"type":"predicate","field_id":"money_raised","operator_id":"gte","values":[10000000]}]'

  # People who founded 3+ companies
  node crunchbase-advanced-search.mjs search people \\
    --query='[{"type":"predicate","field_id":"num_founded_organizations","operator_id":"gte","values":[3]}]'

Data: ${DATA_DIR}/
  session.json     Auth cookies
  cache/           Search results`);
}
