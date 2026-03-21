#!/usr/bin/env node

/**
 * TikTok Hashtag Scraper
 *
 * Scrapes a TikTok hashtag/challenge page to get:
 *   - Hashtag metadata (viewCount, description)
 *   - Top/trending videos for the hashtag
 *
 * Strategy:
 *   1. Navigate to https://www.tiktok.com/tag/{hashtag}
 *   2. Intercept /api/challenge/detail/ for hashtag metadata
 *   3. Intercept /api/challenge/item_list/ for videos
 *
 * Usage:
 *   node tiktok-hashtag.mjs <hashtag>
 *
 * Examples:
 *   node tiktok-hashtag.mjs nature
 *   node tiktok-hashtag.mjs "#travel"
 *   node tiktok-hashtag.mjs fyp
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
  createTTBrowser,
  createTTContext,
  parseVideoItem,
  parseChallenge,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const hashtag = process.argv[2];

if (!hashtag) {
  emitError("MISSING_ARG", "Usage: node tiktok-hashtag.mjs <hashtag>");
}

// Strip leading # if provided
const cleanHashtag = hashtag.replace(/^#/, "");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching TikTok hashtag: #${cleanHashtag}`);

  const browser = await createTTBrowser(Camoufox);

  try {
    const context = await createTTContext(browser);
    const page = await context.newPage();

    // Intercept challenge API calls
    let challengeDetail = null;
    const videoBatches = [];

    page.on("response", async (response) => {
      const url = response.url();

      if (url.includes("/api/challenge/detail/") && !challengeDetail) {
        try {
          challengeDetail = await response.json();
          log("Captured challenge detail");
        } catch (e) {
          log("Failed to parse challenge detail:", e.message);
        }
      }

      if (url.includes("/api/challenge/item_list/")) {
        try {
          const data = await response.json();
          if (data.itemList && data.itemList.length > 0) {
            videoBatches.push(data);
            log(`Captured ${data.itemList.length} hashtag videos`);
          }
        } catch (e) {
          log("Failed to parse challenge item_list:", e.message);
        }
      }
    });

    log(`Navigating to https://www.tiktok.com/tag/${encodeURIComponent(cleanHashtag)}...`);
    const navResp = await page.goto(
      `https://www.tiktok.com/tag/${encodeURIComponent(cleanHashtag)}`,
      { waitUntil: "networkidle", timeout: 60000 }
    );

    if (navResp.status() === 404) {
      emitError("NOT_FOUND", `Hashtag #${cleanHashtag} not found`);
    }

    await delay(3000);

    // Parse challenge info
    let challenge = null;
    if (challengeDetail) {
      const info = challengeDetail.challengeInfo;
      challenge = parseChallenge(info?.challenge, info?.stats);
    }

    // Check embedded data if API call was missed
    if (!challenge) {
      log("No API capture, trying page embedded data...");
      const universalData = await page.evaluate(() => {
        const script = document.getElementById(
          "__UNIVERSAL_DATA_FOR_REHYDRATION__"
        );
        if (!script) return null;
        try {
          return JSON.parse(script.textContent);
        } catch {
          return null;
        }
      });

      if (universalData) {
        const scope = universalData.__DEFAULT_SCOPE__ || {};
        const challengeInfo = scope["webapp.challenge-detail"];
        if (challengeInfo?.challengeInfo) {
          challenge = parseChallenge(
            challengeInfo.challengeInfo.challenge,
            challengeInfo.challengeInfo.stats
          );
        }
      }
    }

    if (!challenge) {
      // Try to get at least basic info from page title
      const title = await page.title();
      log("Could not get challenge detail. Page title:", title);
      challenge = {
        title: cleanHashtag,
        description: null,
        viewCount: null,
        videoCount: null,
        profileUrl: `https://www.tiktok.com/tag/${encodeURIComponent(cleanHashtag)}`,
      };
    }

    log(`Challenge: #${challenge.title} — ${challenge.viewCount ?? "?"} views`);

    // Collect videos
    const allVideos = [];
    let hasMore = false;
    let cursor = null;

    for (const batch of videoBatches) {
      for (const item of batch.itemList || []) {
        const parsed = parseVideoItem(item);
        if (parsed) allVideos.push(parsed);
      }
      hasMore = batch.hasMore ?? false;
      cursor = batch.cursor ?? null;
    }

    log(`Collected ${allVideos.length} videos for #${cleanHashtag}`);

    emitResult({
      hashtag: cleanHashtag,
      challenge,
      videos: allVideos,
      meta: {
        videosReturned: allVideos.length,
        hasMore,
        cursor,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
