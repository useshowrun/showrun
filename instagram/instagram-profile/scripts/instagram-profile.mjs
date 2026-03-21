#!/usr/bin/env node

/**
 * Instagram Profile Scraper
 *
 * Fetches a public Instagram profile along with the most recent posts.
 * Uses the Instagram web API (no login required for public profiles).
 *
 * Usage:
 *   node instagram-profile.mjs <username>
 *
 * Examples:
 *   node instagram-profile.mjs natgeo
 *   node instagram-profile.mjs nasa
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - Profile: id, username, fullName, biography, followerCount, followingCount,
 *              postCount, isVerified, isPrivate, profilePicUrl, externalUrl, etc.
 *   - posts[]: up to 12 most recent posts (images, videos, carousels)
 *     Each post: id, shortcode, url, type, takenAt, caption, hashtags,
 *                likeCount, commentCount, imageUrl, videoUrl, location, etc.
 *   - reels[]: up to 12 most recent reels
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
  parseProfileUser,
  parsePostNode,
  loadAuthCookies,
  IG_HOME,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const username = process.argv[2];

if (!username) {
  emitError(
    "MISSING_ARG",
    "Usage: node instagram-profile.mjs <username>"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching Instagram profile: @${username}`);

  const browser = await createIgBrowser(Camoufox);

  try {
    const context = await createIgContext(browser);

    // Load authentication cookies (IG_COOKIES env → session file → logged-out)
    const isAuthenticated = await loadAuthCookies(context);

    const page = await context.newPage();

    // Initialize session (gets cookies + CSRF token)
    log("Initializing session...");
    const csrf = await initSession(context, page);
    log(`Session ready. CSRF: ${csrf.substring(0, 8)}... Authenticated: ${isAuthenticated}`);

    await delay(1500);

    // Fetch profile data
    log(`Fetching profile for @${username}...`);
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

    const profileData = profileResp.json;
    if (!profileData?.data?.user) {
      emitError("NO_DATA", `No user data returned for @${username}`);
    }

    const user = profileData.data.user;
    log(`Found profile: ${user.full_name} (@${user.username}), ${user.edge_followed_by?.count || 0} followers`);

    // Parse profile
    const profile = parseProfileUser(user);

    // Parse posts (edge_owner_to_timeline_media contains up to 12 posts)
    const timelineEdges = user.edge_owner_to_timeline_media?.edges || [];
    const posts = timelineEdges
      .map((e) => parsePostNode(e.node))
      .filter(Boolean);

    log(`Extracted ${posts.length} posts from timeline`);

    // Parse reels (edge_felix_video_timeline contains up to 12 reels)
    const reelEdges = user.edge_felix_video_timeline?.edges || [];
    const reels = reelEdges
      .map((e) => parsePostNode(e.node))
      .filter(Boolean);

    log(`Extracted ${reels.length} reels`);

    // Emit result
    emitResult({
      username: profile.username,
      profile,
      posts,
      reels,
      meta: {
        postsTotal: profile.postCount,
        postsReturned: posts.length,
        reelsTotal: user.edge_felix_video_timeline?.count ?? null,
        reelsReturned: reels.length,
        authenticated: isAuthenticated,
        note: isAuthenticated
          ? "Authenticated — full data available"
          : "Logged-out mode — limited to 12 posts. Run instagram-login for full access.",
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
