#!/usr/bin/env node
// salesnav-lists.mjs — CRUD operations on Sales Navigator lead lists and account lists
//
// Setup:   node salesnav-lists.mjs auth
// Usage:   node salesnav-lists.mjs list [--type=lead|account] [--count=25] [--start=0]
//          node salesnav-lists.mjs view <listId>
//          node salesnav-lists.mjs members <listId> [--count=25] [--start=0]
//          node salesnav-lists.mjs create --name="My List" [--type=lead] [--description="..."]
//          node salesnav-lists.mjs update <listId> --name="New Name" [--description="..."]
//          node salesnav-lists.mjs delete <listId>
//          node salesnav-lists.mjs add <listId> <urn1,urn2,...>
//          node salesnav-lists.mjs remove <listId> <urn1,urn2,...>
//
// Requires Node 22+ and the chrome-cdp skill. Requests run inside your logged-in
// Chrome tab (via CDP), so keep a Sales Navigator tab open.

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { apiFetch, doAuth as cdpDoAuth, requireAuth } from '../../_shared/salesnav-cdp.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-lists');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_CMD = 'node salesnav-lists.mjs auth';

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
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.linkedin.com';

// ---------------------------------------------------------------------------
// List sources constant
// ---------------------------------------------------------------------------

const LIST_SOURCES = [
  'MANUAL', 'SYSTEM', 'CRM_AT_RISK_OPPORTUNITY', 'CRM_SYNC', 'CRM_BLUEBIRD',
  'BUYER_INTEREST', 'LINKEDIN_SALES_INSIGHTS', 'CSV_IMPORT', 'RECOMMENDATION',
  'CAMPAIGN_INBOUND', 'NEW_EXECS_IN_SAVED_ACCOUNTS', 'LEADS_TO_FOLLOW_UP',
  'CRM_PERSON_ACCOUNT', 'BOOK_OF_BUSINESS', 'SALES_ASSISTANT_ONBOARDING',
].join(',');

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function listLists({ type = 'LEAD', start = 0, count = 25 } = {}) {
  const listType = type.toUpperCase();
  if (listType !== 'LEAD' && listType !== 'ACCOUNT') {
    throw new Error(`Invalid list type: "${type}". Must be "lead" or "account".`);
  }

  const url = `${BASE_URL}/sales-api/salesApiLists`
    + `?q=listType`
    + `&listType=${listType}`
    + `&listSources=List(${LIST_SOURCES})`
    + `&isMetadataNeeded=true`
    + `&start=${start}`
    + `&count=${count}`
    + `&sortCriteria=LAST_MODIFIED`
    + `&sortOrder=DESCENDING`
    + `&ownership=OWNED_BY_VIEWER`;

  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
}

async function viewList(listId) {
  // Fetch the list metadata by listing with a filter — the API does not have
  // a direct GET /salesApiLists/<id> for metadata. Instead we fetch the entity
  // list membership or fall back to listing all and filtering.
  // Actually, REST-li supports GET by ID:
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;

  return await apiFetch(url, {}, { authCmd: AUTH_CMD });
}

async function listMembers(listId, { count = 25, start = 0 } = {}) {
  // Members of a list are fetched via lead search or account search filtered by list
  // For lead lists, use salesApiLeadSearch with LEAD_LIST filter
  // For account lists, use salesApiAccountSearch with ACCOUNT_LIST filter
  // First, get the list to determine type
  const listData = await viewList(listId);
  const listType = listData.listType || 'LEAD';

  if (listType === 'LEAD') {
    const query =
      `(spellCorrectionEnabled:true,recentSearchParam:(doLogHistory:false),filters:List((type:LEAD_LIST,values:List((id:${listId},selectionType:INCLUDED)))))`;
    const url = `${BASE_URL}/sales-api/salesApiLeadSearch`
      + `?q=searchQuery`
      + `&query=${query}`
      + `&start=${start}`
      + `&count=${count}`
      + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14`;

    const data = await apiFetch(url, {}, { authCmd: AUTH_CMD });
    return { listType, listName: listData.name, ...data };
  } else {
    const query =
      `(filters:List((type:ACCOUNT_LIST,values:List((id:${listId},selectionType:INCLUDED)))))`;
    const url = `${BASE_URL}/sales-api/salesApiAccountSearch`
      + `?q=searchQuery`
      + `&query=${query}`
      + `&start=${start}`
      + `&count=${count}`
      + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4`;

    const data = await apiFetch(url, {}, { authCmd: AUTH_CMD });
    return { listType, listName: listData.name, ...data };
  }
}

