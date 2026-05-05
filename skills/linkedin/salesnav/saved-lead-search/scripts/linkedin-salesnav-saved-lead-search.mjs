#!/usr/bin/env node
// linkedin-salesnav-saved-lead-search.mjs — Query Sales Navigator saved searches and fetch full profiles
//
// Setup (one-time, requires Chrome with Sales Navigator open):
//   node linkedin-salesnav-saved-lead-search.mjs auth
//
// Usage (no browser needed after auth):
//   node linkedin-salesnav-saved-lead-search.mjs search <savedSearchId> [--count=50] [--start=0]
//   node linkedin-salesnav-saved-lead-search.mjs profiles <id1,id2,...>
//   node linkedin-salesnav-saved-lead-search.mjs search-profiles <savedSearchId>    # search + fetch in one go
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-salesnav-saved-lead-search');
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
    // Fall back to any LinkedIn tab
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
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node linkedin-salesnav-saved-lead-search.mjs auth');
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

async function apiFetch(auth, url) {
  const resp = await fetch(url, { headers: baseHeaders(auth) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node linkedin-salesnav-saved-lead-search.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Search: query a saved search
// ---------------------------------------------------------------------------

async function searchLeads(auth, savedSearchId, { start = 0, count = 50, sessionId } = {}) {
  const sid = sessionId || Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const url = `https://www.linkedin.com/sales-api/salesApiLeadSearch`
    + `?q=savedSearchId`
    + `&start=${start}`
    + `&count=${count}`
    + `&savedSearchId=${savedSearchId}`
    + `&trackingParam=(sessionId:${encodeURIComponent(sid)})`
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
      entityUrn: el.entityUrn,
    };
  });

  return {
    total: data.paging?.total || leads.length,
    start,
    count: leads.length,
    leads,
    profileIds: leads.map(l => l.profileId).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Profiles: batch fetch full profile data
// ---------------------------------------------------------------------------

// Pre-encoded decoration string — matches LinkedIn's expected format exactly
const PROFILE_DECORATION = '%28%0A%20%20entityUrn%2C%0A%20%20objectUrn%2C%0A%20%20firstName%2C%0A%20%20lastName%2C%0A%20%20fullName%2C%0A%20%20headline%2C%0A%20%20memberBadges%2C%0A%20%20pronoun%2C%0A%20%20degree%2C%0A%20%20profileUnlockInfo%2C%0A%20%20latestTouchPointActivity%2C%0A%20%20location%2C%0A%20%20listCount%2C%0A%20%20summary%2C%0A%20%20savedLead%2C%0A%20%20defaultPosition%2C%0A%20%20contactInfo%2C%0A%20%20crmStatus%2C%0A%20%20pendingInvitation%2C%0A%20%20unlocked%2C%0A%20%20flagshipProfileUrl%2C%0A%20%20fullNamePronunciationAudio%2C%0A%20%20memorialized%2C%0A%20%20numOfConnections%2C%0A%20%20numOfSharedConnections%2C%0A%20%20showTotalConnectionsPage%2C%0A%20%20profilePictureDisplayImage%2C%0A%20%20profileBackgroundPicture%2C%0A%20%20relatedColleagueCompanyId%2C%0A%20%20blockThirdPartyDataSharing%2C%0A%20%20noteCount%2C%0A%20%20positions*%28%0A%20%20%20%20companyName%2C%0A%20%20%20%20current%2C%0A%20%20%20%20new%2C%0A%20%20%20%20description%2C%0A%20%20%20%20endedOn%2C%0A%20%20%20%20posId%2C%0A%20%20%20%20startedOn%2C%0A%20%20%20%20title%2C%0A%20%20%20%20location%2C%0A%20%20%20%20richMedia*%2C%0A%20%20%20%20companyUrn~fs_salesCompany%28entityUrn%2Cname%2CcompanyPictureDisplayImage%29%0A%20%20%29%2C%0A%20%20educations*%28%0A%20%20%20%20degree%2C%0A%20%20%20%20eduId%2C%0A%20%20%20%20endedOn%2C%0A%20%20%20%20schoolName%2C%0A%20%20%20%20startedOn%2C%0A%20%20%20%20fieldsOfStudy*%2C%0A%20%20%20%20richMedia*%2C%0A%20%20%20%20school~fs_salesSchool%28entityUrn%2ClogoId%2Cname%2Curl%2CschoolPictureDisplayImage%29%0A%20%20%29%2C%0A%20%20skills*%2C%0A%20%20languages*%0A%29';

async function fetchProfiles(auth, profileIds) {
  // Batch in groups of 25 to avoid URL length limits
  const BATCH_SIZE = 25;
  const allProfiles = [];

  for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
    const batch = profileIds.slice(i, i + BATCH_SIZE);
    const idsParam = batch
      .map(id => `(profileId:${id},authType:undefined,authToken:undefined)`)
      .join(',');

    const url = `https://www.linkedin.com/sales-api/salesApiProfiles`
      + `?ids=List(${idsParam})`
      + `&decoration=${PROFILE_DECORATION}`;

    const data = await apiFetch(auth, url);

    // Response uses `results` keyed by ID tuple
    const results = data.results || {};
    for (const [key, profile] of Object.entries(results)) {
      allProfiles.push(profile);
    }

    if (i + BATCH_SIZE < profileIds.length) {
      // Small delay between batches
      await new Promise(r => setTimeout(r, 500));
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
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
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

  case 'search': {
    const { flags, positional } = parseFlags(args);
    const savedSearchId = positional[0];
    if (!savedSearchId) {
      console.error('Usage: node linkedin-salesnav-saved-lead-search.mjs search <savedSearchId> [--count=50] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '50');

    console.log(`Searching saved search ${savedSearchId} (start=${start}, count=${count})...`);
    const result = await searchLeads(auth, savedSearchId, { start, count });
    console.log(`Found ${result.total} total leads, returned ${result.count}`);

    // Save results
    const outFile = resolve(CACHE_DIR, `search-${savedSearchId}.json`);
    saveJson(outFile, result);
    console.log(`Results saved to: ${outFile}`);

    // Print summary
    for (const lead of result.leads) {
      console.log(`  ${lead.fullName} — ${lead.headline || ''} @ ${lead.company || ''} (${lead.location || ''})`);
    }
    break;
  }

  case 'profiles': {
    const rawIds = args[0]?.split(',').filter(Boolean);
    if (!rawIds?.length) {
      console.error('Usage: node linkedin-salesnav-saved-lead-search.mjs profiles <id1,id2,...>');
      console.error('  Accepts: Sales Nav IDs (ACwAA...), LinkedIn URNs (urn:li:fsd_profile:ACoAA...),');
      console.error('           or member URNs (urn:li:member:123456)');
      process.exit(1);
    }
    // Normalize IDs — strip URN prefixes, accept any format
    const profileIds = rawIds.map(id => {
      // urn:li:fsd_profile:ACoAA... → ACoAA...
      const fsdMatch = id.match(/fsd_profile:([^,)]+)/);
      if (fsdMatch) return fsdMatch[1];
      // urn:li:fs_salesProfile:(ACwAA...,... ) → ACwAA...
      const salesMatch = id.match(/salesProfile:\(([^,]+)/);
      if (salesMatch) return salesMatch[1];
      // Already a raw ID
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
      console.log(`  ${p.fullName} — ${pos?.title || p.headline} @ ${pos?.company || ''}`);
      if (p.contactInfo?.primaryEmail) console.log(`    Email: ${p.contactInfo.primaryEmail}`);
      if (p.linkedinUrl) console.log(`    LinkedIn: ${p.linkedinUrl}`);
    }
    break;
  }

  case 'search-profiles': {
    const { flags, positional } = parseFlags(args);
    const savedSearchId = positional[0];
    if (!savedSearchId) {
      console.error('Usage: node linkedin-salesnav-saved-lead-search.mjs search-profiles <savedSearchId> [--count=50] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const start = parseInt(flags.start || '0');
    const count = parseInt(flags.count || '50');

    // Step 1: Search
    console.log(`Searching saved search ${savedSearchId}...`);
    const searchResult = await searchLeads(auth, savedSearchId, { start, count });
    console.log(`Found ${searchResult.total} total, fetching ${searchResult.count} profiles...`);

    // Step 2: Fetch full profiles
    const profiles = await fetchProfiles(auth, searchResult.profileIds);
    const formatted = profiles.map(formatProfile);

    // Save
    const outFile = resolve(CACHE_DIR, `search-profiles-${savedSearchId}.json`);
    saveJson(outFile, { total: searchResult.total, profiles: formatted });
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
    console.log(`linkedin-salesnav-saved-lead-search — Query saved searches and fetch profiles

Commands:
  auth                                        Authenticate via Chrome (one-time)
  search <savedSearchId> [--count] [--start]  Run a saved search
  profiles <id1,id2,...>                       Fetch full profiles by ID or URN
  search-profiles <savedSearchId> [opts]      Search + fetch profiles in one step

Profile ID formats (all work for 'profiles' command):
  ACwAABJVBJEB...                             Sales Nav / LinkedIn ID
  urn:li:fsd_profile:ACoAABJVBJEB...          LinkedIn profile URN
  urn:li:fs_salesProfile:(ACwAABJVBJEB...,...)  Sales Nav URN

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Search results and profile data`);
}
