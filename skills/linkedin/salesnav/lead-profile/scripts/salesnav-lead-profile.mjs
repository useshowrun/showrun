#!/usr/bin/env node
// salesnav-lead-profile.mjs — Fetch comprehensive Sales Navigator lead profile data
//
// Setup:   node salesnav-lead-profile.mjs auth
// Usage:   node salesnav-lead-profile.mjs view <profileId> [--sections=basic,positions,contact,insights]
//          node salesnav-lead-profile.mjs batch <id1,id2,...>
//          node salesnav-lead-profile.mjs lead-iq <profileId>
//          node salesnav-lead-profile.mjs spotlights <profileId>
//          node salesnav-lead-profile.mjs highlights <profileId>
//          node salesnav-lead-profile.mjs timeline <profileId>
//          node salesnav-lead-profile.mjs notes <profileId>
//          node salesnav-lead-profile.mjs warm-intro <profileId>
//          node salesnav-lead-profile.mjs insights <profileId>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/salesnav-lead-profile');
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
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(new URL('.', import.meta.url).pathname, '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
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
// URL encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encode a rest.li decoration string for use as a query parameter value.
 * LinkedIn's Sales API requires the decoration parameter to be percent-encoded.
 * encodeURIComponent does NOT encode (, ), *, ~ so we must handle those manually.
 * Verified: unencoded decorations return HTTP 400; encoded ones return HTTP 200.
 */
function encodeDecoration(str) {
  return str
    .replace(/%/g, '%25')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/,/g, '%2C')
    .replace(/\*/g, '%2A')
    .replace(/~/g, '%7E')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/ /g, '%20');
}

/**
 * Encode a URN for use as a query parameter value.
 * encodeURIComponent does not encode ( and ) which LinkedIn requires encoded.
 */
