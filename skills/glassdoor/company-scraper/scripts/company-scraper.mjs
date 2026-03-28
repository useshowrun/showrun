#!/usr/bin/env node
/**
 * glassdoor-company-scraper
 *
 * Scrape Glassdoor company data: overview/ratings, reviews, salaries, jobs.
 * Uses Playwright + real Chrome (CDP) to bypass Cloudflare WAF.
 *
 * Usage:
 *   node company-scraper.mjs search <query> [options]
 *   node company-scraper.mjs overview <company-id> [options]
 *   node company-scraper.mjs reviews <company-id> [options]
 *   node company-scraper.mjs salaries <company-id> [options]
 *   node company-scraper.mjs jobs <company-id> [options]
 *   node company-scraper.mjs all <company-id> [options]
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/glassdoor');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_CDP_PORTS = [9333, 9222, 9229];
const MAX_CF_WAIT_MS = 45_000;

const BASE_URL = 'https://www.glassdoor.com';

// Country TLD IDs
const COUNTRY_IDS = { US: 1, UK: 2, CA: 3, IN: 4, AU: 5, FR: 6, DE: 7 };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function log(msg) {
  process.stderr.write(`[glassdoor] ${msg}\n`);
}

function exitError(code, message, detail = '') {
  const exitCodes = { WAF_BLOCKED: 2, LOGIN_REQUIRED: 3, RATE_LIMITED: 3 };
  const err = { error: { code, message, detail } };
  process.stderr.write(`[glassdoor] ERROR ${code}: ${message}${detail ? ' — ' + detail : ''}\n`);
  console.log(JSON.stringify(err, null, 2));
  process.exit(exitCodes[code] || 1);
}

function cacheKey(action, companyId, extra = '') {
  return resolve(CACHE_DIR, `${action}-${companyId}${extra}.json`);
}

function readCache(path) {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const age = Date.now() - new Date(data.fetchedAt || 0).getTime();
    if (age < CACHE_TTL_MS) return data;
  } catch {}
  return null;
}

function writeCache(path, data) {
  ensureDir(CACHE_DIR);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Build company URL slug
function buildCompanyUrl(type, companyId, companyName = 'Company', page = 1) {
  const slug = companyName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const pageStr = page > 1 ? `_P${page}` : '';
  switch (type) {
    case 'overview':
      return `${BASE_URL}/Overview/Working-at-${slug}-EI_IE${companyId}.htm`;
    case 'reviews':
      return `${BASE_URL}/Reviews/${slug}-Reviews-E${companyId}${pageStr}.htm`;
    case 'salaries':
      return `${BASE_URL}/Salary/${slug}-Salaries-E${companyId}${pageStr}.htm`;
    case 'jobs':
      return `${BASE_URL}/Jobs/${slug}-Jobs-E${companyId}${pageStr}.htm`;
    default:
      return `${BASE_URL}/Overview/Working-at-${slug}-EI_IE${companyId}.htm`;
  }
}

// ---------------------------------------------------------------------------
// Browser / CDP Setup
// ---------------------------------------------------------------------------

async function detectCdpUrl(preferredUrl) {
  if (preferredUrl) {
    try {
      const resp = await fetch(`${preferredUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) return preferredUrl;
    } catch {}
    throw new Error(`Cannot connect to CDP at ${preferredUrl}`);
  }

  for (const port of DEFAULT_CDP_PORTS) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        log(`Found Chrome CDP on port ${port}`);
        return `http://localhost:${port}`;
      }
    } catch {}
  }

  throw new Error(
    'No Chrome CDP endpoint found on ports 9333, 9222, 9229.\n' +
    'Start Chrome with: google-chrome-stable --remote-debugging-port=9333\n' +
    'Then navigate to https://www.glassdoor.com in the browser.'
  );
}

async function connectBrowser(cdpUrl) {
  log(`Connecting to Chrome at ${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  return { browser, context };
}

// ---------------------------------------------------------------------------
// Cloudflare Challenge Detection
// ---------------------------------------------------------------------------

async function waitForCloudflare(page, timeoutMs = MAX_CF_WAIT_MS) {
  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < timeoutMs) {
    // Use page.evaluate for reliable DOM state (not cached Playwright state)
    const status = await getCfStatus(page);
    const { title, url } = status;

    // Hard block
    if (title.includes('Security | Glassdoor') || title.includes('Help Us Protect')) {
      return { passed: false, reason: 'hard_block', title };
    }

    // Cloudflare challenge (JavaScript challenge that should auto-solve)
    if (title.includes('Just a moment') || (url || '').includes('challenge-platform')) {
      log(`Cloudflare challenge active (title: "${title}") — waiting...`);
      await page.waitForTimeout(pollInterval);
      continue;
    }

    // Rate limited
    if (title.includes('429') || title.includes('Too Many Requests')) {
      return { passed: false, reason: 'rate_limited', title };
    }

    // Page hasn't loaded yet (blank title)
    if (!title) {
      await page.waitForTimeout(pollInterval);
      continue;
    }

    // Success — page has meaningful content
    log(`Page loaded: "${title.substring(0, 60)}"`);
    return { passed: true, title };
  }

  const status = await getCfStatus(page).catch(() => ({ title: '', reason: 'error' }));
  return { passed: false, reason: 'timeout', title: status.title };
}

// ---------------------------------------------------------------------------
// Data Extraction
// ---------------------------------------------------------------------------

/**
 * Check current page for Cloudflare challenge via page.evaluate (more reliable than page.title()).
 */
