#!/usr/bin/env node
// salesnav-account-search.mjs — Run ad-hoc Sales Navigator account/company searches with all 15 filter types
//
// Setup:   node salesnav-account-search.mjs auth
// Usage:   node salesnav-account-search.mjs search --industry="Technology" --headcount="E,F"
//          node salesnav-account-search.mjs filters
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

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-account-search');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_CMD = 'node salesnav-account-search.mjs auth';

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
// Filter definitions
// ---------------------------------------------------------------------------

/**
 * All 15 account search filter types mapped from CLI flags.
 *
 * Filter format types:
 *   MULTI_SELECT    -> values:List((id:<val>,selectionType:INCLUDED),...)
 *   RANGE_DROPDOWN  -> values:List((id:<rangeId>,selectionType:INCLUDED))
 *   RANGE_TEXT      -> values:List((id:<min>-<max>,selectionType:INCLUDED))
 *   TOGGLE          -> values:List((id:true,selectionType:INCLUDED))
 *   AGGREGATED      -> sub-filters (REGION + POSTAL_CODE under HEADQUARTERS_LOCATION)
 */

const HEADCOUNT_LABELS = {
  'A': 'Self-employed',
  'B': '1-10',
  'C': '11-50',
  'D': '51-200',
  'E': '201-500',
  'F': '501-1000',
  'G': '1001-5000',
  'H': '5001-10000',
  'I': '10001+',
};

const REVENUE_RANGES = {
  '1': 'Less than $1M',
  '2': '$1M-$10M',
  '3': '$10M-$50M',
  '4': '$50M-$100M',
  '5': '$100M-$500M',
  '6': '$500M-$1B',
  '7': '$1B-$10B',
  '8': '$10B+',
};

const FOLLOWER_LABELS = {
  'NFR1': '1-500',
  'NFR2': '501-1000',
  'NFR3': '1001-5000',
  'NFR4': '5001-10000',
  'NFR5': '10001+',
};

const FORTUNE_LABELS = {
  '1': 'Fortune 50',
  '2': 'Fortune 51-100',
  '3': 'Fortune 101-250',
  '4': 'Fortune 251-500',
};

const ACTIVITY_LABELS = {
  'SLC': 'Senior leadership changes',
  'RFE': 'Funding events',
};

const RELATIONSHIP_LABELS = {
  'F': 'First degree',
  'S': 'Second degree',
  'O': 'Third degree+',
};

// LinkedIn industry name → numeric ID mapping (case-insensitive lookup)
const INDUSTRY_IDS = {
  'technology': 4, 'technology, information and internet': 6, 'technology, information and media': 1594,
  'software development': 4, 'it services and it consulting': 96,
  'computer and network security': 118, 'computer networking': 13,
  'financial services': 43, 'banking': 41, 'insurance': 42,
  'investment banking': 129, 'investment management': 45, 'venture capital and private equity': 106,
  'accounting': 47, 'capital markets': 130,
  'healthcare': 14, 'hospital and health care': 14, 'medical devices': 53,
  'pharmaceuticals': 54, 'biotechnology': 49, 'health, wellness and fitness': 94,
  'manufacturing': 25, 'automotive': 26, 'aviation and aerospace': 28,
  'chemicals': 29, 'machinery': 30, 'industrial automation': 1862,
  'retail': 27, 'consumer goods': 55, 'food and beverage': 34,
  'apparel and fashion': 19, 'luxury goods and jewelry': 71,
  'education': 69, 'higher education': 68, 'e-learning': 109,
  'education management': 1999,
  'construction': 48, 'real estate': 44, 'architecture and planning': 50,
  'marketing and advertising': 80, 'public relations and communications': 85,
  'media and telecommunications': 39, 'entertainment': 18, 'media production': 1853,
  'telecommunications': 8, 'broadcast media': 1861,
  'government administration': 75, 'military': 76, 'law enforcement': 78,
  'legal services': 10, 'law practice': 9,
  'nonprofit organization management': 84, 'civic and social organization': 91,
  'transportation': 116, 'logistics and supply chain': 150, 'warehousing': 119,
  'oil and gas': 57, 'mining and metals': 56, 'utilities': 59,
  'renewables and environment': 58, 'environmental services': 86,
  'hospitality': 31, 'restaurants': 32, 'leisure, travel and tourism': 30,
  'professional services': 1810, 'management consulting': 11,
  'staffing and recruiting': 104, 'human resources': 137,
  'research': 113, 'think tanks': 114,
  'design': 36, 'graphic design': 107,
  'agriculture': 201, 'farming': 63,
  'sports': 33, 'performing arts': 37,
};

