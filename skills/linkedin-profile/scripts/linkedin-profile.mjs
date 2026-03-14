#!/usr/bin/env node
// linkedin-profile.mjs — Fetch LinkedIn profile data from regular LinkedIn
//
// Setup (one-time, requires Chrome with LinkedIn open):
//   node linkedin-profile.mjs auth
//
// Usage:
//   node linkedin-profile.mjs resolve emrahyalaz
//   node linkedin-profile.mjs view emrahyalaz
//   node linkedin-profile.mjs view-api emrahyalaz
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
// CDP integration
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
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
// Profile resolution: vanity name -> URN
// ---------------------------------------------------------------------------

function parseVanityName(input) {
  const match = input.match(/(?:linkedin\.com\/in\/|^\/in\/|^)([a-zA-Z0-9\-_%]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : input;
}

async function resolveProfileUrn(auth, vanityName) {
  const profiles = loadJson(PROFILES_FILE);
  const cacheKey = vanityName.toLowerCase();

  if (profiles[cacheKey]) return profiles[cacheKey];

  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanityName)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`;
  const result = await apiFetch(auth, url);

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node linkedin-profile.mjs auth');
    }
    throw new Error(`Failed to resolve profile "${vanityName}" (HTTP ${result.status})`);
  }

  const elements = result.data?.data?.['*elements'] || result.data?.['*elements'] || [];
  let profileUrn = elements.find(e => e.includes('fsd_profile'));

  const included = result.data?.included || [];

  if (!profileUrn) {
    const profile = included.find(e => e.entityUrn?.includes('fsd_profile') && e.firstName);
    if (profile) profileUrn = profile.entityUrn;
  }

  if (!profileUrn) throw new Error(`Could not find profile URN for "${vanityName}"`);

  const profileObj = included.find(e => e.entityUrn === profileUrn);
  const name = profileObj
    ? `${profileObj.firstName || ''} ${profileObj.lastName || ''}`.trim()
    : vanityName;

  const profileData = {
    urn: profileUrn,
    name,
    vanityName,
    firstName: profileObj?.firstName,
    lastName: profileObj?.lastName,
    headline: profileObj?.headline,
    location: profileObj?.geoLocationName || profileObj?.locationName,
    publicIdentifier: profileObj?.publicIdentifier,
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
    // Direct entity component
    const entity = union.entityComponent;
    if (entity) {
      const title = entity.titleV2?.text?.text || entity.title?.text;
      const subtitle = entity.subtitle?.text;
      const caption = entity.caption?.text;
      const metadata = entity.metadata?.text;
      // Extract description from subComponents
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
    // Nested fixedListComponent (contains entityComponents)
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
    // Skip header components (they just contain the section title like "Experience")
    if (union.headerComponent) continue;

    // Extract entity items from fixedListComponent or direct entityComponent
    const extracted = extractEntityItems([comp]);
    items.push(...extracted);
  }

  return items;
}

// ---------------------------------------------------------------------------
// view-api: direct API call (fetches profile + card data, no browser needed)
// ---------------------------------------------------------------------------

async function viewApi(auth, vanityName) {
  // Step 1: Fetch basic profile to get card URNs
  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanityName)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`;
  const result = await apiFetch(auth, url);

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node linkedin-profile.mjs auth');
    }
    throw new Error(`Failed to fetch profile "${vanityName}" (HTTP ${result.status})`);
  }

  const included = result.data?.included || [];
  const profile = included.find(e => e.entityUrn?.includes('fsd_profile') && e.firstName);
  if (!profile) throw new Error(`Could not find profile data for "${vanityName}"`);

  // Extract geo location from included entities
  const geoEntity = included.find(e => e.$type?.includes('Geo') && e.entityUrn === profile.geoLocation?.geoUrn);
  const location = geoEntity?.defaultLocalizedName || profile.geoLocationName || profile.locationName;

  // Extract profile picture URL
  const pic = profile.profilePicture?.displayImageReference?.vectorImage;
  const profilePicture = pic ? `${pic.rootUrl}400_400/${pic.artifacts?.find(a => a.width === 400)?.fileIdentifyingUrlPathSegment || pic.artifacts?.[0]?.fileIdentifyingUrlPathSegment || ''}` : null;

  // Build base profile
  const output = {
    fullName: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    location,
    profileUrl: `https://www.linkedin.com/in/${profile.publicIdentifier || vanityName}/`,
    profileUrn: profile.entityUrn,
    objectUrn: profile.objectUrn,
    premium: profile.premium,
    influencer: profile.influencer,
    creator: profile.creator,
    profilePicture,
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

  // Step 2: Extract card URNs from profile entity
  const cardUrns = [];
  // Check both reference patterns LinkedIn uses
  for (const cardType of CARD_TYPES) {
    const urnKey = `*${cardType.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase())}Card`;
    const urnKey2 = `${cardType.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase())}CardUrn`;
    const cardUrn = profile[urnKey] || profile[urnKey2];
    if (cardUrn) {
      cardUrns.push({ type: cardType, urn: cardUrn });
    }
  }

  // Also look for known patterns directly
  if (profile['*experienceCard']) cardUrns.push({ type: 'EXPERIENCE', urn: profile['*experienceCard'] });
  if (profile.experienceCardUrn) cardUrns.push({ type: 'EXPERIENCE', urn: profile.experienceCardUrn });
  if (profile['*educationCard']) cardUrns.push({ type: 'EDUCATION', urn: profile['*educationCard'] });
  if (profile.educationCardUrn) cardUrns.push({ type: 'EDUCATION', urn: profile.educationCardUrn });

  // Also try to construct card URNs from the profile URN for common types
  const profileId = profile.entityUrn?.replace('urn:li:fsd_profile:', '');
  if (profileId) {
    for (const cardType of CARD_TYPES) {
      const constructedUrn = `urn:li:fsd_profileCard:(${profileId},${cardType},en_US)`;
      if (!cardUrns.find(c => c.type === cardType)) {
        cardUrns.push({ type: cardType, urn: constructedUrn });
      }
    }
  }

  // Deduplicate by type
  const seenTypes = new Set();
  const uniqueCards = cardUrns.filter(c => {
    if (seenTypes.has(c.type)) return false;
    seenTypes.add(c.type);
    return true;
  });

  // Step 3: Fetch each card
  console.log(`Fetching ${uniqueCards.length} profile cards...`);
  for (const card of uniqueCards) {
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
          default:
            break;
        }
      }
    } catch (err) {
      // Card fetch failed — skip silently (e.g., card doesn't exist for this profile)
    }
    // Small delay between card requests
    await new Promise(r => setTimeout(r, 300));
  }

  // Clean up empty arrays
  for (const key of Object.keys(output)) {
    if (Array.isArray(output[key]) && output[key].length === 0) {
      delete output[key];
    }
  }

  output._raw = result.data;
  return output;
}

