#!/usr/bin/env node
/**
 * LinkedIn Company Page Scraper
 *
 * Fetches a public LinkedIn company page without login.
 * Data available without auth: name, industry, follower count, employee count,
 * description, website, headquarters, company type, founded date, specialties,
 * locations, and company logo.
 *
 * Strategy:
 *   1. Navigate to linkedin.com/company/<slug> with camoufox
 *   2. Extract from: meta tags, semantic DOM sections (h2-anchored sections)
 *   3. Use stable selectors: h2 text matching, data-entity-urn, semantic structure
 *   4. With LI_COOKIES env var: access to more employee data and posts
 *
 * Usage:
 *   node linkedin-company.mjs <slug>
 *
 * Examples:
 *   node linkedin-company.mjs microsoft
 *   node linkedin-company.mjs openai
 *   node linkedin-company.mjs google
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - slug, name, profileUrl, profileImage
 *   - industry, followerCount, employeeCount
 *   - about, website, companySize, headquarters, companyType, founded, specialties
 *   - locations[]: office locations
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createLinkedInBrowser,
  createLinkedInContext,
  extractCompanyData,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const slug = process.argv[2];
if (!slug) {
  emitError("MISSING_ARG", "Usage: node linkedin-company.mjs <company-slug>");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(`[linkedin-company] Fetching company: ${slug}`);

const browser = await createLinkedInBrowser(Camoufox);

try {
  const context = await createLinkedInContext(browser);
  const page = await context.newPage();

  const companyUrl = `https://www.linkedin.com/company/${slug}`;
  log(`[linkedin-company] Navigating to: ${companyUrl}`);

  await page.goto(companyUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await delay(3000);

  // Check for auth wall / redirect
  const finalUrl = page.url();
  if (
    finalUrl.includes("/authwall") ||
    finalUrl.includes("/login") ||
    finalUrl.includes("/signup")
  ) {
    await browser.close();
    emitError(
      "AUTH_REQUIRED",
      "LinkedIn requires authentication. Set LI_COOKIES env var with valid LinkedIn cookies."
    );
  }

  const pageTitle = await page.title();
  if (
    pageTitle.toLowerCase().includes("page not found") ||
    pageTitle === "LinkedIn" ||
    pageTitle === ""
  ) {
    await browser.close();
    emitError("NOT_FOUND", `Company not found: ${slug}`);
  }

  log(`[linkedin-company] Page loaded: ${pageTitle}`);

  // Extract company data
  const company = await extractCompanyData(page);

  if (!company.name) {
    await browser.close();
    emitError("EXTRACTION_FAILED", "Could not extract company name. Page may require login.");
  }

  log(`[linkedin-company] Extracted: ${company.name}`);
  log(`[linkedin-company] Industry: ${company.industry}`);
  log(`[linkedin-company] Followers: ${company.followerCount}`);
  log(`[linkedin-company] Employees: ${company.employeeCount}`);

  await browser.close();

  emitResult({
    ...company,
    meta: {
      ...company.meta,
      scrapedAt: new Date().toISOString(),
      authenticated: !!process.env.LI_COOKIES,
    },
  });
} catch (err) {
  await browser.close().catch(() => {});
  emitError("SCRAPER_ERROR", err.message);
}
