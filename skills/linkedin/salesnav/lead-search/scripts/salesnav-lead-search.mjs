#!/usr/bin/env node
// salesnav-lead-search.mjs — Ad-hoc Sales Navigator lead searches with ALL 33+ filter types
//
// Setup:   node salesnav-lead-search.mjs auth
// Usage:   node salesnav-lead-search.mjs search --title="CTO" --company="Microsoft"
//          node salesnav-lead-search.mjs filters
//          node salesnav-lead-search.mjs profiles <id1,id2,...>
//          node salesnav-lead-search.mjs search-profiles --title="VP Engineering" --headcount="E,F"
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { ensureFreshAuth, fetchAuthed } from '../../../_shared/li-auth.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-lead-search');
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------


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

function getAuth() {
  try {
    const auth = ensureFreshAuth({ sessionFile: SESSION_FILE });
    if (!auth.cookie) {
      console.error('No auth found. Run: node salesnav-lead-search.mjs auth');
      process.exit(1);
    }
    return auth;
  } catch (err) {
    console.error(`Could not refresh auth from Chrome: ${err.message}`);
    const cached = loadJson(SESSION_FILE);
    if (cached.cookie) {
      console.error('Falling back to cached session.json (may be stale).');
      return cached;
    }
    process.exit(1);
  }
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

async function apiFetch(auth, url) {
  const resp = await fetchAuthed(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-lead-search.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Filter definitions — ALL 33+ filter types
// ---------------------------------------------------------------------------

/**
 * Filter registry. Each entry maps a CLI flag to its Sales Nav filter type.
 *
 * kind:
 *   'text'     — free-text value, sent as (id:<val>,text:<val>,selectionType:INCLUDED)
 *   'text-only'— free-text value, sent as (text:<val>,selectionType:INCLUDED) — NO id field
 *   'id-only'  — value is an ID/code, sent as (id:<val>,selectionType:INCLUDED) — NO text field
 *   'id-text'  — value is "id:text" or just text, sent as (id:<val>,text:<val>,selectionType:INCLUDED)
 *   'toggle'   — boolean flag, sent as (id:true,selectionType:INCLUDED)
 */
const FILTER_REGISTRY = [
  // --- Company group ---
  { flag: 'company',        type: 'CURRENT_COMPANY',            kind: 'id-text', excludeFlag: 'exclude-company' },
  { flag: 'headcount',      type: 'COMPANY_HEADCOUNT',          kind: 'id-only' },
  { flag: 'past-company',   type: 'PAST_COMPANY',               kind: 'id-text', excludeFlag: 'exclude-past-company' },
  { flag: 'company-type',   type: 'COMPANY_TYPE',               kind: 'id-only' },
  { flag: 'company-hq',     type: 'COMPANY_HEADQUARTERS',       kind: 'id-text', excludeFlag: 'exclude-company-hq' },

  // --- Role group ---
  { flag: 'function',       type: 'FUNCTION',                   kind: 'text-only' },
  { flag: 'title',          type: 'CURRENT_TITLE',              kind: 'text-only' },
  { flag: 'seniority',      type: 'SENIORITY_LEVEL',            kind: 'id-only' },
  { flag: 'past-title',     type: 'PAST_TITLE',                 kind: 'text-only' },
  { flag: 'years-at-company',    type: 'YEARS_AT_CURRENT_COMPANY',   kind: 'id-only' },
  { flag: 'years-in-position',   type: 'YEARS_IN_CURRENT_POSITION',  kind: 'id-only' },

  // --- Personal group ---
  { flag: 'region',         type: 'REGION',                     kind: 'id-text', excludeFlag: 'exclude-region' },
  { flag: 'postal-code',    type: 'POSTAL_CODE',                kind: 'id-text' },
  { flag: 'industry',       type: 'INDUSTRY',                   kind: 'text-only' },
  { flag: 'first-name',     type: 'FIRST_NAME',                 kind: 'text' },
  { flag: 'last-name',      type: 'LAST_NAME',                  kind: 'text' },
  { flag: 'profile-language', type: 'PROFILE_LANGUAGE',          kind: 'id-only' },
  { flag: 'years-experience', type: 'YEARS_OF_EXPERIENCE',       kind: 'id-only' },
  { flag: 'group',          type: 'GROUP',                      kind: 'text-only' },
  { flag: 'school',         type: 'SCHOOL',                     kind: 'text-only' },

  // --- Buyer Intent group ---
  { flag: 'follows-company',  type: 'FOLLOWS_YOUR_COMPANY',     kind: 'toggle' },
  { flag: 'viewed-profile',   type: 'VIEWED_YOUR_PROFILE',      kind: 'toggle' },

  // --- Best Path In group ---
  { flag: 'relationship',     type: 'RELATIONSHIP',             kind: 'id-only' },
  { flag: 'connection-of',    type: 'CONNECTION_OF',             kind: 'id-text' },
  { flag: 'past-colleague',   type: 'PAST_COLLEAGUE',           kind: 'toggle' },
  { flag: 'shared-experiences', type: 'WITH_SHARED_EXPERIENCES', kind: 'toggle' },

  // --- Recent Updates group ---
  { flag: 'changed-jobs',       type: 'RECENTLY_CHANGED_JOBS',  kind: 'toggle' },
  { flag: 'posted-on-linkedin', type: 'POSTED_ON_LINKEDIN',     kind: 'toggle' },

  // --- Workflow group ---
  { flag: 'persona',          type: 'PERSONA',                  kind: 'id-text' },
  { flag: 'account-list',     type: 'ACCOUNT_LIST',             kind: 'id-only' },
  { flag: 'lead-list',        type: 'LEAD_LIST',                kind: 'id-only' },
  { flag: 'in-crm',           type: 'LEADS_IN_CRM',             kind: 'id-only' },
  { flag: 'interacted-with',  type: 'LEAD_INTERACTIONS',        kind: 'id-only' },
  { flag: 'saved',            type: 'SAVED_LEADS_AND_ACCOUNTS', kind: 'id-only' },
];

// Lookup for quick access
const FILTER_BY_FLAG = Object.fromEntries(FILTER_REGISTRY.map(f => [f.flag, f]));

// All recognized filter flags (including exclude- variants)
const ALL_FILTER_FLAGS = new Set();
for (const f of FILTER_REGISTRY) {
  ALL_FILTER_FLAGS.add(f.flag);
  if (f.excludeFlag) ALL_FILTER_FLAGS.add(f.excludeFlag);
}

// Headcount code lookup
const HEADCOUNT_LABELS = {
  'B': '1-10', 'C': '11-50', 'D': '51-200', 'E': '201-500',
  'F': '501-1000', 'G': '1001-5000', 'H': '5001-10000', 'I': '10001+',
};

// Region name → LinkedIn geo ID mapping (case-insensitive)
const REGION_IDS = {
  'united states': 102571732, 'united kingdom': 101165590, 'canada': 101174742,
  'australia': 101452733, 'germany': 101282230, 'france': 105015875,
  'india': 102713980, 'brazil': 106057199, 'japan': 101355337,
  'singapore': 102454443, 'netherlands': 102890719, 'ireland': 104738515,
  'israel': 101620260, 'spain': 105646813, 'italy': 103350119,
  'sweden': 105117694, 'switzerland': 106693272, 'mexico': 103323778,
  'south korea': 105149562, 'china': 102890883, 'new zealand': 104107862,
  'uae': 104305776, 'united arab emirates': 104305776, 'turkey': 102105699,
  'poland': 105072130, 'belgium': 100565514, 'norway': 103819153,
  'denmark': 104514075, 'finland': 100456013, 'austria': 103883259,
  'san francisco bay area': 90000084, 'greater new york city area': 90000070,
  'greater los angeles area': 90000049, 'greater chicago area': 90000024,
  'greater boston area': 90000013, 'greater seattle area': 90000086,
  'greater london area': 90009496, 'california': 102095887, 'new york': 105080838,
  'texas': 102748797, 'florida': 101318387, 'illinois': 102206173,
  'massachusetts': 103644278, 'washington': 103977389, 'colorado': 105763813,
};

/**
 * Resolve a text name to a numeric ID. Returns the value as-is if already numeric.
 */
function resolveGeoId(value) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (REGION_IDS[lower] !== undefined) return String(REGION_IDS[lower]);
  for (const [key, id] of Object.entries(REGION_IDS)) {
    if (key.includes(lower)) return String(id);
  }
  return trimmed; // fallback: pass through as-is
}

// ---------------------------------------------------------------------------
// Build RESTLI query from CLI flags
// ---------------------------------------------------------------------------

// id-only: (id:<val>,selectionType:X) — for code-based filters (headcount, seniority, etc.)
function buildIdOnlyValues(value, selectionType) {
  return value.split(',').map(v => {
    const trimmed = v.trim();
    return `(id:${trimmed},selectionType:${selectionType})`;
  });
}

// text-only: (text:<val>,selectionType:X) — for text-search filters (title, function, industry, etc.)
function buildTextOnlyValues(value, selectionType) {
  return value.split(',').map(v => {
    const trimmed = v.trim();
    return `(text:${trimmed},selectionType:${selectionType})`;
  });
}

// id+text: (id:<val>,text:<val>,selectionType:X) — for entity filters (company, region, etc.)
// Optional idResolver converts text names to numeric IDs (e.g., "United States" → "102571732")
function buildIdTextValues(value, selectionType, idResolver) {
  return value.split(',').map(v => {
    const trimmed = v.trim();
    const id = idResolver ? idResolver(trimmed) : trimmed;
    return `(id:${id},text:${encodeURIComponent(trimmed)},selectionType:${selectionType})`;
  });
}

// text fields like FIRST_NAME, LAST_NAME: (id:<val>,text:<val>,selectionType:INCLUDED)
function buildTextFieldValues(value) {
  return [`(id:${value},text:${value},selectionType:INCLUDED)`];
}

function buildToggleValues() {
  return ['(id:true,selectionType:INCLUDED)'];
}

function buildSearchQuery(flags) {
  const filters = [];

  // Keywords use text-only format
  if (flags.keyword) {
    filters.push(`(type:KEYWORDS,values:List((text:${flags.keyword},selectionType:INCLUDED)))`);
  }

  for (const def of FILTER_REGISTRY) {
    const includeVal = flags[def.flag];
    const excludeVal = def.excludeFlag ? flags[def.excludeFlag] : undefined;

    if (!includeVal && !excludeVal) continue;

    const values = [];

    if (includeVal) {
      switch (def.kind) {
        case 'text':
          values.push(...buildTextFieldValues(includeVal));
          break;
        case 'text-only':
          values.push(...buildTextOnlyValues(includeVal, 'INCLUDED'));
          break;
        case 'id-only':
          values.push(...buildIdOnlyValues(includeVal, 'INCLUDED'));
          break;
        case 'id-text': {
          // Use geo ID resolver for region/location filters
          const resolver = ['REGION', 'COMPANY_HEADQUARTERS', 'POSTAL_CODE'].includes(def.type) ? resolveGeoId : undefined;
          values.push(...buildIdTextValues(includeVal, 'INCLUDED', resolver));
          break;
        }
        case 'toggle':
          values.push(...buildToggleValues());
          break;
        default:
          values.push(...buildIdTextValues(includeVal, 'INCLUDED'));
          break;
      }
    }

    if (excludeVal) {
      const resolver = ['REGION', 'COMPANY_HEADQUARTERS', 'POSTAL_CODE'].includes(def.type) ? resolveGeoId : undefined;
      switch (def.kind) {
        case 'text-only':
          values.push(...buildTextOnlyValues(excludeVal, 'EXCLUDED'));
          break;
        case 'id-only':
          values.push(...buildIdOnlyValues(excludeVal, 'EXCLUDED'));
          break;
        default:
          values.push(...buildIdTextValues(excludeVal, 'EXCLUDED', resolver));
          break;
      }
    }

    // Handle postal code radius subfilter
    if (def.type === 'POSTAL_CODE' && flags.radius) {
      filters.push(`(type:${def.type},values:List(${values.join(',')}),subFilter:(type:POSTAL_RADIUS,values:List((id:${flags.radius},text:${flags.radius},selectionType:INCLUDED))))`);
    } else {
      filters.push(`(type:${def.type},values:List(${values.join(',')}))`);
    }
  }

  if (filters.length === 0) {
    console.error('Error: at least one search filter is required.');
    console.error('Run: node salesnav-lead-search.mjs filters  to see all available filters.');
    process.exit(1);
  }

  const filtersStr = `List(${filters.join(',')})`;
  return `(spellCorrectionEnabled:true,recentSearchParam:(doLogHistory:false),filters:${filtersStr})`;
}

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

async function searchLeads(auth, flags, { start = 0, count = 25 } = {}) {
  const query = buildSearchQuery(flags);
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');

  const url = `https://www.linkedin.com/sales-api/salesApiLeadSearch`
    + `?q=searchQuery`
    + `&query=${query}`
    + `&start=${start}`
    + `&count=${count}`
    + `&trackingParam=(sessionId:${sid})`
    + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14`;

  const data = await apiFetch(auth, url);

  const leads = (data.elements || []).map(el => {
    const urnMatch = (el.entityUrn || '').match(/\(([^,]+)/);
    return {
      profileId: urnMatch ? urnMatch[1] : null,
      fullName: el.fullName,
      firstName: el.firstName,
      lastName: el.lastName,
      headline: el.currentPositions?.[0]?.title,
      company: el.currentPositions?.[0]?.companyName,
      location: el.geoRegion,
      degree: el.degree,
      premium: el.premium,
      entityUrn: el.entityUrn,
    };
  });

  return {
    total: data.paging?.total ?? data.metadata?.totalDisplayCount ?? leads.length,
    start,
    count: leads.length,
    leads,
    profileIds: leads.map(l => l.profileId).filter(Boolean),
  };
}

/**
 * Paginate through all search results up to maxResults.
 * Adds 3-5 second delays between pages to respect rate limits.
 */
async function searchAllLeads(auth, flags, { maxResults = 2500, pageSize = 25 } = {}) {
  let start = 0;
  let allLeads = [];
  let total = 0;

  while (start < maxResults) {
    const count = Math.min(pageSize, maxResults - start);
    const result = await searchLeads(auth, flags, { start, count });
    total = result.total;
    allLeads = allLeads.concat(result.leads);

    console.log(`  Fetched ${allLeads.length} / ${total} leads (page at offset ${start})`);

    if (result.leads.length < count || allLeads.length >= total || allLeads.length >= maxResults) break;
    start += count;

    // Rate limit: 3-5 second delay between pages
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }

  return {
    total,
    count: allLeads.length,
    leads: allLeads,
    profileIds: allLeads.map(l => l.profileId).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Percent-encode REST-li decoration strings for the decoration= query param
// ---------------------------------------------------------------------------

function encodeDecoration(str) {
  return str
    .replace(/%/g, '%25').replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/,/g, '%2C').replace(/\*/g, '%2A').replace(/~/g, '%7E')
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/ /g, '%20');
}

// ---------------------------------------------------------------------------
// Profiles: batch fetch full profile data
// ---------------------------------------------------------------------------

const PROFILE_DECORATION =
  '(entityUrn,objectUrn,firstName,lastName,fullName,headline,memberBadges,pronoun,degree,'
  + 'profileUnlockInfo,latestTouchPointActivity,location,listCount,summary,savedLead,'
  + 'defaultPosition,contactInfo,crmStatus,pendingInvitation,unlocked,flagshipProfileUrl,'
  + 'fullNamePronunciationAudio,memorialized,numOfConnections,numOfSharedConnections,'
  + 'showTotalConnectionsPage,profilePictureDisplayImage,profileBackgroundPicture,'
  + 'relatedColleagueCompanyId,blockThirdPartyDataSharing,noteCount,'
  + 'positions*(companyName,current,new,description,endedOn,posId,startedOn,title,location,richMedia*,'
  + 'companyUrn~fs_salesCompany(entityUrn,name,companyPictureDisplayImage)),'
  + 'educations*(degree,eduId,endedOn,schoolName,startedOn,fieldsOfStudy*,richMedia*,'
  + 'school~fs_salesSchool(entityUrn,logoId,name,url,schoolPictureDisplayImage)),'
  + 'skills*,languages*)';

async function fetchProfiles(auth, profileIds) {
  const BATCH_SIZE = 25;
  const allProfiles = [];

  for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
    const batch = profileIds.slice(i, i + BATCH_SIZE);
    const idsParam = batch
      .map(id => `(profileId:${id},authType:undefined,authToken:undefined)`)
      .join(',');

    const url = `https://www.linkedin.com/sales-api/salesApiProfiles`
      + `?ids=List(${idsParam})`
      + `&decoration=${encodeDecoration(PROFILE_DECORATION)}`;

    const data = await apiFetch(auth, url);
    const results = data.results || {};
    for (const [, profile] of Object.entries(results)) {
      allProfiles.push(profile);
    }

    if (i + BATCH_SIZE < profileIds.length) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    }
  }

  return allProfiles;
}