function encodeUrnParam(urn) {
  return encodeURIComponent(urn)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node salesnav-lead-profile.mjs auth');
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
      console.error('Session expired. Run: node salesnav-lead-profile.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Profile ID parsing
// ---------------------------------------------------------------------------

/**
 * Parse a profile identifier. Accepts:
 *   - Raw profileId: "ACwAABJVBJEB..."
 *   - Full URN: "urn:li:fs_salesProfile:(ACwAABJVBJEB...,NAME_SEARCH,Yq9I)"
 *   - Partial URN: "(ACwAABJVBJEB...,NAME_SEARCH,Yq9I)"
 *
 * Returns { profileId, authType, authToken }
 */
function parseProfileId(input) {
  // Full URN: urn:li:fs_salesProfile:(ACwAA...,NAME_SEARCH,Yq9I)
  const urnMatch = input.match(/\(([^,]+),([^,]+),([^)]+)\)/);
  if (urnMatch) {
    return { profileId: urnMatch[1].trim(), authType: urnMatch[2].trim(), authToken: urnMatch[3].trim() };
  }
  // Comma-separated without parens: ACwAA...,NAME_SEARCH,Yq9I
  const parts = input.split(',');
  if (parts.length >= 3) {
    return { profileId: parts[0].trim(), authType: parts[1].trim(), authToken: parts[2].trim() };
  }
  // Just a raw profileId — use undefined auth
  return { profileId: input.trim(), authType: 'undefined', authToken: 'undefined' };
}

/**
 * Build the profile key for the single-profile endpoint.
 */
function profileKey({ profileId, authType, authToken }) {
  return `(profileId:${profileId},authType:${authType},authToken:${authToken})`;
}

/**
 * Build the entity URN from a parsed profile (for endpoints that need the full URN).
 * The browser sends the full auth tuple in the URN, e.g.:
 *   urn:li:fs_salesProfile:(ACwAABJVBJEBNs2huLK4tjDy5s9m8p9jrZFfa6M,NAME_SEARCH,P3ii)
 */
function profileUrn(parsed) {
  if (typeof parsed === 'string') {
    // Legacy: just a profileId string
    return `urn:li:fs_salesProfile:(${parsed},undefined,undefined)`;
  }
  return `urn:li:fs_salesProfile:(${parsed.profileId},${parsed.authType},${parsed.authToken})`;
}

// ---------------------------------------------------------------------------
// Decoration strings
// ---------------------------------------------------------------------------

// Basic profile decoration (main fields, positions, education, skills)
const DECORATION_BASIC = [
  'entityUrn', 'objectUrn', 'firstName', 'lastName', 'fullName',
  'headline', 'pronoun', 'degree', 'location', 'summary',
  'contactInfo', 'crmStatus', 'pendingInvitation', 'unlocked',
  'flagshipProfileUrl', 'savedLead', 'defaultPosition', 'listCount',
  'noteCount', 'memorialized', 'blockThirdPartyDataSharing',
  'positions*(companyName,current,new,description,endedOn,posId,startedOn,title,location,richMedia*,companyUrn~fs_salesCompany(entityUrn,name,companyPictureDisplayImage))',
  'educations*(degree,eduId,endedOn,schoolName,startedOn,fieldsOfStudy*,richMedia*,school~fs_salesSchool(entityUrn,logoId,name,url,schoolPictureDisplayImage))',
  'skills*', 'languages*',
].join(',');

// Extended profile decoration (picture, badges, connections)
const DECORATION_EXTENDED = [
  'profilePictureDisplayImage', 'profileBackgroundPicture',
  'memberBadges', 'numOfConnections', 'numOfSharedConnections',
  'showTotalConnectionsPage', 'inmailRestriction',
  'fullNamePronunciationAudio', 'profileUnlockInfo',
  'latestTouchPointActivity', 'lastMessagingActivity',
  'volunteeringExperiences*',
  'relatedColleagueCompanyId',
].join(',');

// Insights decoration (summary insights, shared connections)
const DECORATION_INSIGHTS = [
  'summaryInsights', 'schools', 'currentPositions',
  'pastPositions', 'sharedInsights',
].join(',');

// Highlights decoration
const DECORATION_HIGHLIGHTS = [
  'entityUrn', 'sharedConnectionsHighlight',
  'teamLinkConnectionsHighlight',
].join(',');

// Batch profile decoration (must be encoded for the decoration= query param)
const BATCH_DECORATION_RAW = '(entityUrn,objectUrn,firstName,lastName,fullName,headline,memberBadges,pronoun,degree,profileUnlockInfo,latestTouchPointActivity,location,listCount,summary,savedLead,defaultPosition,contactInfo,crmStatus,pendingInvitation,unlocked,flagshipProfileUrl,fullNamePronunciationAudio,memorialized,numOfConnections,numOfSharedConnections,showTotalConnectionsPage,profilePictureDisplayImage,profileBackgroundPicture,relatedColleagueCompanyId,blockThirdPartyDataSharing,noteCount,positions*(companyName,current,new,description,endedOn,posId,startedOn,title,location,richMedia*,companyUrn~fs_salesCompany(entityUrn,name,companyPictureDisplayImage)),educations*(degree,eduId,endedOn,schoolName,startedOn,fieldsOfStudy*,richMedia*,school~fs_salesSchool(entityUrn,logoId,name,url,schoolPictureDisplayImage)),skills*,languages*)';
const BATCH_DECORATION = encodeDecoration(BATCH_DECORATION_RAW);

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch main profile data (basic + extended + insights decorations).
 */
async function fetchProfile(auth, parsed, sections) {
  const key = profileKey(parsed);
  const allSections = !sections || sections.length === 0;

  const decorationParts = [];
  if (allSections || sections.includes('basic') || sections.includes('positions') || sections.includes('contact')) {
    decorationParts.push(DECORATION_BASIC);
  }
  if (allSections || sections.includes('extended') || sections.includes('picture') || sections.includes('connections')) {
    decorationParts.push(DECORATION_EXTENDED);
  }
  // Note: DECORATION_INSIGHTS fields (summaryInsights, schools, currentPositions, etc.)
  // are NOT valid on the salesApiProfiles endpoint; they are fetched via sub-endpoints instead.

  // Join decoration parts (no naive comma-split dedup: nested sub-expressions
  // share field names like 'location', 'endedOn' which must not be removed)
  const decoration = encodeDecoration(`(${decorationParts.join(',')})`);

  const url = `https://www.linkedin.com/sales-api/salesApiProfiles/${key}?decoration=${decoration}`;
  return apiFetch(auth, url);
}

/**
 * Batch fetch profile data (max 25 per batch).
 */
async function fetchBatchProfiles(auth, profileIds) {
  const BATCH_SIZE = 25;
  const allProfiles = [];

  for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
    const batch = profileIds.slice(i, i + BATCH_SIZE);
    const idsParam = batch
      .map(id => `(profileId:${id},authType:undefined,authToken:undefined)`)
      .join(',');

    const url = `https://www.linkedin.com/sales-api/salesApiProfiles`
      + `?ids=List(${idsParam})`
      + `&decoration=${BATCH_DECORATION}`;

    const data = await apiFetch(auth, url);
    const results = data.results || {};
    for (const [, profile] of Object.entries(results)) {
      allProfiles.push(profile);
    }

    if (i + BATCH_SIZE < profileIds.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return allProfiles;
}

/**
 * Fetch profile spotlights (job changes, shared connections, etc.).
 */
async function fetchSpotlights(auth, parsed) {
  const url = `https://www.linkedin.com/sales-api/salesApiProfileSpotlights/${parsed.profileId}`
    + `?authType=${parsed.authType}&authToken=${parsed.authToken}`;
  return apiFetch(auth, url);
}

/**
 * Fetch Lead IQ (AI-generated insights).
 */
async function fetchLeadIq(auth, parsed) {
  const requestId = randomUUID();
  const url = `https://www.linkedin.com/sales-api/salesApiLeadIq/${parsed.profileId}`
    + `?requestId=${requestId}&isPreview=true`;
  return apiFetch(auth, url);
}

/**
 * Fetch profile highlights (shared connections, team members).
 */
async function fetchHighlights(auth, parsed) {
  const decoration = encodeDecoration('(sharedConnection(sharedConnectionUrns*~fs_salesProfile(entityUrn,firstName,lastName,fullName,pictureInfo,profilePictureDisplayImage)),teamlinkInfo(totalCount),sharedEducations*(overlapInfo,entityUrn~fs_salesSchool(entityUrn,logoId,name,url,schoolPictureDisplayImage)),sharedExperiences*(overlapInfo,entityUrn~fs_salesCompany(entityUrn,pictureInfo,name,companyPictureDisplayImage)),sharedGroups*(entityUrn~fs_salesGroup(entityUrn,name,largeLogoId,smallLogoId,groupPictureDisplayImage)))');
  const url = `https://www.linkedin.com/sales-api/salesApiProfileHighlights/${parsed.profileId}`
    + `?decoration=${decoration}`;
  return apiFetch(auth, url);
}

/**
 * Fetch warm introduction paths.
 */
async function fetchWarmIntro(auth, parsed, spotlightType = 'FIRST_DEGREE') {
  const key = profileKey(parsed);
  const url = `https://www.linkedin.com/sales-api/salesApiWarmIntro`
    + `?profileAuthKey=${key}`
    + `&q=warmIntroBySeniority`
    + `&warmIntroSpotlightType=${spotlightType}`;
  return apiFetch(auth, url);
}

/**
 * Fetch lead insights (posts and comments).
 */
async function fetchInsights(auth, parsed) {
  const urn = encodeUrnParam(profileUrn(parsed));
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const url = `https://www.linkedin.com/sales-api/salesApiInsightsV2`
    + `?insightTypes=List(LEAD_POST,LEAD_COMMENT)`
    + `&q=findByMember`
    + `&profile=${urn}`
    + `&timeRange=(start:${ninetyDaysAgo},end:${now})`
    + `&start=0&count=10`;
  return apiFetch(auth, url);
}

/**
 * Fetch profile timeline/activity.
 */
async function fetchTimeline(auth, parsed) {
  const urn = encodeUrnParam(profileUrn(parsed));
  const timelineDec = encodeDecoration('(actorProfileUrn~fs_salesProfile(entityUrn,objectUrn,degree,firstName,lastName,fullName),targetProfileUrn~fs_salesProfile(entityUrn,objectUrn,degree,firstName,lastName,fullName),entityUrn(salesAssetBundleUrn,listUrn~fs_salesList(id,name,listSource,role)),entityCount,performedAt,domainSource,type)');
  const url = `https://www.linkedin.com/sales-api/salesApiProfileTimeline`
    + `?q=timeline`
    + `&count=10`
    + `&profile=${urn}`
    + `&timelineActivityFilters=List(ALL)`
    + `&decoration=${timelineDec}`;
  return apiFetch(auth, url);
}

/**
 * Fetch notes on a lead.
 */
async function fetchNotes(auth, parsed) {
  const urn = encodeUrnParam(profileUrn(parsed));
  const url = `https://www.linkedin.com/sales-api/salesApiEntityNote`
    + `?count=20`
    + `&entityUrn=${urn}`
    + `&q=entity`
    + `&start=0`
    + `&visibility=ALL`;
  return apiFetch(auth, url);
}

/**
 * Fetch full profile with all sub-endpoints merged.
 */
async function fetchFullProfile(auth, parsed, sections) {
  const allSections = !sections || sections.length === 0;
  const result = {};

  // Always fetch main profile
  console.log('  Fetching profile data...');
  result.profile = await fetchProfile(auth, parsed, sections);

  if (allSections || sections.includes('spotlights')) {
    console.log('  Fetching spotlights...');
    try { result.spotlights = await fetchSpotlights(auth, parsed); }
    catch (e) { result.spotlights = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('lead-iq')) {
    console.log('  Fetching Lead IQ...');
    try { result.leadIq = await fetchLeadIq(auth, parsed); }
    catch (e) { result.leadIq = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('highlights')) {
    console.log('  Fetching highlights...');
    try { result.highlights = await fetchHighlights(auth, parsed); }
    catch (e) { result.highlights = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('insights')) {
    console.log('  Fetching insights (posts/comments)...');
    try { result.insights = await fetchInsights(auth, parsed); }
    catch (e) { result.insights = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('timeline')) {
    console.log('  Fetching timeline...');
    try { result.timeline = await fetchTimeline(auth, parsed); }
    catch (e) { result.timeline = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('notes')) {
    console.log('  Fetching notes...');
    try { result.notes = await fetchNotes(auth, parsed); }
    catch (e) { result.notes = { error: e.message }; }
    await new Promise(r => setTimeout(r, 300));
  }

  if (allSections || sections.includes('warm-intro')) {
    console.log('  Fetching warm intro paths...');
    try { result.warmIntro = await fetchWarmIntro(auth, parsed); }
    catch (e) { result.warmIntro = { error: e.message }; }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

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
    memberBadges: p.memberBadges,
    savedLead: p.savedLead,
    noteCount: p.noteCount,
    positions: (p.positions || []).map(pos => ({
      title: pos.title,
      company: pos.companyName,
      location: pos.location,
      current: pos.current,
      isNew: pos.new,
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

function printProfileSummary(p) {
  const profile = p.profile || p;
  console.log(`\n${profile.fullName || '(unknown)'}`);
  if (profile.headline) console.log(`  ${profile.headline}`);
  if (profile.location) console.log(`  Location: ${profile.location}`);
  if (profile.flagshipProfileUrl) console.log(`  LinkedIn: ${profile.flagshipProfileUrl}`);

  const contact = profile.contactInfo || {};
  if (contact.primaryEmail) console.log(`  Email: ${contact.primaryEmail}`);
  if (contact.emails?.length) console.log(`  Emails: ${contact.emails.map(e => e.emailAddress || e).join(', ')}`);
  if (contact.websites?.length) console.log(`  Websites: ${contact.websites.map(w => w.url || w).join(', ')}`);

  const currentPos = (profile.positions || []).find(pos => pos.current);
  if (currentPos) {
    console.log(`  Current: ${currentPos.title} @ ${currentPos.companyName}`);
  }

  if (profile.numOfConnections) console.log(`  Connections: ${profile.numOfConnections}`);
  if (profile.numOfSharedConnections) console.log(`  Shared connections: ${profile.numOfSharedConnections}`);
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

  case 'view': {
    const { flags, positional } = parseFlags(args);
    const rawId = positional[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs view <profileId> [--sections=basic,positions,contact,insights]');
      console.error('\nAccepts: raw profileId (ACwAA...) or full URN (urn:li:fs_salesProfile:(ACwAA...,NAME_SEARCH,Yq9I))');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const sections = flags.sections ? flags.sections.split(',').map(s => s.trim()) : [];
    const auth = getAuth();

    console.log(`Fetching profile: ${parsed.profileId} (auth: ${parsed.authType})...`);
    const result = await fetchFullProfile(auth, parsed, sections);

    const outFile = resolve(CACHE_DIR, `profile-${parsed.profileId}.json`);
    saveJson(outFile, result);
    console.log(`\nProfile saved to: ${outFile}`);

    printProfileSummary(result.profile);
    break;
  }

  case 'batch': {
    const rawIds = args[0]?.split(',').filter(Boolean);
    if (!rawIds?.length) {
      console.error('Usage: node salesnav-lead-profile.mjs batch <id1,id2,...>');
      console.error('  Max 25 profile IDs per batch.');
      process.exit(1);
    }

    // Normalize IDs
    const profileIds = rawIds.map(id => {
      const fsdMatch = id.match(/fsd_profile:([^,)]+)/);
      if (fsdMatch) return fsdMatch[1];
      const salesMatch = id.match(/salesProfile:\(([^,]+)/);
      if (salesMatch) return salesMatch[1];
      return id;
    });

    if (profileIds.length > 25) {
      console.error(`Error: max 25 profiles per batch, got ${profileIds.length}`);
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Batch fetching ${profileIds.length} profiles...`);
    const profiles = await fetchBatchProfiles(auth, profileIds);
    const formatted = profiles.map(formatProfile);

    const outFile = resolve(CACHE_DIR, `batch-${Date.now()}.json`);
    saveJson(outFile, formatted);
    console.log(`${formatted.length} profiles saved to: ${outFile}`);

    for (const p of formatted) {
      const pos = p.positions.find(x => x.current);
      console.log(`  ${p.fullName} -- ${pos?.title || p.headline} @ ${pos?.company || ''}`);
      if (p.contactInfo?.primaryEmail) console.log(`    Email: ${p.contactInfo.primaryEmail}`);
    }
    break;
  }

  case 'lead-iq': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs lead-iq <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching Lead IQ for: ${parsed.profileId}...`);
    const data = await fetchLeadIq(auth, parsed);

    const outFile = resolve(CACHE_DIR, `lead-iq-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Lead IQ saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'spotlights': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs spotlights <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching spotlights for: ${parsed.profileId}...`);
    const data = await fetchSpotlights(auth, parsed);

    const outFile = resolve(CACHE_DIR, `spotlights-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Spotlights saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'highlights': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs highlights <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching highlights for: ${parsed.profileId}...`);
    const data = await fetchHighlights(auth, parsed);

    const outFile = resolve(CACHE_DIR, `highlights-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Highlights saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'timeline': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs timeline <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching timeline for: ${parsed.profileId}...`);
    const data = await fetchTimeline(auth, parsed);

    const outFile = resolve(CACHE_DIR, `timeline-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Timeline saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'notes': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs notes <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching notes for: ${parsed.profileId}...`);
    const data = await fetchNotes(auth, parsed);

    const outFile = resolve(CACHE_DIR, `notes-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Notes saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'warm-intro': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs warm-intro <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching warm intro paths for: ${parsed.profileId}...`);
    const data = await fetchWarmIntro(auth, parsed);

    const outFile = resolve(CACHE_DIR, `warm-intro-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Warm intro paths saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'insights': {
    const rawId = args[0];
    if (!rawId) {
      console.error('Usage: node salesnav-lead-profile.mjs insights <profileId>');
      process.exit(1);
    }

    const parsed = parseProfileId(rawId);
    const auth = getAuth();
    console.log(`Fetching insights (posts/comments) for: ${parsed.profileId}...`);
    const data = await fetchInsights(auth, parsed);

    const outFile = resolve(CACHE_DIR, `insights-${parsed.profileId}.json`);
    saveJson(outFile, data);
    console.log(`Insights saved to: ${outFile}`);
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  default:
    console.log(`salesnav-lead-profile -- Fetch comprehensive Sales Navigator lead profile data

Commands:
  auth                                        Authenticate via Chrome (one-time)
  view <profileId> [--sections=...]           Fetch full profile with all sections
  batch <id1,id2,...>                         Batch fetch basic profile data (max 25)
  lead-iq <profileId>                         Fetch AI-generated Lead IQ insights
  spotlights <profileId>                      Fetch profile spotlights (job changes, etc.)
  highlights <profileId>                      Fetch profile highlights (shared connections)
  timeline <profileId>                        Fetch profile timeline/activity
  notes <profileId>                           Fetch notes on this lead
  warm-intro <profileId>                      Fetch warm introduction paths
  insights <profileId>                        Fetch lead posts and comments

Sections for --sections flag (comma-separated):
  basic        Core fields, positions, education, skills, contact info
  extended     Profile picture, badges, connection counts
  insights     Summary insights, shared connections
  spotlights   Job changes, shared connections badges
  lead-iq      AI-generated Lead IQ insights
  highlights   Shared connections, team members
  timeline     Profile activity timeline
  notes        Notes on this lead
  warm-intro   Warm introduction paths

Profile ID formats:
  ACwAABJVBJEB...                                       Raw profile ID
  urn:li:fs_salesProfile:(ACwAABJVBJEB...,NAME_SEARCH,Yq9I)  Full URN with auth
  (ACwAABJVBJEB...,NAME_SEARCH,Yq9I)                   Partial URN with auth

Data: ${DATA_DIR}/
  session.json       Auth cookies
  cache/             Profile data and sub-endpoint results`);
}
