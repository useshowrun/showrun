#!/usr/bin/env node

/**
 * Instagram Posts Scraper
 *
 * Fetches recent posts from a public Instagram profile.
 * Returns up to 12 posts per page (limited by the unauthenticated API).
 *
 * Usage:
 *   node instagram-posts.mjs <username> [maxPosts]
 *
 * Examples:
 *   node instagram-posts.mjs natgeo 12
 *   node instagram-posts.mjs nasa 12
 *
 * Note:
 *   Without login, the API returns the most recent 12 posts only.
 *   The `maxPosts` parameter is clamped to 12 for unauthenticated access.
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
  initSession,
  igFetch,
  parsePostNode,
  loadAuthCookies,
  IG_HOME,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const username = process.argv[2];
const maxPosts = Math.min(parseInt(process.argv[3] || "12", 10), 12); // API limit without login

if (!username) {
  emitError(
    "MISSING_ARG",
    "Usage: node instagram-posts.mjs <username> [maxPosts]"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching posts for @${username} (max: ${maxPosts})`);

  const browser = await createIgBrowser(Camoufox);

  try {
    const context = await createIgContext(browser);

    // Load authentication cookies (IG_COOKIES env → session file → logged-out)
    const isAuthenticated = await loadAuthCookies(context);

    const page = await context.newPage();

    log("Initializing session...");
    const csrf = await initSession(context, page);
    log(`Session ready. CSRF: ${csrf.substring(0, 8)}... Authenticated: ${isAuthenticated}`);

    await delay(1500);

    // Fetch profile which includes posts
    log(`Fetching posts via profile API...`);
    const profileUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const profileResp = await igFetch(page, profileUrl, csrf, IG_HOME);

    if (profileResp.status !== 200) {
      if (profileResp.status === 404) {
        emitError("NOT_FOUND", `User @${username} not found`);
      }
      if (profileResp.status === 401 || profileResp.status === 403) {
        emitResult({
          error: true,
          code: "SESSION_EXPIRED",
          message: "Instagram session expired or invalid. Re-run instagram-login to authenticate.",
          instruction: "node instagram-login/scripts/instagram-login.mjs",
        });
        process.exit(1);
      }
      emitError(
        "API_ERROR",
        `Profile API returned ${profileResp.status}: ${profileResp.text.substring(0, 200)}`
      );
    }

    const user = profileResp.json?.data?.user;
    if (!user) {
      emitError("NO_DATA", `No user data returned for @${username}`);
    }

    log(`Profile: ${user.full_name} (@${user.username})`);

    // Extract posts from the profile response
    const timelineEdges = user.edge_owner_to_timeline_media?.edges || [];
    const totalPostCount = user.edge_owner_to_timeline_media?.count || 0;

    const posts = timelineEdges
      .slice(0, maxPosts)
      .map((e) => parsePostNode(e.node))
      .filter(Boolean);

    log(`Extracted ${posts.length} posts (total: ${totalPostCount})`);

    emitResult({
      username: user.username,
      userId: user.id,
      posts,
      meta: {
        totalPosts: totalPostCount,
        postsReturned: posts.length,
        authenticated: isAuthenticated,
        note: isAuthenticated
          ? "Authenticated — full data available"
          : "Logged-out mode — limited to 12 most recent posts. Run instagram-login for full access.",
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
