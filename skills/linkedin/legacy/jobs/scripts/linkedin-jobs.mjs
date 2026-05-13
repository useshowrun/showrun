#!/usr/bin/env node
// linkedin-jobs.mjs — Search jobs, view details, get insights, and save jobs on LinkedIn
//
// Setup:   node linkedin-jobs.mjs auth
// Usage:   node linkedin-jobs.mjs search --keywords="software engineer" --location="San Francisco"
//          node linkedin-jobs.mjs details <jobId>
//          node linkedin-jobs.mjs save <jobId>
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/linkedin-jobs');
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
    console.error('No auth found. Run: node linkedin-jobs.mjs auth');
    process.exit(1);
  }
  return auth;
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
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  if (resp.status === 204) return { status: 204, data: null }; // No Content (e.g., save/unsave)
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired. Run: node linkedin-jobs.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Job search
// ---------------------------------------------------------------------------

const SEARCH_DECORATION_ID = 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220';

async function searchJobs(auth, opts = {}) {
  const { keywords, location, count = 25, start = 0, sortBy } = opts;

  // Build query parts
  const parts = ['origin:JOB_SEARCH_PAGE_SEARCH_BUTTON'];
  if (keywords) parts.push(`keywords:${encodeURIComponent(keywords)}`);
  if (location) parts.push(`locationUnion:(seoLocation:(location:${encodeURIComponent(location)}))`);
  if (sortBy) parts.push(`sortBy:${sortBy}`);
  parts.push('spellCorrectionEnabled:true');

  // Build selectedFilters — all filters go into a single selectedFilters:(...)
  const selectedFilters = [];
  const filterMap = {
    'date-posted': 'datePosted',
    experience: 'experience',
    'job-type': 'jobType',
    remote: 'workplaceType',
    company: 'company',
    industry: 'industry',
    function: 'function',
    title: 'title',
    salary: 'salary',
    benefits: 'benefits',
    commitments: 'commitments',
  };

  for (const [cliKey, apiKey] of Object.entries(filterMap)) {
    if (opts[cliKey]) selectedFilters.push(`${apiKey}:List(${opts[cliKey]})`);
  }

  // Boolean/toggle filters
  if (opts['easy-apply']) selectedFilters.push('easyApply:List(true)');
  if (opts['under-10']) selectedFilters.push('under10Applicants:List(true)');
  if (opts['in-network']) selectedFilters.push('network:List(F,S)');
  if (opts['fair-chance']) selectedFilters.push('fairChanceEmployer:List(true)');
  if (opts['verified']) selectedFilters.push('verifiedJob:List(true)');

  if (selectedFilters.length) {
    parts.push(`selectedFilters:(${selectedFilters.join(',')})`);
  }

  const query = `(${parts.join(',')})`;
  const url = `https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?decorationId=${SEARCH_DECORATION_ID}&count=${count}&q=jobSearch&query=${query}&start=${start}`;

  const { data } = await apiFetch(auth, url);
  const elements = data.elements || [];
  const total = data.paging?.total || elements.length;

  const jobs = elements.map(el => {
    const card = el.jobCardUnion?.jobPostingCard || {};
    const postingId = card.jobPostingUrn?.match(/\d+$/)?.[0];
    return {
      jobId: postingId,
      title: card.jobPostingTitle,
      company: card.primaryDescription?.text,
      location: card.secondaryDescription?.text,
      salary: card.tertiaryDescription?.text || null,
      link: postingId ? `https://www.linkedin.com/jobs/view/${postingId}/` : null,
      postingUrn: card.jobPostingUrn,
    };
  }).filter(j => j.title);

  return { total, count: jobs.length, start, jobs };
}

// ---------------------------------------------------------------------------
// Job details
// ---------------------------------------------------------------------------

const DETAIL_QUERY_ID = 'voyagerJobsDashJobPostingDetailSections.772cd794c28e3200864f81d143911057';
const POSTING_QUERY_ID = 'voyagerJobsDashJobPostings.891aed7916d7453a37e4bbf5f1f60de4';

