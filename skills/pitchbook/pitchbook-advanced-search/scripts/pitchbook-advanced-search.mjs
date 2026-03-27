#!/usr/bin/env node

/**
 * Pitchbook Advanced Search (Screener)
 *
 * Multi-step API flow for running advanced/screener searches on Pitchbook.
 *
 * Usage:
 *   node pitchbook-advanced-search.mjs auth
 *   node pitchbook-advanced-search.mjs search [--type=COMPANIES] [--page=1] [--page-size=25]
 *   node pitchbook-advanced-search.mjs count <searchId>
 *   node pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies]
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
  COMPANIES: { entryPointKey: 'COMPANY', searchType: 'COMPANIES' },
  DEALS: { entryPointKey: 'DEAL', searchType: 'DEALS' },
  INVESTORS: { entryPointKey: 'INVESTOR', searchType: 'INVESTORS' },
};

const TAB_TYPE_MAP = {
  companies: 'company',
  deals: 'deal',
  investors: 'investor',
};

// ---------------------------------------------------------------------------
// Step 1: Create search session
// ---------------------------------------------------------------------------
function createSearch(auth, type) {
  const body = SEARCH_TYPE_MAP[type];
  if (!body) {
    console.error(`Unknown search type: ${type}. Use COMPANIES, DEALS, or INVESTORS.`);
    process.exit(1);
  }
  console.log(`[Step 1/6] Creating search session (type=${type})...`);
  const url = `${BASE}/web-api/advanced-search-api/searches?ignoreUserPreferences=true`;
  return curlPost(url, auth, body, REFERER);
}

// ---------------------------------------------------------------------------
// Step 2: Run the search
// ---------------------------------------------------------------------------
function runSearch(auth, searchId) {
  console.log(`[Step 2/6] Running search ${searchId}...`);
  const url = `${BASE}/web-api/advanced-search-api/searches/${searchId}/run?resetTrigger=AS_CRITERIA&resetFilters=true`;
  return curlPost(url, auth, {}, REFERER);
}

// ---------------------------------------------------------------------------
// Step 3: Get search metadata
// ---------------------------------------------------------------------------
function getSearchMeta(auth, searchId) {
  console.log(`[Step 3/6] Getting search metadata...`);
  const url = `${BASE}/web-api/advanced-search-api/searches/${searchId}`;
  return curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 4: Get view (to find dataSetId)
// ---------------------------------------------------------------------------
function getView(auth, viewId) {
  console.log(`[Step 4/6] Getting view ${viewId}...`);
  const url = `${BASE}/web-api/advanced-search-api/views/${viewId}`;
  return curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 5: Get result count
// ---------------------------------------------------------------------------
function getCount(auth, dataSetId) {
  console.log(`[Step 5/6] Getting result count...`);
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/entities/count?alertMode=false&recentUpdatesMode=false`;
  return curlGet(url, auth, REFERER);
}

// ---------------------------------------------------------------------------
// Step 6: Fetch results
// ---------------------------------------------------------------------------
function fetchResults(auth, dataSetId, page, pageSize) {
  console.log(`[Step 6/6] Fetching results (page=${page}, pageSize=${pageSize})...`);
  const url = `${BASE}/web-api/advanced-search-api/tables/${dataSetId}/data?page=${page}&pageSize=${pageSize}&alertMode=false&recentUpdatesMode=false`;
  return curlPost(url, auth, {}, REFERER);
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
async function doFullSearch(auth, type, page, pageSize) {
  // Step 1: Create
  const createResult = createSearch(auth, type);
  const searchId = createResult?.searchId;
  if (!searchId) {
    console.error('Failed to create search session. Response:', JSON.stringify(createResult));
    process.exit(1);
  }
  console.log(`  searchId: ${searchId}`);
  await delay(6000);

  // Step 2: Run
  runSearch(auth, searchId);
  await delay(6000);

  // Step 3: Get metadata
  const meta = getSearchMeta(auth, searchId);
  await delay(6000);

  // Step 4: Get view — derive viewId from metadata or convention
  const tabType = type === 'DEALS' ? 'deal' : type === 'INVESTORS' ? 'investor' : 'company';
  const viewId = `${searchId}.${tabType}`;
  const viewData = getView(auth, viewId);
  const dataSetId = viewData?.dataSetId || `${searchId}.${tabType}.data_set`;
  console.log(`  dataSetId: ${dataSetId}`);
  await delay(6000);

  // Step 5: Count
  const countResult = getCount(auth, dataSetId);
  const count = countResult?.count;
  console.log(`  count: ${count}`);
  await delay(6000);

  // Step 6: Fetch results
  const results = fetchResults(auth, dataSetId, page, pageSize);

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
async function doResults(auth, searchId, page, pageSize, tab) {
  checkCurl();
  const tabType = TAB_TYPE_MAP[tab] || 'company';
  const dataSetId = `${searchId}.${tabType}.data_set`;

  const countResult = getCount(auth, dataSetId);
  const count = countResult?.count;

  const results = fetchResults(auth, dataSetId, page, pageSize);

  const outFile = resolve(CACHE_DIR, `advanced-search-${searchId}-p${page}.json`);
  saveJson(outFile, { searchId, dataSetId, count, results });
  console.log(`Results saved to: ${outFile}`);

  printSummary(results, count);
  return results;
}

// ---------------------------------------------------------------------------
// Count for existing search
// ---------------------------------------------------------------------------
function doCount(auth, searchId) {
  checkCurl();
  // Default to company tab for count
  const dataSetId = `${searchId}.company.data_set`;
  const countResult = getCount(auth, dataSetId);
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
    const auth = getAuth();
    checkCurl();
    const type = (flags.type || 'COMPANIES').toUpperCase();
    const page = parseInt(flags.page || '1', 10);
    const pageSize = parseInt(flags['page-size'] || '25', 10);
    await doFullSearch(auth, type, page, pageSize);
    break;
  }
  case 'count': {
    const searchId = positional[0];
    if (!searchId) {
      console.error('Usage: node pitchbook-advanced-search.mjs count <searchId>');
      process.exit(1);
    }
    const auth = getAuth();
    doCount(auth, searchId);
    break;
  }
  case 'results': {
    const searchId = positional[0];
    if (!searchId) {
      console.error('Usage: node pitchbook-advanced-search.mjs results <searchId> [--page=1] [--page-size=25] [--tab=companies]');
      process.exit(1);
    }
    const auth = getAuth();
    const page = parseInt(flags.page || '1', 10);
    const pageSize = parseInt(flags['page-size'] || '25', 10);
    const tab = (flags.tab || 'companies').toLowerCase();
    await doResults(auth, searchId, page, pageSize, tab);
    break;
  }
  default:
    console.log(`pitchbook-advanced-search

Run advanced/screener searches on Pitchbook via multi-step API flow.

Commands:
  auth                                        Capture session from Chrome via CDP
  search [--type=COMPANIES] [--page=1] [--page-size=25]
                                              Run a full search (create -> run -> fetch)
  count <searchId>                            Get result count for an existing search
  results <searchId> [--page=1] [--page-size=25] [--tab=companies]
                                              Fetch results for an existing search session

Search types: COMPANIES, DEALS, INVESTORS
Tab options:   companies, deals, investors

Examples:
  node pitchbook-advanced-search.mjs search
  node pitchbook-advanced-search.mjs search --type=DEALS --page=1 --page-size=50
  node pitchbook-advanced-search.mjs count s637561838
  node pitchbook-advanced-search.mjs results s637561838 --page=2 --page-size=100 --tab=companies`);
}
