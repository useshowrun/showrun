#!/usr/bin/env node

/**
 * Facebook Comments Scraper
 *
 * Extracts comments from public Facebook posts.
 *
 * Strategy:
 *  1. Navigate to the Facebook post permalink page
 *  2. DOM extraction: parse [role="article"] elements for comment text, author, timestamp
 *  3. Optionally intercept GraphQL API calls for structured data (when cookies provided)
 *
 * Facebook renders a preview (~5-10 comments) for logged-out users in the SSR DOM.
 * For authenticated access (more comments, likes, profiles), set FB_COOKIES env var.
 *
 * Usage:
 *   node facebook-comments.mjs <post_url_or_id> [maxComments]
 *
 * Examples:
 *   node facebook-comments.mjs "https://www.facebook.com/natgeo/posts/pfbid..." 20
 *   node facebook-comments.mjs "https://www.facebook.com/photo/?fbid=123456789"
 *   node facebook-comments.mjs "https://www.facebook.com/permalink/story.php?story_fbid=123&id=456"
 *
 * Env vars:
 *   FB_COOKIES - JSON array of cookie objects for authenticated access
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createFbBrowser,
  createFbContext,
  extractSessionTokens,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const rawInput = process.argv[2];
const maxComments = parseInt(process.argv[3] || "20", 10);

if (!rawInput) {
  emitError(
    "MISSING_ARG",
    "Usage: node facebook-comments.mjs <post_url> [maxComments]\n" +
      "Example: node facebook-comments.mjs \"https://www.facebook.com/natgeo/posts/pfbid...\" 20"
  );
}

// Normalize the post URL
function normalizePostUrl(input) {
  // Already a full URL
  if (input.startsWith("http")) return input;

  // Just a pfbid shortcode — try to make it a posts URL
  if (/^pfbid[A-Za-z0-9]+$/.test(input)) {
    return `https://www.facebook.com/posts/${input}`;
  }

  // Numeric ID
  if (/^\d+$/.test(input)) {
    return `https://www.facebook.com/permalink/story.php?story_fbid=${input}`;
  }

  // page/posts/id format
  if (input.includes("/")) {
    return `https://www.facebook.com/${input}`;
  }

  return input;
}

const postUrl = normalizePostUrl(rawInput);

// ---------------------------------------------------------------------------
// Badge/role prefixes that appear before the commenter's name
// ---------------------------------------------------------------------------
const COMMENT_BADGES = [
  "Top fan",
  "Author",
  "Moderator",
  "Admin",
  "New member",
  "Highlighted",
];

// ---------------------------------------------------------------------------
// Parse comment from [role="article"] DOM element
//
// Comment article innerText structure:
//   [Badge (optional)]
//   {Commenter Name}
//   {Comment text (may be multi-line)}
//   {Time} (e.g., "5m", "2h", "3d", "Just now")
//   {Like count (optional, e.g. "5")}
//
// The aria-label on the containing region is:
//   "Comment by {Name} {time} ago"
// ---------------------------------------------------------------------------

async function extractCommentsFromDom(page, maxComments) {
  return page.evaluate((params) => {
    const { maxComments, COMMENT_BADGES } = params;
    const results = [];
    const seenIds = new Set();

    // Select [role="article"] elements — filter to leaf articles (comments)
    // vs the top-level article (the post itself)
    const allArticles = Array.from(
      document.querySelectorAll('[role="article"]')
    );

    // The top-level post article contains all comment articles as children
    // Leaf articles (no child articles) are individual comments
    const commentArticles = allArticles.filter((a) => {
      const innerCount = a.querySelectorAll('[role="article"]').length;
      return innerCount === 0;
    });

    for (const article of commentArticles) {
      if (results.length >= maxComments) break;

      const rawText = (article.innerText || "").trim();
      if (!rawText || rawText.length < 2) continue;

      // Parse lines
      const lines = rawText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);

      if (lines.length < 2) continue;

      // Handle badge prefix
      let nameLineIdx = 0;
      if (COMMENT_BADGES.some((b) => lines[0]?.startsWith(b))) {
        nameLineIdx = 1;
      }

      const name = lines[nameLineIdx] || null;
      if (!name || name.length > 100) continue; // Skip garbage entries

      // Find time marker: "5m", "2h", "1d", "3w", "Just now", "just now"
      // Time is usually the second-to-last or last non-digit line
      let timeText = null;
      let timeLineIdx = -1;

      for (let i = nameLineIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (
          /^\d+[mhdws]$/i.test(l) ||
          /^just now$/i.test(l) ||
          /^\d+\s+(minute|hour|day|week|month|year)s?\s+ago$/i.test(l)
        ) {
          timeText = l;
          timeLineIdx = i;
          break;
        }
      }

      // Comment text: everything between name and time
      const textStart = nameLineIdx + 1;
      const textEnd = timeLineIdx >= 0 ? timeLineIdx : lines.length;
      const commentText = lines.slice(textStart, textEnd).join("\n").trim();

      if (!commentText) continue;

      // Extract comment_id from links
      const commentLinks = Array.from(
        article.querySelectorAll('a[href*="comment_id="]')
      );
      let commentId = null;
      for (const link of commentLinks) {
        const href = link.getAttribute("href") || "";
        const m = href.match(/comment_id=(\d+)/);
        if (m) {
          commentId = m[1];
          break;
        }
      }

      // Skip duplicate comment IDs (same comment rendered twice)
      if (commentId && seenIds.has(commentId)) continue;
      if (commentId) seenIds.add(commentId);

      // Extract commenter profile URL (not the post URL, not the comment URL)
      let profileUrl = null;
      const allLinks = Array.from(article.querySelectorAll("a[href]"));
      for (const link of allLinks) {
        const href = link.getAttribute("href") || "";
        // Profile links: facebook.com/username or facebook.com/profile.php?id=...
        if (
          href.includes("facebook.com/") &&
          !href.includes("/posts/") &&
          !href.includes("/permalink/") &&
          !href.includes("/photo") &&
          !href.includes("/video") &&
          !href.includes("comment_id=") &&
          !href.includes("reaction_type=") &&
          !href.includes("/help/")
        ) {
          profileUrl = href.split("?")[0];
          break;
        }
      }

      // Like count (numeric suffix after time)
      let likeCount = null;
      if (timeLineIdx >= 0 && timeLineIdx + 1 < lines.length) {
        const after = lines[timeLineIdx + 1];
        if (/^\d+$/.test(after)) {
          likeCount = parseInt(after, 10);
        }
      }

      // Badge
      const badge =
        nameLineIdx > 0 ? lines.slice(0, nameLineIdx).join(" ") : null;

      results.push({
        id: commentId,
        name,
        text: commentText,
        timeText,
        profileUrl,
        likeCount,
        badge,
      });
    }

    return results;
  }, { maxComments, COMMENT_BADGES });
}

// ---------------------------------------------------------------------------
// Extract post info from DOM
// ---------------------------------------------------------------------------

async function extractPostInfo(page, postUrl) {
  return page.evaluate((postUrl) => {
    // Try to get post metadata from embedded JSON scripts
    const scripts = Array.from(
      document.querySelectorAll("script[type='application/json']")
    );

    let totalComments = null;
    let totalReactions = null;
    let totalShares = null;
    let postText = null;

    // Pattern: "X comments" in page text
    const bodyText = document.body.innerText || "";
    const commentMatch = bodyText.match(/(\d+)\s+comments?/i);
    if (commentMatch) totalComments = parseInt(commentMatch[1], 10);

    const reactMatch = bodyText.match(/All reactions:\s*(\d+)/i);
    if (reactMatch) totalReactions = parseInt(reactMatch[1], 10);

    const shareMatch = bodyText.match(/(\d+)\s+shares?/i);
    if (shareMatch) totalShares = parseInt(shareMatch[1], 10);

    // Post text: look for the main article (the one with child articles)
    const allArticles = Array.from(
      document.querySelectorAll('[role="article"]')
    );
    const mainArticle = allArticles.find((a) => {
      return a.querySelectorAll('[role="article"]').length > 0;
    });

    if (mainArticle) {
      // The post body text is the beginning before "All reactions"
      const articleText = mainArticle.innerText || "";
      const reactIdx = articleText.indexOf("All reactions");
      if (reactIdx > 0) {
        // Get lines from beginning
        const firstLines = articleText
          .substring(0, reactIdx)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l);
        // Skip page name and time at start
        postText = firstLines.slice(2).join("\n").trim() || null;
      }
    }

    // Page name
    const h1 = document.querySelector("h1, h2");
    const pageName = h1?.textContent?.trim() || null;

    // Try to get page name from title: "{Post text snippet} - {Page Name} | Facebook"
    const titleEl = document.querySelector("title");
    const titleText = titleEl?.textContent?.trim() || "";
    const titleMatch = titleText.match(/^.+\s+-\s+(.+?)\s+\|\s+Facebook$/);
    const pageNameFromTitle = titleMatch ? titleMatch[1] : null;

    return {
      postUrl,
      pageName: pageNameFromTitle || pageName,
      postText: postText ? postText.substring(0, 500) : null,
      totalComments,
      totalReactions,
      totalShares,
    };
  }, postUrl);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching comments for post: ${postUrl}`);
  log(`Max comments: ${maxComments}`);

  const browser = await createFbBrowser(Camoufox);

  try {
    const context = await createFbContext(browser);

    // Inject cookies if provided
    const cookiesJson = process.env.FB_COOKIES || null;
    let isAuthenticated = false;
    if (cookiesJson) {
      try {
        const cookies = JSON.parse(cookiesJson);
        const fbCookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || ".facebook.com",
          path: c.path || "/",
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? true,
          sameSite: c.sameSite || "None",
        }));
        await context.addCookies(fbCookies);
        isAuthenticated = true;
        log(`Loaded ${fbCookies.length} cookies from FB_COOKIES env`);
      } catch (e) {
        log(`Warning: Failed to parse FB_COOKIES: ${e.message}`);
      }
    }

    const page = await context.newPage();

    // Navigate to post
    log(`Navigating to ${postUrl}...`);
    let navigated = false;
    try {
      await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      navigated = true;
    } catch (e) {
      emitError("NAV_FAILED", `Failed to navigate to post: ${e.message}`);
    }

    log("Waiting for page content...");
    await delay(5000);

    const finalUrl = page.url();
    const pageTitle = await page.title();
    log(`Final URL: ${finalUrl}`);
    log(`Title: ${pageTitle}`);

    // Check for error conditions
    const bodyText = await page.evaluate(
      () => document.body.innerText.substring(0, 200)
    );
    if (
      pageTitle === "Facebook" &&
      finalUrl.includes("/login/") &&
      !isAuthenticated
    ) {
      emitError(
        "AUTH_REQUIRED",
        "Facebook requires login to view this post. Provide FB_COOKIES env var."
      );
    }

    if (
      bodyText.includes("This content isn't available") ||
      bodyText.includes("Sorry, this page isn't available")
    ) {
      emitError("NOT_FOUND", "Post not found or private");
    }

    // Extract post info
    log("Extracting post info...");
    const postInfo = await extractPostInfo(page, postUrl);
    log(
      `Post: ${postInfo.pageName}, ${postInfo.totalComments ?? "?"} comments, ${postInfo.totalReactions ?? "?"} reactions`
    );

    // Extract comments from DOM
    log("Extracting comments from DOM...");
    let comments = await extractCommentsFromDom(page, maxComments);
    log(`DOM extracted ${comments.length} comments`);

    // If we have fewer comments than expected and there are more,
    // try scrolling to load more comments
    const hasMoreComments =
      postInfo.totalComments != null &&
      postInfo.totalComments > comments.length;

    if (isAuthenticated && hasMoreComments && comments.length < maxComments) {
      log(
        `Scrolling to load more comments (have ${comments.length}/${postInfo.totalComments})...`
      );

      // Try clicking "View more comments" button
      const viewMoreText = [
        "View more comments",
        "View X more comments",
        "Most relevant",
        "See more comments",
      ];

      // Click the "Most relevant" dropdown first to switch to "All comments" if needed
      try {
        const mostRelevantBtn = await page.locator(
          'div[role="button"]:has-text("Most relevant")'
        );
        if (await mostRelevantBtn.count() > 0) {
          await mostRelevantBtn.first().click();
          await delay(500);
          // Look for "All comments" option
          const allCommentsBtn = await page.locator(
            'div[role="menuitem"]:has-text("All comments")'
          );
          if (await allCommentsBtn.count() > 0) {
            await allCommentsBtn.first().click();
            await delay(2000);
          }
        }
      } catch (e) {
        log(`Could not switch comment sort: ${e.message}`);
      }

      // Click "View more comments" buttons up to 3 times
      for (let attempt = 0; attempt < 3; attempt++) {
        let foundLoadMore = false;

        try {
          const loadMoreBtn = page.locator(
            'div[role="button"]:has-text("View more"), div[role="button"]:has-text("See more comments")'
          );
          if (await loadMoreBtn.count() > 0) {
            await loadMoreBtn.first().click();
            await delay(2000);
            foundLoadMore = true;
          }
        } catch (e) {
          log(`Load more click error: ${e.message}`);
        }

        if (!foundLoadMore) break;

        // Re-extract after loading more
        const moreComments = await extractCommentsFromDom(page, maxComments);
        if (moreComments.length > comments.length) {
          comments = moreComments;
          log(`Updated to ${comments.length} comments`);
        }

        if (comments.length >= maxComments) break;
      }
    }

    log(`Final: ${comments.length} comments`);

    emitResult({
      postUrl,
      finalUrl,
      postInfo,
      commentCount: postInfo.totalComments,
      commentsReturned: comments.length,
      hasMore:
        postInfo.totalComments != null &&
        postInfo.totalComments > comments.length,
      comments,
      isAuthenticated,
      meta: {
        note: isAuthenticated
          ? "Authenticated — may have more comments available."
          : "Without authentication, only ~5-10 top comments visible. Provide FB_COOKIES for full access.",
        source: "dom_extraction",
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
