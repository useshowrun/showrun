#!/usr/bin/env node
// linkedin-profile.mjs — LinkedIn profile data & actions from the terminal
//
// Setup (one-time, requires Chrome with LinkedIn open):
//   node linkedin-profile.mjs auth
//
// Commands:
//   node linkedin-profile.mjs view <profile>         Full profile via API
//   node linkedin-profile.mjs resolve <profile>      Resolve vanity name to URN
//   node linkedin-profile.mjs posts <profile>        Fetch recent posts
//   node linkedin-profile.mjs connections [--count]  List your connections
//   node linkedin-profile.mjs connect <profile>      Send connection request
//   node linkedin-profile.mjs disconnect <profile>   Remove connection
//   node linkedin-profile.mjs withdraw <profile>     Withdraw pending invitation
//   node linkedin-profile.mjs follow <profile>       Follow a profile
//   node linkedin-profile.mjs unfollow <profile>     Unfollow a profile
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-profile');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const PROFILES_FILE = resolve(DATA_DIR, 'profiles.json');
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
// CDP integration (only needed for auth)
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract cookies from Chrome LinkedIn tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding LinkedIn tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/feed', '/in/', 'linkedin.com']) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');

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
    console.error('No auth found. Run: node linkedin-profile.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'X-LI-Lang': 'en_US',
    'X-LI-Track': JSON.stringify({
      clientVersion: '1.13.42849', mpVersion: '1.13.42849', osName: 'web',
      timezoneOffset: new Date().getTimezoneOffset() / -60,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceFormFactor: 'DESKTOP', mpName: 'voyager-web',
      displayDensity: 1, displayWidth: 3440, displayHeight: 1440,
    }),
    'Csrf-Token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Profile resolution: vanity name -> URN (via GraphQL)
// ---------------------------------------------------------------------------

function parseVanityName(input) {
  const match = input.match(/(?:linkedin\.com\/in\/|^\/in\/|^)([^\s/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : input;
}

function findTargetProfile(graphqlData) {
  const included = graphqlData?.included || [];
  // Use the *elements reference from the response to find the correct profile
  const topData = graphqlData?.data?.data || graphqlData?.data || {};
  const byMember = topData.identityDashProfilesByMemberIdentity || topData;
  const targetUrns = byMember['*elements'] || [];
  if (targetUrns.length) {
    const profile = included.find(e => e.entityUrn === targetUrns[0] && e.firstName);
    if (profile) return profile;
  }
  // Fallback: first profile with firstName (legacy)
  return included.find(e => e.entityUrn?.includes('fsd_profile') && e.firstName);
}

async function fetchProfileGraphQL(auth, vanityName) {
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:${encodeURIComponent(vanityName)})&queryId=voyagerIdentityDashProfiles.a3de77c32c473719f1c58fae6bff43a5`;
  const result = await apiFetch(auth, url);
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node linkedin-profile.mjs auth');
    }
    throw new Error(`Failed to fetch profile "${vanityName}" (HTTP ${result.status})`);
  }
  return result.data;
}

function extractRelationship(included) {
  const memberRel = included.find(e => e.$type?.includes('MemberRelationship'));
  const followState = included.find(e => e.$type?.includes('FollowingState'));
  const connection = included.find(e => e.$type === 'com.linkedin.voyager.dash.relationships.Connection');

  let connectionStatus = 'unknown';
  let memberDistance = null;
  let invitationUrn = null;
  if (memberRel?.memberRelationship) {
    const rel = memberRel.memberRelationship;
    if (rel.self) connectionStatus = 'self';
    else if (rel.connection) connectionStatus = 'connected';
    else if (rel.noConnection) {
      memberDistance = rel.noConnection.memberDistance;
      const inv = rel.noConnection.invitation;
      if (inv?.invitation) {
        connectionStatus = 'pending';
        invitationUrn = inv.invitation.entityUrn || inv.invitation['*invitation'];
      } else {
        connectionStatus = 'not_connected';
      }
    }
  }

  return {
    connectionStatus,
    memberDistance,
    following: followState?.following || false,
    followerCount: followState?.followerCount || null,
    connectionUrn: connection?.entityUrn || null,
    invitationUrn,
    followingStateUrn: followState?.entityUrn || null,
  };
}

function extractMutualConnections(included) {
  const insight = included.find(e => e.$type?.includes('Insight') && e.text?.text?.includes('mutual'));
  if (!insight) return null;

  const text = insight.text?.text || '';
  const countMatch = text.match(/(\d+)\s*other\s*mutual/);

  // Extract named profile URNs from text attributes
  const attrs = insight.text?.attributesV2 || [];
  const namedUrns = attrs
    .filter(a => a.detailData?.['*profileFullName'])
    .map(a => a.detailData['*profileFullName']);

  // Resolve names from included
  const namedProfiles = namedUrns.map(urn => {
    const p = included.find(e => e.entityUrn === urn && e.firstName);
    return p ? { urn, name: `${p.firstName || ''} ${p.lastName || ''}`.trim() } : { urn, name: urn };
  });

  // Dedupe
  const seen = new Set();
  const unique = namedProfiles.filter(p => { if (seen.has(p.urn)) return false; seen.add(p.urn); return true; });

  const otherCount = countMatch ? parseInt(countMatch[1]) : 0;
  const totalCount = unique.length + otherCount;

  return {
    text,
    totalCount,
    namedConnections: unique,
    searchUrl: insight.navigationUrl || null,
  };
}

async function resolveProfileUrn(auth, vanityName) {
  const profiles = loadJson(PROFILES_FILE);
  const cacheKey = vanityName.toLowerCase();
  if (profiles[cacheKey]) return profiles[cacheKey];

  const data = await fetchProfileGraphQL(auth, vanityName);
  const included = data?.included || [];
  const profile = findTargetProfile(data);
  if (!profile) throw new Error(`Could not find profile data for "${vanityName}"`);

  const profileData = {
    urn: profile.entityUrn,
    name: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
    vanityName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    location: profile.geoLocationName || profile.locationName,
    publicIdentifier: profile.publicIdentifier,
  };
  profiles[cacheKey] = profileData;
  saveJson(PROFILES_FILE, profiles);
  return profileData;
}

// ---------------------------------------------------------------------------
// Card fetching: retrieve profile card data (experience, education, etc.)
// ---------------------------------------------------------------------------

const CARD_TYPES = ['EXPERIENCE', 'EDUCATION', 'SKILLS', 'LICENSES_AND_CERTIFICATIONS',
  'VOLUNTEERING_EXPERIENCES', 'HONORS_AND_AWARDS', 'LANGUAGES', 'PROJECTS', 'PUBLICATIONS',
  'COURSES', 'TEST_SCORES', 'ORGANIZATIONS'];

async function fetchProfileCard(auth, cardUrn) {
  const encoded = encodeURIComponent(cardUrn);
  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfileCards/${encoded}`;
  const result = await apiFetch(auth, url);
  if (!result.ok) return null;
  return result.data;
}

function extractEntityItems(components) {
  const items = [];
  if (!components) return items;
  for (const comp of components) {
    const union = comp.componentsUnion || comp.components || comp;
    const entity = union.entityComponent;
    if (entity) {
      const title = entity.titleV2?.text?.text || entity.title?.text;
      const subtitle = entity.subtitle?.text;
      const caption = entity.caption?.text;
      const metadata = entity.metadata?.text;
      let description = null;
      let skills = null;
      const subComps = entity.subComponents?.components || [];
      for (const sub of subComps) {
        const subUnion = sub.componentsUnion || sub.components || sub;
        const fixedList = subUnion.fixedListComponent;
        if (fixedList?.components) {
          for (const inner of fixedList.components) {
            const innerUnion = inner.componentsUnion || inner.components || inner;
            if (innerUnion.textComponent) {
              description = innerUnion.textComponent.text?.text || description;
            }
            if (innerUnion.insightComponent?.text?.text?.text) {
              skills = innerUnion.insightComponent.text.text.text;
            }
          }
        }
      }
      if (title) {
        items.push({ title, subtitle, caption, metadata, description, skills });
      }
    }
    const fixedList = union.fixedListComponent;
    if (fixedList?.components) {
      items.push(...extractEntityItems(fixedList.components));
    }
  }
  return items;
}

function parseCardItems(cardData) {
  const items = [];
  const topComponents = cardData?.data?.topComponents || cardData?.topComponents || [];
  for (const comp of topComponents) {
    const union = comp.componentsUnion || comp.components || comp;
    if (union.headerComponent) continue;
    const extracted = extractEntityItems([comp]);
    items.push(...extracted);
  }
  return items;
}

// ---------------------------------------------------------------------------
// view: fetch full profile via API (GraphQL + profile cards, no browser)
// ---------------------------------------------------------------------------

async function viewProfile(auth, vanityName) {
  // Step 1: Fetch profile via GraphQL (includes relationship data)
  const graphqlData = await fetchProfileGraphQL(auth, vanityName);
  const included = graphqlData?.included || [];
  const profile = findTargetProfile(graphqlData);
  if (!profile) throw new Error(`Could not find profile data for "${vanityName}"`);

  const relationship = extractRelationship(included);
  const mutualConnections = extractMutualConnections(included);
  const connectionsTotal = profile.connections?.paging?.total || null;

  // Extract profile picture URL
  const pic = profile.profilePicture?.displayImageReference?.vectorImage;
  const profilePicture = pic ? `${pic.rootUrl}400_400/${pic.artifacts?.find(a => a.width === 400)?.fileIdentifyingUrlPathSegment || pic.artifacts?.[0]?.fileIdentifyingUrlPathSegment || ''}` : null;

  const output = {
    fullName: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    location: profile.geoLocationName || profile.locationName,
    profileUrl: `https://www.linkedin.com/in/${profile.publicIdentifier || vanityName}/`,
    profileUrn: profile.entityUrn,
    objectUrn: profile.objectUrn,
    premium: profile.premium,
    influencer: profile.influencer,
    creator: profile.creator,
    profilePicture,
    connectionsCount: connectionsTotal,
    relationship,
    mutualConnections,
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    languages: [],
    volunteering: [],
    honors: [],
    projects: [],
    publications: [],
    courses: [],
  };

  // Step 2: Build card URNs
  const cardUrns = [];
  const profileId = profile.entityUrn?.replace('urn:li:fsd_profile:', '');
  if (profileId) {
    for (const cardType of CARD_TYPES) {
      cardUrns.push({ type: cardType, urn: `urn:li:fsd_profileCard:(${profileId},${cardType},en_US)` });
    }
  }

  // Step 3: Fetch each card
  console.log(`Fetching ${cardUrns.length} profile cards...`);
  for (const card of cardUrns) {
    try {
      const cardData = await fetchProfileCard(auth, card.urn);
      if (!cardData) continue;
      const items = parseCardItems(cardData);
      for (const item of items) {
        switch (card.type) {
          case 'EXPERIENCE':
            output.experience.push({ title: item.title, company: item.subtitle, duration: item.caption, location: item.metadata, description: item.description, skills: item.skills });
            break;
          case 'EDUCATION':
            output.education.push({ school: item.title, degree: item.subtitle, duration: item.caption, activities: item.description });
            break;
          case 'SKILLS':
            output.skills.push(item.title);
            break;
          case 'LICENSES_AND_CERTIFICATIONS':
            output.certifications.push({ name: item.title, authority: item.subtitle, date: item.caption });
            break;
          case 'LANGUAGES':
            output.languages.push(item.title);
            break;
          case 'VOLUNTEERING_EXPERIENCES':
            output.volunteering.push({ role: item.title, organization: item.subtitle, duration: item.caption, description: item.description });
            break;
          case 'HONORS_AND_AWARDS':
            output.honors.push({ title: item.title, issuer: item.subtitle, date: item.caption });
            break;
          case 'PROJECTS':
            output.projects.push({ title: item.title, description: item.description || item.subtitle });
            break;
          case 'PUBLICATIONS':
            output.publications.push({ name: item.title, publisher: item.subtitle });
            break;
          case 'COURSES':
            output.courses.push(item.title);
            break;
          case 'ORGANIZATIONS':
            if (!output.organizations) output.organizations = [];
            output.organizations.push({ name: item.title, role: item.subtitle, duration: item.caption });
            break;
        }
      }
    } catch {
      // Card doesn't exist for this profile
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // Clean up empty arrays
  for (const key of Object.keys(output)) {
    if (Array.isArray(output[key]) && output[key].length === 0) delete output[key];
  }

  output._raw = graphqlData;
  return output;
}

// ---------------------------------------------------------------------------
// Actions: follow, unfollow, connect, withdraw, disconnect
// ---------------------------------------------------------------------------

async function followProfile(auth, profileUrn, follow) {
  const followStateUrn = `urn:li:fsd_followingState:${profileUrn}`;
  const url = `https://www.linkedin.com/voyager/api/feed/dash/followingStates/${followStateUrn}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ patch: { $set: { following: follow } } }),
  });
}

async function sendConnectionRequest(auth, profileUrn, message) {
  const body = {
    invitee: { inviteeUnion: { memberProfile: profileUrn } },
  };
  if (message) body.customMessage = message;
  return await apiFetch(auth,
    'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'accept': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

async function withdrawInvitation(auth, invitationUrn) {
  const encoded = encodeURIComponent(invitationUrn);
  return await apiFetch(auth,
    `https://www.linkedin.com/voyager/api/voyagerRelationshipsDashInvitations/${encoded}?action=withdraw`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'accept': 'application/json' },
      body: JSON.stringify({ sharedSecret: null, invitationType: 'CONNECTION' }),
    }
  );
}

async function removeConnection(auth, connectionUrn) {
  return await apiFetch(auth,
    'https://www.linkedin.com/voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections&decorationId=com.linkedin.voyager.dash.deco.relationships.MemberRelationship-34',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'accept': 'application/json' },
      body: JSON.stringify({ connectionUrn }),
    }
  );
}

async function listConnections(auth, { count = 10, start = 0, sortType = 'RECENTLY_ADDED' } = {}) {
  const url = `https://www.linkedin.com/voyager/api/relationships/dash/connections?q=search&sortType=${sortType}&count=${count}&start=${start}`;
  const result = await apiFetch(auth, url);
  if (!result.ok) throw new Error(`Failed to list connections (HTTP ${result.status})`);

  const included = result.data?.included || [];
  const connections = included
    .filter(e => e.$type === 'com.linkedin.voyager.dash.relationships.Connection')
    .map(c => ({
      connectionUrn: c.entityUrn,
      profileUrn: c.connectedMember,
      createdAt: c.createdAt,
    }));

  // Resolve names for each connection
  for (const conn of connections) {
    if (!conn.profileUrn) continue;
    const url = `https://www.linkedin.com/voyager/api/identity/dash/profiles/${conn.profileUrn}?decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76`;
    try {
      const result = await apiFetch(auth, url);
      if (result.ok) {
        const p = result.data?.data || result.data;
        conn.name = `${p.firstName || ''} ${p.lastName || ''}`.trim();
        conn.headline = p.headline;
        conn.publicIdentifier = p.publicIdentifier;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }

  return connections;
}

// ---------------------------------------------------------------------------
// Posts: fetch profile activity/posts
// ---------------------------------------------------------------------------

async function fetchPosts(auth, profileUrn, { count = 10 } = {}) {
  const encodedUrn = encodeURIComponent(profileUrn);
  const url = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?profileUrn=${encodedUrn}&q=memberShareFeed&moduleKey=member-shares_your-posts&count=${count}`;
  const result = await apiFetch(auth, url, { headers: { 'accept': 'application/json' } });

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node linkedin-profile.mjs auth');
    }
    throw new Error(`Failed to fetch posts (HTTP ${result.status})`);
  }

  const elements = result.data?.elements || [];
  const posts = elements.map(el => {
    const text = el.commentary?.text?.text || el.resharedUpdate?.commentary?.text?.text || '';
    const socialCounts = el.socialDetail?.totalSocialActivityCounts || {};
    const media = [];
    const content = el.content || {};
    if (content.articleComponent) {
      media.push({
        type: 'article',
        title: content.articleComponent.title?.text,
        subtitle: content.articleComponent.subtitle?.text,
        url: content.articleComponent.navigationContext?.actionTarget,
      });
    }
    if (content.imageComponent) media.push({ type: 'image' });
    if (content.videoComponent) media.push({ type: 'video' });
    const reshared = el.resharedUpdate ? {
      text: el.resharedUpdate.commentary?.text?.text,
      actor: el.resharedUpdate.actor?.name?.text,
    } : null;

    return {
      urn: el.updateMetadata?.urn,
      text,
      created: el.actor?.subDescription?.text?.replace(/\s*•\s*$/, '').trim(),
      likes: socialCounts.numLikes || 0,
      comments: socialCounts.numComments || 0,
      shares: socialCounts.numShares || 0,
      impressions: socialCounts.numImpressions || null,
      media: media.length ? media : undefined,
      reshared: reshared || undefined,
    };
  });

  return { profileUrn, posts, paginationToken: result.data?.metadata?.paginationToken || null };
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

function formatRelationship(rel) {
  const parts = [];
  if (rel.connectionStatus === 'connected') parts.push('Connected');
  else if (rel.connectionStatus === 'pending') parts.push('Invitation pending');
  else if (rel.connectionStatus === 'self') parts.push('This is you');
  else parts.push(`Not connected (${rel.memberDistance || '?'})`);
  if (rel.following) parts.push('Following');
  if (rel.followerCount) parts.push(`${rel.followerCount} followers`);
  return parts.join(' | ');
}

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'resolve': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs resolve <vanityName|url>');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    console.log(`Resolving ${vanityName}...`);
    const profile = await resolveProfileUrn(auth, vanityName);
    console.log(`  Name: ${profile.name}`);
    console.log(`  URN:  ${profile.urn}`);
    console.log(`  Headline: ${profile.headline || '(not available)'}`);
    console.log(`  Location: ${profile.location || '(not available)'}`);
    break;
  }

  case 'view':
  case 'view-api': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs view <vanityName|url>');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    console.log(`Fetching profile: ${vanityName}...`);
    const profile = await viewProfile(auth, vanityName);

    const { _raw, ...clean } = profile;
    const outFile = resolve(CACHE_DIR, `profile-${vanityName}.json`);
    saveJson(outFile, clean);
    const rawFile = resolve(CACHE_DIR, `profile-raw-${vanityName}.json`);
    saveJson(rawFile, _raw);

    console.log(`\n${profile.fullName}`);
    console.log(`  ${profile.headline}`);
    if (profile.location) console.log(`  ${profile.location}`);
    console.log(`  ${profile.profileUrl}`);
    console.log(`  URN: ${profile.profileUrn}`);
    if (profile.connectionsCount) console.log(`  Connections: ${profile.connectionsCount}`);
    if (profile.relationship) console.log(`  Status: ${formatRelationship(profile.relationship)}`);
    if (profile.mutualConnections) {
      console.log(`  Mutual: ${profile.mutualConnections.text}`);
    }
    if (profile.experience?.length) {
      console.log(`\n  Experience (${profile.experience.length}):`);
      for (const p of profile.experience) {
        console.log(`    ${p.title || ''} @ ${p.company || ''}`);
        if (p.duration) console.log(`      ${p.duration}`);
      }
    }
    if (profile.education?.length) {
      console.log(`\n  Education (${profile.education.length}):`);
      for (const e of profile.education) {
        console.log(`    ${e.school || ''} — ${e.degree || ''}`);
      }
    }
    if (profile.skills?.length) {
      console.log(`\n  Skills (${profile.skills.length}): ${profile.skills.slice(0, 10).join(', ')}${profile.skills.length > 10 ? '...' : ''}`);
    }
    if (profile.languages?.length) {
      console.log(`\n  Languages: ${profile.languages.join(', ')}`);
    }
    if (profile.certifications?.length) {
      console.log(`\n  Certifications (${profile.certifications.length}):`);
      for (const c of profile.certifications) console.log(`    ${c.name}${c.authority ? ' — ' + c.authority : ''}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'posts': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs posts <vanityName|url> [--count=10]');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    const count = parseInt(flags.count || '10');

    console.log(`Resolving ${vanityName}...`);
    const resolved = await resolveProfileUrn(auth, vanityName);
    console.log(`Fetching posts for ${resolved.name}...`);

    const postsResult = await fetchPosts(auth, resolved.urn, { count });
    const outFile = resolve(CACHE_DIR, `posts-${vanityName}.json`);
    saveJson(outFile, postsResult);

    console.log(`\n${resolved.name} — ${postsResult.posts.length} posts\n`);
    for (const post of postsResult.posts) {
      const date = post.created || '';
      const text = post.text || '(no text)';
      const engagement = [
        post.likes ? `${post.likes} likes` : null,
        post.comments ? `${post.comments} comments` : null,
        post.shares ? `${post.shares} shares` : null,
      ].filter(Boolean).join(', ') || 'no engagement';

      console.log(`  [${date.trim()}] ${text.substring(0, 150)}${text.length > 150 ? '...' : ''}`);
      console.log(`    ${engagement}`);
      if (post.urn) console.log(`    ${post.urn}`);
      console.log();
    }
    if (postsResult.paginationToken) console.log(`More posts available. Use --count=N for more.`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'mutual': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs mutual <vanityName|url>');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    console.log(`Fetching mutual connections for ${vanityName}...`);
    const graphqlData = await fetchProfileGraphQL(auth, vanityName);
    const included = graphqlData?.included || [];
    const mutual = extractMutualConnections(included);

    if (!mutual) {
      console.log('No mutual connections found (you may already be connected or this is your own profile).');
      break;
    }

    console.log(`\n${mutual.text}`);
    console.log(`  Total: ${mutual.totalCount} mutual connections`);
    if (mutual.namedConnections.length) {
      console.log('\n  Named:');
      for (const c of mutual.namedConnections) {
        console.log(`    ${c.name} (${c.urn})`);
      }
    }
    if (mutual.searchUrl) {
      console.log(`\n  Full list: ${mutual.searchUrl}`);
    }
    break;
  }

  case 'connections': {
    const { flags } = parseFlags(args);
    const auth = getAuth();
    const count = parseInt(flags.count || '10');
    const start = parseInt(flags.start || '0');

    console.log(`Fetching connections (${start}-${start + count})...`);
    const connections = await listConnections(auth, { count, start });

    if (!connections.length) {
      console.log('No connections found.');
      break;
    }

    for (const c of connections) {
      const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
      console.log(`  ${c.name || 'Unknown'} — ${c.headline || ''}`);
      if (c.publicIdentifier) console.log(`    linkedin.com/in/${c.publicIdentifier}`);
      console.log(`    Connected: ${date} | ${c.profileUrn}`);
      console.log();
    }
    console.log(`${connections.length} connections shown. Use --start=${start + count} for more.`);
    break;
  }

  case 'follow':
  case 'unfollow': {
    const input = args[0];
    if (!input) {
      console.error(`Usage: node linkedin-profile.mjs ${command} <vanityName|url>`);
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    const resolved = await resolveProfileUrn(auth, vanityName);
    const follow = command === 'follow';

    console.log(`${follow ? 'Following' : 'Unfollowing'} ${resolved.name}...`);
    const result = await followProfile(auth, resolved.urn, follow);
    if (result.ok || result.status === 200) {
      console.log(`${follow ? 'Now following' : 'Unfollowed'} ${resolved.name}.`);
    } else {
      console.error(`Failed (HTTP ${result.status}):`, JSON.stringify(result.data).substring(0, 300));
      process.exit(1);
    }
    break;
  }

  case 'connect': {
    const { positional } = parseFlags(args);
    const input = positional[0];
    const message = positional.slice(1).join(' ') || undefined;
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs connect <vanityName|url> ["optional message"]');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);
    const resolved = await resolveProfileUrn(auth, vanityName);

    console.log(`Sending connection request to ${resolved.name}...`);
    const result = await sendConnectionRequest(auth, resolved.urn, message);
    if (result.ok) {
      console.log(`Connection request sent to ${resolved.name}.`);
    } else {
      console.error(`Failed (HTTP ${result.status}):`, JSON.stringify(result.data).substring(0, 300));
      process.exit(1);
    }
    break;
  }

  case 'withdraw': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs withdraw <vanityName|url>');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);

    // Fetch profile to get invitation URN
    console.log(`Checking invitation status for ${vanityName}...`);
    const graphqlData = await fetchProfileGraphQL(auth, vanityName);
    const included = graphqlData?.included || [];
    const rel = extractRelationship(included);

    if (!rel.invitationUrn) {
      console.error('No pending invitation found for this profile.');
      process.exit(1);
    }

    console.log(`Withdrawing invitation ${rel.invitationUrn}...`);
    const result = await withdrawInvitation(auth, rel.invitationUrn);
    if (result.ok) {
      console.log('Invitation withdrawn.');
    } else {
      console.error(`Failed (HTTP ${result.status}):`, JSON.stringify(result.data).substring(0, 300));
      process.exit(1);
    }
    break;
  }

  case 'disconnect': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs disconnect <vanityName|url>');
      process.exit(1);
    }
    const auth = getAuth();
    const vanityName = parseVanityName(input);

    // Fetch profile to get connection URN
    console.log(`Checking connection status for ${vanityName}...`);
    const graphqlData = await fetchProfileGraphQL(auth, vanityName);
    const included = graphqlData?.included || [];
    const rel = extractRelationship(included);

    if (!rel.connectionUrn) {
      console.error('Not connected to this profile.');
      process.exit(1);
    }

    console.log(`Removing connection (${rel.connectionUrn})...`);
    const result = await removeConnection(auth, rel.connectionUrn);
    if (result.ok) {
      console.log('Connection removed.');
    } else {
      console.error(`Failed (HTTP ${result.status}):`, JSON.stringify(result.data).substring(0, 300));
      process.exit(1);
    }
    break;
  }

  default:
    console.log(`linkedin-profile — LinkedIn profile data & actions

Commands:
  auth                              Authenticate via Chrome (one-time)
  view <profile>                    Fetch full profile via API
  resolve <profile>                 Resolve vanity name to URN
  posts <profile> [--count=10]      Fetch recent posts/activity
  mutual <profile>                  Show mutual connections
  connections [--count=10] [--start=0]
                                    List your connections
  connect <profile> ["message"]     Send connection request
  disconnect <profile>              Remove connection
  withdraw <profile>                Withdraw pending invitation
  follow <profile>                  Follow a profile
  unfollow <profile>                Unfollow a profile

Profile input formats:
  https://linkedin.com/in/username
  /in/username
  username

Data: ${DATA_DIR}/
  session.json     Auth cookies & CSRF token
  profiles.json    Cached URN lookups
  cache/           Profile & posts data`);
}
