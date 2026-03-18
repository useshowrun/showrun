#!/usr/bin/env node
// salesnav-saved-searches.mjs — List, run, and delete Sales Navigator saved searches (lead + account)
//
// Setup:   node salesnav-saved-searches.mjs auth
// Usage:   node salesnav-saved-searches.mjs list [--type=lead|account]
//          node salesnav-saved-searches.mjs run <savedSearchId> [--type=lead|account] [--count=25] [--start=0]
//          node salesnav-saved-searches.mjs run-profiles <savedSearchId> [--count=25] [--start=0]
//          node salesnav-saved-searches.mjs delete <savedSearchId>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-saved-searches');
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
    resolve(new URL('.', import.meta.url).pathname, '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

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

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://www.linkedin.com'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const cookieStr = cookies
    .filter(c => c.domain.includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const csrfToken = (cookieMap['JSESSIONID'] || '').replace(/"/g, '');
  if (!csrfToken) throw new Error('JSESSIONID not found. Are you logged in?');
  if (!cookieMap['li_at']) throw new Error('li_at cookie not found. Are you logged in?');

  saveJson(SESSION_FILE, { cookie: cookieStr, csrfToken, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node salesnav-saved-searches.mjs auth');
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

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, { ...options, headers: { ...baseHeaders(auth), ...options.headers } });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-saved-searches.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
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
// List saved searches
// ---------------------------------------------------------------------------

async function listSavedSearches(auth, type = 'lead') {
  const q = type === 'account' ? 'savedCompanySearches' : 'savedPeopleSearches';
  const url = `https://www.linkedin.com/sales-api/salesApiSavedSearchesV2`
    + `?decoration=${encodeDecoration('(createdAt,id,lastViewedAt,name,newHitsCount,seat,keywords,filters)')}`
    + `&count=50`
    + `&q=${q}`
    + `&start=0`;

  const data = await apiFetch(auth, url);

  return (data.elements || []).map(el => ({
    id: el.id,
    name: el.name,
    createdAt: el.createdAt ? new Date(el.createdAt).toISOString() : null,
    lastViewedAt: el.lastViewedAt ? new Date(el.lastViewedAt).toISOString() : null,
    newHitsCount: el.newHitsCount || 0,
    keywords: el.keywords || null,
    filters: (el.filters || []).map(f => {
      const meta = f.singleFilterMetadata || f.rangeFilterMetadata || f.toggleFilterMetadata || {};
      return {
        type: meta.type || 'UNKNOWN',
        values: (meta.values || []).map(v => ({
          id: v.id,
          displayValue: v.displayValue,
          selectionType: v.selectionType,
        })),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Run saved search (lead or account)
// ---------------------------------------------------------------------------

async function runSavedSearch(auth, savedSearchId, { type = 'lead', start = 0, count = 25 } = {}) {
  let url;
  if (type === 'account') {
    url = `https://www.linkedin.com/sales-api/salesApiAccountSearch`
      + `?q=savedSearchId`
      + `&savedSearchId=${savedSearchId}`
      + `&start=${start}`
      + `&count=${count}`
      + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4`;
  } else {
    url = `https://www.linkedin.com/sales-api/salesApiLeadSearch`
      + `?q=savedSearchId`
      + `&savedSearchId=${savedSearchId}`
      + `&start=${start}`
      + `&count=${count}`
      + `&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14`;
  }

  const data = await apiFetch(auth, url);

  if (type === 'account') {
    const accounts = (data.elements || []).map(el => ({
      entityUrn: el.entityUrn,
      companyName: el.companyName,
      industry: el.industry,
      employeeCountRange: el.employeeCountRange,
      employeeDisplayCount: el.employeeDisplayCount,
      description: el.description,
      saved: el.saved,
    }));
    return {
      total: data.paging?.total || data.metadata?.totalDisplayCount || accounts.length,
      start,
      count: accounts.length,
      elements: accounts,
    };
  }

  // Lead search
  const leads = (data.elements || []).map(el => {
    const urnMatch = (el.entityUrn || '').match(/\(([^,]+)/);
    return {
      profileId: urnMatch ? urnMatch[1] : null,
      entityUrn: el.entityUrn,
      fullName: el.fullName,
      firstName: el.firstName,
      lastName: el.lastName,
      headline: el.currentPositions?.[0]?.title,
      company: el.currentPositions?.[0]?.companyName,
      location: el.geoRegion,
    };
  });

  return {
    total: data.paging?.total || data.metadata?.totalDisplayCount || leads.length,
    start,
    count: leads.length,
    elements: leads,
    profileIds: leads.map(l => l.profileId).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Batch profile fetch (for run-profiles)
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
    contactInfo: p.contactInfo || {},
    positions: (p.positions || []).map(pos => ({
      title: pos.title,
      company: pos.companyName,
      location: pos.location,
      current: pos.current,
      startedOn: pos.startedOn,
      endedOn: pos.endedOn,
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
// Delete saved search
// ---------------------------------------------------------------------------

async function deleteSavedSearch(auth, savedSearchId) {
  const url = `https://www.linkedin.com/sales-api/salesApiSavedSearchesV2/${savedSearchId}`;
  const resp = await fetch(url, { method: 'DELETE', headers: baseHeaders(auth) });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node salesnav-saved-searches.mjs auth');
    }
    const text = await resp.text();
    throw new Error(`Delete failed (HTTP ${resp.status}): ${text.substring(0, 300)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) flags[match[1]] = match[2];
    else positional.push(arg);
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
    const type = flags.type || 'lead';
    if (type !== 'lead' && type !== 'account') {
      console.error('Invalid --type. Use --type=lead or --type=account');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Listing saved ${type} searches...`);
    const searches = await listSavedSearches(auth, type);

    const outFile = resolve(CACHE_DIR, `saved-searches-${type}.json`);
    saveJson(outFile, searches);
    console.log(`Found ${searches.length} saved ${type} searches. Saved to: ${outFile}\n`);

    for (const s of searches) {
      const filters = s.filters.map(f => f.type).join(', ');
      console.log(`  [${s.id}] ${s.name}`);
      console.log(`    New hits: ${s.newHitsCount} | Created: ${s.createdAt || 'N/A'}`);
      if (s.keywords) console.log(`    Keywords: ${s.keywords}`);
      if (filters) console.log(`    Filters: ${filters}`);
      console.log();
    }
    break;
  }

  case 'run': {
    const { flags, positional } = parseFlags(args);
    const savedSearchId = positional[0];
    if (!savedSearchId) {
      console.error('Usage: node salesnav-saved-searches.mjs run <savedSearchId> [--type=lead|account] [--count=25] [--start=0]');
      process.exit(1);
    }

    const type = flags.type || 'lead';
    if (type !== 'lead' && type !== 'account') {
      console.error('Invalid --type. Use --type=lead or --type=account');
      process.exit(1);
    }

    const auth = getAuth();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    console.log(`Running saved ${type} search ${savedSearchId} (start=${start}, count=${count})...`);
    const result = await runSavedSearch(auth, savedSearchId, { type, start, count });

    const outFile = resolve(CACHE_DIR, `run-${type}-${savedSearchId}.json`);
    saveJson(outFile, result);
    console.log(`Total: ${result.total} | Returned: ${result.count} | Saved to: ${outFile}\n`);

    if (type === 'account') {
      for (const a of result.elements) {
        console.log(`  ${a.companyName} — ${a.industry || ''} (${a.employeeDisplayCount || '?'} employees)`);
      }
    } else {
      for (const l of result.elements) {
        console.log(`  ${l.fullName} — ${l.headline || ''} @ ${l.company || ''} (${l.location || ''})`);
      }
    }
    break;
  }

  case 'run-profiles': {
    const { flags, positional } = parseFlags(args);
    const savedSearchId = positional[0];
    if (!savedSearchId) {
      console.error('Usage: node salesnav-saved-searches.mjs run-profiles <savedSearchId> [--count=25] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '25');

    // Step 1: Run the saved lead search
    console.log(`Running saved lead search ${savedSearchId} (start=${start}, count=${count})...`);
    const searchResult = await runSavedSearch(auth, savedSearchId, { type: 'lead', start, count });
    console.log(`Found ${searchResult.total} total leads, fetching ${searchResult.count} profiles...`);

    if (!searchResult.profileIds || searchResult.profileIds.length === 0) {
      console.log('No profile IDs found in search results.');
      break;
    }

    // Step 2: Batch fetch full profiles
    const profiles = await fetchProfiles(auth, searchResult.profileIds);
    const formatted = profiles.map(formatProfile);

    const outFile = resolve(CACHE_DIR, `run-profiles-${savedSearchId}.json`);
    saveJson(outFile, { total: searchResult.total, start, count: formatted.length, profiles: formatted });
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

  case 'delete': {
    const savedSearchId = args[0];
    if (!savedSearchId) {
      console.error('Usage: node salesnav-saved-searches.mjs delete <savedSearchId>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Deleting saved search ${savedSearchId}...`);
    await deleteSavedSearch(auth, savedSearchId);
    console.log(`Saved search ${savedSearchId} deleted.`);
    break;
  }

  default:
    console.log(`salesnav-saved-searches — List, run, and delete Sales Navigator saved searches

Commands:
  auth                                              Authenticate via Chrome (one-time)
  list [--type=lead|account]                        List saved searches (default: lead)
  run <id> [--type=lead|account] [--count] [--start]  Run a saved search
  run-profiles <id> [--count] [--start]             Run saved lead search + fetch full profiles
  delete <id>                                       Delete a saved search

Examples:
  node salesnav-saved-searches.mjs auth
  node salesnav-saved-searches.mjs list
  node salesnav-saved-searches.mjs list --type=account
  node salesnav-saved-searches.mjs run 12345
  node salesnav-saved-searches.mjs run 12345 --type=account --count=50
  node salesnav-saved-searches.mjs run-profiles 12345
  node salesnav-saved-searches.mjs delete 12345

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Search results and profile data`);
}