async function getCfStatus(page) {
  try {
    const status = await page.evaluate(() => ({
      title: document.title,
      url: window.location.href,
      hasChallenge: document.title?.includes('Just a moment') || document.title?.includes('Security | Glassdoor'),
      hasContent: document.querySelector('main, #app, [data-test], .main-header, h1') !== null,
    }));
    return status;
  } catch {
    return { title: '', url: '', hasChallenge: false, hasContent: false };
  }
}

/**
 * Extract embedded Apollo/Next.js state from Glassdoor page HTML.
 * Returns unpacked data object or null.
 */
async function extractPageData(page) {
  return page.evaluate(() => {
    function resolveRefs(data, root) {
      if (!data || typeof data !== 'object') return data;
      if (data.__ref) return resolveRefs(root[data.__ref], root);
      if (Array.isArray(data)) return data.map(item => resolveRefs(item, root));
      const out = {};
      for (const [k, v] of Object.entries(data)) {
        out[k] = resolveRefs(v, root);
      }
      return out;
    }

    // Method 1: __NEXT_DATA__ script tag
    const nextScript = document.getElementById('__NEXT_DATA__');
    if (nextScript) {
      try {
        const d = JSON.parse(nextScript.textContent);
        const cache = d?.props?.pageProps?.apolloCache;
        if (cache) {
          return { source: 'next_data', data: resolveRefs(cache.ROOT_QUERY || cache, cache) };
        }
      } catch (e) {}
    }

    // Method 2: window.apolloState variable in inline script
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const s of scripts) {
      const text = s.textContent;
      const match = text.match(/"apolloState"\s*:\s*(\{.+?\})\s*;/s);
      if (match) {
        try {
          const cache = JSON.parse(match[1]);
          return { source: 'apollo_state', data: resolveRefs(cache.ROOT_QUERY || cache, cache) };
        } catch (e) {}
      }
    }

    // Method 3: Check if body is JSON (API endpoint)
    try {
      const bodyText = document.body.innerText.trim();
      if (bodyText.startsWith('[') || bodyText.startsWith('{')) {
        return { source: 'json_body', data: JSON.parse(bodyText) };
      }
    } catch (e) {}

    return null;
  });
}

/**
 * Parse employer data from Apollo cache.
 */
function parseEmployerFromCache(cacheData) {
  if (!cacheData?.data) return null;
  const data = cacheData.data;

  // Find employer key in cache
  const employerKey = Object.keys(data).find(k => k.startsWith('Employer:') || k === 'employer');
  if (!employerKey && !data.employer) return null;

  const employer = data[employerKey] || data.employer;
  if (!employer) return null;

  return {
    id: employer.id,
    name: employer.name || employer.shortName,
    description: employer.squareLogoUrl ? undefined : employer.overview?.description,
    website: employer.website || employer.primaryWebsite,
    headquarters: employer.headquarters,
    size: employer.size?.label || employer.size,
    founded: employer.foundedYear,
    type: employer.type?.label || employer.type,
    industry: employer.industryName || employer.primaryIndustry?.industryName,
    revenue: employer.revenue?.label || employer.revenue,
    overallRating: employer.ratings?.overallRating || employer.overallRating,
    ratings: {
      culture: employer.ratings?.cultureAndValuesRating,
      workLifeBalance: employer.ratings?.workLifeBalanceRating,
      seniorManagement: employer.ratings?.seniorManagementRating,
      compensation: employer.ratings?.compensationAndBenefitsRating,
      careerOpportunities: employer.ratings?.careerOpportunitiesRating,
      diversityInclusion: employer.ratings?.diversityAndInclusionRating,
    },
    ceoApproval: employer.ceoApproval?.approvalPct,
    businessOutlook: employer.positiveOutlookPct,
    reviewCount: employer.numberOfRatings || employer.reviewCount,
    logoUrl: employer.squareLogoUrl,
    profileUrl: employer.links?.overviewUrl || employer.links?.reviewsUrl,
  };
}

/**
 * Extract company overview metadata (profileId, dynamic ID) needed for BFF API.
 */