// ---------------------------------------------------------------------------
// view: CDP-based full profile capture (intercepts all GraphQL responses)
// ---------------------------------------------------------------------------

async function viewFull(auth, vanityName) {
  console.log('Finding LinkedIn tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');

  // Install network interceptor
  console.log('Installing interceptor...');
  const interceptorCode = `(() => {
    window.__profileData = { requests: [], installed: true };
    const orig = window.fetch;
    window.fetch = async function(...a) {
      const resp = await orig.apply(this, a);
      const url = typeof a[0] === "string" ? a[0] : a[0]?.url || "";
      if (url.includes("/voyager/api/")) {
        try {
          const clone = resp.clone();
          const body = await clone.text();
          window.__profileData.requests.push({
            url: url.substring(0, 500),
            status: resp.status,
            body,
            ts: Date.now()
          });
        } catch(e) {}
      }
      return resp;
    };
    return "interceptor_installed";
  })()`;
  cdp('eval', target, interceptorCode);

  // Navigate to profile
  const profileUrl = `https://www.linkedin.com/in/${vanityName}/`;
  console.log(`Navigating to ${profileUrl}...`);
  cdp('nav', target, profileUrl);

  // Wait for initial load
  await new Promise(r => setTimeout(r, 3000));

  // Scroll down to trigger lazy-loaded sections
  console.log('Scrolling to load all sections...');
  cdp('eval', target, 'window.scrollTo(0, document.body.scrollHeight)');
  await new Promise(r => setTimeout(r, 2000));
  cdp('eval', target, 'window.scrollTo(0, document.body.scrollHeight * 2)');
  await new Promise(r => setTimeout(r, 2000));

  // Collect intercepted data
  console.log('Collecting intercepted data...');
  const rawCount = cdp('eval', target, 'window.__profileData.requests.length');
  const count = parseInt(rawCount) || 0;
  console.log(`Captured ${count} API responses.`);

  // Read all captured responses
  const allData = [];
  for (let i = 0; i < count; i++) {
    try {
      const chunk = cdp('eval', target, `JSON.stringify({url: window.__profileData.requests[${i}].url, body: window.__profileData.requests[${i}].body.substring(0, 50000)})`);
      const parsed = JSON.parse(chunk);
      allData.push(parsed);
    } catch { /* skip oversized responses */ }
  }

  // Clean up
  cdp('eval', target, 'delete window.__profileData');

  // Parse and compile profile data
  const profile = compileProfileData(allData, vanityName);
  return profile;
}

