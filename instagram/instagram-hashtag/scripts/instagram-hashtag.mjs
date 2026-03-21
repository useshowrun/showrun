#!/usr/bin/env node

/**
 * Instagram Hashtag Scraper
 *
 * Scrapes top/recent posts for a hashtag from Instagram's explore page.
 * Uses DOM-based extraction since the hashtag API requires authentication.
 *
 * The hashtag explore page loads a preview of top reels/posts without login.
 * Returns shortcodes, video preview URLs, and post URLs.
 *
 * Usage:
 *   node instagram-hashtag.mjs <hashtag>
 *
 * Examples:
 *   node instagram-hashtag.mjs photography
 *   node instagram-hashtag.mjs istanbul
 *   node instagram-hashtag.mjs sunset
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
  createIgBrowser,
  createIgContext,
  loadAuthCookies,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const hashtag = (process.argv[2] || "").replace(/^#/, ""); // Strip leading #

if (!hashtag) {
  emitError(
    "MISSING_ARG",
    "Usage: node instagram-hashtag.mjs <hashtag>"
  );
}

// ---------------------------------------------------------------------------
// Extract post cards from hashtag page DOM
// ---------------------------------------------------------------------------

async function extractHashtagPosts(page) {
  return page.evaluate(() => {
    const posts = [];

    // The hashtag explore page renders video reels/posts as <a> links
    // Each <a> wraps a <video> or <img> element
    const links = Array.from(
      document.querySelectorAll("a[href*='/reel/'], a[href*='/p/']")
    );

    for (const link of links) {
      const href = link.href || "";
      if (!href) continue;

      // Extract shortcode from URL
      const shortcodeMatch = href.match(/\/(reel|p)\/([A-Za-z0-9_-]+)\//);
      if (!shortcodeMatch) continue;

      const postType = shortcodeMatch[1]; // 'reel' or 'p'
      const shortcode = shortcodeMatch[2];

      // Get media preview from nested video or img
      const video = link.querySelector("video");
      const img = link.querySelector("img");

      const thumbnailUrl =
        video?.poster || img?.src || null;
      const videoPreviewUrl = video?.src || null;

      // Try to get alt text (may contain description)
      const altText = img?.alt || video?.title || null;

      posts.push({
        shortcode,
        url: href,
        type: postType === "reel" ? "reel" : "post",
        thumbnailUrl,
        videoPreviewUrl,
        altText,
      });
    }

    return posts;
  });
}

// ---------------------------------------------------------------------------
// Get hashtag page metadata
// ---------------------------------------------------------------------------

async function extractHashtagMeta(page) {
  return page.evaluate(() => {
    // Title is like "Photography • 4.5B reels on Instagram"
    const title = document.title;
    const reelCountMatch = title.match(/([\d.,]+[KMBT]?)\s+reels?/i);
    const postCountMatch = title.match(/([\d.,]+[KMBT]?)\s+posts?/i);

    return {
      title,
      reelCount: reelCountMatch ? reelCountMatch[1] : null,
      postCount: postCountMatch ? postCountMatch[1] : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching hashtag: #${hashtag}`);
  const hashtagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;

  const browser = await createIgBrowser(Camoufox);

  try {
    const context = await createIgContext(browser);

    // Load authentication cookies (IG_COOKIES env → session file → logged-out)
    const isAuthenticated = await loadAuthCookies(context);

    const page = await context.newPage();

    log(`Navigating to ${hashtagUrl}...`);
    await page.goto(hashtagUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for posts to load
    log("Waiting for posts to load...");
    let loaded = false;
    for (let i = 0; i < 20; i++) {
      const count = await page.locator("a[href*='/reel/'], a[href*='/p/']").count();
      if (count > 0) {
        log(`Found ${count} post links`);
        loaded = true;
        break;
      }
      await delay(1000);
    }

    if (!loaded) {
      // Check if login wall
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      if (bodyText.includes("Log in") || bodyText.includes("Log into") || bodyText.includes("Log In")) {
        if (!isAuthenticated) {
          emitResult({
            error: true,
            code: "SESSION_EXPIRED",
            message: "Instagram requires login to view hashtag content. Run instagram-login to authenticate.",
            instruction: "node instagram-login/scripts/instagram-login.mjs",
            hashtag: `#${hashtag}`,
          });
        } else {
          emitResult({
            error: true,
            code: "SESSION_EXPIRED",
            message: "Instagram session expired. Re-run instagram-login to refresh.",
            instruction: "node instagram-login/scripts/instagram-login.mjs",
          });
        }
        process.exit(1);
      }
      emitError("NO_RESULTS", `No posts found for hashtag #${hashtag}`);
    }

    // Wait a bit more for video sources to populate
    await delay(2000);

    // Extract posts
    const posts = await extractHashtagPosts(page);
    const meta = await extractHashtagMeta(page);

    log(`Extracted ${posts.length} posts for #${hashtag}`);
    log(`Page title: ${meta.title}`);

    if (posts.length === 0) {
      emitError("NO_RESULTS", `No posts found for hashtag #${hashtag}`);
    }

    emitResult({
      hashtag: `#${hashtag}`,
      pageTitle: meta.title,
      reelCount: meta.reelCount,
      postCount: meta.postCount,
      count: posts.length,
      posts,
      meta: {
        note: isAuthenticated
          ? "Authenticated — hashtag content available."
          : "DOM-based extraction — limited preview. Run instagram-login for full access.",
        authenticated: isAuthenticated,
        url: hashtagUrl,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
