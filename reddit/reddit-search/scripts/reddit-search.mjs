#!/usr/bin/env node

/**
 * Reddit Search Scraper
 *
 * Searches Reddit for posts using Reddit's JSON API via browser automation.
 * Can search globally or within a specific subreddit.
 *
 * Usage:
 *   node reddit-search.mjs <query> [subreddit] [sort] [limit] [time]
 *
 * Examples:
 *   node reddit-search.mjs "artificial intelligence"
 *   node reddit-search.mjs "rust language" programming
 *   node reddit-search.mjs "machine learning" "" top 50 month
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay, parsePost } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const query = process.argv[2];
const subreddit = (process.argv[3] || "").replace(/^r\//i, "").trim();
const sort = process.argv[4] || "relevance";
const limit = parseInt(process.argv[5] || "25", 10);
const time = process.argv[6] || "all";

if (!query) {
  emitError("MISSING_ARG", "Usage: node reddit-search.mjs <query> [subreddit] [sort] [limit] [time]");
}

const VALID_SORTS = ["relevance", "hot", "top", "new", "comments"];
if (!VALID_SORTS.includes(sort)) {
  emitError("INVALID_ARG", `Sort must be one of: ${VALID_SORTS.join(", ")}`);
}

const clampedLimit = Math.min(Math.max(limit, 1), 100);

// ---------------------------------------------------------------------------
// Build API URL
// ---------------------------------------------------------------------------

function buildApiUrl() {
  const params = new URLSearchParams({
    q: query,
    sort,
    t: time,
    limit: clampedLimit,
    raw_json: "1",
    type: "link", // Only posts (links), not comments or subreddits
  });
  
  if (subreddit) {
    // Search within a specific subreddit
    return `https://www.reddit.com/r/${subreddit}/search.json?${params}&restrict_sr=1`;
  } else {
    // Global search
    return `https://www.reddit.com/search.json?${params}`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiUrl = buildApiUrl();
  log(`Query: "${query}", Subreddit: ${subreddit || "global"}, Sort: ${sort}, Limit: ${clampedLimit}, Time: ${time}`);
  log(`API URL: ${apiUrl}`);

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

    let interceptedData = null;
    let interceptError = null;

    page.on("response", async (response) => {
      const url = response.url();
      // Match our search JSON API call
      if (url.includes("reddit.com") && url.includes("search.json")) {
        try {
          const status = response.status();
          log(`Intercepted response: ${url} [${status}]`);
          if (status === 200) {
            const text = await response.text();
            interceptedData = JSON.parse(text);
          } else if (status === 403) {
            interceptError = "FORBIDDEN";
          } else if (status === 404) {
            interceptError = "NOT_FOUND";
          } else if (status === 429) {
            interceptError = "RATE_LIMITED";
          } else {
            interceptError = `HTTP_ERROR_${status}`;
          }
        } catch (e) {
          log(`Error parsing response: ${e.message}`);
        }
      }
    });

    log("Navigating to Reddit search JSON API...");
    await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 60000 });
    await delay(2000);

    // If no intercept, try to parse from page body
    if (!interceptedData && !interceptError) {
      const content = await page.evaluate(() => document.body.innerText);
      try {
        interceptedData = JSON.parse(content);
        log("Parsed JSON from page body");
      } catch (e) {
        log("Could not parse page body as JSON, retrying...");
        await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 30000 });
        await delay(2000);
        const content2 = await page.evaluate(() => document.body.innerText);
        try {
          interceptedData = JSON.parse(content2);
        } catch (e2) {
          emitError("PARSE_ERROR", "Could not obtain Reddit search JSON data");
        }
      }
    }

    if (interceptError) {
      emitError(interceptError, `Reddit search failed: ${interceptError}`);
    }

    if (!interceptedData) {
      emitError("NO_DATA", "No data received from Reddit search API");
    }

    // Parse results
    const listing = interceptedData?.data;
    if (!listing) {
      emitError("UNEXPECTED_FORMAT", "Unexpected Reddit search API response format");
    }

    const children = listing.children || [];
    const results = children
      .filter(c => c.kind === "t3") // t3 = post/link
      .map(c => parsePost(c))
      .filter(Boolean);

    log(`Found ${results.length} search results for "${query}"`);

    emitResult({
      query,
      subreddit: subreddit || null,
      sort,
      limit: clampedLimit,
      time,
      count: results.length,
      after: listing.after || null,
      before: listing.before || null,
      results,
    });

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
