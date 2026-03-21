#!/usr/bin/env node
/**
 * Twitter/X Profile Scraper
 *
 * Fetches a public Twitter/X profile along with recent tweets.
 * No login required for public profiles.
 *
 * Strategy:
 *   1. Navigate to x.com/@username with camoufox (fingerprinted browser)
 *   2. Intercept GraphQL calls to UserByScreenName + UserTweets endpoints
 *   3. Parse user profile + extract tweets from timeline
 *
 * Usage:
 *   node twitter-profile.mjs <username> [maxTweets]
 *
 * Examples:
 *   node twitter-profile.mjs elonmusk 20
 *   node twitter-profile.mjs NASA 10
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - profile: id, username, name, bio, followers, following, tweets count, etc.
 *   - tweets[]: recent tweets with text, likes, retweets, views, media, etc.
 *   - meta: tweetsReturned, hasMore, nextCursor
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createTwBrowser,
  createTwContext,
  bootstrapTwitter,
  callTwitterAPI,
  parseUser,
  extractTimelineEntries,
  getUserTimelineInstructions,
  setupInterception,
  BEARER_TOKEN,
  QUERY_IDS,
  USER_FEATURES,
  TWEET_FEATURES,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const username = args[0];
const maxTweets = parseInt(args[1] || "20", 10);

if (!username) {
  emitError("MISSING_ARG", "Usage: node twitter-profile.mjs <username> [maxTweets]");
}

// Strip leading @ if provided
const cleanUsername = username.replace(/^@/, "");

// ---------------------------------------------------------------------------
// Fetch user profile via API
// ---------------------------------------------------------------------------

async function fetchUserProfile(page, auth) {
  log(`[profile] Fetching profile for @${cleanUsername}...`);

  const data = await callTwitterAPI(page, {
    endpoint: "UserByScreenName",
    queryId: QUERY_IDS.UserByScreenName,
    variables: {
      screen_name: cleanUsername,
      withSafetyModeUserFields: true,
    },
    features: USER_FEATURES,
    bearerToken: BEARER_TOKEN,
    guestToken: auth.guestToken,
    csrfToken: auth.csrfToken,
  });

  if (!data) return null;

  // Navigate the response structure
  const userResult = data?.data?.user?.result;
  if (!userResult) {
    log("[profile] No user result in response");
    return null;
  }

  if (userResult.__typename === "UserUnavailable") {
    emitError("USER_UNAVAILABLE", `User @${cleanUsername} is not available (suspended or deleted)`);
  }

  return parseUser(userResult);
}

// ---------------------------------------------------------------------------
// Fetch tweets via API
// ---------------------------------------------------------------------------

async function fetchUserTweets(page, auth, userId, cursor = null, count = 20) {
  log(`[tweets] Fetching tweets for userId=${userId}, count=${count}${cursor ? ", with cursor" : ""}...`);

  const variables = {
    userId,
    count: Math.min(count, 40), // Twitter max per request
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
    ...(cursor ? { cursor } : {}),
  };

  const data = await callTwitterAPI(page, {
    endpoint: "UserTweets",
    queryId: QUERY_IDS.UserTweets,
    variables,
    features: TWEET_FEATURES,
    bearerToken: BEARER_TOKEN,
    guestToken: auth.guestToken,
    csrfToken: auth.csrfToken,
  });

  if (!data) return { tweets: [], nextCursor: null };

  const instructions =
    getUserTimelineInstructions(data?.data?.user?.result);

  const { tweets, nextCursor } = extractTimelineEntries(instructions);

  log(`[tweets] Extracted ${tweets.length} tweets, nextCursor: ${nextCursor ? "yes" : "no"}`);

  return { tweets, nextCursor };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching Twitter/X profile: @${cleanUsername}`);

  const browser = await createTwBrowser(Camoufox);

  try {
    const context = await createTwContext(browser);
    const page = await context.newPage();

    // Set up interception for fallback (in case direct API fails)
    const store = setupInterception(page, ["UserByScreenName", "UserTweets"]);

    // Bootstrap Twitter session (gets guest token + csrf token)
    const auth = await bootstrapTwitter(page);

    if (!auth.guestToken && !auth.csrfToken) {
      log("[auth] Warning: No auth tokens — API calls may fail");
    }

    // Navigate to the user profile page — this triggers UserByScreenName + UserTweets XHR calls
    // which we intercept. Also updates auth cookies.
    log(`[nav] Navigating to https://x.com/${cleanUsername}...`);
    try {
      await page.goto(`https://x.com/${cleanUsername}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (e) {
      log(`[nav] Navigation warning: ${e.message}`);
    }

    await delay(3000);

    // Check final page state
    const finalUrl = page.url();
    const title = await page.title();
    log(`[nav] Final URL: ${finalUrl}, Title: ${title}`);

    // Check for "not found" page
    if (title.includes("Page Not Found") || finalUrl.includes("/i/timeline")) {
      emitError("NOT_FOUND", `User @${cleanUsername} not found on X`);
    }

    // Primary: use intercepted data (most reliable — browser's own auth)
    let profile = null;
    let userId = null;

    const interceptedUser = await store.waitFor("UserByScreenName", 5000);
    if (interceptedUser) {
      const userResult = interceptedUser?.data?.user?.result;
      profile = parseUser(userResult);
      userId = profile?.id;
      log(`[profile] Got profile from intercept: ${profile?.name}`);
    }

    // Fallback: direct API call with captured auth tokens
    if (!profile) {
      log("[profile] Intercept missed, trying direct API call...");
      profile = await fetchUserProfile(page, auth);
      userId = profile?.id;
    }

    if (!profile) {
      emitError("NO_PROFILE", `Could not fetch profile for @${cleanUsername}`);
    }

    log(`[profile] Found: ${profile.name} (@${profile.username}), ${profile.followersCount} followers`);

    // Fetch tweets
    const allTweets = [];
    let nextCursor = null;
    let attempts = 0;
    const maxAttempts = Math.ceil(maxTweets / 20) + 1;

    // Primary: use intercepted tweet data
    let tweetData = { tweets: [], nextCursor: null };

    const interceptedTweets = await store.waitFor("UserTweets", 5000);
    if (interceptedTweets) {
      const instructions =
        getUserTimelineInstructions(interceptedTweets?.data?.user?.result);
      const { tweets, nextCursor: nc } = extractTimelineEntries(instructions);
      tweetData = { tweets, nextCursor: nc };
      log(`[tweets] Got ${tweets.length} tweets from intercept`);
    }

    // Fallback: direct API for first batch
    if (tweetData.tweets.length === 0) {
      log("[tweets] Intercept empty, trying direct API...");
      tweetData = await fetchUserTweets(page, auth, userId, null, Math.min(maxTweets, 40));
    }

    for (const t of tweetData.tweets) {
      if (allTweets.length < maxTweets) allTweets.push(t);
    }
    nextCursor = tweetData.nextCursor;

    // Paginate if needed
    while (allTweets.length < maxTweets && nextCursor && attempts < maxAttempts) {
      attempts++;
      await delay(2000);

      const more = await fetchUserTweets(
        page,
        auth,
        userId,
        nextCursor,
        Math.min(maxTweets - allTweets.length, 40)
      );

      let addedCount = 0;
      for (const t of more.tweets) {
        if (allTweets.length < maxTweets) {
          allTweets.push(t);
          addedCount++;
        }
      }

      nextCursor = more.nextCursor;
      log(`[tweets] Batch ${attempts}: added ${addedCount} tweets, total: ${allTweets.length}`);

      if (more.tweets.length === 0) break;
    }

    const finalTweets = allTweets.filter(Boolean);

    emitResult({
      username: cleanUsername,
      profile,
      tweets: finalTweets,
      meta: {
        tweetsReturned: finalTweets.length,
        hasMore: !!nextCursor,
        nextCursor: nextCursor || null,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log(`[fatal] ${err.stack || err.message}`);
  emitError("UNEXPECTED_ERROR", err.message);
});
