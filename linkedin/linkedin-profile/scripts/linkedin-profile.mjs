#!/usr/bin/env node
/**
 * LinkedIn Person Profile Scraper
 *
 * Fetches a public LinkedIn person profile without login.
 * Data available without auth: name, headline, location, about, experience,
 * education, recent articles, and profile image.
 *
 * Strategy:
 *   1. Navigate to linkedin.com/in/<username> with camoufox (fingerprinted Firefox)
 *   2. Extract from: meta tags (OG, profile:*), JSON-LD, semantic DOM (h1/h2/h3/h4/li)
 *   3. Use stable selectors: data attributes, aria roles, semantic headings, .core-section-container
 *   4. With LI_COOKIES env var: full authenticated access
 *
 * Usage:
 *   node linkedin-profile.mjs <username>
 *
 * Examples:
 *   node linkedin-profile.mjs williamhgates
 *   node linkedin-profile.mjs satyanadella
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - username, name, headline, location, profileImage, about
 *   - experiences[]: title, company, startDate, endDate, duration, location
 *   - education[]: school, degree, startDate, endDate
 *   - articles[]: title, url, publishedAt, likeCount
 *
 * Auth:
 *   Set LI_COOKIES env var to a JSON array of LinkedIn cookies for full access.
 *   Without auth, LinkedIn shows: name, headline, location, about, up to 3
 *   experience items, education, and a few recent articles.
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createLinkedInBrowser,
  createLinkedInContext,
  extractPersonProfile,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const username = process.argv[2];
if (!username) {
  emitError("MISSING_ARG", "Usage: node linkedin-profile.mjs <username>");
}

// Strip @ prefix if provided
const cleanUsername = username.replace(/^@/, "");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(`[linkedin-profile] Fetching profile for: ${cleanUsername}`);

const browser = await createLinkedInBrowser(Camoufox);

try {
  const context = await createLinkedInContext(browser);
  const page = await context.newPage();

  // Navigate to the profile page
  const profileUrl = `https://www.linkedin.com/in/${cleanUsername}`;
  log(`[linkedin-profile] Navigating to: ${profileUrl}`);

  await page.goto(profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Wait for content to render
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

  // Check for 404 / profile not found
  const pageTitle = await page.title();
  if (
    pageTitle.toLowerCase().includes("page not found") ||
    pageTitle === "LinkedIn" ||
    pageTitle === ""
  ) {
    await browser.close();
    emitError("NOT_FOUND", `Profile not found: ${cleanUsername}`);
  }

  log(`[linkedin-profile] Page loaded: ${pageTitle}`);

  // Extract profile data
  const profile = await extractPersonProfile(page);

  // Validate we got meaningful data
  if (!profile.name) {
    // Try to get more information
    const bodyText = await page.evaluate(() => document.body?.textContent?.substring(0, 500));
    log(`[linkedin-profile] No name found. Body preview: ${bodyText}`);
    await browser.close();
    emitError("EXTRACTION_FAILED", "Could not extract profile name. Profile may require login.");
  }

  log(`[linkedin-profile] Extracted: ${profile.name} (${profile.headline})`);
  log(`[linkedin-profile] Experience: ${profile.experiences.length} entries`);
  log(`[linkedin-profile] Education: ${profile.education.length} entries`);
  log(`[linkedin-profile] Articles: ${profile.articles.length} entries`);

  await browser.close();

  emitResult({
    ...profile,
    meta: {
      ...profile.meta,
      scrapedAt: new Date().toISOString(),
      authenticated: !!process.env.LI_COOKIES,
    },
  });
} catch (err) {
  await browser.close().catch(() => {});
  emitError("SCRAPER_ERROR", err.message);
}
