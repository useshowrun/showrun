#!/usr/bin/env node

/**
 * Glassdoor Company Search Scraper
 *
 * Searches Glassdoor for company information by company name.
 * Returns company ratings, review counts, job counts, and salary counts.
 *
 * Strategy:
 *   1. Navigate to glassdoor.com/Search/results.htm?keyword=<name>
 *   2. Parse DOM: company names, star ratings, job/review/salary counts, company links
 *   3. Return structured company data from search results
 *
 * Note: Individual company detail pages (/Overview/, /Reviews/, /Salaries/) are
 * Cloudflare-protected (from this server IP). The search results page is accessible
 * and provides the key summary data.
 *
 * Data returned from search results:
 *   - name, rating (1-5), reviewCount, jobCount, salaryCount
 *   - overviewUrl (link to full company page)
 *   - Employer ID (from URL)
 *
 * Usage:
 *   node glassdoor-company.mjs <company_name> [--max <N>]
 *
 * Examples:
 *   node glassdoor-company.mjs google
 *   node glassdoor-company.mjs "openai" --max 3
 *   node glassdoor-company.mjs microsoft
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  parseCountString,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let companyName = null;
let maxResults = 5;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxResults = parseInt(args[++i], 10);
  } else if (!companyName) {
    companyName = args[i];
  }
}

if (!companyName) {
  emitError("MISSING_ARG", "Usage: glassdoor-company.mjs <company_name> [--max N]");
}

const encodedKeyword = encodeURIComponent(companyName);
const searchUrl = `https://www.glassdoor.com/Search/results.htm?keyword=${encodedKeyword}`;

// ---------------------------------------------------------------------------
// Extract company ID from Glassdoor URL
// ---------------------------------------------------------------------------

function extractEmployerId(url) {
  // URL format: /Overview/Working-at-Google-EI_IE9079.11,17.htm
  const match = url?.match(/EI_IE(\d+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Parse count from text like "69.2Kreviews" or "6.7Kjobs"
// ---------------------------------------------------------------------------

function parseCount(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)([KMBkmb]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * mult);
}

// ---------------------------------------------------------------------------
// Extract companies from DOM
// ---------------------------------------------------------------------------

async function extractCompaniesFromDom(page) {
  return page.evaluate(() => {
    const results = [];

    // Get all company overview links from search results
    const companyLinks = Array.from(
      document.querySelectorAll('a[href*="/Overview/Working-at-"]')
    );

    for (const link of companyLinks) {
      const text = link.innerText || "";
      const href = link.href || "";

      // Parse link text: "OpenAI\n4.5★\n575jobs\n137reviews\n282salaries"
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      const name = lines[0];
      if (!name || name.length < 2) continue;

      // Find star rating
      let rating = null;
      let jobs = null;
      let reviews = null;
      let salaries = null;

      for (const line of lines.slice(1)) {
        const starMatch = line.match(/^([\d.]+)★$/);
        if (starMatch) {
          rating = parseFloat(starMatch[1]);
          continue;
        }
        if (/\d.*jobs?/i.test(line)) jobs = line;
        else if (/\d.*reviews?/i.test(line)) reviews = line;
        else if (/\d.*salaries?/i.test(line)) salaries = line;
      }

      // Extract employer ID from URL
      const idMatch = href.match(/EI_IE(\d+)/);
      const employerId = idMatch ? idMatch[1] : null;

      results.push({
        name,
        rating,
        jobCount: null,
        reviewCount: null,
        salaryCount: null,
        jobText: jobs,
        reviewText: reviews,
        salaryText: salaries,
        overviewUrl: href,
        employerId,
        reviewsUrl: employerId ? `https://www.glassdoor.com/Reviews/${name.replace(/\s+/g, "-")}-Reviews-E${employerId}.htm` : null,
      });
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching Glassdoor for company: "${companyName}"`);
  log(`URL: ${searchUrl}`);

  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await context.newPage();

    log("Navigating to Glassdoor search...");
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await delay(4000);

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    const title = await page.title();
    log(`Title: ${title}`);

    if (title === "" || title.toLowerCase().includes("moment")) {
      emitError("BLOCKED", "Glassdoor is blocking this request (Cloudflare). Try again later or use a residential proxy.");
    }

    // Extract company data from DOM
    const companies = await extractCompaniesFromDom(page);
    log(`Found ${companies.length} companies in search results`);

    // Parse count strings
    for (const company of companies) {
      company.jobCount = parseCount(company.jobText);
      company.reviewCount = parseCount(company.reviewText);
      company.salaryCount = parseCount(company.salaryText);
      // Clean up raw text fields
      delete company.jobText;
      delete company.reviewText;
      delete company.salaryText;
    }

    const finalResults = companies.slice(0, maxResults);

    log(`\nFinal result:`);
    for (const c of finalResults) {
      log(`  ${c.name}: ⭐${c.rating} | ${c.reviewCount} reviews | ${c.jobCount} jobs | ${c.salaryCount} salaries`);
    }

    emitResult({
      query: companyName,
      searchUrl,
      companies: finalResults,
      meta: {
        returned: finalResults.length,
        hasMore: companies.length > maxResults,
        note: "Individual company pages (reviews, salaries) may require GD_COOKIES or a residential proxy due to Cloudflare protection.",
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
