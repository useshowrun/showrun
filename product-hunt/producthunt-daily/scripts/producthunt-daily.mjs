#!/usr/bin/env node
/**
 * Product Hunt Daily Scraper
 *
 * Fetches today's (or a specific date's) top products from Product Hunt.
 * Uses camoufox browser automation to scrape the leaderboard page which
 * shows products ranked by votes with full data including vote counts, names,
 * taglines, topics, and product slugs.
 *
 * Data Source:
 *   https://www.producthunt.com/           (today's products, rank order by votes)
 *   https://www.producthunt.com/leaderboard/daily/YYYY/M/D  (specific date)
 *
 * No authentication required — all public data.
 *
 * Strategy:
 *   - Navigate to the leaderboard page (today or specific date)
 *   - Scrape DOM using stable [data-test="post-item-<id>"] sections
 *   - Extract: id, name, tagline, topics, vote count, comment count, slug, thumbnail
 *
 * Usage:
 *   node producthunt-daily.mjs [options]
 *
 * Options:
 *   --date <YYYY-MM-DD>   Products for this specific date (default: today's homepage)
 *   --max <N>             Max results to return (default: 30)
 *
 * Examples:
 *   node producthunt-daily.mjs
 *   node producthunt-daily.mjs --date 2026-03-20
 *   node producthunt-daily.mjs --date 2026-03-15 --max 10
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay, scrapePostItems } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let dateFilter = null; // YYYY-MM-DD or null (today)
let maxResults = 30;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--date": dateFilter = args[++i]; break;
    case "--max":  maxResults = parseInt(args[++i], 10); break;
    default:
      emitError("UNKNOWN_ARG", `Unknown argument: ${args[i]}`);
  }
}

if (dateFilter && !/^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
  emitError("INVALID_DATE", `Date must be in YYYY-MM-DD format, got: ${dateFilter}`);
}

const clampedMax = Math.min(Math.max(maxResults, 1), 100);

// ---------------------------------------------------------------------------
// Build URL
// ---------------------------------------------------------------------------

function buildUrl(dateStr) {
  if (!dateStr) {
    return "https://www.producthunt.com/";
  }
  const [year, month, day] = dateStr.split("-");
  // Remove leading zeros from month/day for PH leaderboard URL format
  return `https://www.producthunt.com/leaderboard/daily/${year}/${parseInt(month, 10)}/${parseInt(day, 10)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const targetDate = dateFilter || new Date().toISOString().slice(0, 10);
  const url = buildUrl(dateFilter);

  log(`Fetching daily products for: ${targetDate}`);
  log(`URL: ${url}`);

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

    log("Navigating to Product Hunt leaderboard...");
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      log(`Navigation note: ${e.message}`);
    }

    // Wait for product list to render
    await delay(8000);

    const title = await page.title().catch(() => "");
    log(`Page title: "${title}"`);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      log("Cloudflare challenge detected, waiting for bypass...");
      await delay(10000);
    }

    // Scrape the post items from the DOM
    const products = await page.evaluate(scrapePostItems);

    log(`Extracted ${products.length} products`);

    if (products.length === 0) {
      // Check if it's an empty day or a navigation error
      const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const isNotFound = bodyText.includes("Page not found") || bodyText.includes("404");
      if (isNotFound) {
        emitResult({
          date: targetDate,
          returned: 0,
          products: [],
          note: "Page not found — date may be in the future or invalid",
          scrapedAt: new Date().toISOString(),
        });
        return;
      }
    }

    const limited = products.slice(0, clampedMax);

    emitResult({
      date: targetDate,
      url,
      totalFound: products.length,
      returned: limited.length,
      products: limited,
      scrapedAt: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("FATAL", err.message);
});
