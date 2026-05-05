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
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-lists');
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
// Auth
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}


const LINKEDIN_COOKIE_URLS = [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/sales/',
  'https://www.linkedin.com/sales/home',
];

function parseCookieResponse(raw, source) {
  try {
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.cookies)) throw new Error('response has no cookies array');
    return data.cookies;
  } catch (err) {
    throw new Error(`${source} cookie extraction failed: ${err.message}`);
  }
}

function cookieMapFrom(cookies) {
  return Object.fromEntries(cookies.map(c => [c.name, c.value]));
}

function linkedInCookieString(cookies) {
  return cookies
    .filter(c => String(c.domain || '').includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function activeTabInfo(target, listText = '') {
  let url = '';
  let title = '';
  try {
    const raw = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    }));
    const parsed = JSON.parse(raw);
    const value = parsed?.result?.value || parsed?.result?.description;
    if (value) {
      const info = JSON.parse(value);
      url = info.url || '';
      title = info.title || '';
    }
  } catch {}
  if (!url) {
    const line = String(listText || '').split('\n').find(l => l.trim().startsWith(`${target} `) || l.includes(target));
    if (line) url = line.trim();
  }
  return { url, title };
}

function readLinkedInCookies(target) {
  const errors = [];
  try {
    const cookies = parseCookieResponse(cdp('evalraw', target, 'Storage.getCookies', '{}'), 'Storage.getCookies');
    return { cookies, source: 'Storage.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  try {
    const cookies = parseCookieResponse(
      cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: LINKEDIN_COOKIE_URLS })),
      'Network.getCookies',
    );
    return { cookies, source: 'Network.getCookies' };
  } catch (err) {
    errors.push(err.message);
  }

  for (const url of LINKEDIN_COOKIE_URLS) {
    try {
      const cookies = parseCookieResponse(
        cdp('evalraw', target, 'Network.getCookies', JSON.stringify({ urls: [url] })),
        `Network.getCookies ${url}`,
      );
      return { cookies, source: `Network.getCookies ${url}` };
    } catch (err) {
      errors.push(err.message);
    }
  }

  throw new Error(`LinkedIn/Sales Nav cookie extraction failure in active CDP session: ${errors.join(' | ')}`);
}