async function createList({ name, type = 'LEAD', description = '' } = {}) {
  const listType = type.toUpperCase();
  if (listType !== 'LEAD' && listType !== 'ACCOUNT') {
    throw new Error(`Invalid list type: "${type}". Must be "lead" or "account".`);
  }
  if (!name) throw new Error('List name is required (--name="...")');

  const url = `${BASE_URL}/sales-api/salesApiLists`;
  const body = { listType, name };
  if (description) body.description = description;

  return await apiFetch(url, {
    method: 'POST',
    headers: { 'X-Restli-Method': 'CREATE' },
    body: JSON.stringify(body),
  }, { authCmd: AUTH_CMD });
}

async function updateList(listId, { name, description } = {}) {
  if (!name && description === undefined) {
    throw new Error('At least --name or --description is required for update.');
  }

  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;
  const patch = {};
  if (name) patch.name = { '$set': name };
  if (description !== undefined) patch.description = { '$set': description };

  return await apiFetch(url, {
    method: 'POST',
    headers: { 'X-Restli-Method': 'PARTIAL_UPDATE' },
    body: JSON.stringify({ patch }),
  }, { authCmd: AUTH_CMD });
}

async function deleteList(listId) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;
  // 2xx returns no body; shared apiFetch surfaces 401/403/errors itself.
  await apiFetch(url, { method: 'DELETE' }, { authCmd: AUTH_CMD });
  return { success: true };
}

async function addEntities(listId, entityUrns) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}?action=addEntities`;
  return await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify({ entities: entityUrns }),
  }, { authCmd: AUTH_CMD });
}

async function removeEntities(listId, entityUrns) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}?action=removeEntities`;
  return await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify({ entities: entityUrns }),
  }, { authCmd: AUTH_CMD });
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function printListSummary(el) {
  const modified = formatTimestamp(el.lastModifiedAt);
  const source = el.listSource || 'UNKNOWN';
  console.log(`  [${el.id}] ${el.name} (${el.listType}, ${source})`);
  console.log(`    Entities: ${el.entityCount ?? '?'}  |  Modified: ${modified}  |  Role: ${el.role || '?'}`);
  if (el.description) console.log(`    Description: ${el.description}`);
}

