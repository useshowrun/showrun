#!/usr/bin/env node

/**
 * YouTube Comments Scraper
 *
 * Fetches comments from any public YouTube video.
 * No API key or login required — intercepts youtubei/v1/next API responses.
 *
 * Strategy:
 *   1. Navigate to the video page with camoufox (fingerprinted Firefox)
 *   2. Add SOCS consent cookie to bypass consent dialog
 *   3. Intercept all POST requests to /youtubei/v1/next
 *   4. On page scroll, YouTube loads comments via these requests
 *   5. Comments are in frameworkUpdates.entityBatchUpdate.mutations[].commentEntityPayload
 *   6. Comment IDs are in onResponseReceivedEndpoints reloadContinuationItemsCommand / appendContinuationItemsAction
 *   7. Pagination: extract continuation token from last continuationItemRenderer
 *
 * Usage:
 *   node youtube-comments.mjs <videoId|url> [--max <N>] [--sort top|new]
 *
 * Examples:
 *   node youtube-comments.mjs dQw4w9WgXcQ
 *   node youtube-comments.mjs dQw4w9WgXcQ --max 100
 *   node youtube-comments.mjs "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --sort new
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   {
 *     videoId, videoUrl, totalComments,
 *     comments: [{
 *       id, text, author, authorChannelId, authorChannelUrl,
 *       authorAvatarUrl, isAuthorVerified, publishedTime,
 *       likeCount, replyCount, isLikedByCreator, isPinned
 *     }],
 *     meta: { returned, hasMore, sortedBy }
 *   }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  addConsentCookies, extractPageJson,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let videoInput = null;
let maxComments = 20;
let sortBy = "top"; // "top" or "new"

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxComments = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--sort" && args[i + 1]) {
    sortBy = args[i + 1].toLowerCase();
    i++;
  } else if (!videoInput) {
    videoInput = args[i];
  }
}

if (!videoInput) {
  emitError("MISSING_ARG", "Usage: node youtube-comments.mjs <videoId|url> [--max N] [--sort top|new]");
}

// ---------------------------------------------------------------------------
// Resolve video ID from URL or plain ID
// ---------------------------------------------------------------------------

function resolveVideoId(input) {
  if (input.startsWith("http")) {
    try {
      const url = new URL(input);
      if (url.hostname.includes("youtu.be")) {
        return url.pathname.slice(1).split("?")[0];
      }
      return url.searchParams.get("v") || url.pathname.split("/").pop();
    } catch {
      return input;
    }
  }
  if (input.includes("youtu.be/")) {
    return input.split("youtu.be/").pop().split("?")[0];
  }
  return input.trim();
}

const videoId = resolveVideoId(videoInput);
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

// ---------------------------------------------------------------------------
// Parse comments from a single "next" API response
// Comments data uses two parts:
//   1. frameworkUpdates.entityBatchUpdate.mutations[].commentEntityPayload
//      -> Contains actual comment content (text, author, likes, etc.)
//      -> Keyed by commentId
//   2. onResponseReceivedEndpoints reloadContinuationItemsCommand / appendContinuationItemsAction
//      -> Contains ordered list of commentIds
//      -> Contains continuation token for next page
// ---------------------------------------------------------------------------

function parseCommentPayload(payload) {
  if (!payload || !payload.commentEntityPayload) return null;
  const c = payload.commentEntityPayload;
  const props = c.properties || {};
  const author = c.author || {};
  const toolbar = c.toolbar || {};
  const avatar = c.avatar || {};

  // Parse like count from string like "201K" or "1,234"
  const likeStr = toolbar.likeCountNotliked || toolbar.likeCountLiked || "0";
  const likeCount = parseLikeCount(likeStr);

  // Parse reply count
  const replyCountStr = toolbar.replyCount || "0";
  const replyCount = parseInt(String(replyCountStr).replace(/[^0-9]/g, ""), 10) || 0;

  // Get avatar URL
  const avatarSources = avatar.image?.sources || [];
  const authorAvatarUrl = avatarSources.length > 0 ? avatarSources[0].url : null;

  return {
    id: props.commentId || null,
    text: props.content?.content || "",
    authorChannelId: author.channelId || null,
    author: author.displayName || null,
    authorChannelUrl: author.channelId
      ? `https://www.youtube.com/channel/${author.channelId}`
      : null,
    authorAvatarUrl,
    isAuthorVerified: author.isVerified || false,
    publishedTime: props.publishedTime || null,
    likeCount,
    replyCount,
    isLikedByCreator: toolbar.heartState === "TOOLBAR_HEART_STATE_HEARTED",
    isPinned: !!(props.pinnedCommentBadge),
  };
}

function parseLikeCount(str) {
  if (!str) return 0;
  const s = String(str).replace(/,/g, "").trim();
  const m = s.match(/^([\d.]+)\s*([KMBkmb]?)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * mult);
}

// ---------------------------------------------------------------------------
// Extract comment IDs and continuation token from continuation items
// ---------------------------------------------------------------------------

function extractFromContinuationItems(items) {
  const commentIds = [];
  let continuationToken = null;
  let totalComments = null;

  for (const item of items || []) {
    // Header with total comment count
    if (item.commentsHeaderRenderer) {
      const countRuns = item.commentsHeaderRenderer.countText?.runs || [];
      const countStr = countRuns.map((r) => r.text).join("").replace(/[^0-9]/g, "");
      if (countStr) totalComments = parseInt(countStr, 10);
    }

    // Comment thread
    if (item.commentThreadRenderer) {
      const ctr = item.commentThreadRenderer;
      const cvm = ctr.commentViewModel?.commentViewModel;
      if (cvm?.commentId) {
        commentIds.push(cvm.commentId);
      }
    }

    // Continuation token for next page
    if (item.continuationItemRenderer) {
      const cr = item.continuationItemRenderer;
      const token =
        cr.continuationEndpoint?.continuationCommand?.token ||
        cr.button?.buttonRenderer?.navigationEndpoint?.continuationCommand?.token;
      if (token) continuationToken = token;
    }
  }

  return { commentIds, continuationToken, totalComments };
}

// ---------------------------------------------------------------------------
// Process a single "next" API response into comment data
// ---------------------------------------------------------------------------

function processNextResponse(data) {
  // 1. Build map of commentId -> comment data from frameworkUpdates mutations
  const commentMap = new Map();
  const mutations =
    data.frameworkUpdates?.entityBatchUpdate?.mutations || [];

  for (const mutation of mutations) {
    const payload = mutation.payload;
    if (!payload?.commentEntityPayload) continue;
    const comment = parseCommentPayload(payload);
    if (comment?.id) {
      commentMap.set(comment.id, comment);
    }
  }

  // 2. Get ordered comment IDs and continuation token from endpoints
  const endpoints = data.onResponseReceivedEndpoints || [];
  let allCommentIds = [];
  let continuationToken = null;
  let totalComments = null;

  for (const ep of endpoints) {
    // Initial load: reloadContinuationItemsCommand
    if (ep.reloadContinuationItemsCommand?.targetId === "comments-section") {
      const items = ep.reloadContinuationItemsCommand.continuationItems || [];
      const extracted = extractFromContinuationItems(items);
      allCommentIds = allCommentIds.concat(extracted.commentIds);
      if (extracted.continuationToken) continuationToken = extracted.continuationToken;
      if (extracted.totalComments !== null) totalComments = extracted.totalComments;
    }

    // Pagination: appendContinuationItemsAction
    if (ep.appendContinuationItemsAction?.targetId === "comments-section") {
      const items = ep.appendContinuationItemsAction.continuationItems || [];
      const extracted = extractFromContinuationItems(items);
      allCommentIds = allCommentIds.concat(extracted.commentIds);
      if (extracted.continuationToken) continuationToken = extracted.continuationToken;
    }
  }

  // 3. Assemble comments in order
  const orderedComments = allCommentIds
    .map((id) => commentMap.get(id))
    .filter(Boolean);

  return { orderedComments, continuationToken, totalComments, commentMap };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching YouTube comments for video: ${videoId}`);
  log(`URL: ${watchUrl}`);
  log(`Sort: ${sortBy}, Max: ${maxComments}`);

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

    await addConsentCookies(context);

    const page = await context.newPage();

    // Intercept /youtubei/v1/next responses
    const nextResponses = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("youtubei/v1/next")) {
        try {
          const data = await response.json();
          nextResponses.push(data);
          const mutations = data.frameworkUpdates?.entityBatchUpdate?.mutations || [];
          const commentCount = mutations.filter(
            (m) => m.payload?.commentEntityPayload
          ).length;
          log(`next response: ${commentCount} comments, keys=${Object.keys(data).join(",")}`);
        } catch (e) {
          log(`Failed to parse next response: ${e.message}`);
        }
      }
    });

    log("Navigating to video page...");
    const response = await page.goto(watchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (response?.status() === 404) {
      emitError("VIDEO_NOT_FOUND", `Video ${videoId} not found`);
    }

    // Wait for initial page load
    await delay(3000);

    const title = await page.title();
    log(`Page title: ${title}`);

    if (title.includes("404") || title === "") {
      emitError("VIDEO_NOT_FOUND", `Video ${videoId} not found`);
    }

    // Extract ytInitialPlayerResponse to validate video exists
    const playerRaw = await extractPageJson(page, "ytInitialPlayerResponse");
    if (playerRaw) {
      const player = JSON.parse(playerRaw);
      if (player.playabilityStatus?.status === "ERROR") {
        emitError("VIDEO_UNAVAILABLE", player.playabilityStatus?.reason || "Video unavailable");
      }
    }

    // If sort=new, we need to wait for comments to load then click sort button
    // For now: scroll to trigger comment loading (default "Top" sort)
    log("Scrolling to trigger comment loading...");

    // Scroll gradually to simulate human behavior
    for (let i = 1; i <= 8; i++) {
      await page.evaluate((px) => window.scrollTo(0, px), i * 200);
      await delay(600);
    }

    // Wait for first comment batch to arrive
    const waitStart = Date.now();
    while (
      nextResponses.filter((r) => {
        const mutations = r.frameworkUpdates?.entityBatchUpdate?.mutations || [];
        return mutations.some((m) => m.payload?.commentEntityPayload);
      }).length === 0 &&
      Date.now() - waitStart < 20000
    ) {
      await delay(1000);
      // Keep scrolling
      const currentScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate((px) => window.scrollTo(0, px), currentScroll + 300);
    }

    if (nextResponses.length === 0) {
      log("No next responses captured yet. Waiting more...");
      await delay(5000);
    }

    // If sort=new, find and click the sort button
    if (sortBy === "new") {
      log('Attempting to switch to "Newest first" sort...');
      try {
        // The sort button typically appears after comments load
        await page.waitForSelector('yt-sort-filter-sub-menu-renderer', { timeout: 10000 });
        await page.evaluate(() => {
          const sortBtn = document.querySelector('yt-sort-filter-sub-menu-renderer button');
          if (sortBtn) sortBtn.click();
        });
        await delay(1500);

        // Click "Newest first" in the dropdown
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer'));
          const newestItem = items.find((el) =>
            el.textContent?.toLowerCase().includes("newest")
          );
          if (newestItem) newestItem.click();
        });
        await delay(2000);
        log("Sort switched to Newest first");
        // Clear responses and re-capture
        nextResponses.length = 0;
        // Re-scroll to trigger new load
        for (let i = 0; i < 5; i++) {
          await page.evaluate((px) => window.scrollTo(0, px), (i + 3) * 200);
          await delay(500);
        }
        await delay(3000);
      } catch (e) {
        log(`Sort switch failed (may not be supported): ${e.message}`);
      }
    }

    // Collect and deduplicate all comments
    const seenIds = new Set();
    const allComments = [];
    let totalComments = null;
    let hasMore = false;

    // Process all captured responses
    for (const responseData of nextResponses) {
      const result = processNextResponse(responseData);
      for (const comment of result.orderedComments) {
        if (!comment?.id || seenIds.has(comment.id)) continue;
        seenIds.add(comment.id);
        allComments.push(comment);
      }
      if (result.totalComments !== null && totalComments === null) {
        totalComments = result.totalComments;
      }
    }

    log(`After initial load: ${allComments.length} unique comments`);

    // Paginate by continuing to scroll if we need more
    let scrollAttempts = 0;
    const maxScrollAttempts = 30;
    let noNewDataCount = 0;

    while (allComments.length < maxComments && scrollAttempts < maxScrollAttempts) {
      scrollAttempts++;
      const prevResponseCount = nextResponses.length;
      const prevCommentCount = allComments.length;

      // Scroll further down
      const currentScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate((px) => window.scrollTo(0, px), currentScroll + 500);
      await delay(2000);

      // Process new responses
      if (nextResponses.length > prevResponseCount) {
        for (let i = prevResponseCount; i < nextResponses.length; i++) {
          const result = processNextResponse(nextResponses[i]);
          for (const comment of result.orderedComments) {
            if (!comment?.id || seenIds.has(comment.id)) continue;
            seenIds.add(comment.id);
            allComments.push(comment);
          }
        }

        if (allComments.length > prevCommentCount) {
          noNewDataCount = 0;
          log(`Scroll ${scrollAttempts}: ${allComments.length} unique comments`);
        } else {
          noNewDataCount++;
        }
      } else {
        noNewDataCount++;
      }

      // Stop if 4 consecutive scrolls yield no new comments
      if (noNewDataCount >= 4) {
        log(`${noNewDataCount} consecutive scrolls with no new comments — stopping`);
        hasMore = allComments.length < (totalComments || Infinity);
        break;
      }
    }

    if (allComments.length >= maxComments) {
      hasMore = allComments.length < (totalComments || allComments.length);
    }

    const finalComments = allComments.slice(0, maxComments);

    log(`\nFinal result:`);
    log(`  Total comments on video: ${totalComments ?? "unknown"}`);
    log(`  Collected: ${finalComments.length}`);
    log(`  Has more: ${hasMore}`);

    emitResult({
      videoId,
      videoUrl: watchUrl,
      totalComments,
      comments: finalComments,
      meta: {
        returned: finalComments.length,
        hasMore,
        sortedBy: sortBy,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