// LinkedIn region/geo name → numeric ID mapping (case-insensitive lookup)
const REGION_IDS = {
  'united states': 102571732, 'united kingdom': 101165590, 'canada': 101174742,
  'australia': 101452733, 'germany': 101282230, 'france': 105015875,
  'india': 102713980, 'brazil': 106057199, 'japan': 101355337,
  'china': 102890883, 'singapore': 102454443, 'netherlands': 102890719,
  'sweden': 105117694, 'switzerland': 106693272, 'ireland': 104738515,
  'israel': 101620260, 'spain': 105646813, 'italy': 103350119,
  'south korea': 105149562, 'mexico': 103323778, 'new zealand': 104107862,
  'south africa': 104035573, 'uae': 104305776, 'united arab emirates': 104305776,
  'saudi arabia': 100459316, 'poland': 105072130, 'belgium': 100565514,
  'austria': 103883259, 'norway': 103819153, 'denmark': 104514075,
  'finland': 100456013, 'portugal': 100364837, 'argentina': 100446943,
  'colombia': 100876405, 'chile': 104621616, 'indonesia': 102478259,
  'philippines': 103121230, 'malaysia': 106808692, 'thailand': 105146118,
  'vietnam': 104195383, 'turkey': 102105699, 'nigeria': 105365761,
  'egypt': 106155005, 'kenya': 100710962, 'russia': 101728296,
  'ukraine': 102264497, 'czech republic': 104508036, 'romania': 106670623,
  'hungary': 100288700, 'greece': 104677530,
  // US states / major metro areas
  'california': 102095887, 'new york': 105080838, 'texas': 102748797,
  'florida': 101318387, 'illinois': 102206173, 'massachusetts': 103644278,
  'washington': 103977389, 'georgia': 102579860, 'pennsylvania': 105184865,
  'colorado': 105763813, 'north carolina': 101935417, 'virginia': 102380872,
  'ohio': 101893551, 'michigan': 102110425, 'new jersey': 101651688,
  'arizona': 104960854, 'oregon': 103512726, 'minnesota': 105671231,
  'connecticut': 102838379, 'maryland': 103358965, 'utah': 104367958,
  'tennessee': 104284467, 'indiana': 103882297, 'wisconsin': 105524498,
  'missouri': 104380764, 'san francisco bay area': 90000084,
  'greater new york city area': 90000070, 'greater los angeles area': 90000049,
  'greater chicago area': 90000024, 'greater boston area': 90000013,
  'greater seattle area': 90000086, 'greater denver area': 90000031,
  'greater atlanta area': 90000005, 'greater dallas area': 90000027,
  'greater houston area': 90000042, 'greater miami area': 90000058,
  'greater washington dc area': 90000097, 'greater austin area': 90000007,
  'greater detroit area': 90000032, 'greater phoenix area': 90000076,
  'greater philadelphia area': 90000075, 'greater minneapolis area': 90000060,
  // European cities/areas
  'london': 90009496, 'berlin': 106967730, 'paris': 105285498,
  'amsterdam': 102011674, 'dublin': 104738515, 'munich': 101277560,
  'zurich': 106693272, 'stockholm': 106851035, 'barcelona': 105088894,
  'madrid': 105277424,
};