function formatProfile(p) {
  return {
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    headline: p.headline,
    location: p.location,
    summary: p.summary,
    linkedinUrl: p.flagshipProfileUrl,
    entityUrn: p.entityUrn,
    objectUrn: p.objectUrn,
    connections: p.numOfConnections,
    sharedConnections: p.numOfSharedConnections,
    contactInfo: p.contactInfo || {},
    positions: (p.positions || []).map(pos => ({
      title: pos.title,
      company: pos.companyName,
      location: pos.location,
      current: pos.current,
      startedOn: pos.startedOn,
      endedOn: pos.endedOn,
      description: pos.description,
    })),
    educations: (p.educations || []).map(edu => ({
      school: edu.schoolName,
      degree: edu.degree,
      fields: edu.fieldsOfStudy,
      startedOn: edu.startedOn,
      endedOn: edu.endedOn,
    })),
    skills: p.skills || [],
    languages: p.languages || [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    // Handle --flag=value
    const eqMatch = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (eqMatch) { flags[eqMatch[1]] = eqMatch[2]; continue; }
    // Handle bare --flag (for toggles)
    const bareMatch = arg.match(/^--(\w[\w-]*)$/);
    if (bareMatch) { flags[bareMatch[1]] = 'true'; continue; }
    positional.push(arg);
  }
  return { flags, positional };
}

function searchSlug(flags) {
  const parts = [];
  for (const [key, val] of Object.entries(flags)) {
    if (['start', 'count', 'max', 'radius'].includes(key)) continue;
    parts.push(`${key}-${val}`);
  }
  return parts.join('_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80) || 'search';
}

function hasAnySearchFilter(flags) {
  if (flags.keyword) return true;
  for (const def of FILTER_REGISTRY) {
    if (flags[def.flag]) return true;
    if (def.excludeFlag && flags[def.excludeFlag]) return true;
  }
  return false;
}

function printFilterHelp() {
  console.log(`
All available filter types for Sales Navigator lead search:

COMPANY GROUP:
  --company="Microsoft"              Current company (typeahead, multi)
  --exclude-company="Google"         Exclude current company
  --headcount="B,C,D"               Company headcount
                                      B=1-10, C=11-50, D=51-200, E=201-500
                                      F=501-1000, G=1001-5000, H=5001-10000, I=10001+
  --past-company="Google"            Past company (typeahead, multi)
  --exclude-past-company="Apple"     Exclude past company
  --company-type="PUBLIC,PRIVATE"    Company type
  --company-hq="United States"       Company HQ location (typeahead, multi)
  --exclude-company-hq="China"       Exclude company HQ

ROLE GROUP:
  --function="Engineering,Sales"     Job function
  --title="CTO,VP Engineering"       Current job title (multi)
  --seniority="VP,CXO,DIRECTOR"     Seniority level
  --past-title="Software Engineer"   Past job title (multi)
  --years-at-company="1-2,3-5"      Years at current company
  --years-in-position="1-2,3-5"     Years in current position

PERSONAL GROUP:
  --region="San Francisco Bay Area"  Geography region (typeahead, multi)
  --exclude-region="New York"        Exclude region
  --postal-code="94105"             Postal code (use with --radius)
  --radius=25                        Radius in miles (for postal code: 1/5/10/25/35/50/75/100)
  --industry="Technology,Finance"    Industry (multi)
  --first-name="John"               First name (text)
  --last-name="Smith"               Last name (text)
  --profile-language="en,es"         Profile language (multi)
  --years-experience="5-10,11+"      Years of experience (multi)
  --group="..."                      LinkedIn group (multi)
  --school="Stanford"                School (multi)

BUYER INTENT GROUP:
  --follows-company                  Follows your company (toggle)
  --viewed-profile                   Viewed your profile (toggle)

BEST PATH IN GROUP:
  --relationship="F,S"              Connection degree (F=1st, S=2nd)
  --connection-of="..."             Connections of specific person
  --past-colleague                   Past colleague (toggle)
  --shared-experiences               Shared experiences (toggle)

RECENT UPDATES GROUP:
  --changed-jobs                     Recently changed jobs (toggle)
  --posted-on-linkedin               Posted on LinkedIn recently (toggle)

WORKFLOW GROUP:
  --persona="..."                    Sales Nav persona
  --account-list="..."               Account list (multi)
  --lead-list="..."                  Lead list (multi)
  --in-crm="..."                     People in CRM (multi)
  --interacted-with="..."            People you interacted with (multi)
  --saved="..."                      Saved leads and accounts (multi)

SPECIAL:
  --keyword="software engineer"      Free-text keyword search

PAGINATION:
  --count=25                         Results per page (default: 25, max: 25)
  --start=0                          Offset (default: 0)
  --max=100                          Max results for search-profiles (default: all pages)

EXAMPLES:
  node salesnav-lead-search.mjs search --title="CTO" --headcount="E,F,G"
  node salesnav-lead-search.mjs search --company="Microsoft" --seniority="VP,CXO" --region="San Francisco Bay Area"
  node salesnav-lead-search.mjs search --keyword="machine learning" --industry="Technology" --years-experience="6-10"
  node salesnav-lead-search.mjs search --title="VP Engineering" --company="Stripe" --exclude-company="Google"
  node salesnav-lead-search.mjs search --first-name="John" --last-name="Smith" --company="Apple"
  node salesnav-lead-search.mjs search --changed-jobs --seniority="CXO" --headcount="G,H,I"
  node salesnav-lead-search.mjs search --postal-code="94105" --radius=25 --title="Engineering Manager"
  node salesnav-lead-search.mjs search-profiles --title="CTO" --headcount="D,E" --max=50
`);
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'filters': {
    printFilterHelp();
    break;
  }

  case 'search': {
    const { flags } = parseFlags(args);
    if (!hasAnySearchFilter(flags)) {
      console.error('Usage: node salesnav-lead-search.mjs search --title="..." [--company="..."] [filters...]');
      console.error('\nAt least one search filter is required.');
      console.error('Run: node salesnav-lead-search.mjs filters  to see all available filters.');
      process.exit(1);
    }

    const auth = getAuth();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    const filterSummary = Object.entries(flags)
      .filter(([k]) => !['start', 'count', 'max', 'radius'].includes(k))
      .map(([k, v]) => v === 'true' ? `--${k}` : `${k}="${v}"`)
      .join(', ');
    console.log(`Searching leads: ${filterSummary} (start=${start}, count=${count})...`);

    const result = await searchLeads(auth, flags, { start, count });
    console.log(`Found ${result.total} total leads, returned ${result.count}`);

    const slug = searchSlug(flags);
    const outFile = resolve(CACHE_DIR, `search-${slug}-${Date.now()}.json`);
    saveJson(outFile, result);
    console.log(`Results saved to: ${outFile}`);

    for (const lead of result.leads) {
      console.log(`  ${lead.fullName} -- ${lead.headline || ''} @ ${lead.company || ''} (${lead.location || ''})`);
    }
    break;
  }

  case 'profiles': {
    const rawIds = args[0]?.split(',').filter(Boolean);
    if (!rawIds?.length) {
      console.error('Usage: node salesnav-lead-search.mjs profiles <id1,id2,...>');
      console.error('  Accepts comma-separated Sales Nav profile IDs (max 25 per batch).');
      console.error('  IDs look like: ACwAABJVBJEB...');
      console.error('  Also accepts URNs: urn:li:fsd_profile:ACoAA..., urn:li:fs_salesProfile:(ACwAA...,...)');
      process.exit(1);
    }
    const profileIds = rawIds.map(id => {
      const fsdMatch = id.match(/fsd_profile:([^,)]+)/);
      if (fsdMatch) return fsdMatch[1];
      const salesMatch = id.match(/salesProfile:\(([^,]+)/);
      if (salesMatch) return salesMatch[1];
      return id;
    });

    const auth = getAuth();
    console.log(`Fetching ${profileIds.length} profiles...`);
    const profiles = await fetchProfiles(auth, profileIds);
    const formatted = profiles.map(formatProfile);

    const outFile = resolve(CACHE_DIR, `profiles-${Date.now()}.json`);
    saveJson(outFile, formatted);
    console.log(`${formatted.length} profiles saved to: ${outFile}`);

    for (const p of formatted) {
      const pos = p.positions.find(x => x.current);
      console.log(`  ${p.fullName} -- ${pos?.title || p.headline} @ ${pos?.company || ''}`);
      if (p.contactInfo?.primaryEmail) console.log(`    Email: ${p.contactInfo.primaryEmail}`);
      if (p.linkedinUrl) console.log(`    LinkedIn: ${p.linkedinUrl}`);
    }
    break;
  }

  case 'search-profiles': {
    const { flags } = parseFlags(args);
    if (!hasAnySearchFilter(flags)) {
      console.error('Usage: node salesnav-lead-search.mjs search-profiles --title="..." [--company="..."] [filters...]');
      console.error('\nAt least one search filter is required.');
      console.error('Run: node salesnav-lead-search.mjs filters  to see all available filters.');
      process.exit(1);
    }

    const auth = getAuth();
    const maxResults = parseInt(flags.max || '2500');
    const pageSize = parseInt(flags.count || '25');

    const filterSummary = Object.entries(flags)
      .filter(([k]) => !['start', 'count', 'max', 'radius'].includes(k))
      .map(([k, v]) => v === 'true' ? `--${k}` : `${k}="${v}"`)
      .join(', ');

    // Step 1: Search (paginate through all results)
    console.log(`Searching leads: ${filterSummary} (max=${maxResults})...`);
    const searchResult = await searchAllLeads(auth, flags, { maxResults, pageSize });
    console.log(`Found ${searchResult.total} total, collected ${searchResult.count} leads.`);

    if (searchResult.profileIds.length === 0) {
      console.log('No profiles found matching filters.');
      break;
    }

    // Rate limit: pause between search and profile fetch
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

    // Step 2: Fetch full profiles in batches of 25
    console.log(`Fetching ${searchResult.profileIds.length} full profiles...`);
    const profiles = await fetchProfiles(auth, searchResult.profileIds);
    const formatted = profiles.map(formatProfile);

    const slug = searchSlug(flags);
    const outFile = resolve(CACHE_DIR, `search-profiles-${slug}-${Date.now()}.json`);
    saveJson(outFile, { total: searchResult.total, count: formatted.length, profiles: formatted });
    console.log(`\n${formatted.length} profiles saved to: ${outFile}\n`);

    for (const p of formatted) {
      const pos = p.positions.find(x => x.current);
      console.log(`${p.fullName}`);
      console.log(`  ${pos?.title || p.headline} @ ${pos?.company || ''}`);
      if (p.contactInfo?.primaryEmail) console.log(`  Email: ${p.contactInfo.primaryEmail}`);
      if (p.linkedinUrl) console.log(`  LinkedIn: ${p.linkedinUrl}`);
      console.log();
    }
    break;
  }

  default:
    console.log(`salesnav-lead-search -- Ad-hoc Sales Navigator lead searches with ALL 33+ filter types

Commands:
  auth                                          Authenticate via Chrome (one-time)
  search [filters...]                           Run an ad-hoc lead search
  filters                                       Show all available filter types and usage
  profiles <id1,id2,...>                         Batch fetch full profiles by ID (max 25)
  search-profiles [filters...] [--max=100]      Search + fetch profiles in one step

Quick examples:
  node salesnav-lead-search.mjs search --title="CTO" --headcount="E,F,G"
  node salesnav-lead-search.mjs search --company="Microsoft" --seniority="VP,CXO"
  node salesnav-lead-search.mjs search --keyword="AI" --changed-jobs --seniority="CXO"
  node salesnav-lead-search.mjs search-profiles --title="VP Engineering" --headcount="D,E" --max=50
  node salesnav-lead-search.mjs profiles ACwAABJVBJEB1234,ACwAABJVBJEB5678

Run 'filters' command for the full list of 33+ supported filters.

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Search results and profile data`);
}