function printListDetail(data) {
  console.log(`\nList: ${data.name}`);
  console.log(`  ID:          ${data.id}`);
  console.log(`  Type:        ${data.listType}`);
  console.log(`  Source:      ${data.listSource || 'UNKNOWN'}`);
  console.log(`  Entities:    ${data.entityCount ?? '?'}`);
  console.log(`  Role:        ${data.role || '?'}`);
  console.log(`  Subscribed:  ${data.subscribed ?? '?'}`);
  console.log(`  Modified:    ${formatTimestamp(data.lastModifiedAt)}`);
  console.log(`  Viewed:      ${formatTimestamp(data.lastViewedAt)}`);
  if (data.description) console.log(`  Description: ${data.description}`);
  if (data.creator) {
    // creator may be a URN string or an object depending on decoration
    const creatorStr = typeof data.creator === 'string' ? data.creator
      : data.creator.fullName || [data.creator.firstName, data.creator.lastName].filter(Boolean).join(' ');
    console.log(`  Creator:     ${creatorStr}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (match) {
      flags[match[1]] = match[2] !== undefined ? match[2] : 'true';
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

switch (command) {
  case 'auth': {
    cdpDoAuth(SESSION_FILE, saveJson);
    break;
  }

  case 'list': {
    const { flags } = parseFlags(args);
    const type = (flags.type || 'lead').toUpperCase();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching ${type.toLowerCase()} lists (start=${start}, count=${count})...`);

    const data = await listLists({ type, start, count });
    const total = data.metadata?.totalCount ?? data.paging?.total ?? data.elements?.length ?? 0;
    console.log(`\nFound ${total} ${type.toLowerCase()} list(s):\n`);

    for (const el of (data.elements || [])) {
      printListSummary(el);
    }

    // Save to cache
    const outFile = resolve(CACHE_DIR, `lists-${type.toLowerCase()}.json`);
    saveJson(outFile, data);
    console.log(`\nResults saved to: ${outFile}`);
    break;
  }

  case 'view': {
    const { positional } = parseFlags(args);
    const listId = positional[0];
    if (!listId) {
      console.error('Usage: node salesnav-lists.mjs view <listId>');
      process.exit(1);
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching list ${listId}...`);
    const data = await viewList(listId);
    printListDetail(data);

    const outFile = resolve(CACHE_DIR, `list-${listId}.json`);
    saveJson(outFile, data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'members': {
    const { flags, positional } = parseFlags(args);
    const listId = positional[0];
    if (!listId) {
      console.error('Usage: node salesnav-lists.mjs members <listId> [--count=25] [--start=0]');
      process.exit(1);
    }

    const count = parseInt(flags.count || '25');
    const start = parseInt(flags.start || '0');
    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Fetching members of list ${listId} (start=${start}, count=${count})...`);

    const data = await listMembers(listId, { count, start });
    const total = data.paging?.total ?? data.elements?.length ?? 0;
    console.log(`\nList "${data.listName}" (${data.listType}) — ${total} member(s):\n`);

    for (const el of (data.elements || [])) {
      if (data.listType === 'LEAD') {
        const pos = el.currentPositions?.[0];
        console.log(`  ${el.fullName || [el.firstName, el.lastName].join(' ')} — ${pos?.title || el.headline || ''} @ ${pos?.companyName || ''} (${el.geoRegion || ''})`);
      } else {
        console.log(`  ${el.companyName || el.name || el.entityUrn} — ${el.industry || ''} (${el.employeeDisplayCount || '?'} employees)`);
      }
    }

    const outFile = resolve(CACHE_DIR, `members-${listId}.json`);
    saveJson(outFile, data);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'create': {
    const { flags } = parseFlags(args);
    const name = flags.name;
    const type = flags.type || 'lead';
    const description = flags.description || '';
    const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === true;

    if (!name) {
      console.error('Usage: node salesnav-lists.mjs create --name="My List" [--type=lead|account] [--description="..."] [--dry-run]');
      process.exit(1);
    }

    const body = { listType: type.toUpperCase(), name };
    if (description) body.description = description;

    if (dryRun) {
      console.log('DRY RUN — would send:');
      console.log(`  POST ${BASE_URL}/sales-api/salesApiLists`);
      console.log(`  Headers: X-Restli-Method: CREATE, content-type: application/json`);
      console.log(`  Body: ${JSON.stringify(body, null, 2)}`);
      break;
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Creating ${type} list "${name}"...`);
    const data = await createList({ name, type, description });
    console.log('List created successfully.');
    if (typeof data === 'object') {
      console.log(JSON.stringify(data, null, 2));
    }
    break;
  }

  case 'update': {
    const { flags, positional } = parseFlags(args);
    const listId = positional[0];
    if (!listId) {
      console.error('Usage: node salesnav-lists.mjs update <listId> --name="New Name" [--description="..."] [--dry-run]');
      process.exit(1);
    }

    const name = flags.name;
    const description = flags.description;
    const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === true;

    if (!name && description === undefined) {
      console.error('At least --name or --description is required for update.');
      process.exit(1);
    }

    const patch = {};
    if (name) patch.name = { '$set': name };
    if (description !== undefined) patch.description = { '$set': description };

    if (dryRun) {
      console.log('DRY RUN — would send:');
      console.log(`  POST ${BASE_URL}/sales-api/salesApiLists/${listId}`);
      console.log(`  Headers: X-Restli-Method: PARTIAL_UPDATE, content-type: application/json`);
      console.log(`  Body: ${JSON.stringify({ patch }, null, 2)}`);
      break;
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Updating list ${listId}...`);
    const data = await updateList(listId, { name, description });
    console.log('List updated successfully.');
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
    break;
  }

  case 'delete': {
    const { flags, positional } = parseFlags(args);
    const listId = positional[0];
    if (!listId) {
      console.error('Usage: node salesnav-lists.mjs delete <listId> [--dry-run]');
      process.exit(1);
    }

    const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === true;

    if (dryRun) {
      console.log('DRY RUN — would send:');
      console.log(`  DELETE ${BASE_URL}/sales-api/salesApiLists/${listId}`);
      console.log(`  Headers: content-type: application/json`);
      break;
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Deleting list ${listId}...`);
    const result = await deleteList(listId);
    console.log(`List ${listId} deleted successfully.`);
    break;
  }

  case 'add': {
    const { flags, positional } = parseFlags(args);
    const listId = positional[0];
    const urnsArg = positional[1];
    if (!listId || !urnsArg) {
      console.error('Usage: node salesnav-lists.mjs add <listId> <urn1,urn2,...> [--dry-run]');
      console.error('\nEntity URN formats:');
      console.error('  Lead:    urn:li:fs_salesProfile:(profileId,authType,authToken)');
      console.error('  Account: urn:li:fs_salesCompany:companyId');
      process.exit(1);
    }

    const entityUrns = urnsArg.split(',').map(u => u.trim()).filter(Boolean);
    const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === true;

    if (dryRun) {
      console.log('DRY RUN — would send:');
      console.log(`  POST ${BASE_URL}/sales-api/salesApiLists/${listId}?action=addEntities`);
      console.log(`  Headers: content-type: application/json`);
      console.log(`  Body: ${JSON.stringify({ entities: entityUrns }, null, 2)}`);
      break;
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Adding ${entityUrns.length} entity/entities to list ${listId}...`);
    const data = await addEntities(listId, entityUrns);
    console.log('Entities added successfully.');
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
    break;
  }

  case 'remove': {
    const { flags, positional } = parseFlags(args);
    const listId = positional[0];
    const urnsArg = positional[1];
    if (!listId || !urnsArg) {
      console.error('Usage: node salesnav-lists.mjs remove <listId> <urn1,urn2,...> [--dry-run]');
      console.error('\nEntity URN formats:');
      console.error('  Lead:    urn:li:fs_salesProfile:(profileId,authType,authToken)');
      console.error('  Account: urn:li:fs_salesCompany:companyId');
      process.exit(1);
    }

    const entityUrns = urnsArg.split(',').map(u => u.trim()).filter(Boolean);
    const dryRun = flags['dry-run'] === 'true' || flags['dry-run'] === true;

    if (dryRun) {
      console.log('DRY RUN — would send:');
      console.log(`  POST ${BASE_URL}/sales-api/salesApiLists/${listId}?action=removeEntities`);
      console.log(`  Headers: content-type: application/json`);
      console.log(`  Body: ${JSON.stringify({ entities: entityUrns }, null, 2)}`);
      break;
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    console.log(`Removing ${entityUrns.length} entity/entities from list ${listId}...`);
    const data = await removeEntities(listId, entityUrns);
    console.log('Entities removed successfully.');
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
    break;
  }

  default:
    console.log(`salesnav-lists — CRUD operations on Sales Navigator lead lists and account lists

Commands:
  auth                                            Authenticate via Chrome (one-time)
  list [--type=lead|account] [--count=25]         List all lists (default: lead)
  view <listId>                                   View a specific list's details
  members <listId> [--count=25] [--start=0]       List members of a list
  create --name="..." [--type=lead|account]        Create a new list
  update <listId> --name="..." [--description=""] Update list name/description
  delete <listId>                                  Delete a list
  add <listId> <urn1,urn2,...>                     Add entities to a list
  remove <listId> <urn1,urn2,...>                  Remove entities from a list

Options:
  --type=lead|account   List type (default: lead)
  --count=25            Results per page
  --start=0             Pagination offset
  --name="..."          List name (for create/update)
  --description="..."   List description (for create/update)
  --dry-run             Show request without executing (mutating commands)

Entity URN formats:
  Lead:    urn:li:fs_salesProfile:(profileId,authType,authToken)
  Account: urn:li:fs_salesCompany:companyId

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Cached list data`);
}
