#!/usr/bin/env node

/**
 * Instagram Comments Scraper
 *
 * Fetches comments from a public Instagram post or reel.
 * Accepts a post shortcode or full URL.
 *
 * Strategy:
 *  1. Navigate to the post page with camoufox (Firefox anti-detect)
 *  2. Intercept XHR/fetch calls to Instagram's comments API (works when logged in)
 *  3. DOM extraction: walk up 5 levels from <time datetime> elements and parse
 *     innerText, which has format: "{username}\n \n{timeago}\n{comment text}"
 *
 * Usage:
 *   node instagram-comments.mjs <shortcode_or_url> [maxComments]
 *
 * Examples:
 *   node instagram-comments.mjs C1234567890
 *   node instagram-comments.mjs https://www.instagram.com/p/C1234567890/
 *   node instagram-comments.mjs https://www.instagram.com/reel/C1234567890/
 *   node instagram-comments.mjs C1234567890 50
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Limitations:
 *   - Without login, Instagram renders ~12-16 comments in the page DOM
 *   - Set IG_COOKIES env var (JSON array) for full comment access via API
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createIgBrowser,
  createIgContext,
  initSession,
  igFetch,
  loadAuthCookies,
  IG_HOME,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

let input = process.argv[2];
const maxComments = parseInt(process.argv[3] || "24", 10);

if (!input) {
  emitError(
    "MISSING_ARG",
    "Usage: node instagram-comments.mjs <shortcode_or_url> [maxComments]"
  );
}

// Extract shortcode from URL if given a full URL
let shortcode = input;
const urlMatch = input.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
if (urlMatch) {
  shortcode = urlMatch[2];
}

const postUrl = `https://www.instagram.com/p/${shortcode}/`;

// ---------------------------------------------------------------------------
// Parse a single comment node from API response (when logged in)
// ---------------------------------------------------------------------------

function parseCommentNode(node) {
  if (!node) return null;

  const replyCount =
    node.child_comment_count ?? node.preview_child_comments?.length ?? 0;

  const replies = (node.preview_child_comments || []).map((reply) => ({
    id: reply.pk || reply.id,
    text: reply.text,
    username: reply.user?.username || null,
    fullName: reply.user?.full_name || null,
    profilePicUrl: reply.user?.profile_pic_url || null,
    isVerified: reply.user?.is_verified ?? false,
    likeCount: reply.comment_like_count ?? reply.like_count ?? 0,
    createdAt: reply.created_at
      ? new Date(reply.created_at * 1000).toISOString()
      : null,
  }));

  return {
    id: node.pk || node.id,
    text: node.text,
    username: node.user?.username || null,
    fullName: node.user?.full_name || null,
    profilePicUrl: node.user?.profile_pic_url || null,
    isVerified: node.user?.is_verified ?? false,
    likeCount: node.comment_like_count ?? node.like_count ?? 0,
    createdAt: node.created_at
      ? new Date(node.created_at * 1000).toISOString()
      : null,
    replyCount,
    replies: replies.length > 0 ? replies : undefined,
  };
}

// ---------------------------------------------------------------------------
// DOM-based comment extraction — stable approach
//
// Instagram renders comments for logged-out users in the DOM.
// Each comment's <time datetime="..."> element is 5 levels below a container
// whose innerText follows the pattern:
//   "{username}\n \n{timeago}\n{comment text}\nLike\nReply"
//
// We walk up 5 levels from each <time> element and parse innerText.
// ---------------------------------------------------------------------------

async function extractCommentsFromDom(page) {
  return page.evaluate(() => {
    const results = [];
    const seenTexts = new Set(); // Dedup by full text to avoid parent container repeats

    const timeEls = Array.from(document.querySelectorAll("time[datetime]"));

    for (const timeEl of timeEls) {
      const datetime = timeEl.getAttribute("datetime");

      // Walk up exactly 5 levels
      let el = timeEl;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
      }
      if (!el) continue;

      const rawText = el.innerText?.trim() || "";

      // Skip if we've seen this exact text (happens with nested comment blocks)
      if (seenTexts.has(rawText) || rawText.length < 3) continue;
      seenTexts.add(rawText);

      // Split into lines, filter empty/space-only
      const lines = rawText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== " ");

      if (lines.length < 2) continue;

      // Line 0: username
      const username = lines[0];

      // Skip if looks like a UI element (e.g. "8.3K" likes counter)
      if (/^\d+(\.\d+)?[KMB]?$/.test(username) || username.includes("•")) {
        continue;
      }

      // Validate username (Instagram usernames: letters, digits, dots, underscores)
      if (!/^[a-z0-9._]+$/i.test(username)) {
        continue;
      }

      // Line 1: may be time or "Edited" — find the first line that looks like time
      let timeAgo = null;
      let commentStartIndex = 1;
      for (let j = 1; j < Math.min(4, lines.length); j++) {
        const l = lines[j];
        if (
          /^\d+[dwhmsy]$/i.test(l) || // "3d", "5h", "2w", "1m", "30s"
          /^\d+\s+(day|hour|minute|second|week|month)s?\s+ago$/i.test(l) ||
          l === "just now"
        ) {
          timeAgo = l;
          commentStartIndex = j + 1;
          break;
        }
        // Skip "Edited" and "•" lines
        if (l === "Edited" || l === "•" || l.startsWith("•")) continue;
        commentStartIndex = j;
        break;
      }

      // Comment text: everything from commentStartIndex until "Like", "Reply"
      const commentLines = [];
      for (let j = commentStartIndex; j < lines.length; j++) {
        const l = lines[j];
        // Stop at action words
        if (["Like", "Reply", "Translate", "See translation"].includes(l))
          break;
        // Stop at reply count lines
        if (/^View (all )?\d+ repl(y|ies)$/.test(l)) break;
        commentLines.push(l);
      }
      const commentText = commentLines.join("\n").trim();

      if (!commentText || !username) continue;

      results.push({
        id: null,
        text: commentText,
        username,
        fullName: null,
        profilePicUrl: null,
        isVerified: false,
        likeCount: null,
        createdAt: datetime,
        timeAgo,
        replyCount: null,
      });
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Try to get post info from API (doesn't require auth for basic data)
// ---------------------------------------------------------------------------

async function getPostInfo(page, csrf) {
  // Use the web_profile_info or similar to get post metadata
  // Actually the post page itself renders in the DOM
  return page.evaluate((shortcode) => {
    const scripts = Array.from(
      document.querySelectorAll("script[type='application/json']")
    );
    for (const s of scripts) {
      const text = s.textContent || "";
      if (text.includes(shortcode) || text.includes('"comment_count"')) {
        try {
          function search(obj, depth = 0) {
            if (!obj || typeof obj !== "object" || depth > 15) return null;
            if (
              (obj.shortcode === shortcode || obj.code === shortcode) &&
              (obj.comment_count != null || obj.like_count != null)
            ) {
              return obj;
            }
            for (const val of Object.values(obj)) {
              const found = search(val, depth + 1);
              if (found) return found;
            }
            return null;
          }
          const data = JSON.parse(text);
          const media = search(data);
          if (media) {
            return {
              id: media.id || media.pk,
              shortcode: media.shortcode || media.code || shortcode,
              type: media.__typename || media.media_type,
              caption:
                media.edge_media_to_caption?.edges?.[0]?.node?.text ||
                media.caption?.text ||
                null,
              likeCount:
                media.edge_liked_by?.count ?? media.like_count ?? null,
              commentCount:
                media.edge_media_to_parent_comment?.count ??
                media.comment_count ??
                null,
              ownerUsername:
                media.owner?.username || media.user?.username || null,
              takenAt: media.taken_at_timestamp
                ? new Date(media.taken_at_timestamp * 1000).toISOString()
                : media.taken_at
                ? new Date(media.taken_at * 1000).toISOString()
                : null,
            };
          }
        } catch {}
      }
    }
    return null;
  }, shortcode);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching comments for post: ${shortcode}`);
  log(`Post URL: ${postUrl}`);
  log(`Max comments: ${maxComments}`);

  const browser = await createIgBrowser(Camoufox);

  // Intercepted API responses (works when logged in via cookies)
  const interceptedComments = [];
  let interceptedMediaId = null;
  let interceptedCommentCount = null;
  let interceptedNextMinId = null;

  try {
    const context = await createIgContext(browser);

    // Load authentication cookies (IG_COOKIES env → session file → logged-out)
    const isAuthenticated = await loadAuthCookies(context);

    const page = await context.newPage();

    // Set up XHR/fetch interception for comments API (works when authenticated)
    await page.route("**/api/v1/media/*/comments/**", async (route) => {
      const response = await route.fetch();
      let text;
      try {
        text = await response.text();
      } catch {
        await route.continue();
        return;
      }

      try {
        const data = JSON.parse(text);
        if (data.comments) {
          log(
            `Intercepted comments API: ${(data.comments || []).length} comments`
          );

          const urlMatch = route
            .request()
            .url()
            .match(/\/media\/(\d+)\/comments/);
          if (urlMatch) interceptedMediaId = urlMatch[1];

          const parsed = (data.comments || [])
            .map(parseCommentNode)
            .filter(Boolean);
          interceptedComments.push(...parsed);

          if (data.comment_count) interceptedCommentCount = data.comment_count;
          if (data.next_min_id) interceptedNextMinId = data.next_min_id;
        }
      } catch (e) {
        log(`Failed to parse intercepted comments: ${e.message}`);
      }

      await route.fulfill({ response });
    });

    // Initialize session for CSRF
    log("Initializing session...");
    const csrf = await initSession(context, page);
    log(`Session ready. CSRF: ${csrf.substring(0, 8)}...`);

    await delay(1000);

    // Navigate to the post page — wrap in try/catch to handle invalid shortcodes gracefully
    // Instagram may auto-redirect /p/SHORTCODE to /reel/SHORTCODE for video posts
    log(`Navigating to ${postUrl}...`);
    try {
      await page.goto(postUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch (err) {
      // Navigation timeout or redirect loop — check where we ended up
      log(`Navigation warning: ${err.message}`);
    }

    // Wait for page to load and for any API calls to happen
    log("Waiting for page content...");
    await delay(4000);

    // Check final URL — Instagram may redirect /p/ → /reel/ for video posts
    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    // Check for error page — use safe evaluate
    let pageText = "";
    try {
      pageText = await page.evaluate(
        () => document.body?.innerText?.substring(0, 800) ?? ""
      );
    } catch {
      // Page may have navigated away or be blank
    }

    // Detect hard login wall: URL redirected to login page
    if (finalUrl.includes("/accounts/login/")) {
      emitResult({
        error: true,
        code: "SESSION_EXPIRED",
        message:
          "Instagram requires login to view this post. Run instagram-login to authenticate.",
        instruction: "node instagram-login/scripts/instagram-login.mjs",
        shortcode,
        postUrl,
      });
      process.exit(1);
    }

    // Detect 404 / deleted / private post
    // NOTE: Instagram always shows "Log in" / "Log In" links on every page for logged-out users.
    // Do NOT use "Log in" text as a detection signal — it's always present.
    // These error strings only appear when the post itself cannot be shown.
    if (
      pageText.includes("Sorry, this page") ||
      pageText.includes("Page Not Found") ||
      pageText.includes("Post isn't available") ||
      pageText.includes("This content isn't available") ||
      pageText.includes("The link may be broken, or the profile may have been removed")
    ) {
      emitResult({
        error: true,
        code: "NOT_FOUND",
        message: `Post ${shortcode} not found, was deleted, or is private`,
        shortcode,
        postUrl,
        finalUrl,
      });
      process.exit(1);
    }

    // Determine which source to use
    let finalComments = [];
    let source = "dom_extraction";

    if (interceptedComments.length > 0) {
      log(`Using ${interceptedComments.length} intercepted API comments`);
      finalComments = interceptedComments;
      source = "xhr_interception";
    } else {
      // DOM extraction — works for logged-out users
      log("Extracting comments from DOM...");
      finalComments = await extractCommentsFromDom(page);
      log(`DOM extracted ${finalComments.length} comments`);

      if (finalComments.length === 0) {
        // Try scrolling to trigger more DOM rendering
        await page.evaluate(() => window.scrollBy(0, 400));
        await delay(1500);
        finalComments = await extractCommentsFromDom(page);
        log(
          `DOM extracted (after scroll): ${finalComments.length} comments`
        );
      }
    }

    // Get post metadata from embedded JSON if available
    log("Extracting post info...");
    const postInfo = await getPostInfo(page, csrf);
    if (postInfo) {
      log(
        `Post info: ${postInfo.ownerUsername}, ${postInfo.commentCount} comments, ${postInfo.likeCount} likes`
      );
    }

    // Get comment count from DOM if not available
    let commentCount =
      interceptedCommentCount ?? postInfo?.commentCount ?? null;
    if (!commentCount) {
      commentCount = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll("span"));
        for (const span of spans) {
          const text = span.textContent?.trim() || "";
          if (/^\d[\d,]*\s+comments?$/i.test(text)) {
            return parseInt(text.replace(/[^0-9]/g, ""), 10);
          }
        }
        return null;
      });
    }

    // Limit to maxComments
    finalComments = finalComments.slice(0, maxComments);

    // Skip the first comment if it's the caption (post author)
    const postAuthor = postInfo?.ownerUsername;
    if (
      postAuthor &&
      finalComments.length > 0 &&
      finalComments[0].username === postAuthor
    ) {
      log(
        `Skipping first entry (caption by @${postAuthor}) — not a comment`
      );
      finalComments = finalComments.slice(1);
    }

    log(`Final: ${finalComments.length} comments`);

    emitResult({
      shortcode,
      postUrl,
      postInfo,
      commentCount,
      commentsReturned: finalComments.length,
      hasMore: interceptedNextMinId != null || (commentCount != null && commentCount > finalComments.length),
      nextMinId: interceptedNextMinId,
      comments: finalComments,
      meta: {
        note: isAuthenticated
          ? "Authenticated — full comments API access available."
          : "Logged-out mode — returns ~12-16 DOM-rendered comments. Run instagram-login for full API access.",
        source,
        authenticated: isAuthenticated,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
