#!/usr/bin/env node

/**
 * TikTok Comments Scraper
 *
 * Fetches comments from any public TikTok video.
 * No login required for public videos.
 *
 * Strategy:
 *   1. Navigate to the video page with camoufox (fingerprinted browser)
 *   2. Dismiss any modal overlays (cookie consent / CAPTCHA popups via Escape)
 *   3. JS-click the comment-icon to open the comments panel
 *   4. Intercept /api/comment/list/ API responses automatically triggered by TikTok
 *   5. Scroll the DivCommentMain container to paginate (cursor-based)
 *
 * Usage:
 *   node tiktok-comments.mjs <videoUrl|videoId> [--max <N>]
 *
 * Examples:
 *   node tiktok-comments.mjs "https://www.tiktok.com/@natgeo/video/7619347232646597901"
 *   node tiktok-comments.mjs 7619347232646597901 --max 100
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
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let videoInput = null;
let maxComments = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxComments = parseInt(args[i + 1], 10);
    i++;
  } else if (!videoInput) {
    videoInput = args[i];
  }
}

if (!videoInput) {
  emitError(
    "MISSING_ARG",
    "Usage: node tiktok-comments.mjs <videoUrl|videoId> [--max <N>]"
  );
}

// ---------------------------------------------------------------------------
// Parse video input
// ---------------------------------------------------------------------------

function parseVideoInput(input) {
  // Pure numeric ID
  if (/^\d+$/.test(input.trim())) {
    return { videoId: input.trim(), videoUrl: null };
  }

  // Full URL: https://www.tiktok.com/@username/video/1234567890
  const match = input.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/);
  if (match) {
    return { videoId: match[1], videoUrl: input };
  }

  // Generic: https://www.tiktok.com/video/1234567890
  const genericMatch = input.match(/tiktok\.com\/video\/(\d+)/);
  if (genericMatch) {
    return { videoId: genericMatch[1], videoUrl: input };
  }

  // Short URL: vm.tiktok.com or tiktok.com/t/
  if (input.includes("vm.tiktok.com") || input.includes("tiktok.com/t/")) {
    return { videoId: null, videoUrl: input };
  }

  emitError(
    "INVALID_INPUT",
    `Cannot parse TikTok video URL or ID from: ${input}`
  );
}

const { videoId: parsedId, videoUrl: parsedUrl } = parseVideoInput(videoInput);

// ---------------------------------------------------------------------------
// Parse comment object from TikTok API
// ---------------------------------------------------------------------------

function parseComment(comment) {
  if (!comment) return null;

  const user = comment.user || {};
  const avatarUrl =
    user.avatar_thumb?.url_list?.[0] ||
    user.avatar_medium?.url_list?.[0] ||
    null;

  return {
    id: comment.cid || comment.comment_id || null,
    text: comment.text || "",
    likeCount: comment.digg_count ?? 0,
    replyCount: comment.reply_comment_total ?? 0,
    createTime: comment.create_time
      ? new Date(comment.create_time * 1000).toISOString()
      : null,
    author: {
      id: user.uid || user.id || null,
      uniqueId: user.unique_id || user.uniqueId || null,
      nickname: user.nickname || null,
      avatarUrl,
      isVerified: user.custom_verify ? true : (user.verified ?? false),
    },
    isPinned: comment.is_pin ?? false,
  };
}

// ---------------------------------------------------------------------------
// Scroll comment panel to trigger pagination
// ---------------------------------------------------------------------------

async function scrollCommentPanel(page) {
  await page.evaluate(() => {
    // TikTok's comment panel is inside DivCommentMain — scroll it to bottom
    const commentPanel =
      document.querySelector('[class*="DivCommentMain"]') ||
      document.querySelector('[id="column-list-container"]') ||
      document.querySelector('[class*="comment-list"]') ||
      document.querySelector('[class*="CommentMain"]');

    if (commentPanel) {
      commentPanel.scrollTop = commentPanel.scrollHeight;
    }

    // Also trigger window scroll
    window.scrollTo(0, document.body.scrollHeight);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching TikTok comments for: ${videoInput} (max: ${maxComments})`);

  const browser = await createTTBrowser(Camoufox);

  try {
    const context = await createTTContext(browser);
    const page = await context.newPage();

    // Intercept /api/comment/list/ responses
    const rawCommentPages = [];
    let totalComments = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/comment/list/")) {
        try {
          const data = await response.json();
          rawCommentPages.push(data);
          log(
            `Comment page: cursor=${data.cursor} hasMore=${data.has_more} count=${data.comments?.length || 0}`
          );
          if (totalComments === null && data.total !== undefined) {
            totalComments = data.total;
          }
        } catch (e) {
          log("Failed to parse comment/list:", e.message);
        }
      }
    });

    // Build navigation URL
    let videoUrl = parsedUrl;
    let videoId = parsedId;
    if (!videoUrl && videoId) {
      // Note: TikTok /video/ID without username usually hits 404.
      // Best practice is to pass the full URL with @username.
      // We try anyway in case the video redirects properly.
      videoUrl = `https://www.tiktok.com/video/${videoId}`;
    }

    // Navigate
    log(`Navigating to: ${videoUrl}`);
    try {
      await page.goto(videoUrl, { waitUntil: "networkidle", timeout: 45000 });
    } catch (e) {
      log(`Navigation warning: ${e.message}`);
    }

    await delay(3000);

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    // Check for unavailable / private pages
    const pageText = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");

    if (
      finalUrl.includes("/accounts/login") ||
      pageText.includes("Video unavailable") ||
      pageText.includes("This video is unavailable") ||
      pageText.includes("wasn't available")
    ) {
      emitError("NOT_FOUND", `Video not found or unavailable: ${videoInput}`);
    }

    // Extract video ID from final URL if needed
    if (!videoId) {
      const m = finalUrl.match(/\/video\/(\d+)/);
      if (m) {
        videoId = m[1];
        log(`Extracted video ID: ${videoId}`);
      }
    }

    // Dismiss modal overlays (TikTok shows a CAPTCHA puzzle on first load)
    log("Dismissing modal overlays...");
    await page.keyboard.press("Escape");
    await delay(500);

    const hasModal = await page
      .evaluate(
        () =>
          !!document.querySelector(
            '.TUXModal-overlay[data-transition-status="open"]'
          )
      )
      .catch(() => false);

    if (hasModal) {
      await page.mouse.click(10, 10);
      await delay(300);
      await page.keyboard.press("Escape");
      await delay(300);
    }

    // JS-click the comment icon to open the comments panel
    log("Opening comments panel via JS click...");
    await page.evaluate(() => {
      const el =
        document.querySelector('[data-e2e="comment-icon"]') ||
        document.querySelector('[data-e2e="comment-count"]');
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Wait for first comment page
    log("Waiting for first comment batch...");
    const waitStart = Date.now();
    while (rawCommentPages.length === 0 && Date.now() - waitStart < 15000) {
      await delay(1000);
    }

    if (rawCommentPages.length === 0) {
      log("No comments received. Comments may be disabled.");
      emitResult({
        videoId: videoId || parsedId,
        videoUrl: finalUrl,
        totalComments: 0,
        comments: [],
        meta: {
          returned: 0,
          hasMore: false,
          cursor: null,
          note: "No comments — comments may be disabled or this is a private video",
        },
      });
      return;
    }

    // Collect comments with deduplication
    const seen = new Set();
    const allComments = [];
    let lastCursor = null;
    let hasMore = false;
    let processedPageCount = 0;

    function processNewPages() {
      for (let i = processedPageCount; i < rawCommentPages.length; i++) {
        const pageData = rawCommentPages[i];
        for (const c of pageData.comments || []) {
          const parsed = parseComment(c);
          if (!parsed) continue;
          if (parsed.id && seen.has(parsed.id)) continue; // skip duplicates
          if (parsed.id) seen.add(parsed.id);
          allComments.push(parsed);
        }
        lastCursor = pageData.cursor?.toString() || null;
        hasMore = pageData.has_more === 1 || pageData.has_more === true;
        if (pageData.total !== undefined) totalComments = pageData.total;
      }
      processedPageCount = rawCommentPages.length;
    }

    processNewPages();
    log(`Initial: ${allComments.length} unique comments, hasMore: ${hasMore}`);

    // Pagination: scroll the comment panel to trigger more loads
    let scrollAttempts = 0;
    const maxScrollAttempts = 20;
    let noNewPagesCount = 0;

    while (
      allComments.length < maxComments &&
      hasMore &&
      scrollAttempts < maxScrollAttempts
    ) {
      scrollAttempts++;
      const prevRawCount = rawCommentPages.length;

      await scrollCommentPanel(page);
      await delay(2500);

      if (rawCommentPages.length > prevRawCount) {
        processNewPages();
        noNewPagesCount = 0;
        log(
          `Scroll ${scrollAttempts}: ${allComments.length} unique comments, cursor=${lastCursor}`
        );
      } else {
        noNewPagesCount++;
        log(
          `Scroll ${scrollAttempts}: no new pages (${noNewPagesCount}/3 strikes)`
        );
        if (noNewPagesCount >= 3) {
          log("3 consecutive scrolls with no new pages, stopping");
          break;
        }
      }
    }

    const finalComments = allComments.slice(0, maxComments);

    emitResult({
      videoId,
      videoUrl: finalUrl,
      totalComments: totalComments ?? finalComments.length,
      comments: finalComments,
      meta: {
        returned: finalComments.length,
        hasMore: finalComments.length < allComments.length || hasMore,
        cursor: lastCursor,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
