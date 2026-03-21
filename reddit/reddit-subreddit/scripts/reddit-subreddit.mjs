#!/usr/bin/env node

/**
 * Reddit Subreddit Scraper
 *
 * Scrapes posts from any subreddit using Reddit's internal JSON API,
 * intercepted via camoufox browser automation.
 *
 * Usage:
 *   node reddit-subreddit.mjs <subreddit> [sort] [limit] [time]
 *
 * Examples:
 *   node reddit-subreddit.mjs technology
 *   node reddit-subreddit.mjs worldnews new 50
 *   node reddit-subreddit.mjs programming top 100 all
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay, parsePost } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

let subreddit = process.argv[2];
const sort = process.argv[3] || "hot";
const limit = parseInt(process.argv[4] || "25", 10);
const time = process.argv[5] || "day";

if (!subreddit) {
  emitError("MISSING_ARG", "Usage: node reddit-subreddit.mjs <subreddit> [sort] [limit] [time]");
}

// Normalize subreddit name (remove r/ prefix)
subreddit = subreddit.replace(/^r\//i, "");

const VALID_SORTS = ["hot", "new", "top", "rising", "controversial"];
if (!VALID_SORTS.includes(sort)) {
  emitError("INVALID_ARG", `Sort must be one of: ${VALID_SORTS.join(", ")}`);
}

const clampedLimit = Math.min(Math.max(limit, 1), 100);

// ---------------------------------------------------------------------------
// Build API URL
// ---------------------------------------------------------------------------

function buildApiUrl() {
  let url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${clampedLimit}&raw_json=1`;
  if (sort === "top" || sort === "controversial") {
    url += `&t=${time}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiUrl = buildApiUrl();
  log(`Subreddit: r/${subreddit}, Sort: ${sort}, Limit: ${clampedLimit}`);
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

    // Intercept the Reddit JSON API response
    let interceptedData = null;
    let interceptError = null;

    page.on("response", async (response) => {
      const url = response.url();
      // Match our JSON API call
      if (url.includes(`/r/${subreddit}/${sort}.json`) || url.includes(`/r/${subreddit.toLowerCase()}/${sort}.json`)) {
        try {
          const status = response.status();
          log(`Intercepted response: ${url} [${status}]`);
          if (status === 200) {
            const text = await response.text();
            interceptedData = JSON.parse(text);
          } else if (status === 403) {
            interceptError = "SUBREDDIT_PRIVATE";
          } else if (status === 404) {
            interceptError = "SUBREDDIT_NOT_FOUND";
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

    // Navigate to the JSON API URL directly — Reddit will serve JSON
    log("Navigating to Reddit JSON API...");
    await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 60000 });
    await delay(2000);

    // If no intercept, try to parse page content directly
    if (!interceptedData && !interceptError) {
      const content = await page.evaluate(() => document.body.innerText);
      try {
        interceptedData = JSON.parse(content);
        log("Parsed JSON from page body");
      } catch (e) {
        log("Could not parse page body as JSON, trying DOM navigation...");
        // Try navigating to the HTML version and let the intercept fire
        await page.goto(`https://www.reddit.com/r/${subreddit}/${sort}`, { 
          waitUntil: "networkidle", 
          timeout: 60000 
        });
        await delay(3000);
        
        // Navigate to JSON endpoint
        await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 60000 });
        await delay(2000);
        
        if (!interceptedData) {
          const content2 = await page.evaluate(() => document.body.innerText);
          try {
            interceptedData = JSON.parse(content2);
          } catch (e2) {
            emitError("PARSE_ERROR", "Could not obtain Reddit JSON data");
          }
        }
      }
    }

    if (interceptError) {
      emitError(interceptError, `Failed to fetch r/${subreddit}: ${interceptError}`);
    }

    if (!interceptedData) {
      emitError("NO_DATA", "No data received from Reddit API");
    }

    // Parse posts
    const listing = interceptedData?.data;
    if (!listing) {
      emitError("UNEXPECTED_FORMAT", "Unexpected Reddit API response format");
    }

    const children = listing.children || [];
    const posts = children
      .filter(c => c.kind === "t3") // t3 = link/post
      .map(c => parsePost(c))
      .filter(Boolean);

    log(`Parsed ${posts.length} posts from r/${subreddit}`);

    emitResult({
      subreddit,
      sort,
      limit: clampedLimit,
      time: (sort === "top" || sort === "controversial") ? time : undefined,
      count: posts.length,
      after: listing.after || null,
      before: listing.before || null,
      posts,
    });

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