async function extractProfileMetadata(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const s of scripts) {
      const text = s.textContent;
      const idMatch = text.match(/"(?:employer|profileId)"\s*:\s*(\{[^}]+\})/);
      if (idMatch) {
        try {
          const obj = JSON.parse(idMatch[1]);
          if (obj.id || obj.profileId) return obj;
        } catch {}
      }
      // Try to find employerId and dynamicProfileId
      const eidMatch = text.match(/"employerId"\s*:\s*(\d+)/);
      const dpidMatch = text.match(/"dynamicProfileId"\s*:\s*(\d+)/);
      if (eidMatch) {
        return {
          id: parseInt(eidMatch[1]),
          profileId: dpidMatch ? parseInt(dpidMatch[1]) : 0,
        };
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Search for companies by name.
 */
async function doSearch(query, flags, page) {
  const cacheFile = cacheKey('search', query.replace(/[^a-z0-9]/gi, '-').toLowerCase());
  if (!flags['no-cache']) {
    const cached = readCache(cacheFile);
    if (cached) { log('Using cached search results'); return cached; }
  }

  const url = `${BASE_URL}/api-web/employer/find.htm?autocomplete=true&maxEmployersForAutocomplete=50&term=${encodeURIComponent(query)}`;
  log(`Searching for: "${query}"`);

  // First verify Glassdoor page is loaded (not on challenge)
  const pageStatus = await getCfStatus(page);
  if (pageStatus.hasChallenge) {
    exitError('WAF_BLOCKED', 'Glassdoor Cloudflare challenge is active',
      'Navigate to glassdoor.com in Chrome and wait for the page to fully load, then retry.');
  }

  // Execute search within browser context (has valid Cloudflare cookies)
  // Use relative URL path to avoid CORS issues - the page must be on glassdoor.com domain
  const relativeUrl = `/api-web/employer/find.htm?autocomplete=true&maxEmployersForAutocomplete=50&term=${encodeURIComponent(query)}`;
  const rawResult = await page.evaluate(async (apiPath) => {
    try {
      const resp = await fetch(apiPath, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/javascript, */*',
          'X-Requested-With': 'XMLHttpRequest',
        }
      });
      return { status: resp.status, url: resp.url, text: await resp.text() };
    } catch (e) {
      return { error: e.message, pageOrigin: window.location.origin };
    }
  }, relativeUrl);

  if (rawResult.error) {
    const detail = rawResult.pageOrigin
      ? `Page origin was ${rawResult.pageOrigin} — must be on glassdoor.com`
      : 'This may indicate a network issue or that the Glassdoor session has expired';
    exitError('NETWORK_ERROR', `Search request failed: ${rawResult.error}`, detail);
  }

  if (rawResult.status === 403) {
    // Check if it's a WAF block or just an API restriction
    const isWafBlock = rawResult.text?.includes('Security | Glassdoor') || rawResult.text?.includes('Help Us Protect');
    exitError('WAF_BLOCKED',
      isWafBlock ? 'Glassdoor WAF blocked the search request' : `Search API returned HTTP ${rawResult.status}`,
      'Try navigating to glassdoor.com in Chrome and ensure the page fully loads, then retry'
    );
  }

  let companies = [];
  try {
    const parsed = JSON.parse(rawResult.text);
    // Format: array of [name, idString, ...] or array of objects
    if (Array.isArray(parsed)) {
      companies = parsed.map(item => {
        if (Array.isArray(item)) {
          return { name: item[0], id: String(item[1]), url: `${BASE_URL}/Overview/Working-at-${encodeURIComponent(item[0])}-EI_IE${item[1]}.htm` };
        }
        return { name: item.name || item.label, id: String(item.id || item.employerId), url: item.url };
      }).filter(c => c.name && c.id);
    }
  } catch (e) {
    log(`Failed to parse search response: ${e.message}`);
    log(`Raw: ${rawResult.text.substring(0, 200)}`);
  }

  const result = {
    source: 'glassdoor',
    action: 'search',
    fetchedAt: new Date().toISOString(),
    query,
    results: companies,
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Scrape company overview page.
 */
async function doOverview(companyId, flags, page) {
  const companyName = flags['company-name'] || 'Company';
  const cacheFile = cacheKey('overview', companyId);

  if (!flags['no-cache']) {
    const cached = readCache(cacheFile);
    if (cached) { log('Using cached overview'); return cached; }
  }

  const url = buildCompanyUrl('overview', companyId, companyName);
  log(`Fetching overview: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') });

  const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
  if (!cfResult.passed) {
    exitError(
      cfResult.reason === 'rate_limited' ? 'RATE_LIMITED' : 'WAF_BLOCKED',
      `Glassdoor blocked the request: ${cfResult.reason}`,
      'Visit glassdoor.com in Chrome first to refresh cf_clearance cookie'
    );
  }

  await page.waitForTimeout(2000);

  // Extract embedded data
  const cacheData = await extractPageData(page);
  const employer = parseEmployerFromCache(cacheData);

  // Try DOM extraction as fallback
  let domData = null;
  if (!employer) {
    log('Apollo state not found, trying DOM extraction...');
    domData = await page.evaluate(() => {
      const get = (sel) => document.querySelector(sel)?.innerText?.trim() || null;
      const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

      return {
        name: get('h1') || get('[data-test="employer-short-name"]'),
        description: get('[data-test="employerDescription"]') || get('.description'),
        website: getAttr('[data-test="employer-website"] a', 'href') || get('[data-test="employer-website"]'),
        headquarters: get('[data-test="employer-headquarters"]') || get('[data-test="headquarters"]'),
        size: get('[data-test="employer-size"]') || get('[data-test="fullTimeEmployees"]'),
        founded: get('[data-test="employer-founded"]') || get('[data-test="foundedYear"]'),
        industry: get('[data-test="employer-industry"]') || get('[data-test="primaryIndustry"]'),
        revenue: get('[data-test="employer-revenue"]') || get('[data-test="annualRevenue"]'),
        overallRating: parseFloat(get('[data-test="rating-info"] .rating-headline-average') || get('.ratingNumber') || '0') || null,
        reviewCount: get('[data-test="reviewCount"]'),
      };
    });
  }

  // Detect login wall
  const isLoginWall = await page.evaluate(() =>
    document.querySelector('#HardsellOverlay, [data-test="hardsell-overlay"], .HardsellOverlay') !== null
  );

  const result = {
    source: 'glassdoor',
    action: 'overview',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName: employer?.name || domData?.name || companyName,
    hasLoginOverlay: isLoginWall,
    data: employer || domData || { error: 'Could not extract company data' },
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Scrape reviews using BFF REST API (called from browser context).
 */
async function doReviews(companyId, flags, page) {
  const pageNum = parseInt(flags.page || '1', 10);
  const pageSize = Math.min(parseInt(flags['page-size'] || '10', 10), 50);
  const sort = (flags.sort || 'DATE').toUpperCase();
  const language = flags.language || 'eng';
  const companyName = flags['company-name'] || 'Company';

  const cacheFile = cacheKey('reviews', companyId, `-p${pageNum}`);
  if (!flags['no-cache']) {
    const cached = readCache(cacheFile);
    if (cached) { log('Using cached reviews'); return cached; }
  }

  // First, get the company page to extract profileId (needed for BFF API)
  const overviewUrl = buildCompanyUrl('overview', companyId, companyName);
  log(`Loading company page for profileId: ${overviewUrl}`);
  await page.goto(overviewUrl, { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') });

  const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
  if (!cfResult.passed) {
    exitError(
      cfResult.reason === 'rate_limited' ? 'RATE_LIMITED' : 'WAF_BLOCKED',
      `Glassdoor blocked the request: ${cfResult.reason}`,
      'Visit glassdoor.com in Chrome first to refresh cf_clearance cookie'
    );
  }

  await page.waitForTimeout(1500);

  // Extract profile metadata
  const metadata = await extractProfileMetadata(page);
  const dynamicProfileId = metadata?.profileId || 0;
  const numericEmployerId = parseInt(companyId, 10);

  log(`Using employerId=${numericEmployerId}, dynamicProfileId=${dynamicProfileId}`);

  // Call the BFF reviews API from within the browser (inherits session/cookies)
  const reviewsBody = {
    applyDefaultCriteria: true,
    employerId: numericEmployerId,
    employmentStatuses: ['REGULAR', 'PART_TIME'],
    jobTitle: null,
    goc: null,
    location: {},
    defaultLanguage: language,
    language: language,
    mlHighlightSearch: null,
    onlyCurrentEmployees: flags['current-only'] ? true : false,
    overallRating: flags['min-rating'] ? parseInt(flags['min-rating']) : null,
    pageSize,
    page: pageNum,
    preferredTldId: COUNTRY_IDS[flags.country?.toUpperCase()] || 1,
    reviewCategories: [],
    sort,
    textSearch: '',
    worldwideFilter: false,
    dynamicProfileId,
    useRowProfileTldForRatings: true,
    enableKeywordSearch: true,
  };

  log(`Fetching reviews page ${pageNum} via BFF API...`);

  const apiResult = await page.evaluate(async (body) => {
    try {
      const resp = await fetch('/bff/employer-profile-mono/employer-reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return { status: resp.status, text: await resp.text() };
    } catch (e) {
      return { error: e.message };
    }
  }, reviewsBody);

  if (apiResult.error) {
    exitError('NETWORK_ERROR', `Reviews API failed: ${apiResult.error}`);
  }

  if (apiResult.status === 401 || apiResult.status === 403) {
    exitError('LOGIN_REQUIRED', 'Glassdoor requires login to access reviews API');
  }

  if (apiResult.status === 429) {
    exitError('RATE_LIMITED', 'Glassdoor rate limit hit — wait 60 seconds and retry');
  }

  if (apiResult.status !== 200) {
    // Fallback: extract reviews from HTML page instead
    log(`BFF API returned ${apiResult.status}, falling back to HTML extraction`);
    return await doReviewsFromHtml(companyId, flags, page, pageNum, companyName, cacheFile);
  }

  let reviewsData;
  try {
    reviewsData = JSON.parse(apiResult.text);
  } catch (e) {
    log(`Failed to parse reviews API response: ${e.message}`);
    return await doReviewsFromHtml(companyId, flags, page, pageNum, companyName, cacheFile);
  }

  // Parse BFF response
  const rawReviews = reviewsData?.reviews || reviewsData?.employerReviews || [];
  const pagination = {
    currentPage: pageNum,
    totalPages: reviewsData?.numberOfPages || reviewsData?.pagesCount || 1,
    pageSize,
    totalCount: reviewsData?.filteredReviewsCount || reviewsData?.totalReviews || rawReviews.length,
  };

  const reviews = rawReviews.map(r => ({
    reviewId: r.reviewId || r.id,
    reviewTitle: r.summary || r.reviewTitle,
    reviewerTitle: r.jobTitle?.text || r.jobTitle || r.reviewerTitle,
    reviewerLocation: r.location?.name || r.reviewerLocation,
    reviewDate: r.reviewDateTime || r.reviewDate,
    isCurrentEmployee: r.isCurrentJob || r.isCurrentEmployee,
    employmentStatus: r.employmentStatus,
    ratingOverall: r.ratingOverall || r.overallRating,
    ratingCulture: r.ratingCultureAndValues,
    ratingWorkLifeBalance: r.ratingWorkLifeBalance,
    ratingSeniorManagement: r.ratingSeniorLeadership || r.ratingSeniorManagement,
    ratingCompensation: r.ratingRecommendToFriend || r.ratingCompensationAndBenefits,
    ratingCareerOpportunities: r.ratingCareerOpportunities,
    pros: r.pros,
    cons: r.cons,
    advice: r.advice,
    isRecommended: r.isRecommended,
    outlook: r.businessOutlookStatus || r.outlook,
    ceoApproval: r.ceoStatus || r.ceoApproval,
    helpfulCount: r.countHelpful,
    notHelpfulCount: r.countNotHelpful,
    employerResponse: r.employerResponses?.[0]?.response || null,
  }));

  const result = {
    source: 'glassdoor',
    action: 'reviews',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName: reviewsData?.employer?.name || companyName,
    pagination,
    reviews,
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Fallback: extract reviews from HTML page (for when BFF API is blocked).
 */
async function doReviewsFromHtml(companyId, flags, page, pageNum, companyName, cacheFile) {
  const url = buildCompanyUrl('reviews', companyId, companyName, pageNum);
  log(`Falling back to HTML extraction: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') });
  const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
  if (!cfResult.passed) {
    exitError('WAF_BLOCKED', 'Cloudflare blocked reviews page');
  }

  await page.waitForTimeout(2000);

  // Extract from Apollo cache
  const cacheData = await extractPageData(page);

  const reviews = await page.evaluate(() => {
    function resolveRefs(data, root) {
      if (!data || typeof data !== 'object') return data;
      if (data.__ref) return resolveRefs(root[data.__ref], root);
      if (Array.isArray(data)) return data.map(i => resolveRefs(i, root));
      const out = {};
      for (const [k, v] of Object.entries(data)) out[k] = resolveRefs(v, root);
      return out;
    }

    try {
      const nextScript = document.getElementById('__NEXT_DATA__');
      if (nextScript) {
        const d = JSON.parse(nextScript.textContent);
        const cache = d?.props?.pageProps?.apolloCache;
        if (cache) {
          const unpacked = resolveRefs(cache, cache);
          const reviewKey = Object.keys(unpacked).find(k => k.startsWith('employerReviewsRG') || k.startsWith('EmployerReviews'));
          if (reviewKey) return unpacked[reviewKey];
        }
      }
    } catch (e) {}
    return null;
  });

  const rawReviews = reviews?.reviews || reviews?.currentPageReviews || [];

  const result = {
    source: 'glassdoor',
    action: 'reviews',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName,
    pagination: {
      currentPage: pageNum,
      totalPages: reviews?.numberOfPages || 1,
      pageSize: parseInt(flags['page-size'] || '10'),
      totalCount: reviews?.filteredReviewsCount || rawReviews.length,
    },
    reviews: rawReviews.map(r => ({
      reviewId: r.reviewId,
      reviewTitle: r.summary || r.reviewTitle,
      reviewerTitle: r.jobTitle?.text || r.jobTitle,
      reviewerLocation: r.location?.name,
      reviewDate: r.reviewDateTime,
      isCurrentEmployee: r.isCurrentJob,
      ratingOverall: r.ratingOverall,
      pros: r.pros,
      cons: r.cons,
      advice: r.advice,
      isRecommended: r.isRecommended,
    })),
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Scrape salary data from HTML page.
 */
async function doSalaries(companyId, flags, page) {
  const companyName = flags['company-name'] || 'Company';
  const cacheFile = cacheKey('salaries', companyId);

  if (!flags['no-cache']) {
    const cached = readCache(cacheFile);
    if (cached) { log('Using cached salaries'); return cached; }
  }

  const url = buildCompanyUrl('salaries', companyId, companyName);
  log(`Fetching salaries: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') });
  const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
  if (!cfResult.passed) {
    exitError('WAF_BLOCKED', `Glassdoor blocked salaries page: ${cfResult.reason}`);
  }

  await page.waitForTimeout(2000);

  const cacheData = await extractPageData(page);

  // Extract salary data from Apollo cache
  const salaries = await page.evaluate(() => {
    function resolveRefs(data, root) {
      if (!data || typeof data !== 'object') return data;
      if (data.__ref) return resolveRefs(root[data.__ref], root);
      if (Array.isArray(data)) return data.map(i => resolveRefs(i, root));
      const out = {};
      for (const [k, v] of Object.entries(data)) out[k] = resolveRefs(v, root);
      return out;
    }

    try {
      const nextScript = document.getElementById('__NEXT_DATA__');
      if (nextScript) {
        const d = JSON.parse(nextScript.textContent);
        const cache = d?.props?.pageProps?.apolloCache;
        if (cache) {
          const unpacked = resolveRefs(cache, cache);
          // Find salary data
          const salaryKey = Object.keys(unpacked).find(k =>
            k.includes('Salary') || k.includes('salary') || k.includes('Compensation')
          );
          if (salaryKey) return unpacked[salaryKey];

          // Try root query
          if (unpacked.salaries || unpacked.employerSalaries) {
            return unpacked.salaries || unpacked.employerSalaries;
          }
        }
      }
    } catch (e) {}

    // DOM fallback
    const salaryItems = Array.from(document.querySelectorAll('[data-test="salary-list-item"], .SalaryRow'));
    return salaryItems.map(el => ({
      jobTitle: el.querySelector('[data-test="job-title"], .jobTitle')?.innerText?.trim(),
      salary: el.querySelector('[data-test="salary-value"], .salaryRange')?.innerText?.trim(),
      count: el.querySelector('[data-test="salary-count"]')?.innerText?.trim(),
    })).filter(s => s.jobTitle);
  });

  const result = {
    source: 'glassdoor',
    action: 'salaries',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName,
    data: salaries || { error: 'Could not extract salary data' },
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Scrape job listings from HTML page.
 */
async function doJobs(companyId, flags, page) {
  const companyName = flags['company-name'] || 'Company';
  const pageNum = parseInt(flags.page || '1', 10);
  const cacheFile = cacheKey('jobs', companyId, `-p${pageNum}`);

  if (!flags['no-cache']) {
    const cached = readCache(cacheFile);
    if (cached) { log('Using cached jobs'); return cached; }
  }

  const url = buildCompanyUrl('jobs', companyId, companyName, pageNum);
  log(`Fetching jobs: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') });
  const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
  if (!cfResult.passed) {
    exitError('WAF_BLOCKED', `Glassdoor blocked jobs page: ${cfResult.reason}`);
  }

  await page.waitForTimeout(2000);

  // Extract job listings from Apollo cache or DOM
  const jobs = await page.evaluate(() => {
    function resolveRefs(data, root) {
      if (!data || typeof data !== 'object') return data;
      if (data.__ref) return resolveRefs(root[data.__ref], root);
      if (Array.isArray(data)) return data.map(i => resolveRefs(i, root));
      const out = {};
      for (const [k, v] of Object.entries(data)) out[k] = resolveRefs(v, root);
      return out;
    }

    let jobList = null;
    let pagination = null;

    try {
      const nextScript = document.getElementById('__NEXT_DATA__');
      if (nextScript) {
        const d = JSON.parse(nextScript.textContent);
        const cache = d?.props?.pageProps?.apolloCache;
        if (cache) {
          const unpacked = resolveRefs(cache, cache);
          const jobKey = Object.keys(unpacked).find(k =>
            k.toLowerCase().includes('job') && k.toLowerCase().includes('listing')
          );
          if (jobKey) jobList = unpacked[jobKey];
        }
      }
    } catch (e) {}

    // DOM fallback
    if (!jobList) {
      const jobCards = Array.from(document.querySelectorAll('[data-test="jobCard"], .JobCard, .jobCard'));
      if (jobCards.length > 0) {
        jobList = jobCards.map(card => ({
          jobTitle: card.querySelector('[data-test="job-title"], .jobTitle, a[href*="Jobs"]')?.innerText?.trim(),
          jobLink: card.querySelector('a')?.href,
          location: card.querySelector('[data-test="emp-location"], .location')?.innerText?.trim(),
          salary: card.querySelector('[data-test="detailSalary"], .salary')?.innerText?.trim(),
          postedDate: card.querySelector('[data-test="job-age"], .posted')?.innerText?.trim(),
        })).filter(j => j.jobTitle);
      }
    }

    // Extract pagination from script
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const s of scripts) {
      const text = s.textContent;
      if (text.includes('paginationLinks')) {
        try {
          const match = text.match(/"paginationLinks"\s*:\s*(\[.*?\])\s*,\s*"searchResultsMetadata"/s);
          if (match) {
            const links = JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\u0026/g, '&'));
            pagination = {
              total: links.length,
              currentPage: links.find(l => l.isCurrentPage)?.pageNumber || 1,
              totalPages: links.length,
              links: links.slice(0, 5).map(l => ({ page: l.pageNumber, url: l.urlLink, isCurrent: l.isCurrentPage })),
            };
          }
        } catch (e) {}
        break;
      }
    }

    return { jobs: Array.isArray(jobList) ? jobList : null, pagination };
  });

  const result = {
    source: 'glassdoor',
    action: 'jobs',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName,
    pagination: jobs.pagination || { currentPage: pageNum },
    count: Array.isArray(jobs.jobs) ? jobs.jobs.length : 0,
    jobs: jobs.jobs || [],
  };

  writeCache(cacheFile, result);
  return result;
}

/**
 * Scrape all data (overview + reviews page 1 + salaries + jobs page 1).
 */
async function doAll(companyId, flags, page) {
  log(`Scraping all data for company ${companyId}`);
  const results = {};

  log('--- Overview ---');
  results.overview = await doOverview(companyId, flags, page);
  await page.waitForTimeout(2000);

  log('--- Reviews (page 1) ---');
  try {
    results.reviews = await doReviews(companyId, flags, page);
  } catch (e) {
    log(`Reviews failed: ${e.message}`);
    results.reviews = { error: e.message };
  }
  await page.waitForTimeout(2000);

  log('--- Salaries ---');
  try {
    results.salaries = await doSalaries(companyId, flags, page);
  } catch (e) {
    log(`Salaries failed: ${e.message}`);
    results.salaries = { error: e.message };
  }
  await page.waitForTimeout(2000);

  log('--- Jobs (page 1) ---');
  try {
    results.jobs = await doJobs(companyId, flags, page);
  } catch (e) {
    log(`Jobs failed: ${e.message}`);
    results.jobs = { error: e.message };
  }

  return {
    source: 'glassdoor',
    action: 'all',
    fetchedAt: new Date().toISOString(),
    companyId,
    companyName: results.overview?.companyName || flags['company-name'] || 'Unknown',
    ...results,
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`glassdoor-company-scraper

Scrape Glassdoor company data: overview, reviews, salaries, job listings.
Uses Playwright + real Chrome to bypass Cloudflare WAF.

Commands:
  search <query>                 Search for companies by name
  overview <company-id>          Scrape company overview and ratings
  reviews <company-id>           Scrape employee reviews (paginated)
  salaries <company-id>          Scrape salary data
  jobs <company-id>              Scrape job listings (paginated)
  all <company-id>               Scrape all data for a company

Options:
  --company-name=NAME    Company name slug for URL (e.g. "Google")
  --page=N               Page number (default: 1)
  --page-size=N          Reviews per page (default: 10, max: 50)
  --sort=SORT            Review sort: DATE|HELPFUL|RATING (default: DATE)
  --language=LANG        Language filter: eng|fra|deu (default: eng)
  --current-only         Only current employee reviews
  --min-rating=N         Minimum star rating (1-5)
  --output=FILE          Save JSON to file (default: stdout)
  --cdp-url=URL          Chrome CDP endpoint (default: auto-detect 9333/9222)
  --timeout=MS           Timeout in ms (default: 60000)
  --no-cache             Bypass cache
  --country=CODE         Country: US|UK|CA|IN|AU|FR|DE (default: US)

Examples:
  node company-scraper.mjs search "google"
  node company-scraper.mjs overview 9079 --company-name=Google
  node company-scraper.mjs reviews 9079 --page=2 --sort=HELPFUL
  node company-scraper.mjs salaries 9079 --company-name=Google
  node company-scraper.mjs jobs 9079 --company-name=Google
  node company-scraper.mjs all 9079 --company-name=Google --output=/tmp/google.json

⚠️  Glassdoor is Cloudflare-protected. Requirements:
  - google-chrome-stable with --remote-debugging-port=9333
  - Playwright: npm install playwright (in skill directory)
  - Visit glassdoor.com in Chrome before running

Exit codes:
  0  Success
  1  General error
  2  WAF blocked (Cloudflare)
  3  Login required or rate limited

Company IDs:
  Google=9079, Apple=1651, Amazon=6036, Meta=40772
  Netflix=11891, Microsoft=1651, Tesla=43129, eBay=7853
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const VALID_COMMANDS = ['search', 'overview', 'reviews', 'salaries', 'jobs', 'all'];
if (!VALID_COMMANDS.includes(command)) {
  console.error(`Unknown command: ${command}. Valid: ${VALID_COMMANDS.join(', ')}`);
  process.exit(1);
}

const queryOrId = positional[0];
if (!queryOrId) {
  console.error(`Usage: node company-scraper.mjs ${command} <${command === 'search' ? 'query' : 'company-id'}> [options]`);
  process.exit(1);
}

// Setup and run
let browser, context, page;
let ownsProcess = false;

try {
  // Detect CDP endpoint
  const cdpUrl = await detectCdpUrl(flags['cdp-url']).catch(err => {
    exitError('SETUP_ERROR', err.message, 'Start Chrome with: google-chrome-stable --remote-debugging-port=9333');
  });

  // Connect to browser
  try {
    const conn = await connectBrowser(cdpUrl);
    browser = conn.browser;
    context = conn.context;
  } catch (err) {
    exitError('SETUP_ERROR', `Failed to connect to Chrome: ${err.message}`,
      'Make sure Chrome is running with --remote-debugging-port and you have playwright installed (npm install playwright)');
  }

  // Get or create a page
  const pages = context.pages();
  page = pages.find(p => p.url()?.includes('glassdoor.com')) || pages[0] || await context.newPage();

  // Ensure we're on a working glassdoor.com page (not a non-.com regional variant or challenge page)
  // The fetch API calls use absolute URLs to glassdoor.com, so we MUST be on glassdoor.com domain.
  const currentStatus = await getCfStatus(page);
  const onGlassdoorCom = (currentStatus.url || '').includes('glassdoor.com');
  const onChallenge = currentStatus.hasChallenge;

  if (!onGlassdoorCom || onChallenge) {
    log('Navigating to glassdoor.com to verify session...');
    await page.goto('https://www.glassdoor.com/', { waitUntil: 'domcontentloaded', timeout: parseInt(flags.timeout || '60000') }).catch(() => {});
    const cfResult = await waitForCloudflare(page, MAX_CF_WAIT_MS);
    if (!cfResult.passed) {
      exitError('WAF_BLOCKED',
        'Glassdoor Cloudflare challenge not cleared',
        cfResult.reason === 'hard_block'
          ? 'Your IP is blocked by Glassdoor. This script only works from residential IPs. Cloud/VPS IPs are permanently blocked.'
          : 'Open glassdoor.com in your Chrome browser, navigate a company page until it fully loads, then retry.'
      );
    }
    await page.waitForTimeout(1000);
    // Re-check — if we landed on a non-.com regional Glassdoor (e.g. glassdoor.nl), report it
    const afterNavStatus = await getCfStatus(page);
    if (!(afterNavStatus.url || '').includes('glassdoor.com')) {
      // Glassdoor redirected us to a regional TLD based on our IP
      // This means the API calls (relative URLs) will hit the regional domain, not glassdoor.com
      // The regional API endpoints may not work the same way
      log(`⚠️  Geo-redirect detected: landed on ${afterNavStatus.url} instead of glassdoor.com`);
      log(`   This may cause API failures. Your IP is being routed to a regional Glassdoor site.`);
      log(`   The script will continue but may fail. For best results, use a US residential IP.`);
    }
  } else {
    log(`Using existing Glassdoor.com session at: ${currentStatus.url?.substring(0, 80)}`);
  }

  // Execute command
  let result;
  switch (command) {
    case 'search':
      result = await doSearch(queryOrId, flags, page);
      break;
    case 'overview':
      result = await doOverview(queryOrId, flags, page);
      break;
    case 'reviews':
      result = await doReviews(queryOrId, flags, page);
      break;
    case 'salaries':
      result = await doSalaries(queryOrId, flags, page);
      break;
    case 'jobs':
      result = await doJobs(queryOrId, flags, page);
      break;
    case 'all':
      result = await doAll(queryOrId, flags, page);
      break;
  }

  // Output result
  const outputFile = flags.output;
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    log(`Output saved to: ${outputFile}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  // Summary to stderr
  if (command === 'reviews' && result.pagination) {
    process.stderr.write(`\n[glassdoor] ${result.reviews?.length || 0} reviews | Page ${result.pagination.currentPage}/${result.pagination.totalPages}\n`);
  } else if (command === 'search') {
    process.stderr.write(`\n[glassdoor] Found ${result.results?.length || 0} companies\n`);
  } else if (command === 'jobs') {
    process.stderr.write(`\n[glassdoor] Found ${result.count || 0} jobs\n`);
  }

} catch (err) {
  if (err.message?.includes('ERR_ABORTED') || err.message?.includes('net::')) {
    exitError('NETWORK_ERROR', `Navigation failed: ${err.message}`);
  }
  if (err.message?.includes('playwright')) {
    exitError('SETUP_ERROR', 'Playwright not installed', 'Run: npm install playwright (in skill directory)');
  }
  exitError('UNKNOWN_ERROR', err.message, err.stack?.split('\n')[1] || '');
} finally {
  if (browser && ownsProcess) {
    await browser.close().catch(() => {});
  }
}
