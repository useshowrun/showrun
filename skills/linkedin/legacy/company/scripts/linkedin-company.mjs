#!/usr/bin/env node
// linkedin-company.mjs — Fetch LinkedIn company page data from regular LinkedIn
//
// Setup (one-time):
//   node linkedin-company.mjs auth
//
// Usage:
//   node linkedin-company.mjs view google
//   node linkedin-company.mjs view https://linkedin.com/company/google/
//   node linkedin-company.mjs view 1441
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { ensureFreshAuth, detectKillMarkers, killedErrorMessage } from '../../../_shared/li-auth.mjs';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-company');
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
  console.log('Finding LinkedIn tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('linkedin.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No LinkedIn tab found. Open LinkedIn in Chrome first.');

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
      console.error('No auth found. Run: node linkedin-company.mjs auth');
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
    'X-LI-Lang': 'en_US',
    'Csrf-Token': auth.csrfToken,
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, { ...options, headers: { ...baseHeaders(auth), ...options.headers }, redirect: 'manual' });
  const { killed, killReason } = detectKillMarkers(resp);
  if (killed) throw new Error(killedErrorMessage(url, killReason));
  if (resp.status === 204) return null;
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node linkedin-company.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseCompanyInput(input) {
  // LinkedIn URL: https://linkedin.com/company/google/ or /company/google
  const urlMatch = input.match(/(?:linkedin\.com\/company\/|^\/company\/)([^\s/]+)\/?/);
  if (urlMatch) return { universalName: decodeURIComponent(urlMatch[1]) };

  // Numeric ID
  if (/^\d+$/.test(input)) return { companyId: input };

  // Universal name (slug)
  return { universalName: input };
}

// ---------------------------------------------------------------------------
// Company data fetching
// ---------------------------------------------------------------------------

const DECORATION_ID = 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-35';

async function fetchCompany(auth, input) {
  const parsed = parseCompanyInput(input);
  let url;
  if (parsed.companyId) {
    url = `https://www.linkedin.com/voyager/api/organization/companies/${parsed.companyId}?decorationId=${DECORATION_ID}`;
  } else {
    url = `https://www.linkedin.com/voyager/api/organization/companies?decorationId=${DECORATION_ID}&q=universalName&universalName=${encodeURIComponent(parsed.universalName)}`;
  }

  const data = await apiFetch(auth, url);

  // Single company by ID returns the object directly; by name returns {elements: [...]}
  const company = parsed.companyId ? data : data.elements?.[0];
  if (!company) throw new Error(`Company not found: ${input}`);

  return company;
}

function formatCompany(c) {
  const hq = c.headquarter || c.confirmedLocations?.find(l => l.headquarter) || {};
  const logo = c.logo?.image?.['com.linkedin.common.VectorImage'];
  const logoUrl = logo ? `${logo.rootUrl}${logo.artifacts?.find(a => a.width === 400)?.fileIdentifyingUrlPathSegment || logo.artifacts?.[0]?.fileIdentifyingUrlPathSegment || ''}` : null;

  const formatted = {
    name: c.name,
    universalName: c.universalName,
    tagline: c.tagline,
    description: c.description,
    website: c.companyPageUrl,
    linkedinUrl: `https://www.linkedin.com/company/${c.universalName}/`,
    entityUrn: c.entityUrn,
    companyId: c.entityUrn?.match(/\d+$/)?.[0],

    industry: c.companyIndustries?.map(i => i.localizedName) || [],
    companyType: c.companyType?.localizedName,
    foundedOn: c.foundedOn,
    staffCount: c.staffCount,
    staffCountRange: c.staffCountRange?.start ? `${c.staffCountRange.start}+` : null,

    headquarters: hq.city ? `${hq.city}, ${hq.geographicArea || ''}, ${hq.country || ''}`.replace(/, ,/g, ',').replace(/,$/, '') : null,
    headquartersAddress: hq.line1 ? `${hq.line1}, ${hq.city || ''} ${hq.postalCode || ''}`.trim() : null,

    specialities: c.specialities || [],
    logoUrl,
    phone: c.phone,
  };

  // Funding data
  if (c.fundingData) {
    const fd = c.fundingData;
    const last = fd.lastFundingRound;
    formatted.funding = {
      totalRounds: fd.numFundingRounds,
      crunchbaseUrl: fd.companyCrunchbaseUrl,
      lastRound: last ? {
        type: last.fundingType,
        amount: last.moneyRaised ? `${last.moneyRaised.currencyCode} ${last.moneyRaised.amount.toLocaleString()}` : null,
        date: last.announcedOn,
        investors: last.leadInvestors?.map(i => i.name?.text) || [],
      } : null,
    };
  }

  // Locations
  if (c.confirmedLocations?.length) {
    formatted.locations = c.confirmedLocations.map(loc => ({
      city: loc.city,
      region: loc.geographicArea,
      country: loc.country,
      address: loc.line1,
      postalCode: loc.postalCode,
      isHQ: loc.headquarter || false,
    }));
  }

  // Affiliated companies
  if (c.affiliatedCompaniesWithEmployeesRollup?.length) {
    formatted.affiliatedCompanies = c.affiliatedCompaniesWithEmployeesRollup.map(ac => ({
      name: ac.name,
      universalName: ac.universalName,
      industry: ac.companyIndustries?.[0]?.localizedName,
    }));
  }

  // Associated hashtags
  if (c.associatedHashtags?.length) {
    formatted.hashtags = c.associatedHashtags.map(h =>
      typeof h === 'string' ? h.replace(/urn:li:fs_contentTopicData:urn:li:hashtag:/, '#') : h
    );
  }

  return formatted;
}

