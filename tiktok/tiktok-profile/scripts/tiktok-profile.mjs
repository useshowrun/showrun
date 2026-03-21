#!/usr/bin/env node

/**
 * TikTok Profile Scraper
 *
 * Fetches a public TikTok profile along with recent videos.
 * No login required for public profiles.
 *
 * Strategy:
 *   1. Navigate to @username page with camoufox (headless, fingerprinted browser)
 *   2. Extract profile from __UNIVERSAL_DATA_FOR_REHYDRATION__ (embedded JSON)
 *   3. Intercept /api/post/item_list/ response to get the initial ~35 videos
 *
 * Usage:
 *   node tiktok-profile.mjs <username>
 *
 * Examples:
 *   node tiktok-profile.mjs natgeo
 *   node tiktok-profile.mjs charlidamelio
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - profile: id, uniqueId, nickname, signature, followerCount, videoCount, etc.
 *   - videos[]: up to 35 most recent videos
 *     Each video: id, url, description, hashtags, createTime, duration,
 *                 coverUrl, diggCount, commentCount, playCount, etc.
 *   - meta: videoCount, videosReturned, hasMore, cursor
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createTTBrowser,
  createTTContext,
  parseUser,
  parseVideoItem,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const username = process.argv[2];

if (!username) {
  emitError("MISSING_ARG", "Usage: node tiktok-profile.mjs <username>");
}

// Strip leading @ if provided
const cleanUsername = username.replace(/^@/, "");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching TikTok profile: @${cleanUsername}`);

  const browser = await createTTBrowser(Camoufox);

  try {
    const context = await createTTContext(browser);
    const page = await context.newPage();

    // Intercept /api/post/item_list/ to capture initial videos
    let postListData = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/post/item_list/") && !postListData) {
        try {
          postListData = await response.json();
          log("Captured post/item_list response");
        } catch (e) {
          log("Failed to parse post/item_list:", e.message);
        }
      }
    });

    log(`Navigating to https://www.tiktok.com/@${cleanUsername}...`);
    const response = await page.goto(
      `https://www.tiktok.com/@${cleanUsername}`,
      { waitUntil: "networkidle", timeout: 60000 }
    );

    if (response.status() === 404) {
      emitError("NOT_FOUND", `User @${cleanUsername} not found on TikTok`);
    }

    // Wait for data to settle
    await delay(3000);

    // Extract profile from embedded JSON
    log("Extracting profile from page...");
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

    if (!universalData) {
      emitError(
        "NO_DATA",
        "Could not extract __UNIVERSAL_DATA_FOR_REHYDRATION__ from page"
      );
    }

    const scope = universalData.__DEFAULT_SCOPE__ || {};
    const userDetail = scope["webapp.user-detail"];

    if (!userDetail || userDetail.statusCode !== 0) {
      // Check for user not found
      if (userDetail?.statusCode === 10202 || userDetail?.statusCode === 10221) {
        emitError("NOT_FOUND", `User @${cleanUsername} not found`);
      }
      emitError(
        "API_ERROR",
        `User detail returned status: ${userDetail?.statusCode} - ${userDetail?.statusMsg}`
      );
    }

    const userInfo = userDetail.userInfo;
    const user = userInfo.user;
    const stats = userInfo.stats;
    const statsV2 = userInfo.statsV2;

    log(
      `Found profile: ${user.nickname} (@${user.uniqueId}), ${statsV2?.followerCount || stats?.followerCount} followers`
    );

    // Parse profile
    const profile = parseUser(user, stats, statsV2);

    // Parse videos from intercepted API response
    let videos = [];
    let hasMore = false;
    let cursor = null;

    if (postListData) {
      const rawVideos = postListData.itemList || [];
      videos = rawVideos.map(parseVideoItem).filter(Boolean);
      hasMore = postListData.hasMore ?? false;
      cursor = postListData.cursor ?? null;
      log(`Got ${videos.length} videos from API (hasMore: ${hasMore})`);
    } else {
      log("No video list data captured from API intercept");
    }

    // Emit result
    emitResult({
      username: cleanUsername,
      profile,
      videos,
      meta: {
        videoTotal: profile.videoCount,
        videosReturned: videos.length,
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