function getLinkedInAuthCookies(target, listText = '') {
  const { cookies, source } = readLinkedInCookies(target);
  const cookieMap = cookieMapFrom(cookies);
  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  const missing = ['li_at', 'JSESSIONID'].filter(name => !cookieMap[name]);
  if (missing.length) {
    const info = activeTabInfo(target, listText);
    const activeUrl = info.url || '';
    const activeTitle = info.title || '';
    if (/\/login(?:[/?#]|$)|\/sales\/login(?:[/?#]|$)/i.test(activeUrl)) {
      throw new Error('LinkedIn/Sales Nav is showing login page in the active CDP session; log in through the same live Browser Use URL or pass the exact live CDP endpoint.');
    }
    throw new Error(
      `LinkedIn/Sales Nav auth cookies missing (${missing.join(', ')}) after ${source}. ` +
      `Active tab URL/title: ${activeUrl || '<unknown>'}${activeTitle ? ` / ${activeTitle}` : ''}. ` +
      'This is not enough to claim generic logged-out state: distinguish wrong CDP session/profile, actual logged-out state, or cookie extraction failure. For human login handoff, use the exact live Browser Use CDP endpoint.',
    );
  }
  return { cookieStr: linkedInCookieString(cookies), csrfToken, cookieSource: source };
}

async function doAuth() {
  console.log('Finding Sales Navigator tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com/sales')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn/Sales Navigator tab found.');

  console.log(`Using tab: ${target}`);

  const { cookieStr, csrfToken, cookieSource } = getLinkedInAuthCookies(target, list);
  console.log(`Extracted LinkedIn cookies via ${cookieSource}`);

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.linkedin.com';

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node salesnav-lists.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'csrf-token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

function mutationHeaders(auth) {
  return {
    ...baseHeaders(auth),
    'content-type': 'application/json',
  };
}

async function apiFetch(auth, url, options = {}) {
  const headers = { ...baseHeaders(auth), ...options.headers };
  const resp = await fetch(url, { ...options, headers });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-lists.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 500)}`);
  }
  return data;
}

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

async function listLists(auth, { type = 'LEAD', start = 0, count = 25 } = {}) {
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

  return apiFetch(auth, url);
}

async function viewList(auth, listId) {
  // Fetch the list metadata by listing with a filter — the API does not have
  // a direct GET /salesApiLists/<id> for metadata. Instead we fetch the entity
  // list membership or fall back to listing all and filtering.
  // Actually, REST-li supports GET by ID:
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;

  return apiFetch(auth, url);
}

async function listMembers(auth, listId, { count = 25, start = 0 } = {}) {
  // Members of a list are fetched via lead search or account search filtered by list
  // For lead lists, use salesApiLeadSearch with LEAD_LIST filter
  // For account lists, use salesApiAccountSearch with ACCOUNT_LIST filter
  // First, get the list to determine type
  const listData = await viewList(auth, listId);
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

    const data = await apiFetch(auth, url);
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

    const data = await apiFetch(auth, url);
    return { listType, listName: listData.name, ...data };
  }
}

async function createList(auth, { name, type = 'LEAD', description = '' } = {}) {
  const listType = type.toUpperCase();
  if (listType !== 'LEAD' && listType !== 'ACCOUNT') {
    throw new Error(`Invalid list type: "${type}". Must be "lead" or "account".`);
  }
  if (!name) throw new Error('List name is required (--name="...")');

  const url = `${BASE_URL}/sales-api/salesApiLists`;
  const body = { listType, name };
  if (description) body.description = description;

  return apiFetch(auth, url, {
    method: 'POST',
    headers: {
      ...mutationHeaders(auth),
      'X-Restli-Method': 'CREATE',
    },
    body: JSON.stringify(body),
  });
}

async function updateList(auth, listId, { name, description } = {}) {
  if (!name && description === undefined) {
    throw new Error('At least --name or --description is required for update.');
  }

  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;
  const patch = {};
  if (name) patch.name = { '$set': name };
  if (description !== undefined) patch.description = { '$set': description };

  return apiFetch(auth, url, {
    method: 'POST',
    headers: {
      ...mutationHeaders(auth),
      'X-Restli-Method': 'PARTIAL_UPDATE',
    },
    body: JSON.stringify({ patch }),
  });
}

async function deleteList(auth, listId) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: mutationHeaders(auth),
  });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-lists.mjs auth');
    }
    const text = await resp.text();
    throw new Error(`API error (HTTP ${resp.status}): ${text.substring(0, 500)}`);
  }
  return { success: true, status: resp.status };
}

async function addEntities(auth, listId, entityUrns) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}?action=addEntities`;
  return apiFetch(auth, url, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ entities: entityUrns }),
  });
}

async function removeEntities(auth, listId, entityUrns) {
  const url = `${BASE_URL}/sales-api/salesApiLists/${listId}?action=removeEntities`;
  return apiFetch(auth, url, {
    method: 'POST',
    headers: mutationHeaders(auth),
    body: JSON.stringify({ entities: entityUrns }),
  });
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
    await doAuth();
    break;
  }

  case 'list': {
    const { flags } = parseFlags(args);
    const type = (flags.type || 'lead').toUpperCase();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    const auth = getAuth();
    console.log(`Fetching ${type.toLowerCase()} lists (start=${start}, count=${count})...`);

    const data = await listLists(auth, { type, start, count });
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

    const auth = getAuth();
    console.log(`Fetching list ${listId}...`);
    const data = await viewList(auth, listId);
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
    const auth = getAuth();
    console.log(`Fetching members of list ${listId} (start=${start}, count=${count})...`);

    const data = await listMembers(auth, listId, { count, start });
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

    const auth = getAuth();
    console.log(`Creating ${type} list "${name}"...`);
    const data = await createList(auth, { name, type, description });
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

    const auth = getAuth();
    console.log(`Updating list ${listId}...`);
    const data = await updateList(auth, listId, { name, description });
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

    const auth = getAuth();
    console.log(`Deleting list ${listId}...`);
    const result = await deleteList(auth, listId);
    console.log(`List ${listId} deleted successfully (HTTP ${result.status}).`);
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

    const auth = getAuth();
    console.log(`Adding ${entityUrns.length} entity/entities to list ${listId}...`);
    const data = await addEntities(auth, listId, entityUrns);
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

    const auth = getAuth();
    console.log(`Removing ${entityUrns.length} entity/entities from list ${listId}...`);
    const data = await removeEntities(auth, listId, entityUrns);
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