// ---------------------------------------------------------------------------
// Company posts
// ---------------------------------------------------------------------------

const FEED_QUERY_ID = 'voyagerFeedDashOrganizationalPageUpdates.827e11d165078dd7a5afaf1cba734121';

async function fetchCompanyPosts(auth, companyId, { count = 10, start = 0 } = {}) {
  const variables = `(count:${count},start:${start},moduleKey:ORGANIZATION_MEMBER_FEED_DESKTOP,organizationalPageUrn:urn%3Ali%3Afsd_organizationalPage%3A${companyId})`;
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${FEED_QUERY_ID}`;
  const data = await apiFetch(auth, url);

  const feed = data.data?.feedDashOrganizationalPageUpdatesByOrganizationalPageRelevanceFeed
    || data.data?.feedDashOrganizationalPageUpdatesByOrganizationalPageChronologicalFeed
    || {};
  const elements = feed.elements || [];
  const total = feed.paging?.total || elements.length;

  const posts = elements
    .filter(el => el.metadata?.backendUrn?.includes('activity')) // skip promotions
    .map(el => {
      const socialCounts = el.socialDetail?.totalSocialActivityCounts || {};
      return {
        urn: el.metadata?.backendUrn,
        text: el.commentary?.text?.text || '',
        likes: socialCounts.numLikes || 0,
        comments: socialCounts.numComments || 0,
        shares: socialCounts.numShares || 0,
      };
    });

  return { total, posts, paginationToken: feed.metadata?.paginationToken };
}

// ---------------------------------------------------------------------------
// Company jobs
// ---------------------------------------------------------------------------

const JOBS_DECORATION_ID = 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220';

async function fetchCompanyJobs(auth, companyId, { count = 25, start = 0 } = {}) {
  const query = `(origin:COMPANY_PAGE_JOBS_CLUSTER_EXPANSION,locationUnion:(geoId:92000000),selectedFilters:(company:List(${companyId})))`;
  const url = `https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?decorationId=${JOBS_DECORATION_ID}&count=${count}&q=jobSearch&query=${query}&start=${start}`;
  const data = await apiFetch(auth, url);

  const elements = data.elements || [];
  const total = data.paging?.total || elements.length;

  const jobs = elements.map(el => {
    const card = el.jobCardUnion?.jobPostingCard || {};
    const postingId = card.jobPostingUrn?.match(/\d+$/)?.[0];
    return {
      jobTitle: card.jobPostingTitle,
      company: card.primaryDescription?.text,
      location: card.secondaryDescription?.text,
      salary: card.tertiaryDescription?.text || null,
      postingUrn: card.jobPostingUrn,
      postingId,
      link: postingId ? `https://www.linkedin.com/jobs/view/${postingId}/` : null,
    };
  }).filter(j => j.jobTitle);

  return { total, jobs };
}

// ---------------------------------------------------------------------------
// Company people
// ---------------------------------------------------------------------------

const PEOPLE_SEARCH_QUERY_ID = 'voyagerSearchDashClusters.05111e1b90ee7fea15bebe9f9410ced9';

async function fetchCompanyPeople(auth, companyId, { count = 12, start = 0 } = {}) {
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:resultType,value:List(ORGANIZATION_ALUMNI))),includeFiltersInResponse:false),count:${count})`;
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${PEOPLE_SEARCH_QUERY_ID}`;
  const data = await apiFetch(auth, url);

  const clusters = data.data?.searchDashClustersByAll?.elements || [];
  const people = [];
  let total = 0;

  for (const cluster of clusters) {
    // Extract total from metadata
    if (cluster.totalResultCount) total = cluster.totalResultCount;
    for (const item of (cluster.items || [])) {
      const entity = item.item?.entityResult;
      if (entity) {
        const profileUrn = entity.entityUrn?.match(/fsd_profile:([^,)]+)/)?.[1];
        people.push({
          name: entity.title?.text,
          headline: entity.primarySubtitle?.text,
          location: entity.secondarySubtitle?.text,
          summary: entity.summary?.text,
          profileUrn: profileUrn ? `urn:li:fsd_profile:${profileUrn}` : null,
          profileUrl: entity.navigationUrl?.split('?')[0],
        });
      }
    }
  }

  return { total, people };
}