/**
 * Resolve a text name or numeric ID into a numeric ID for a given lookup map.
 * If the value is already numeric, return it as-is. Otherwise, fuzzy-match against the map.
 */
function resolveId(value, lookupMap) {
  const trimmed = value.trim();
  // If it's already a number, return it directly
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Exact case-insensitive match
  const lower = trimmed.toLowerCase();
  if (lookupMap[lower] !== undefined) return String(lookupMap[lower]);
  // Partial match: find first key that starts with the input
  for (const [key, id] of Object.entries(lookupMap)) {
    if (key.startsWith(lower)) return String(id);
  }
  // Partial match: find first key that contains the input
  for (const [key, id] of Object.entries(lookupMap)) {
    if (key.includes(lower)) return String(id);
  }
  // Fall back to using the text as-is (may produce 0 results)
  console.error(`Warning: could not resolve "${trimmed}" to a numeric ID. Pass a numeric ID or check the filters command.`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Search: build RESTLI query from CLI flags
// ---------------------------------------------------------------------------

function buildMultiSelectFilter(type, csvValues) {
  const ids = csvValues.split(',').map(v => v.trim()).filter(Boolean);
  const valuesStr = ids.map(id => `(id:${encodeURIComponent(id)},selectionType:INCLUDED)`).join(',');
  return `(type:${type},values:List(${valuesStr}))`;
}

function buildTextFilter(type, text) {
  const encoded = encodeURIComponent(text);
  return `(type:${type},values:List((id:${encoded},text:${encoded},selectionType:INCLUDED)))`;
}

function buildRangeFilter(type, rangeStr) {
  // Expects "min-max" format, e.g. "5-20"
  const encoded = encodeURIComponent(rangeStr);
  return `(type:${type},values:List((id:${encoded},selectionType:INCLUDED)))`;
}

function buildToggleFilter(type) {
  return `(type:${type},values:List((id:true,selectionType:INCLUDED)))`;
}

function buildSearchQuery(flags) {
  const filters = [];

  // 1. ANNUAL_REVENUE (RANGE_DROPDOWN) -- expects revenue range IDs like "3" or "3,4,5"
  if (flags['revenue']) {
    filters.push(buildMultiSelectFilter('ANNUAL_REVENUE', flags['revenue']));
  }

  // 2. COMPANY_HEADCOUNT (MULTI_SELECT) -- expects letter codes like "B,C,D"
  if (flags['headcount']) {
    filters.push(buildMultiSelectFilter('COMPANY_HEADCOUNT', flags['headcount']));
  }

  // 3. COMPANY_HEADCOUNT_GROWTH (RANGE_TEXT) -- expects "min-max" percentage
  if (flags['headcount-growth']) {
    filters.push(buildRangeFilter('COMPANY_HEADCOUNT_GROWTH', flags['headcount-growth']));
  }

  // 4. REGION under HEADQUARTERS_LOCATION -- accepts name (resolved to ID) or numeric ID
  if (flags['hq-region']) {
    const regions = flags['hq-region'].split(',').map(v => v.trim()).filter(Boolean);
    const valuesStr = regions.map(v => {
      const id = resolveId(v, REGION_IDS);
      const text = encodeURIComponent(v);
      return `(id:${id},text:${text},selectionType:INCLUDED)`;
    }).join(',');
    filters.push(`(type:REGION,values:List(${valuesStr}))`);
  }

  // 5. POSTAL_CODE under HEADQUARTERS_LOCATION -- with optional radius
  if (flags['hq-postal']) {
    const radius = flags['radius'] || '25';
    const encoded = encodeURIComponent(flags['hq-postal']);
    filters.push(`(type:POSTAL_CODE,values:List((id:${encoded},selectionType:INCLUDED)),subFilter:(radius:${radius}))`);
  }

  // 6. INDUSTRY (MULTI_SELECT) -- accepts name (resolved to ID) or numeric ID
  if (flags['industry']) {
    const industries = flags['industry'].split(',').map(v => v.trim()).filter(Boolean);
    const valuesStr = industries.map(v => {
      const id = resolveId(v, INDUSTRY_IDS);
      const text = encodeURIComponent(v);
      return `(id:${id},text:${text},selectionType:INCLUDED)`;
    }).join(',');
    filters.push(`(type:INDUSTRY,values:List(${valuesStr}))`);
  }

  // 7. NUM_OF_FOLLOWERS (MULTI_SELECT) -- expects codes like "NFR1,NFR2"
  if (flags['followers']) {
    filters.push(buildMultiSelectFilter('NUM_OF_FOLLOWERS', flags['followers']));
  }

  // 8. DEPARTMENT_HEADCOUNT (RANGE_TEXT) -- expects "min-max"
  if (flags['dept-headcount']) {
    filters.push(buildRangeFilter('DEPARTMENT_HEADCOUNT', flags['dept-headcount']));
  }

  // 9. DEPARTMENT_HEADCOUNT_GROWTH (RANGE_TEXT) -- expects "min-max" percentage
  if (flags['dept-growth']) {
    filters.push(buildRangeFilter('DEPARTMENT_HEADCOUNT_GROWTH', flags['dept-growth']));
  }

  // 10. FORTUNE (MULTI_SELECT) -- expects "1,2,3"
  if (flags['fortune']) {
    filters.push(buildMultiSelectFilter('FORTUNE', flags['fortune']));
  }

  // 11. JOB_OPPORTUNITIES (TOGGLE)
  if (flags['job-opportunities'] !== undefined) {
    filters.push(buildToggleFilter('JOB_OPPORTUNITIES'));
  }

  // 12. ACCOUNT_ACTIVITIES (MULTI_SELECT) -- expects "SLC,RFE"
  if (flags['activities']) {
    filters.push(buildMultiSelectFilter('ACCOUNT_ACTIVITIES', flags['activities']));
  }

  // 13. RELATIONSHIP (MULTI_SELECT) -- expects "F,S"
  if (flags['relationship']) {
    filters.push(buildMultiSelectFilter('RELATIONSHIP', flags['relationship']));
  }

  // 14. ACCOUNTS_IN_CRM (TOGGLE)
  if (flags['in-crm'] !== undefined) {
    filters.push(buildToggleFilter('ACCOUNTS_IN_CRM'));
  }

  // 15. SAVED_ACCOUNTS (TOGGLE)
  if (flags['saved'] !== undefined) {
    filters.push(buildToggleFilter('SAVED_ACCOUNTS'));
  }

  // 16. ACCOUNT_LIST (MULTI_SELECT) -- expects list ID(s)
  if (flags['account-list']) {
    filters.push(buildMultiSelectFilter('ACCOUNT_LIST', flags['account-list']));
  }

  // Keyword (free-text, not a numbered filter but supported by the API)
  if (flags['keyword']) {
    const encoded = encodeURIComponent(flags['keyword']);
    filters.push(`(type:KEYWORDS,values:List((text:${encoded})))`);
  }

  if (filters.length === 0) {
    console.error('Error: at least one search filter is required. Run "filters" command for help.');
    process.exit(1);
  }

  const filtersStr = `List(${filters.join(',')})`;
  return `(spellCorrectionEnabled:true,recentSearchParam:(doLogHistory:false),filters:${filtersStr})`;
}

function searchAccounts(flags, { start = 0, count = 25 } = {}) {
  const query = buildSearchQuery(flags);
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');

  const url = `https://www.linkedin.com/sales-api/salesApiAccountSearch`
    + `?q=searchQuery`
    + `&query=${query}`
    + `&start=${start}`
    + `&count=${count}`
    + `&trackingParam=(sessionId:${sid})`
    + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4`;

  const data = apiFetch(url, {}, { authCmd: AUTH_CMD });

  const accounts = (data.elements || []).map(el => {
    const urnMatch = (el.entityUrn || '').match(/fs_salesCompany:(\d+)/);
    return {
      companyId: urnMatch ? urnMatch[1] : null,
      companyName: el.companyName,
      description: el.description,
      industry: el.industry,
      employeeCountRange: el.employeeCountRange,
      employeeDisplayCount: el.employeeDisplayCount,
      entityUrn: el.entityUrn,
      saved: el.saved,
      listCount: el.listCount,
      spotlightBadges: el.spotlightBadges || [],
      trackingId: el.trackingId,
    };
  });

  return {
    total: data.paging?.total ?? data.metadata?.totalDisplayCount ?? accounts.length,
    start,
    count: accounts.length,
    accounts,
  };
}

// ---------------------------------------------------------------------------
// Filters: show all available filter types
// ---------------------------------------------------------------------------

function showFilters() {
  console.log(`salesnav-account-search — All 15+ account search filters

COMPANY ATTRIBUTES:
  --revenue="<ids>"              Annual revenue range IDs (comma-separated)
                                   1=<$1M  2=$1M-$10M  3=$10M-$50M  4=$50M-$100M
                                   5=$100M-$500M  6=$500M-$1B  7=$1B-$10B  8=$10B+
                                   Example: --revenue="3,4,5"

  --headcount="<codes>"          Company headcount ranges (comma-separated letter codes)
                                   A=Self-employed  B=1-10  C=11-50  D=51-200
                                   E=201-500  F=501-1000  G=1001-5000
                                   H=5001-10000  I=10001+
                                   Example: --headcount="E,F,G"

  --headcount-growth="<min>-<max>"  Headcount growth percentage range
                                   Example: --headcount-growth="5-20"

  --hq-region="<region>"         Headquarters region (text)
                                   Example: --hq-region="United States"

  --hq-postal="<code>"           Headquarters postal code (with --radius=<miles>)
                                   Example: --hq-postal="94105" --radius=25

  --industry="<name>"            Industry name (text)
                                   Example: --industry="Technology"

  --followers="<codes>"          Number of followers (comma-separated)
                                   NFR1=1-500  NFR2=501-1000  NFR3=1001-5000
                                   NFR4=5001-10000  NFR5=10001+
                                   Example: --followers="NFR3,NFR4,NFR5"

  --dept-headcount="<min>-<max>"    Department headcount range
                                   Example: --dept-headcount="10-50"

  --dept-growth="<min>-<max>"    Department headcount growth percentage range
                                   Example: --dept-growth="5-20"

  --fortune="<ids>"              Fortune ranking (comma-separated)
                                   1=Fortune 50  2=Fortune 51-100
                                   3=Fortune 101-250  4=Fortune 251-500
                                   Example: --fortune="1,2"

SPOTLIGHTS:
  --job-opportunities            Companies with job postings (toggle, no value needed)

  --activities="<codes>"         Recent activities (comma-separated)
                                   SLC=Senior leadership changes
                                   RFE=Funding events
                                   Example: --activities="SLC,RFE"

  --relationship="<codes>"       Connection degree (comma-separated)
                                   F=First degree  S=Second degree  O=Third degree+
                                   Example: --relationship="F,S"

WORKFLOW:
  --in-crm                       Companies in your CRM (toggle, no value needed)

  --saved                        Saved accounts only (toggle, no value needed)

  --account-list="<id>"          Account list ID(s) (comma-separated)
                                   Example: --account-list="12345"

GENERAL:
  --keyword="<text>"             Free-text keyword search
                                   Example: --keyword="artificial intelligence"

PAGINATION:
  --count=25                     Results per page (default: 25)
  --start=0                      Offset (default: 0)
`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    // Handle both --flag=value and --flag (toggle)
    const matchVal = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (matchVal) {
      flags[matchVal[1]] = matchVal[2];
    } else if (arg.startsWith('--')) {
      // Toggle flag (no value)
      const name = arg.replace(/^--/, '');
      flags[name] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** Build a slug from search flags for cache filenames */
function searchSlug(flags) {
  const parts = [];
  for (const key of ['keyword', 'industry', 'headcount', 'revenue', 'hq-region', 'fortune']) {
    if (flags[key] && typeof flags[key] === 'string') parts.push(`${key}-${flags[key]}`);
  }
  return parts.join('_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80) || 'search';
}

const SEARCH_FLAGS = [
  'keyword', 'revenue', 'headcount', 'headcount-growth', 'hq-region', 'hq-postal',
  'industry', 'followers', 'dept-headcount', 'dept-growth', 'fortune',
  'job-opportunities', 'activities', 'relationship', 'in-crm', 'saved', 'account-list',
];

function hasAnySearchFlag(flags) {
  return SEARCH_FLAGS.some(f => flags[f] !== undefined);
}

switch (command) {
  case 'auth': {
    cdpDoAuth(SESSION_FILE, saveJson);
    break;
  }

  case 'search': {
    const { flags } = parseFlags(args);
    if (!hasAnySearchFlag(flags)) {
      console.error('Usage: node salesnav-account-search.mjs search --industry="Technology" [--headcount="E,F"] [--count=25] [--start=0]');
      console.error('\nAt least one search filter is required. Run "filters" command for all options.');
      process.exit(1);
    }

    requireAuth(SESSION_FILE, loadJson, AUTH_CMD);
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    const filterSummary = Object.entries(flags)
      .filter(([k]) => !['start', 'count', 'radius'].includes(k))
      .map(([k, v]) => v === true ? k : `${k}="${v}"`)
      .join(', ');
    console.log(`Searching accounts: ${filterSummary} (start=${start}, count=${count})...`);

    const result = searchAccounts(flags, { start, count });
    console.log(`Found ${result.total} total accounts, returned ${result.count}`);

    // Save results
    const slug = searchSlug(flags);
    const outFile = resolve(CACHE_DIR, `search-${slug}-${Date.now()}.json`);
    saveJson(outFile, result);
    console.log(`Results saved to: ${outFile}`);

    // Print summary
    for (const acct of result.accounts) {
      const badges = acct.spotlightBadges.length > 0 ? ` [${acct.spotlightBadges.map(b => b.displayValue || b.label || b.type || b.id || '').filter(Boolean).join(', ')}]` : '';
      console.log(`  ${acct.companyName} — ${acct.industry || 'N/A'} — ${acct.employeeDisplayCount || acct.employeeCountRange || 'N/A'} employees${badges}`);
    }
    break;
  }

  case 'filters': {
    showFilters();
    break;
  }

  default:
    console.log(`salesnav-account-search — Sales Navigator account/company search with all filter types

Commands:
  auth                                        Authenticate via Chrome (one-time)
  search --industry="..." [filters] [opts]    Run an ad-hoc account search
  filters                                     Show all available filter types and usage

Search filters (at least one required):
  --keyword="..."             Free-text keyword search
  --revenue="3,4,5"           Annual revenue range IDs
  --headcount="E,F,G"         Company headcount letter codes
  --headcount-growth="5-20"   Headcount growth percentage range
  --hq-region="United States" Headquarters region
  --hq-postal="94105"         Headquarters postal code (with --radius=25)
  --industry="Technology"     Industry name
  --followers="NFR3,NFR4"     Number of followers codes
  --dept-headcount="10-50"    Department headcount range
  --dept-growth="5-20"        Department headcount growth range
  --fortune="1,2"             Fortune ranking
  --job-opportunities         Companies with job postings
  --activities="SLC,RFE"      Recent activities
  --relationship="F,S"        Connection degree
  --in-crm                    Companies in CRM
  --saved                     Saved accounts only
  --account-list="12345"      Account list ID(s)

Pagination:
  --count=25          Results per page (default: 25)
  --start=0           Offset (default: 0)

Run "filters" for detailed descriptions and value codes.

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Search results`);
}