async function fetchJobDetails(auth, jobId) {
  const jobUrn = `urn%3Ali%3Afsd_jobPosting%3A${jobId}`;
  const result = {};

  // 1. Top card: title, company, location, workplace type
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(TOP_CARD,HOW_YOU_FIT_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true,jobDetailsContext:(isJobSearch:true))&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.topCard) {
        const tc = card.topCard;
        result.title = tc.jobPostingTitle;
        result.company = tc.primaryDescription?.text;
        result.subtitle = tc.navigationBarSubtitle;
        result.location = tc.jobPosting?.location?.defaultLocalizedName || tc.secondaryDescription?.text;
        // Salary is in jobInsightsV2, not tertiaryDescription
        const insights = tc.jobInsightsV2ResolutionResults || [];
        for (const ins of insights) {
          const descs = ins.jobInsightViewModel?.description || [];
          for (const d of descs) {
            const text = d.text?.text?.trim();
            if (text && /\$|€|£|salary|yr|hr|mo/i.test(text)) {
              result.salary = text;
              break;
            }
          }
          if (result.salary) break;
        }
        result.companyUrn = tc.jobPosting?.companyDetails?.jobCompany?.company?.entityUrn;
        result.companyName = tc.jobPosting?.companyDetails?.jobCompany?.company?.name;
        result.companyUniversalName = tc.jobPosting?.companyDetails?.jobCompany?.company?.universalName;
        result.reposted = tc.jobPosting?.repostedJob;
        result.jobState = tc.jobPosting?.jobState;
        result.workplaceTypes = tc.jobPosting?.jobWorkplaceTypes?.map(w => w.localizedName) || [];
      }
      if (card.howYouFitCard) {
        result.howYouFit = card.howYouFitCard.items?.map(i => i.text?.text).filter(Boolean) || [];
      }
    }
  }

  // 2. Description
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(JOB_DESCRIPTION_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.jobDescription) {
        result.description = card.jobDescription.jobPosting?.description?.text;
        result.postedOn = card.jobDescription.postedOnText;
      }
    }
  }

  // 3. Applicant insights (premium)
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(JOB_APPLICANT_INSIGHTS),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.jobApplicantInsightsUrn) {
        const insights = card.jobApplicantInsightsUrn;
        result.applicantInsights = {
          applicantCount: insights.applicantCount,
          topDegrees: insights.degreeDetails?.map(d => ({
            degree: d.degree?.name,
            percentage: d.percentage,
          })) || [],
          topSkills: insights.skillDetails?.map(s => ({
            skill: s.skill?.name,
            percentage: s.percentage,
          })) || [],
        };
      }
    }
  }

  // 4. Company card
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(COMPANY_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.companyCard) {
        const cc = card.companyCard;
        result.aboutCompany = {
          name: cc.name,
          description: cc.description?.text?.substring(0, 500),
          industry: cc.industry,
          staffCount: cc.staffCount,
          staffCountRange: cc.staffCountRange,
          url: cc.url,
        };
      }
    }
  }

  // 5. Company insights (premium)
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(COMPANY_INSIGHTS_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.companyInsightsCard?.companyInsightsCard) {
        const insights = card.companyInsightsCard.companyInsightsCard;
        result.companyInsights = (insights.elements || []).map(el => {
          const items = [];
          for (const comp of (el.body?.components || [])) {
            const entity = comp.componentsUnion?.entityComponent;
            if (entity) {
              items.push({
                title: entity.titleV2?.text?.text,
                subtitle: entity.subtitle?.text,
                caption: entity.caption?.text,
              });
            }
            const chart = comp.componentsUnion?.chartComponent;
            if (chart) {
              items.push({
                type: 'chart',
                title: chart.title?.text,
                chartType: chart.chartType,
              });
            }
          }
          return {
            header: el.header?.title?.text,
            items,
          };
        }).filter(i => i.items.length > 0);
      }
    }
  }

  // 6. Hiring team
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(HIRING_TEAM_CARD,CONNECTIONS_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true,includeConnectionsCard:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.hiringTeamCard) {
        const team = card.hiringTeamCard;
        result.hiringTeam = (team.hiringTeamMembers || []).map(m => ({
          name: m.name?.text,
          headline: m.headline?.text,
          profileUrl: m.navigationUrl,
        }));
      }
    }
  }

  // 7. Salary and benefits
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(SALARY_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.salaryCard) {
        result.salaryDetails = card.salaryCard;
      }
    }
  }
  {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(BENEFITS_CARD),jobPostingUrn:${jobUrn},includeSecondaryActionsV2:true)&queryId=${DETAIL_QUERY_ID}`;
    const { data } = await apiFetch(auth, url);
    const section = data.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes?.elements?.[0];
    for (const card of (section?.jobPostingDetailSection || [])) {
      if (card.benefitsCard) {
        result.benefits = card.benefitsCard;
      }
    }
  }

  result.jobId = jobId;
  result.link = `https://www.linkedin.com/jobs/view/${jobId}/`;
  return result;
}

