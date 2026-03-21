#!/usr/bin/env node

/**
 * Reddit Post Scraper
 *
 * Scrapes a Reddit post and its comments using Reddit's JSON API.
 * Accepts either a full post URL or just a post ID.
 *
 * Usage:
 *   node reddit-post.mjs <post_url_or_id> [commentLimit] [commentSort]
 *
 * Examples:
 *   node reddit-post.mjs https://www.reddit.com/r/technology/comments/abc123/title/
 *   node reddit-post.mjs abc123
 *   node reddit-post.mjs abc123 200 new
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay, parsePost, parseComment } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const input = process.argv[2];
const commentLimit = parseInt(process.argv[3] || "100", 10);
const commentSort = process.argv[4] || "top";

if (!input) {
  emitError("MISSING_ARG", "Usage: node reddit-post.mjs <post_url_or_id> [commentLimit] [commentSort]");
}

const VALID_SORTS = ["top", "best", "new", "controversial", "old", "qa"];
if (!VALID_SORTS.includes(commentSort)) {
  emitError("INVALID_ARG", `Comment sort must be one of: ${VALID_SORTS.join(", ")}`);
}

const clampedLimit = Math.min(Math.max(commentLimit, 1), 500);

// ---------------------------------------------------------------------------
// Resolve post URL -> JSON API URL
// ---------------------------------------------------------------------------

function resolveApiUrl(input) {
  // If it's already a full URL
  if (input.startsWith("http")) {
    // Normalize: strip trailing slash, fragment, query
    const url = new URL(input);
    const path = url.pathname.replace(/\/$/, "");
    return `https://www.reddit.com${path}.json?limit=${clampedLimit}&sort=${commentSort}&raw_json=1`;
  }
  
  // If it looks like a full permalink path /r/sub/comments/id/title
  if (input.startsWith("/r/")) {
    return `https://www.reddit.com${input.replace(/\/$/, "")}.json?limit=${clampedLimit}&sort=${commentSort}&raw_json=1`;
  }
  
  // If it's just a post ID (base36, 4-8 chars typically)
  // We don't know the subreddit, so we use the short URL redirect
  return `https://www.reddit.com/comments/${input}.json?limit=${clampedLimit}&sort=${commentSort}&raw_json=1`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiUrl = resolveApiUrl(input);
  log(`Input: ${input}`);
  log(`API URL: ${apiUrl}`);
  log(`Comment limit: ${clampedLimit}, Sort: ${commentSort}`);

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
      // Match our JSON API response
      if (url.includes(".json") && url.includes("reddit.com") && 
          (url.includes("/comments/") || url.includes("/r/"))) {
        try {
          const status = response.status();
          log(`Intercepted response: ${url} [${status}]`);
          if (status === 200) {
            const text = await response.text();
            const parsed = JSON.parse(text);
            // Reddit post API returns an array of [postListing, commentsListing]
            if (Array.isArray(parsed) && parsed.length >= 2) {
              interceptedData = parsed;
            }
          } else if (status === 403) {
            interceptError = "POST_PRIVATE";
          } else if (status === 404) {
            interceptError = "POST_NOT_FOUND";
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

    log("Navigating to Reddit post JSON API...");
    await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 60000 });
    await delay(2000);

    // If no intercept, try to parse from page body
    if (!interceptedData && !interceptError) {
      const content = await page.evaluate(() => document.body.innerText);
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          interceptedData = parsed;
        } else {
          interceptedData = parsed;
        }
        log("Parsed JSON from page body");
      } catch (e) {
        log("Could not parse page body, retrying...");
        await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 30000 });
        await delay(2000);
        const content2 = await page.evaluate(() => document.body.innerText);
        try {
          interceptedData = JSON.parse(content2);
        } catch (e2) {
          emitError("PARSE_ERROR", "Could not obtain Reddit JSON data");
        }
      }
    }

    if (interceptError) {
      emitError(interceptError, `Failed to fetch post: ${interceptError}`);
    }

    if (!interceptedData) {
      emitError("NO_DATA", "No data received from Reddit API");
    }

    // Reddit post JSON is [postListing, commentsListing]
    let postData, commentsData;
    
    if (Array.isArray(interceptedData) && interceptedData.length >= 2) {
      postData = interceptedData[0];
      commentsData = interceptedData[1];
    } else {
      emitError("UNEXPECTED_FORMAT", "Expected array of [postListing, commentsListing]");
    }

    // Parse post
    const postChildren = postData?.data?.children || [];
    if (postChildren.length === 0) {
      emitError("POST_NOT_FOUND", "No post data in response");
    }
    
    const post = parsePost(postChildren[0]);
    log(`Post: ${post?.title}`);

    // Parse comments
    const commentChildren = commentsData?.data?.children || [];
    const comments = commentChildren
      .filter(c => c.kind === "t1") // t1 = comment
      .map(c => parseComment(c))
      .filter(Boolean);
    
    log(`Parsed ${comments.length} top-level comments`);

    emitResult({
      post,
      commentCount: comments.length,
      commentSort,
      comments,
    });

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
