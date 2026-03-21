#!/usr/bin/env node
/**
 * LinkedIn Jobs Search Scraper
 *
 * Searches LinkedIn public job listings by keyword and location.
 * Returns job cards with id, title, company, location, posted date, URL.
 * No login required for public job search.
 *
 * Strategy:
 *   1. Navigate to linkedin.com/jobs/search/?keywords=...&location=...
 *   2. Extract job cards via data-entity-urn (stable URN-based IDs)
 *   3. Semantic DOM: h3 (title), h4 (company), metadata div (location/date)
 *   4. Optionally fetch job detail pages for full description + criteria
 *
 * Usage:
 *   node linkedin-jobs.mjs <keywords> [location] [options]
 *
 * Examples:
 *   node linkedin-jobs.mjs "software engineer" "United States"
 *   node linkedin-jobs.mjs "product manager" "San Francisco" --max 25
 *   node linkedin-jobs.mjs "data scientist" "Remote" --detail
 *   node linkedin-jobs.mjs "ML engineer" "New York" --start 25 --max 50
 *
 * Options:
 *   --max N       Maximum results to return (default: 25, max: 100 per query)
 *   --start N     Start at result index N (for pagination, default: 0)
 *   --detail      Fetch full job description for each result (slow, ~2s/job)
 *   --type X      Filter by job type: full-time, part-time, contract, temporary, volunteer, internship
 *   --level X     Filter by seniority: internship, entry_level, associate, mid_senior_level, director, executive
 *   --remote      Filter for remote jobs only
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - jobs[]: jobId, title, company, location, postedAt, isEasyApply, url, logoImg
 *   - totalResults: total job count for the search
 *   - meta: keywords, location, page, scrapedAt
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createLinkedInBrowser,
  createLinkedInContext,
  extractJobListings,
  extractJobDetail,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0]?.startsWith("-")) {
  emitError(
    "MISSING_ARG",
    'Usage: node linkedin-jobs.mjs <keywords> [location] [--max N] [--start N] [--detail] [--type X] [--level X] [--remote]'
  );
}

const keywords = args[0];
// Location is second arg if it doesn't start with --
const location = args[1] && !args[1].startsWith("--") ? args[1] : "";

// Parse optional flags — collect all args that start with "--"
const allArgs = args.slice(0);

function getFlag(flag) {
  const idx = allArgs.indexOf(flag);
  return idx >= 0 ? allArgs[idx + 1] : null;
}

function hasFlag(flag) {
  return allArgs.includes(flag);
}

const maxResults = parseInt(getFlag("--max") || "25", 10);
const startIndex = parseInt(getFlag("--start") || "0", 10);
const fetchDetail = hasFlag("--detail");
const isRemote = hasFlag("--remote");

// Job type filter mapping
const JOB_TYPE_MAP = {
  "full-time": "F",
  "part-time": "P",
  contract: "C",
  temporary: "T",
  volunteer: "V",
  internship: "I",
};
const jobTypeRaw = getFlag("--type");
const jobType = jobTypeRaw ? JOB_TYPE_MAP[jobTypeRaw.toLowerCase()] || null : null;

// Seniority level filter
const LEVEL_MAP = {
  internship: "1",
  entry_level: "2",
  associate: "3",
  mid_senior_level: "4",
  director: "5",
  executive: "6",
};
const seniorityRaw = getFlag("--level");
const seniorityLevel = seniorityRaw ? LEVEL_MAP[seniorityRaw.toLowerCase()] || null : null;

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(start = 0) {
  const params = new URLSearchParams({
    keywords,
    start: String(start),
  });
  if (location) params.set("location", location);
  if (jobType) params.set("f_JT", jobType);
  if (seniorityLevel) params.set("f_E", seniorityLevel);
  if (isRemote) params.set("f_WT", "2"); // 2 = Remote
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(`[linkedin-jobs] Search: "${keywords}"${location ? ` in "${location}"` : ""}`);
log(`[linkedin-jobs] Options: max=${maxResults} start=${startIndex} detail=${fetchDetail}`);

const browser = await createLinkedInBrowser(Camoufox);

try {
  const context = await createLinkedInContext(browser);
  const page = await context.newPage();

  // Navigate to search page
  const searchUrl = buildSearchUrl(startIndex);
  log(`[linkedin-jobs] Navigating to: ${searchUrl}`);

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await delay(4000);

  // Check for auth wall
  const finalUrl = page.url();
  if (
    finalUrl.includes("/authwall") ||
    finalUrl.includes("/login") ||
    finalUrl.includes("/signup")
  ) {
    await browser.close();
    emitError(
      "AUTH_REQUIRED",
      "LinkedIn job search requires authentication. Set LI_COOKIES env var with valid LinkedIn cookies."
    );
  }

  const pageTitle = await page.title();
  log(`[linkedin-jobs] Page loaded: ${pageTitle}`);

  // Extract job listings
  let { jobs, totalResults } = await extractJobListings(page);
  log(`[linkedin-jobs] Found ${jobs.length} jobs on page (total: ${totalResults})`);

  // Limit to maxResults
  jobs = jobs.slice(0, maxResults);

  // Optionally paginate to get more results
  if (jobs.length < maxResults && jobs.length > 0 && !startIndex) {
    // Try to get next page's worth of results
    const remaining = maxResults - jobs.length;
    log(`[linkedin-jobs] Need ${remaining} more results, trying next page...`);
    const page2Url = buildSearchUrl(jobs.length + startIndex);
    await page.goto(page2Url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
    const result2 = await extractJobListings(page);
    jobs = jobs.concat(result2.jobs.slice(0, remaining));
    log(`[linkedin-jobs] After pagination: ${jobs.length} total jobs`);
  }

  // Fetch full detail for each job if --detail flag
  if (fetchDetail && jobs.length > 0) {
    log(`[linkedin-jobs] Fetching details for ${jobs.length} jobs...`);
    const detailPage = await context.newPage();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (!job.url) continue;
      try {
        log(`[linkedin-jobs] Detail ${i + 1}/${jobs.length}: ${job.title} @ ${job.company}`);
        await detailPage.goto(job.url, {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        });
        await delay(2000);
        const detail = await extractJobDetail(detailPage);
        // Merge detail into job object
        jobs[i] = {
          ...job,
          description: detail.description,
          criteria: detail.criteria,
          applicantCount: detail.applicantCount || job.applicantCount,
        };
      } catch (e) {
        log(`[linkedin-jobs] Detail fetch failed for job ${job.jobId}: ${e.message}`);
      }
    }
    await detailPage.close();
  }

  await browser.close();

  emitResult({
    jobs,
    totalResults,
    meta: {
      keywords,
      location: location || null,
      start: startIndex || 0,
      returned: jobs.length,
      scrapedAt: new Date().toISOString(),
      authenticated: !!process.env.LI_COOKIES,
      filters: {
        jobType: jobTypeRaw || null,
        seniorityLevel: seniorityRaw || null,
        remote: isRemote,
      },
    },
  });
} catch (err) {
  await browser.close().catch(() => {});
  emitError("SCRAPER_ERROR", err.message);
}