function compileProfileData(capturedResponses, vanityName) {
  const profile = {
    vanityName,
    profileUrl: `https://www.linkedin.com/in/${vanityName}/`,
    fullName: null,
    firstName: null,
    lastName: null,
    headline: null,
    location: null,
    summary: null,
    profileUrn: null,
    experience: [],
    education: [],
    skills: [],
    languages: [],
    certifications: [],
    honors: [],
    contactInfo: {},
    _capturedEndpoints: [],
  };

  for (const resp of capturedResponses) {
    profile._capturedEndpoints.push(resp.url);

    let data;
    try { data = JSON.parse(resp.body); } catch { continue; }

    const included = data?.included || [];
    for (const entity of included) {
      const type = entity.$type || '';
      const urn = entity.entityUrn || '';

      // Profile basic info
      if (urn.includes('fsd_profile') && entity.firstName) {
        profile.fullName = profile.fullName || `${entity.firstName || ''} ${entity.lastName || ''}`.trim();
        profile.firstName = profile.firstName || entity.firstName;
        profile.lastName = profile.lastName || entity.lastName;
        profile.headline = profile.headline || entity.headline;
        profile.location = profile.location || entity.geoLocationName || entity.locationName;
        profile.summary = profile.summary || entity.summary;
        profile.profileUrn = profile.profileUrn || urn;
      }

      // Experience/positions
      if ((type.includes('Position') || entity.companyName) && entity.title && !profile.experience.find(e => e.title === entity.title && e.company === entity.companyName)) {
        profile.experience.push({
          title: entity.title,
          company: entity.companyName,
          location: entity.locationName || entity.geoLocationName,
          description: entity.description,
          startDate: entity.dateRange?.start || entity.timePeriod?.startDate,
          endDate: entity.dateRange?.end || entity.timePeriod?.endDate,
          current: entity.dateRange?.end ? false : true,
        });
      }

      // Education
      if ((type.includes('Education') || entity.schoolName) && entity.schoolName && !profile.education.find(e => e.school === entity.schoolName)) {
        profile.education.push({
          school: entity.schoolName,
          degree: entity.degreeName,
          field: entity.fieldOfStudy,
          description: entity.description,
          startDate: entity.dateRange?.start || entity.timePeriod?.startDate,
          endDate: entity.dateRange?.end || entity.timePeriod?.endDate,
        });
      }

      // Skills
      if ((type.includes('Skill') || entity.name) && entity.name && type.includes('Skill') && !profile.skills.includes(entity.name)) {
        profile.skills.push(entity.name);
      }

      // Languages
      if (type.includes('Language') && entity.name && !profile.languages.includes(entity.name)) {
        profile.languages.push(entity.name);
      }

      // Certifications
      if (type.includes('Certification') && entity.name) {
        profile.certifications.push({
          name: entity.name,
          authority: entity.authority,
          url: entity.url,
        });
      }

      // Contact info
      if (type.includes('ContactInfo') || entity.emailAddress) {
        if (entity.emailAddress) profile.contactInfo.email = entity.emailAddress;
        if (entity.phoneNumbers) profile.contactInfo.phones = entity.phoneNumbers;
        if (entity.websites) profile.contactInfo.websites = entity.websites;
        if (entity.twitterHandles) profile.contactInfo.twitter = entity.twitterHandles;
      }
    }
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Posts: fetch profile activity/posts
// ---------------------------------------------------------------------------

async function fetchPosts(auth, profileUrn, { count = 10 } = {}) {
  const encodedUrn = encodeURIComponent(profileUrn);
  const url = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?profileUrn=${encodedUrn}&q=memberShareFeed&moduleKey=member-shares_your-posts&count=${count}`;
  // Use application/json to get denormalized response (not normalized URN refs)
  const result = await apiFetch(auth, url, { headers: { 'accept': 'application/json' } });

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.error('Session expired. Run: node linkedin-profile.mjs auth');
    }
    throw new Error(`Failed to fetch posts (HTTP ${result.status})`);
  }

  const elements = result.data?.elements || [];
  const posts = elements.map(el => {
    const text = el.commentary?.text?.text
      || el.resharedUpdate?.commentary?.text?.text
      || '';
    const socialCounts = el.socialDetail?.totalSocialActivityCounts || {};
    const media = [];

    // Extract images/articles/videos
    const content = el.content || {};
    if (content.articleComponent) {
      media.push({
        type: 'article',
        title: content.articleComponent.title?.text,
        subtitle: content.articleComponent.subtitle?.text,
        url: content.articleComponent.navigationContext?.actionTarget,
      });
    }
    if (content.imageComponent) {
      media.push({ type: 'image' });
    }
    if (content.videoComponent) {
      media.push({ type: 'video' });
    }
    // Check for reshared content
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

  return {
    profileUrn,
    posts,
    paginationToken: result.data?.metadata?.paginationToken || null,
  };
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

  case 'view-api': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs view-api <vanityName|url>');
      process.exit(1);
    }

    const auth = getAuth();
    const vanityName = parseVanityName(input);
    console.log(`Fetching profile via API: ${vanityName}...`);
    const profile = await viewApi(auth, vanityName);

    // Save without raw data
    const { _raw, ...clean } = profile;
    const outFile = resolve(CACHE_DIR, `api-${vanityName}.json`);
    saveJson(outFile, clean);

    // Also save raw response
    const rawFile = resolve(CACHE_DIR, `api-raw-${vanityName}.json`);
    saveJson(rawFile, _raw);

    console.log(`\n${profile.fullName}`);
    console.log(`  ${profile.headline}`);
    if (profile.location) console.log(`  ${profile.location}`);
    console.log(`  ${profile.profileUrl}`);
    console.log(`  URN: ${profile.profileUrn}`);
    if (profile.experience?.length) {
      console.log(`\n  Experience (${profile.experience.length}):`);
      for (const p of profile.experience) {
        console.log(`    ${p.title || ''} @ ${p.company || p.subtitle || ''}`);
        if (p.duration || p.caption) console.log(`      ${p.duration || p.caption}`);
      }
    }
    if (profile.education?.length) {
      console.log(`\n  Education (${profile.education.length}):`);
      for (const e of profile.education) {
        console.log(`    ${e.school || ''} — ${e.degree || ''} ${e.field || ''}`);
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
    console.log(`Raw response: ${rawFile}`);
    break;
  }

  case 'view': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-profile.mjs view <vanityName|url>');
      console.error('  Requires Chrome with LinkedIn open.');
      process.exit(1);
    }

    const auth = getAuth();
    const vanityName = parseVanityName(input);
    console.log(`Fetching full profile via CDP: ${vanityName}...`);
    const profile = await viewFull(auth, vanityName);

    const outFile = resolve(CACHE_DIR, `profile-${vanityName}.json`);
    saveJson(outFile, profile);

    console.log(`\n${profile.fullName || vanityName}`);
    if (profile.headline) console.log(`  ${profile.headline}`);
    if (profile.location) console.log(`  ${profile.location}`);
    if (profile.summary) console.log(`  ${profile.summary.substring(0, 200)}...`);
    console.log(`  URN: ${profile.profileUrn || '(not captured)'}`);

    if (profile.experience.length) {
      console.log(`\n  Experience (${profile.experience.length}):`);
      for (const e of profile.experience) {
        console.log(`    ${e.title} @ ${e.company}${e.current ? ' (current)' : ''}`);
      }
    }
    if (profile.education.length) {
      console.log(`\n  Education (${profile.education.length}):`);
      for (const e of profile.education) {
        console.log(`    ${e.school} — ${e.degree || ''} ${e.field || ''}`);
      }
    }
    if (profile.skills.length) {
      console.log(`\n  Skills (${profile.skills.length}): ${profile.skills.slice(0, 10).join(', ')}${profile.skills.length > 10 ? '...' : ''}`);
    }
    if (profile.contactInfo.email) {
      console.log(`\n  Email: ${profile.contactInfo.email}`);
    }

    console.log(`\nCaptured ${profile._capturedEndpoints.length} API responses.`);
    console.log(`Saved to: ${outFile}`);
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

    // Resolve URN first
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
    if (postsResult.paginationToken) {
      console.log(`More posts available. Use --count=N for more.`);
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  default:
    console.log(`linkedin-profile — Fetch LinkedIn profile data from regular LinkedIn

Commands:
  auth                              Authenticate via Chrome (one-time)
  resolve <vanityName|url>          Resolve to profile URN
  view-api <vanityName|url>         Fetch profile via API (basic info, no browser)
  view <vanityName|url>             Fetch full profile via CDP (needs Chrome)
  posts <vanityName|url> [--count]  Fetch recent posts/activity

Profile input formats (all work):
  https://linkedin.com/in/username
  /in/username
  username

Data: ${DATA_DIR}/
  session.json     Auth cookies & CSRF token
  profiles.json    Cached URN lookups
  cache/           Profile data`);
}
