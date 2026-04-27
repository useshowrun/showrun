#!/usr/bin/env node

/**
 * Pitchbook Advanced Search (Screener)
 *
 * Multi-step API flow for running advanced/screener searches on Pitchbook.
 *
 * Usage:
 *   node pitchbook-advanced-search.mjs auth
 *   node pitchbook-advanced-search.mjs search [--type=COMPANIES] [--page=1] [--page-size=25] [--criteria=<json>] [--sort=<columnId>] [--sort-order=DESC]
 *   node pitchbook-advanced-search.mjs count <searchId>
 *   node pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies] [--sort=<columnId>] [--sort-order=DESC]
 *   node pitchbook-advanced-search.mjs criteria-schema [--type=COMPANIES]
 *   node pitchbook-advanced-search.mjs columns <searchId> [--tab=companies]
 */

import { resolve } from 'path';
import {
  CACHE_DIR,
  getAuth,
  checkCurl,
  doCdpAuth,
  curlGet,
  curlPost,
  saveJson,
  parseFlags,
  delay,
} from '../../lib/utils.mjs';

const BASE = 'https://my.pitchbook.com';
const REFERER = `${BASE}/search/companies`;

const SEARCH_TYPE_MAP = {
  COMPANIES: { entryPointKey: 'ALL_COMPANIES', searchType: 'COMPANY' },
  DEALS: { entryPointKey: 'ALL_DEALS', searchType: 'DEAL' },
  INVESTORS: { entryPointKey: 'ALL_INVESTORS', searchType: 'INVESTOR' },
};

const TAB_TYPE_MAP = {
  companies: 'company',
  deals: 'deal',
  investors: 'investor',
};

// ---------------------------------------------------------------------------
// Step 1: Create search session
// ---------------------------------------------------------------------------
async function createSearch(auth, type) {
  const body = SEARCH_TYPE_MAP[type];
  if (!body) {
    console.error(`Unknown search type: ${type}. Use COMPANIES, DEALS, or INVESTORS.`);
    process.exit(1);
  }
  console.log(`[Step 1/6] Creating search session (type=${type})...`);
  const url = `${BASE}/web-api/advanced-search-api/searches?ignoreUserPreferences=true`;
  return await curlPost(url, auth, body, REFERER);
}

// ---------------------------------------------------------------------------
// Step 1b: Create criteria key (for filter application)
// ---------------------------------------------------------------------------
async function createCriteriaKey(auth, searchId) {
  console.log(`  Creating criteria key for ${searchId}...`);
  const url = `${BASE}/web-api/advanced-search-api/search-criteria/${searchId}/key`;
  const res = await curlPost(url, auth, {}, REFERER);
  return res?.value || res?.intValue?.toString();
}

// ---------------------------------------------------------------------------
// Step 1c: Set a single filter field
// ---------------------------------------------------------------------------
async function setCriteriaField(auth, searchId, criteriaKey, field, op, body) {
  console.log(`  Setting filter: ${field} (${op})`);
  const url = `${BASE}/web-api/advanced-search-api-bff/api/v1/search-criteria/${searchId}/fields/${field}/${op}?criteriaKey=${criteriaKey}`;
  return await curlPost(url, auth, body, REFERER);
}

// ---------------------------------------------------------------------------
// Step 1d: Apply criteria to the search
// ---------------------------------------------------------------------------
async function applyCriteria(auth, searchId, criteriaKey) {
  console.log(`  Applying criteria...`);
  const url = `${BASE}/web-api/advanced-search-api-bff/api/v1/search-criteria/${searchId}/key/${criteriaKey}/apply`;
  return await curlPost(url, auth, {}, REFERER);
}