// ---------------------------------------------------------------------------
// Save / Unsave
// ---------------------------------------------------------------------------

async function saveJob(auth, jobId) {
  const urn = `urn:li:fsd_saveState:(SAVE,urn:li:fsd_jobPosting:${jobId})`;
  const url = `https://www.linkedin.com/voyager/api/voyagerFeedDashSaveStates/${encodeURIComponent(urn)}`;

  const body = JSON.stringify({ patch: { $set: { saved: true } } });
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
    },
    body,
  });
}

async function unsaveJob(auth, jobId) {
  const urn = `urn:li:fsd_saveState:(SAVE,urn:li:fsd_jobPosting:${jobId})`;
  const url = `https://www.linkedin.com/voyager/api/voyagerFeedDashSaveStates/${encodeURIComponent(urn)}`;

  const body = JSON.stringify({ patch: { $set: { saved: false } } });
  return await apiFetch(auth, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Easy Apply preview
// ---------------------------------------------------------------------------

const APPLY_QUERY_ID = 'voyagerJobsDashOnsiteApplyApplication.a1ce7ed0aefd0c79e2f6a351d1c4907e';

async function fetchEasyApplyPreview(auth, jobId) {
  const jobUrn = encodeURIComponent(`urn:li:fsd_jobPosting:${jobId}`);
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(jobPostingUrn:${jobUrn})&queryId=${APPLY_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const el = data.data?.jobsDashOnsiteApplyApplicationByJobPosting?.elements?.[0];
  if (!el) throw new Error('Easy Apply not available for this job (may require external application).');

  const forms = el.jobApplicationForms || [];
  const pages = [];

  for (const form of forms) {
    const groups = form.questionGroupings || [];
    const pageTitle = form.title || null;
    const pageEntries = []; // multiple groups on same page

    for (const group of groups) {
      const type = group.questionGroupingType;
      const prefilled = group.prefilled;

      // Resume page
      if (type === 'RESUME') {
        const resumes = (group.usedResumesResolutionResults || []).map(r => r.fileName || r.name).filter(Boolean);
        pageEntries.push({ type: 'RESUME', title: 'Resume', prefilled: resumes.length > 0, resumes });
        continue;
      }

      // Top choice (premium, optional)
      if (type === 'TOP_CHOICE') continue; // Skip — optional premium feature

      // Form sections (contact info, work experience, education, custom questions)
      const fs = group.formSection || group.customizedFormSection?.labelFormSection;
      if (!fs) continue;

      const fields = [];
      for (const g of (fs.formElementGroups || [])) {
        for (const fe of (g.formElements || [])) {
          const label = fe.title?.text || '?';
          const required = !!fe.required;
          const inputVals = fe.input?.formElementInputValuesResolutionResults || [];
          let value = null;
          for (const iv of inputVals) {
            value = iv.textInputValue || iv.entityInputValue?.inputEntityName || iv.urnInputValue || value;
          }
          // Determine field type from formComponentResolutionResult
          const fcr = fe.formComponentResolutionResult || {};
          let fieldType = 'text';
          if (fcr.dropdownFormComponent) fieldType = 'dropdown';
          else if (fcr.textEntityListFormComponent) fieldType = 'select';
          else if (fcr.multilineTextFormComponent) fieldType = 'textarea';
          else if (fcr.checkboxFormComponent || fcr.nestedCheckboxFormComponent) fieldType = 'checkbox';
          else if (fcr.toggleFormComponent) fieldType = 'toggle';
          else if (fcr.numberInputFormComponent) fieldType = 'number';
          else if (fcr.dateFormComponent) fieldType = 'date';
          else if (fcr.mediaUploadFormComponent) fieldType = 'file';

          fields.push({ label, required, fieldType, value, urn: fe.urn });
        }
      }

      // Skip empty unfilled template slots (e.g., blank work experience / education entries)
      const hasValues = fields.some(f => f.value);
      if (!hasValues && !prefilled && fields.length > 0 && (pageTitle === 'Work experience' || pageTitle === 'Education')) continue;

      if (fields.length > 0) {
        pageEntries.push({ type: type || 'FORM', title: prefilled ? (pageTitle || 'Contact Info') : (pageTitle || 'Additional Questions'), prefilled, fields });
      }
    }

    if (pageEntries.length > 0) {
      pages.push({ pageTitle: pageTitle || pageEntries[0]?.title || '?', entries: pageEntries });
    }
  }

  return { jobId, pages, totalPages: pages.length };
}

// ---------------------------------------------------------------------------
// Easy Apply submit
// ---------------------------------------------------------------------------

async function fetchEasyApplyForm(auth, jobId) {
  const jobUrn = encodeURIComponent(`urn:li:fsd_jobPosting:${jobId}`);
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(jobPostingUrn:${jobUrn})&queryId=${APPLY_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const el = data.data?.jobsDashOnsiteApplyApplicationByJobPosting?.elements?.[0];
  if (!el) throw new Error('Easy Apply not available for this job (may require external application).');
  return el;
}

function extractFormResponses(formData, answers = {}) {
  const responses = [];
  const fileUploadResponses = [];
  const unanswered = [];
  const forms = formData.jobApplicationForms || [];

  for (const form of forms) {
    for (const group of (form.questionGroupings || [])) {
      const type = group.questionGroupingType;

      // Resume — use the first available resume
      if (type === 'RESUME') {
        const fus = group.customizedFormSection?.fileUploadFormSection;
        const resumes = group.usedResumesResolutionResults || [];
        if (resumes.length > 0 && fus?.fileUploadFormElement) {
          const feUrn = fus.fileUploadFormElement.formElementUrn;
          const resumeUrn = resumes[0].entityUrn;
          if (feUrn && resumeUrn) {
            fileUploadResponses.push({ inputUrn: resumeUrn, formElementUrn: feUrn });
          }
        }
        continue;
      }

      if (type === 'TOP_CHOICE') continue;

      const fs = group.formSection || group.customizedFormSection?.labelFormSection;
      if (!fs) continue;

      for (const g of (fs.formElementGroups || [])) {
        // Skip empty template groups (e.g., blank work experience / education slots)
        const groupElements = g.formElements || [];
        const groupHasAnyValue = groupElements.some(fe => {
          const ivs = fe.input?.formElementInputValuesResolutionResults || [];
          return ivs.some(iv => iv.textInputValue || iv.entityInputValue || iv.urnInputValue);
        });
        if (!groupHasAnyValue && !group.prefilled) continue;

        for (const fe of groupElements) {
          const urn = fe.urn;
          if (!urn) continue;

          const label = fe.title?.text || '?';
          const required = !!fe.required;
          const inputVals = fe.input?.formElementInputValuesResolutionResults || [];

          // Check if user provided an answer override
          const answerKey = label.toLowerCase().trim();
          const userAnswer = answers[answerKey] || answers[label] || answers[urn];

          // Get pre-filled value
          let prefilled = null;
          let prefilledEntity = null;
          for (const iv of inputVals) {
            if (iv.textInputValue) prefilled = iv.textInputValue;
            if (iv.entityInputValue) {
              prefilledEntity = iv.entityInputValue;
              prefilled = iv.entityInputValue.inputEntityName;
            }
            if (iv.urnInputValue) prefilled = iv.urnInputValue;
          }

          const finalValue = userAnswer || prefilled;

          if (!finalValue && required) {
            // Only flag as unanswered for custom questions, not pre-filled profile sections
            if (!group.prefilled) {
              unanswered.push({ label, urn, fieldType: fe.formComponentResolutionResult ? 'form' : 'text' });
            }
            continue;
          }

          if (!finalValue) continue; // skip optional empty fields

          // Build the response entry — strip API metadata from entity values
          const entry = { formElementUrn: urn, formElementInputValues: [] };
          if (prefilledEntity && !userAnswer) {
            const clean = { inputEntityName: prefilledEntity.inputEntityName };
            if (prefilledEntity.inputEntityUrn) clean.inputEntityUrn = prefilledEntity.inputEntityUrn;
            entry.formElementInputValues.push({ entityInputValue: clean });
          } else if (urn.includes('multipleChoice') || urn.includes('phoneNumber~country')) {
            entry.formElementInputValues.push({ entityInputValue: { inputEntityName: finalValue } });
          } else {
            entry.formElementInputValues.push({ textInputValue: String(finalValue) });
          }
          responses.push(entry);
        }
      }
    }
  }

  return { responses, fileUploadResponses, unanswered };
}

function generateReferenceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '+').replace(/\//g, '/');
}

async function submitEasyApply(auth, jobId, answers = {}, { followCompany = true } = {}) {
  const formData = await fetchEasyApplyForm(auth, jobId);
  const { responses, fileUploadResponses, unanswered } = extractFormResponses(formData, answers);

  if (unanswered.length > 0) {
    const missing = unanswered.map(u => `  - ${u.label}`).join('\n');
    throw new Error(`Missing required answers:\n${missing}\n\nProvide them with --answers='{"field name": "value"}'`);
  }

  const body = {
    followCompany,
    responses,
    fileUploadResponses,
    referenceId: generateReferenceId(),
    trackingCode: 'd_flagship3_search_srp_jobs',
  };

  return await apiFetch(auth, 'https://www.linkedin.com/voyager/api/voyagerJobsDashOnsiteApplyApplication?action=submitApplication', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Saved jobs list
// ---------------------------------------------------------------------------

const SEARCH_CLUSTER_QUERY_ID = 'voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8';

const SAVED_TABS = {
  saved: 'SEARCH_MY_ITEMS_JOB_SEEKER',
  'in-progress': 'SEARCH_MY_ITEMS_JOB_SEEKER_IN_PROGRESS',
  applied: 'SEARCH_MY_ITEMS_JOB_SEEKER_APPLIED',
  archived: 'SEARCH_MY_ITEMS_JOB_SEEKER_ARCHIVED',
};

async function listSavedJobs(auth, { tab = 'saved', count = 25, start = 0 } = {}) {
  const intent = SAVED_TABS[tab] || SAVED_TABS.saved;
  const variables = `(start:${start},query:(flagshipSearchIntent:${intent}))`;
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${SEARCH_CLUSTER_QUERY_ID}`;
  const { data } = await apiFetch(auth, url);

  const clusters = data.data?.searchDashClustersByAll?.elements || [];
  const jobs = [];
  let total = 0;

  for (const cluster of clusters) {
    if (cluster.totalResultCount) total = cluster.totalResultCount;
    for (const item of (cluster.items || [])) {
      const entity = item.item?.entityResult;
      if (entity) {
        const title = entity.title?.text;
        const subtitle = entity.primarySubtitle?.text;
        const location = entity.secondarySubtitle?.text;
        const jobIdMatch = entity.entityUrn?.match(/jobPosting:(\d+)/);
        const jobId = jobIdMatch?.[1];
        if (title) {
          jobs.push({
            jobId,
            title,
            company: subtitle,
            location,
            link: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : null,
          });
        }
      }
    }
  }

  return { total, jobs };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseJobId(input) {
  if (!input) return null;
  // Accept: numeric ID, LinkedIn URL, or URN
  const urlMatch = input.match(/jobs\/view\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  const urnMatch = input.match(/jobPosting:(\d+)/);
  if (urnMatch) return urnMatch[1];
  if (/^\d+$/.test(input)) return input;
  return input;
}

const [, , command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (m) { flags[m[1]] = m[2]; }
    else if (arg.startsWith('--')) { flags[arg.slice(2)] = true; } // boolean flags like --easy-apply
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
    const { flags } = parseFlags(args);
    if (!flags.keywords && !flags.company && !flags.location && !flags.title) {
      console.error(`Usage: node linkedin-jobs.mjs search --keywords="..." [filters]

Filters:
  --keywords="..."           Search terms
  --location="..."           Location name
  --sort=DD|R                Most recent or most relevant
  --date-posted=r86400       r86400=24h | r604800=week | r2592000=month
  --experience=1,2,3         1=intern 2=entry 3=assoc 4=mid 5=dir 6=exec
  --job-type=F,C             F=full P=part C=contract T=temp V=volunteer I=intern O=other
  --remote=2                 1=onsite 2=remote 3=hybrid
  --company=1441             Company ID(s), comma-separated
  --industry=4,6             Industry ID(s): 4=SoftwareDev 6=Tech 96=ITServices 43=Finance
  --function=eng,it          Job function: eng it rsch qa cnsl anls edu othr
  --title=9,39               Title ID(s): 9=SWE 39=SeniorSWE 30128=AIEngineer 25206=MLE
  --salary=4                 1=$40k+ 2=$60k+ 3=$80k+ 4=$100k+ 5=$120k+ 6=$140k+ 7=$160k+ 8=$180k+ 9=$200k+
  --benefits=1,3,4           1=Medical 2=Vision 3=Dental 4=401k 5=Pension 7=MatLeave 8=PatLeave
  --commitments=5            1=DEI 2=Environment 3=Work-life 4=Social 5=Career
  --easy-apply               Easy Apply only
  --under-10                 Under 10 applicants
  --in-network               In your network
  --fair-chance              Fair Chance Employer
  --verified                 Has verifications
  --count=25 --start=0       Pagination`);
      process.exit(1);
    }

    const auth = getAuth();
    const count = parseInt(flags.count || '25');
    const start = parseInt(flags.start || '0');

    console.log(`Searching jobs...`);
    const result = await searchJobs(auth, {
      keywords: flags.keywords,
      location: flags.location,
      sortBy: flags.sort,
      'date-posted': flags['date-posted'],
      experience: flags.experience,
      'job-type': flags['job-type'],
      remote: flags.remote,
      company: flags.company,
      industry: flags.industry,
      function: flags.function,
      title: flags.title,
      salary: flags.salary,
      benefits: flags.benefits,
      commitments: flags.commitments,
      'easy-apply': 'easy-apply' in flags,
      'under-10': 'under-10' in flags,
      'in-network': 'in-network' in flags,
      'fair-chance': 'fair-chance' in flags,
      'verified': 'verified' in flags,
      count,
      start,
    });

    const slug = (flags.keywords || 'jobs').replace(/\s+/g, '_').substring(0, 30);
    const outFile = resolve(CACHE_DIR, `search-${slug}.json`);
    saveJson(outFile, result);

    console.log(`\n${result.count} jobs (${result.total} total)\n`);
    for (const job of result.jobs) {
      console.log(`  [${job.jobId}] ${job.title}`);
      console.log(`    ${job.company} — ${job.location || ''}${job.salary ? ' | ' + job.salary : ''}`);
      console.log(`    ${job.link}`);
      console.log();
    }
    if (result.total > start + count) {
      console.log(`More results available. Use --start=${start + count} for next page.`);
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'details': {
    const jobId = parseJobId(args[0]);
    if (!jobId) {
      console.error('Usage: node linkedin-jobs.mjs details <jobId|url>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching job details for ${jobId}...`);
    const details = await fetchJobDetails(auth, jobId);

    const outFile = resolve(CACHE_DIR, `job-${jobId}.json`);
    saveJson(outFile, details);

    console.log(`\n${details.title || '(unknown)'}`);
    console.log(`  ${details.subtitle || ''}`);
    if (details.salary) console.log(`  Salary: ${details.salary}`);
    if (details.workplaceTypes?.length) console.log(`  Workplace: ${details.workplaceTypes.join(', ')}`);
    if (details.postedOn) console.log(`  ${details.postedOn}`);
    if (details.reposted) console.log(`  (Reposted)`);

    if (details.description) {
      console.log(`\n  Description:`);
      console.log(`  ${details.description.substring(0, 500)}${details.description.length > 500 ? '...' : ''}`);
    }

    if (details.applicantInsights) {
      const ai = details.applicantInsights;
      console.log(`\n  Applicant Insights:`);
      console.log(`    ${ai.applicantCount} applicants`);
      if (ai.topDegrees?.length) {
        console.log(`    Top degrees: ${ai.topDegrees.map(d => `${d.degree} (${d.percentage}%)`).join(', ')}`);
      }
      if (ai.topSkills?.length) {
        console.log(`    Top skills: ${ai.topSkills.map(s => `${s.skill} (${s.percentage}%)`).join(', ')}`);
      }
    }

    if (details.aboutCompany) {
      const c = details.aboutCompany;
      console.log(`\n  About ${c.name}:`);
      if (c.industry) console.log(`    Industry: ${c.industry}`);
      if (c.staffCount) console.log(`    Employees: ${c.staffCount.toLocaleString()}`);
      if (c.description) console.log(`    ${c.description.substring(0, 200)}...`);
    }

    if (details.companyInsights?.length) {
      console.log(`\n  Company Insights (Premium):`);
      for (const section of details.companyInsights) {
        if (section.header) console.log(`    ${section.header}`);
        for (const item of section.items.slice(0, 5)) {
          if (item.title) console.log(`      ${item.title}${item.subtitle ? ' — ' + item.subtitle : ''}`);
        }
      }
    }

    if (details.hiringTeam?.length) {
      console.log(`\n  Hiring Team:`);
      for (const m of details.hiringTeam) {
        console.log(`    ${m.name} — ${m.headline || ''}`);
      }
    }

    if (details.howYouFit?.length) {
      console.log(`\n  How You Fit:`);
      for (const f of details.howYouFit) console.log(`    - ${f}`);
    }

    console.log(`\n  ${details.link}`);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'easy-apply-preview': {
    const jobId = parseJobId(args[0]);
    if (!jobId) {
      console.error('Usage: node linkedin-jobs.mjs easy-apply-preview <jobId|url>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Fetching Easy Apply form for ${jobId}...`);
    let preview;
    try {
      preview = await fetchEasyApplyPreview(auth, jobId);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    const outFile = resolve(CACHE_DIR, `easy-apply-${jobId}.json`);
    saveJson(outFile, preview);

    console.log(`\nEasy Apply — ${preview.totalPages} pages\n`);
    for (let i = 0; i < preview.pages.length; i++) {
      const page = preview.pages[i];
      console.log(`  Page ${i + 1}: ${page.pageTitle}`);

      for (const entry of page.entries) {
        const status = entry.prefilled ? ' (pre-filled)' : '';
        if (entry.type === 'RESUME') {
          console.log(`    Resume${status}`);
          if (entry.resumes?.length) {
            console.log(`      Available: ${entry.resumes.join(', ')}`);
          } else {
            console.log(`      Upload required`);
          }
        } else if (entry.fields) {
          if (entry.title !== page.pageTitle) console.log(`    ${entry.title}${status}`);
          else if (status) console.log(`    ${status.trim()}`);
          for (const f of entry.fields) {
            const req = f.required ? ' *' : '';
            const val = f.value ? ` = "${String(f.value).substring(0, 60)}${String(f.value).length > 60 ? '...' : ''}"` : '';
            console.log(`      [${f.fieldType}] ${f.label}${req}${val}`);
          }
        }
      }
      console.log();
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'easy-apply': {
    const { flags, positional } = parseFlags(args);
    const jobId = parseJobId(positional[0]);
    if (!jobId) {
      console.error(`Usage: node linkedin-jobs.mjs easy-apply <jobId|url> [--answers='{"field":"value"}']

  Submits an Easy Apply application using your profile data.
  Pre-filled fields (contact info, resume, work experience, education)
  are sent automatically. Custom questions need --answers.

  Tip: Run easy-apply-preview first to see what questions are required.

  Examples:
    node linkedin-jobs.mjs easy-apply 4387993640
    node linkedin-jobs.mjs easy-apply 4387993640 --answers='{"How many years...":"5"}'
    node linkedin-jobs.mjs easy-apply 4387993640 --no-follow`);
      process.exit(1);
    }

    const auth = getAuth();
    let answers = {};
    if (flags.answers) {
      try { answers = JSON.parse(flags.answers); } catch {
        console.error('Invalid --answers JSON. Use: --answers=\'{"question":"answer"}\'');
        process.exit(1);
      }
    }
    const followCompany = !('no-follow' in flags);

    // First show preview so user sees what will be submitted
    console.log(`Fetching Easy Apply form for ${jobId}...`);
    let preview;
    try {
      preview = await fetchEasyApplyPreview(auth, jobId);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    console.log(`\nEasy Apply — ${preview.totalPages} pages`);
    for (const page of preview.pages) {
      const filledCount = page.entries.reduce((sum, e) => sum + (e.fields?.filter(f => f.value)?.length || 0), 0);
      const totalCount = page.entries.reduce((sum, e) => sum + (e.fields?.length || 0), 0);
      console.log(`  ${page.pageTitle}${filledCount ? ` (${filledCount}/${totalCount} filled)` : ''}`);
    }

    console.log(`\nSubmitting application...`);
    try {
      await submitEasyApply(auth, jobId, answers, { followCompany });
      console.log(`\nApplication submitted successfully for job ${jobId}!`);
      console.log(`  https://www.linkedin.com/jobs/view/${jobId}/`);
    } catch (e) {
      console.error(`\nFailed to submit: ${e.message}`);
      process.exit(1);
    }
    break;
  }

  case 'save': {
    const jobId = parseJobId(args[0]);
    if (!jobId) {
      console.error('Usage: node linkedin-jobs.mjs save <jobId|url>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Saving job ${jobId}...`);
    await saveJob(auth, jobId);
    console.log(`Job ${jobId} saved.`);
    break;
  }

  case 'unsave': {
    const jobId = parseJobId(args[0]);
    if (!jobId) {
      console.error('Usage: node linkedin-jobs.mjs unsave <jobId|url>');
      process.exit(1);
    }

    const auth = getAuth();
    console.log(`Unsaving job ${jobId}...`);
    await unsaveJob(auth, jobId);
    console.log(`Job ${jobId} unsaved.`);
    break;
  }

  case 'saved': {
    const { flags } = parseFlags(args);
    const auth = getAuth();
    const count = parseInt(flags.count || '25');
    const start = parseInt(flags.start || '0');
    const tab = flags.tab || 'saved';

    if (!SAVED_TABS[tab]) {
      console.error(`Invalid tab: ${tab}. Use: saved, in-progress, applied, archived`);
      process.exit(1);
    }

    console.log(`Fetching ${tab} jobs...`);
    const result = await listSavedJobs(auth, { tab, count, start });

    const outFile = resolve(CACHE_DIR, `${tab}-jobs.json`);
    saveJson(outFile, result);

    console.log(`\n${result.jobs.length} ${tab} jobs${result.total ? ` (${result.total} total)` : ''}\n`);
    for (const job of result.jobs) {
      console.log(`  [${job.jobId || '?'}] ${job.title}`);
      console.log(`    ${job.company || ''} — ${job.location || ''}`);
      console.log();
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  default:
    console.log(`linkedin-jobs — Search jobs, view details, get insights, and save jobs

Commands:
  auth                                    Authenticate via Chrome (one-time)
  search --keywords="..." [filters]       Search for jobs
  details <jobId>                         Full job details + insights
  easy-apply-preview <jobId>               Preview Easy Apply form fields
  easy-apply <jobId> [--answers='{...}']   Submit Easy Apply application
  save <jobId>                            Save a job
  unsave <jobId>                          Unsave a job
  saved [--tab=saved] [--count=25]         List saved/in-progress/applied/archived jobs

Search filters:
  --keywords="software engineer"          Search terms
  --location="San Francisco"              Location
  --sort=DD|R                             Most recent / most relevant
  --date-posted=r86400                    24h | r604800 week | r2592000 month
  --experience=1,2,3                      1=intern 2=entry 3=assoc 4=mid 5=dir 6=exec
  --job-type=F,C                          F=full P=part C=contract T=temp V=volunteer I=intern
  --remote=2                              1=onsite 2=remote 3=hybrid
  --company=1441                          Company ID(s)
  --industry=4,6                          Industry ID(s)
  --function=eng,it                       Job function codes
  --title=9                               Title ID(s)
  --salary=4                              1=$40k+ ... 9=$200k+
  --benefits=1,3                          Benefit ID(s)
  --commitments=5                         Commitment ID(s)
  --easy-apply                            Easy Apply only
  --under-10                              Under 10 applicants
  --in-network                            In your network
  --verified                              Has verifications
  --count=25 --start=0                    Pagination

Job details include:
  Title, company, location, salary, workplace type
  Full description, posted date
  Applicant insights (count, top degrees, top skills)
  Company info (industry, size, description)
  Company insights (headcount growth, hiring trends) [Premium]
  Hiring team members
  How You Fit analysis

Data: ${DATA_DIR}/
  session.json    Auth cookies & CSRF token
  cache/          Search results and job details`);
}
