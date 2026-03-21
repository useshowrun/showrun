#!/usr/bin/env node

/**
 * TikTok Videos Scraper
 *
 * Fetches videos from a TikTok user profile page.
 * Supports pagination via cursor.
 * No login required for public profiles.
 *
 * Strategy:
 *   1. Navigate to the user's profile page with camoufox
 *   2. The page auto-loads the first batch via /api/post/item_list/
 *   3. If --cursor is given, scroll the page to trigger more loads
 *      (or use the secUid + cursor to call the API directly via fetch)
 *
 * Usage:
 *   node tiktok-videos.mjs <username> [--cursor <cursor>] [--count <n>]
 *
 * Examples:
 *   node tiktok-videos.mjs natgeo
 *   node tiktok-videos.mjs natgeo --cursor 1771438710000
 *   node tiktok-videos.mjs charlidamelio --count 35
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
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const username = args[0];

if (!username || username.startsWith("--")) {
  emitError("MISSING_ARG", "Usage: node tiktok-videos.mjs <username> [--cursor <cursor>] [--count <n>]");
}

const cleanUsername = username.replace(/^@/, "");

// Parse optional flags
let cursor = null;
let requestedCount = 35;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--cursor" && args[i + 1]) {
    cursor = args[i + 1];
    i++;
  } else if (args[i] === "--count" && args[i + 1]) {
    requestedCount = parseInt(args[i + 1], 10);
    i++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching TikTok videos for: @${cleanUsername}${cursor ? ` (cursor: ${cursor})` : ""}`);

  const browser = await createTTBrowser(Camoufox);

  try {
    const context = await createTTContext(browser);
    const page = await context.newPage();

    // Capture all item_list API calls
    const capturedBatches = [];

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/post/item_list/")) {
        try {
          const data = await response.json();
          if (data.itemList && data.itemList.length > 0) {
            capturedBatches.push(data);
            log(`Captured batch of ${data.itemList.length} videos (cursor: ${data.cursor})`);
          }
        } catch (e) {
          log("Failed to parse item_list:", e.message);
        }
      }
    });

    log(`Navigating to @${cleanUsername}...`);
    const navResp = await page.goto(
      `https://www.tiktok.com/@${cleanUsername}`,
      { waitUntil: "networkidle", timeout: 60000 }
    );

    if (navResp.status() === 404) {
      emitError("NOT_FOUND", `User @${cleanUsername} not found`);
    }

    await delay(3000);

    // If we have a cursor, we need to scroll to get more videos
    // TikTok loads more videos when you scroll the page
    if (cursor && capturedBatches.length > 0) {
      const secUid = capturedBatches[0]?.itemList?.[0]?.author?.secUid;
      log(`Using secUid: ${secUid ? secUid.substring(0, 20) + "..." : "not found"}`);

      // Try to trigger API calls by injecting a fetch call directly
      const moreBatches = await page.evaluate(
        async ({ secUid, cursor, count }) => {
          // Build URL with same params as the browser uses
          const params = new URLSearchParams({
            aid: "1988",
            app_language: "en",
            app_name: "tiktok_web",
            browser_language: "en-US",
            browser_name: "Mozilla",
            browser_online: "true",
            browser_platform: "MacIntel",
            browser_version: "5.0 (Macintosh)",
            channel: "tiktok_web",
            cookie_enabled: "true",
            count: String(count),
            coverFormat: "0",
            cursor: String(cursor),
            data_collection_enabled: "false",
            device_platform: "web_pc",
            focus_state: "true",
            from_page: "user",
            is_fullscreen: "false",
            is_page_visible: "true",
            language: "en",
            os: "mac",
            secUid: secUid || "",
            video_encoding: "mp4",
            webcast_language: "en",
          });

          try {
            const resp = await fetch(
              `/api/post/item_list/?${params.toString()}`,
              {
                credentials: "include",
                headers: {
                  accept: "application/json",
                  "sec-fetch-dest": "empty",
                  "sec-fetch-mode": "cors",
                  "sec-fetch-site": "same-origin",
                },
              }
            );
            const data = await resp.json();
            return data;
          } catch (e) {
            return { error: e.message };
          }
        },
        {
          secUid: capturedBatches[0]?.itemList?.[0]?.author?.secUid,
          cursor,
          count: requestedCount,
        }
      );

      if (moreBatches?.itemList?.length > 0) {
        capturedBatches.push(moreBatches);
        log(`Fetched ${moreBatches.itemList.length} additional videos via in-page fetch`);
      } else {
        log("In-page fetch result:", JSON.stringify(moreBatches).substring(0, 200));
        // Fall back to scroll trigger
        log("Trying scroll to trigger more loads...");
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(3000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(3000);
      }
    }

    // Collect all videos from all batches
    const allVideos = [];
    let lastCursor = null;
    let hasMore = false;

    for (const batch of capturedBatches) {
      for (const item of batch.itemList || []) {
        const parsed = parseVideoItem(item);
        if (parsed) allVideos.push(parsed);
      }
      lastCursor = batch.cursor;
      hasMore = batch.hasMore ?? false;
    }

    log(`Total videos collected: ${allVideos.length}`);

    emitResult({
      username: cleanUsername,
      videos: allVideos,
      meta: {
        videosReturned: allVideos.length,
        hasMore,
        nextCursor: lastCursor,
        batchCount: capturedBatches.length,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