async function fetchDecisionMakers(auth, companyId) {
  const url = `https://www.linkedin.com/voyager/api/voyagerIdentityDashProfiles?decorationId=com.linkedin.voyager.dash.deco.identity.profile.DecisionMakers-2&organizationUrn=urn%3Ali%3Afsd_company%3A${companyId}&q=decisionMakers`;
  const data = await apiFetch(auth, url);

  const included = data.included || [];
  return included
    .filter(e => e.entityUrn?.includes('fsd_profile') && e.firstName)
    .map(p => ({
      name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
      headline: p.headline,
      profileUrn: p.entityUrn,
      profileUrl: p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}/` : null,
    }));
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

async function followCompany(auth, companyId, follow = true) {
  const urn = `urn:li:fsd_followingState:urn:li:fsd_company:${companyId}`;
  const url = `https://www.linkedin.com/voyager/api/feed/dash/followingStates/${encodeURIComponent(urn)}`;
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ patch: { $set: { following: follow } } }),
  });
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

  case 'view': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs view <company-name|url|id>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching company: ${input}...`);
    const raw = await fetchCompany(auth, input);
    const company = formatCompany(raw);

    // Save formatted + raw
    const slug = company.universalName || input;
    const outFile = resolve(CACHE_DIR, `company-${slug}.json`);
    saveJson(outFile, company);
    const rawFile = resolve(CACHE_DIR, `company-raw-${slug}.json`);
    saveJson(rawFile, raw);

    console.log(`\n${company.name}`);
    if (company.tagline) console.log(`  "${company.tagline}"`);
    if (company.description) console.log(`  ${company.description.substring(0, 200)}${company.description.length > 200 ? '...' : ''}`);
    console.log();
    if (company.industry?.length) console.log(`  Industry: ${company.industry.join(', ')}`);
    if (company.companyType) console.log(`  Type: ${company.companyType}`);
    if (company.staffCount) console.log(`  Employees: ${company.staffCount.toLocaleString()}`);
    if (company.headquarters) console.log(`  HQ: ${company.headquarters}`);
    if (company.foundedOn?.year) console.log(`  Founded: ${company.foundedOn.year}`);
    if (company.website) console.log(`  Website: ${company.website}`);
    if (company.linkedinUrl) console.log(`  LinkedIn: ${company.linkedinUrl}`);
    if (company.specialities?.length) console.log(`  Specialties: ${company.specialities.join(', ')}`);
    if (company.funding) {
      const f = company.funding;
      console.log(`\n  Funding: ${f.totalRounds} round(s)`);
      if (f.lastRound) {
        console.log(`    Last: ${f.lastRound.type} — ${f.lastRound.amount || 'undisclosed'}`);
        if (f.lastRound.investors?.length) console.log(`    Investors: ${f.lastRound.investors.join(', ')}`);
      }
    }
    if (company.locations?.length) {
      console.log(`\n  Locations (${company.locations.length}):`);
      for (const loc of company.locations.slice(0, 5)) {
        console.log(`    ${loc.isHQ ? '[HQ] ' : ''}${loc.city || ''}, ${loc.region || ''}, ${loc.country || ''}`);
      }
      if (company.locations.length > 5) console.log(`    ... and ${company.locations.length - 5} more`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'posts': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs posts <company-name|url|id> [--count=10]');
      process.exit(1);
    }

    const auth = getAuth();
    const count = parseInt(flags.count || '10');

    // First get company info to resolve the ID
    console.log(`Fetching company: ${input}...`);
    const company = await fetchCompany(auth, input);
    const companyId = company.entityUrn?.match(/\d+$/)?.[0];

    if (!companyId) throw new Error('Could not determine company ID');

    console.log(`Fetching posts for ${company.name}...`);
    const result = await fetchCompanyPosts(auth, companyId, { count });

    const slug = company.universalName || input;
    const outFile = resolve(CACHE_DIR, `posts-${slug}.json`);
    saveJson(outFile, { company: company.name, companyId, total: result.total, posts: result.posts });

    console.log(`\n${company.name} — ${result.posts.length} posts (${result.total} total)\n`);
    for (const post of result.posts) {
      const text = post.text || '(no text)';
      const engagement = [
        post.likes ? `${post.likes} likes` : null,
        post.comments ? `${post.comments} comments` : null,
        post.shares ? `${post.shares} shares` : null,
      ].filter(Boolean).join(', ') || 'no engagement';

      console.log(`  ${text.substring(0, 150)}${text.length > 150 ? '...' : ''}`);
      console.log(`    ${engagement}`);
      if (post.urn) console.log(`    ${post.urn}`);
      console.log();
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'jobs': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs jobs <company-name|url|id> [--count=25] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const count = parseInt(flags.count || '25');
    const start = parseInt(flags.start || '0');

    console.log(`Fetching company: ${input}...`);
    const company = await fetchCompany(auth, input);
    const companyId = company.entityUrn?.match(/\d+$/)?.[0];
    if (!companyId) throw new Error('Could not determine company ID');

    console.log(`Fetching jobs for ${company.name}...`);
    const result = await fetchCompanyJobs(auth, companyId, { count, start });

    const slug = company.universalName || input;
    const outFile = resolve(CACHE_DIR, `jobs-${slug}.json`);
    saveJson(outFile, { company: company.name, companyId, total: result.total, jobs: result.jobs });

    console.log(`\n${company.name} — ${result.jobs.length} jobs (${result.total} total)\n`);
    for (const job of result.jobs) {
      console.log(`  ${job.jobTitle}`);
      console.log(`    ${job.location || ''}${job.salary ? ' | ' + job.salary : ''}`);
      if (job.link) console.log(`    ${job.link}`);
      console.log();
    }
    if (result.total > start + count) {
      console.log(`More jobs available. Use --start=${start + count} for next page.`);
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'people': {
    const { flags, positional } = parseFlags(args);
    const input = positional[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs people <company-name|url|id> [--count=12] [--start=0]');
      process.exit(1);
    }

    const auth = getAuth();
    const count = parseInt(flags.count || '12');
    const start = parseInt(flags.start || '0');

    console.log(`Fetching company: ${input}...`);
    const company = await fetchCompany(auth, input);
    const companyId = company.entityUrn?.match(/\d+$/)?.[0];
    if (!companyId) throw new Error('Could not determine company ID');

    console.log(`Fetching people at ${company.name}...`);
    const result = await fetchCompanyPeople(auth, companyId, { count, start });

    // Also fetch decision makers
    let decisionMakers = [];
    try {
      decisionMakers = await fetchDecisionMakers(auth, companyId);
    } catch { /* may not be available */ }

    const slug = company.universalName || input;
    const outFile = resolve(CACHE_DIR, `people-${slug}.json`);
    saveJson(outFile, { company: company.name, companyId, total: result.total, people: result.people, decisionMakers });

    console.log(`\n${company.name} — ${result.people.length} people${result.total ? ` (${result.total} total)` : ''}\n`);
    for (const p of result.people) {
      console.log(`  ${p.name}`);
      if (p.headline) console.log(`    ${p.headline}`);
      if (p.location) console.log(`    ${p.location}`);
      console.log();
    }
    if (decisionMakers.length) {
      console.log(`  Decision Makers (${decisionMakers.length}):`);
      for (const dm of decisionMakers) {
        console.log(`    ${dm.name} — ${dm.headline || ''}`);
      }
      console.log();
    }
    if (result.total > start + count) {
      console.log(`More people available. Use --start=${start + count} for next page.`);
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'follow': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs follow <company-name|url|id>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching company: ${input}...`);
    const company = await fetchCompany(auth, input);
    const companyId = company.entityUrn?.match(/\d+$/)?.[0];
    if (!companyId) throw new Error('Could not determine company ID');

    console.log(`Following ${company.name}...`);
    await followCompany(auth, companyId, true);
    console.log(`Now following ${company.name}.`);
    break;
  }

  case 'unfollow': {
    const input = args[0];
    if (!input) {
      console.error('Usage: node linkedin-company.mjs unfollow <company-name|url|id>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching company: ${input}...`);
    const company = await fetchCompany(auth, input);
    const companyId = company.entityUrn?.match(/\d+$/)?.[0];
    if (!companyId) throw new Error('Could not determine company ID');

    console.log(`Unfollowing ${company.name}...`);
    await followCompany(auth, companyId, false);
    console.log(`Unfollowed ${company.name}.`);
    break;
  }

  default:
    console.log(`linkedin-company — Fetch LinkedIn company page data

Commands:
  auth                                    Authenticate via Chrome (one-time)
  view <company-name|url|id>              Fetch company info
  posts <company-name|url|id> [--count]   Fetch company posts
  jobs <company-name|url|id> [--count]    Fetch job listings
  people <company-name|url|id> [--count]  Fetch employees & decision makers
  follow <company-name|url|id>            Follow a company
  unfollow <company-name|url|id>          Unfollow a company

Company input formats (all work):
  https://linkedin.com/company/google
  /company/google
  google                                  Universal name (URL slug)
  1441                                    Company ID

Data: ${DATA_DIR}/
  session.json    Auth cookies & CSRF token
  cache/          Company data, posts, and jobs`);
}