// ---------------------------------------------------------------------------
// Get criteria state (for schema discovery)
// ---------------------------------------------------------------------------
async function getCriteriaState(auth, searchId, criteriaKey) {
  const url = `${BASE}/web-api/advanced-search-api-bff/api/v1/search-criteria/${searchId}?criteriaKey=${criteriaKey}`;
  return await curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 2: Run the search
// ---------------------------------------------------------------------------
async function runSearch(auth, searchId) {
  console.log(`[Step 2/6] Running search ${searchId}...`);
  const url = `${BASE}/web-api/advanced-search-api/searches/${searchId}/run?resetTrigger=AS_CRITERIA&resetFilters=true`;
  return await curlPost(url, auth, {}, REFERER);
}

// ---------------------------------------------------------------------------
// Step 3: Get search metadata
// ---------------------------------------------------------------------------
async function getSearchMeta(auth, searchId) {
  console.log(`[Step 3/6] Getting search metadata...`);
  const url = `${BASE}/web-api/advanced-search-api/searches/${searchId}`;
  return await curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 4: Get view (to find dataSetId)
// ---------------------------------------------------------------------------
async function getView(auth, viewId) {
  console.log(`[Step 4/6] Getting view ${viewId}...`);
  const url = `${BASE}/web-api/advanced-search-api/views/${viewId}`;
  return await curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Sorting: set the sort order on a result set (optional)
// ---------------------------------------------------------------------------
async function setSorting(auth, dataSetId, columnId, order) {
  console.log(`  Sorting by ${columnId} ${order}...`);
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/columns/sorting`;
  const body = [{ order, columnId, hidden: false, nullsFirst: false }];
  return await curlPost(url, auth, body, REFERER);
}

async function getColumns(auth, dataSetId) {
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/columns?alertMode=false&recentUpdatesMode=false`;
  return await curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 5: Get result count
// ---------------------------------------------------------------------------
async function getCount(auth, dataSetId) {
  console.log(`[Step 5/6] Getting result count...`);
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/entities/count?alertMode=false&recentUpdatesMode=false`;
  return await curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 6: Fetch results
// ---------------------------------------------------------------------------
async function fetchResults(auth, dataSetId, page, pageSize) {
  console.log(`[Step 6/6] Fetching results (page=${page}, pageSize=${pageSize})...`);
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/data?page=${page}&pageSize=${pageSize}&alertMode=false&recentUpdatesMode=false`;
  return await curlPost(url, auth, {}, REFERER);
}

// ---------------------------------------------------------------------------
// Print result summary
// ---------------------------------------------------------------------------
function printSummary(data, count) {
  if (count !== undefined) {
    console.log(`\nTotal results: ${count}`);
  }

  const rows = data?.dataRows || [];
  console.log(`Showing ${rows.length} result(s):\n`);

  for (const row of rows.slice(0, 50)) {
    const cv = row.columnValues || {};
    const name = cv.companyName?.[0]?.name || cv.investorName?.[0]?.name || cv.dealName?.[0]?.name || row.pbId || '?';
    const industry = cv.primaryIndustryCode?.[0]?.value || '';
    const city = cv.hqCity?.[0]?.value || '';
    const country = cv.hqCountry?.[0]?.value || '';
    const location = [city, country].filter(Boolean).join(', ');

    const parts = [`  ${name}`];
    if (industry) parts.push(`Industry: ${industry}`);
    if (location) parts.push(`Location: ${location}`);
    console.log(parts.join(' | '));
  }
}

// ---------------------------------------------------------------------------
// Full search flow
// ---------------------------------------------------------------------------
async function doFullSearch(auth, type, page, pageSize, criteria, sortColumn, sortOrder) {
  // Step 1: Create
  const createResult = await createSearch(auth, type);
  const searchId = createResult?.id || createResult?.searchId;
  if (!searchId) {
    console.error('Failed to create search session. Response:', JSON.stringify(createResult).substring(0, 500));
    process.exit(1);
  }
  console.log(`  searchId: ${searchId}`);
  await delay(6000);

  // Step 1b–1d: Apply filter criteria (if provided)
  if (Array.isArray(criteria) && criteria.length > 0) {
    console.log(`[Step 1b/6] Applying ${criteria.length} filter(s)...`);
    const criteriaKey = await createCriteriaKey(auth, searchId);
    if (!criteriaKey) {
      console.error('Failed to create criteria key.');
      process.exit(1);
    }
    console.log(`  criteriaKey: ${criteriaKey}`);
    await delay(2000);

    for (const filter of criteria) {
      if (!filter?.field || !filter?.op || !filter?.body) {
        console.error(`Invalid filter (needs {field, op, body}): ${JSON.stringify(filter)}`);
        process.exit(1);
      }
      await setCriteriaField(auth, searchId, criteriaKey, filter.field, filter.op, filter.body);
      await delay(2000);
    }

    await applyCriteria(auth, searchId, criteriaKey);
    await delay(4000);
  }

  // Step 2: Run
  await runSearch(auth, searchId);
  await delay(6000);

  // Step 3: Get metadata
  const meta = await getSearchMeta(auth, searchId);
  await delay(6000);

  // Step 4: Get view — derive viewId from metadata or convention
  const tabType = type === 'DEALS' ? 'deal' : type === 'INVESTORS' ? 'investor' : 'company';
  const viewId = `${searchId}.${tabType}`;
  const viewData = await getView(auth, viewId);
  const dataSetId = viewData?.dataSetId || `${searchId}.${tabType}.data_set`;
  console.log(`  dataSetId: ${dataSetId}`);
  await delay(6000);

  // Optional sort before count/fetch
  if (sortColumn) {
    await setSorting(auth, dataSetId, sortColumn, sortOrder || 'DESC');
    await delay(2000);
  }

  // Step 5: Count
  const countResult = await getCount(auth, dataSetId);
  const count = countResult?.count;
  console.log(`  count: ${count}`);
  await delay(6000);

  // Step 6: Fetch results
  const results = await fetchResults(auth, dataSetId, page, pageSize);

  // Save
  const outFile = resolve(CACHE_DIR, `advanced-search-${searchId}-p${page}.json`);
  saveJson(outFile, { searchId, dataSetId, count, results });
  console.log(`\nResults saved to: ${outFile}`);

  printSummary(results, count);
  return { searchId, dataSetId, count, results };
}

// ---------------------------------------------------------------------------
// Results for existing search
// ---------------------------------------------------------------------------
async function doResults(auth, searchId, page, pageSize, tab, sortColumn, sortOrder) {
  checkCurl();
  const tabType = TAB_TYPE_MAP[tab] || 'company';
  const dataSetId = `${searchId}.${tabType}.data_set`;

  if (sortColumn) {
    await setSorting(auth, dataSetId, sortColumn, sortOrder || 'DESC');
    await delay(2000);
  }

  const countResult = await getCount(auth, dataSetId);
  const count = countResult?.count;

  const results = await fetchResults(auth, dataSetId, page, pageSize);

  const outFile = resolve(CACHE_DIR, `advanced-search-${searchId}-p${page}.json`);
  saveJson(outFile, { searchId, dataSetId, count, results });
  console.log(`Results saved to: ${outFile}`);

  printSummary(results, count);
  return results;
}

// ---------------------------------------------------------------------------
// Count for existing search
// ---------------------------------------------------------------------------
async function doCount(auth, searchId) {
  checkCurl();
  // Default to company tab for count
  const dataSetId = `${searchId}.company.data_set`;
  const countResult = await getCount(auth, dataSetId);
  console.log(`Result count: ${countResult?.count}`);
  return countResult;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'search': {
    const auth = await getAuth();
    checkCurl();
    const type = (flags.type || 'COMPANIES').toUpperCase();
    const page = parseInt(flags.page || '1', 10);
    const pageSize = parseInt(flags['page-size'] || '25', 10);
    let criteria;
    if (flags.criteria) {
      try {
        criteria = JSON.parse(flags.criteria);
      } catch (err) {
        console.error(`Invalid --criteria JSON: ${err.message}`);
        process.exit(1);
      }
    }
    const sortColumn = flags.sort;
    const sortOrder = (flags['sort-order'] || 'DESC').toUpperCase();
    await doFullSearch(auth, type, page, pageSize, criteria, sortColumn, sortOrder);
    break;
  }
  case 'criteria-schema': {
    const auth = await getAuth();
    checkCurl();
    const type = (flags.type || 'COMPANIES').toUpperCase();
    const createResult = await createSearch(auth, type);
    const searchId = createResult?.id || createResult?.searchId;
    if (!searchId) {
      console.error('Failed to create search session.');
      process.exit(1);
    }
    console.log(`  searchId: ${searchId}`);
    await delay(2000);
    const criteriaKey = await createCriteriaKey(auth, searchId);
    if (!criteriaKey) {
      console.error('Failed to create criteria key.');
      process.exit(1);
    }
    console.log(`  criteriaKey: ${criteriaKey}`);
    await delay(1500);
    const state = await getCriteriaState(auth, searchId, criteriaKey);
    const outFile = resolve(CACHE_DIR, `criteria-schema-${type}-${searchId}.json`);
    saveJson(outFile, state);
    console.log(`\nCriteria schema saved to: ${outFile}`);
    console.log(`Top-level fields: ${Object.keys(state || {}).join(', ')}`);
    break;
  }
  case 'count': {
    const searchId = positional[0];
    if (!searchId) {
      console.error('Usage: node pitchbook-advanced-search.mjs count <searchId>');
      process.exit(1);
    }
    const auth = await getAuth();
    await doCount(auth, searchId);
    break;
  }
  case 'results': {
    const searchId = positional[0];
    if (!searchId) {
      console.error('Usage: node pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies]');
      process.exit(1);
    }
    const auth = await getAuth();
    const page = parseInt(flags.page || '1', 10);
    const pageSize = parseInt(flags['page-size'] || '25', 10);
    const tab = (flags.tab || 'companies').toLowerCase();
    const sortColumn = flags.sort;
    const sortOrder = (flags['sort-order'] || 'DESC').toUpperCase();
    await doResults(auth, searchId, page, pageSize, tab, sortColumn, sortOrder);
    break;
  }
  case 'columns': {
    const searchId = positional[0];
    if (!searchId) {
      console.error('Usage: node pitchbook-advanced-search.mjs columns <searchId> [--tab=companies]');
      process.exit(1);
    }
    const auth = await getAuth();
    checkCurl();
    const tabType = TAB_TYPE_MAP[(flags.tab || 'companies').toLowerCase()] || 'company';
    const dataSetId = `${searchId}.${tabType}.data_set`;
    const data = await getColumns(auth, dataSetId);
    const sortable = (data.columns || []).filter(c => c.sortable).map(c => ({ id: c.columnId, label: c.label, type: c.columnType }));
    const outFile = resolve(CACHE_DIR, `columns-${searchId}-${tabType}.json`);
    saveJson(outFile, data);
    console.log(`\nSortable columns (${sortable.length}/${(data.columns || []).length}) saved to ${outFile}:\n`);
    for (const c of sortable) console.log(`  ${c.id.padEnd(32)} ${(c.type || '').padEnd(14)} ${c.label}`);
    break;
  }
  default:
    console.log(`pitchbook-advanced-search

Run advanced/screener searches on Pitchbook via multi-step API flow.

Commands:
  auth                                        Capture session from Chrome via CDP
  search [--type=COMPANIES] [--page=1] [--page-size=25] [--criteria=<json>] [--sort=<columnId>] [--sort-order=DESC]
                                              Run a full search (create -> apply criteria -> run -> sort -> fetch)
  count <searchId>                            Get result count for an existing search
  results <searchId> [--page=1] [--page-size=25] [--tab=companies] [--sort=<columnId>] [--sort-order=DESC]
                                              Fetch results for an existing search session (with optional sort)
  criteria-schema [--type=COMPANIES]          Create an empty search and dump the criteria field tree
  columns <searchId> [--tab=companies]        List sortable result columns (run search first to get a searchId)

Search types: COMPANIES, DEALS, INVESTORS
Tab options:   companies, deals, investors

--criteria format: JSON array of {field, op, body} objects. Example (US-only location):
  [{"field":"company.location.codes","op":"collection","body":{"value":["gUS"],"requestType":"COLLECTION","updateType":"SET_VALUE"}}]

Examples:
  node pitchbook-advanced-search.mjs search
  node pitchbook-advanced-search.mjs search --type=DEALS --page=1 --page-size=50
  node pitchbook-advanced-search.mjs count s637561838
  node pitchbook-advanced-search.mjs results s637561838 --page=2 --page-size=100 --tab=companies
  node pitchbook-advanced-search.mjs criteria-schema --type=COMPANIES
  node pitchbook-advanced-search.mjs columns s637561838
  node pitchbook-advanced-search.mjs search --sort=vcRaised --sort-order=DESC

Common sortable columns (run 'columns <searchId>' for the full list):
  lastFinancingDate       Most recent round date (default sort)
  lastFinancingSize       Deal size of the most recent round
  vcRaised                Total raised across all rounds
  lastFinancingValuation  Valuation at last round
  employees               Headcount
  yearFounded             Year founded`);
}
