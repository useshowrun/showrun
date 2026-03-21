#!/usr/bin/env node
/**
 * Twitter/X Tweets Scraper
 *
 * Paginates through a user's tweet timeline.
 * Supports cursor-based pagination for large accounts.
 * No login required for public profiles.
 *
 * Usage:
 *   node twitter-tweets.mjs <username> [maxTweets] [--cursor <cursor>] [--replies] [--retweets]
 *
 * Examples:
 *   node twitter-tweets.mjs NASA 50
 *   node twitter-tweets.mjs NASA 50 --cursor "DAABCgABF..." --replies --retweets
 *
 * Flags:
 *   --cursor <value>  Resume from a pagination cursor
 *   --replies         Include replies (default: exclude)
 *   --retweets        Include retweets (default: exclude)
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

function parseArgs(argv) {
  const args = argv.slice(2);

  const username = args[0];
  if (!username) {
    emitError("MISSING_ARG", "Usage: node twitter-tweets.mjs <username> [maxTweets] [--cursor <cursor>] [--replies] [--retweets]");
  }

  const maxTweets = parseInt(args[1] || "50", 10);

  let cursor = null;
  let includeReplies = false;
  let includeRetweets = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--cursor" && args[i + 1]) {
      cursor = args[i + 1];
      i++;
    } else if (args[i] === "--replies") {
      includeReplies = true;
    } else if (args[i] === "--retweets") {
      includeRetweets = true;
    }
  }

  return {
    username: username.replace(/^@/, ""),
    maxTweets,
    cursor,
    includeReplies,
    includeRetweets,
  };
}

const config = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchUserId(page, auth, username) {
  log(`[profile] Looking up userId for @${username}...`);

  const data = await callTwitterAPI(page, {
    endpoint: "UserByScreenName",
    queryId: QUERY_IDS.UserByScreenName,
    variables: {
      screen_name: username,
      withSafetyModeUserFields: true,
    },
    features: USER_FEATURES,
    bearerToken: BEARER_TOKEN,
    guestToken: auth.guestToken,
    csrfToken: auth.csrfToken,
  });

  const userResult = data?.data?.user?.result;
  if (!userResult) return null;

  if (userResult.__typename === "UserUnavailable") {
    emitError("USER_UNAVAILABLE", `User @${username} is not available`);
  }

  return parseUser(userResult);
}

async function fetchTweetsBatch(page, auth, userId, cursor, count) {
  const endpoint = config.includeReplies ? "UserTweetsAndReplies" : "UserTweets";
  const queryId = config.includeReplies
    ? QUERY_IDS.UserTweetsAndReplies || QUERY_IDS.UserTweets
    : QUERY_IDS.UserTweets;

  const variables = {
    userId,
    count: Math.min(count, 40),
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

  const instructions = getUserTimelineInstructions(data?.data?.user?.result);

  let { tweets, nextCursor } = extractTimelineEntries(instructions);

  // Filter based on flags
  if (!config.includeReplies) {
    tweets = tweets.filter((t) => !t.isReply);
  }
  if (!config.includeRetweets) {
    tweets = tweets.filter((t) => !t.isRetweet);
  }

  return { tweets, nextCursor };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching tweets for @${config.username}, max=${config.maxTweets}`);
  if (config.includeReplies) log("[config] Including replies");
  if (config.includeRetweets) log("[config] Including retweets");
  if (config.cursor) log(`[config] Starting from cursor`);

  const browser = await createTwBrowser(Camoufox);

  try {
    const context = await createTwContext(browser);
    const page = await context.newPage();

    // Bootstrap Twitter session
    const auth = await bootstrapTwitter(page);

    // Set up interception — page visit will trigger UserByScreenName + UserTweets calls
    const store = setupInterception(page, ["UserByScreenName", "UserTweets"]);

    // Navigate to user page to trigger page load (browser warms up auth cookies)
    log(`[nav] Navigating to https://x.com/${config.username}...`);
    try {
      await page.goto(`https://x.com/${config.username}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (e) {
      log(`[nav] Navigation warning: ${e.message}`);
    }
    await delay(3000);

    // Primary: get profile from intercepted data
    let profile = null;
    const interceptedUser = await store.waitFor("UserByScreenName", 5000);
    if (interceptedUser) {
      const userResult = interceptedUser?.data?.user?.result;
      profile = parseUser(userResult);
      log(`[profile] Got from intercept: ${profile?.name}`);
    }

    // Fallback: direct API call
    if (!profile) {
      profile = await fetchUserId(page, auth, config.username);
    }

    if (!profile) {
      emitError("NOT_FOUND", `Could not find user @${config.username}`);
    }

    log(`[profile] @${profile.username} (ID: ${profile.id}), ${profile.tweetsCount} total tweets`);

    // Paginate tweets
    const allTweets = [];
    const seenIds = new Set();
    let cursor = config.cursor || null;
    let attempts = 0;
    const maxAttempts = Math.ceil(config.maxTweets / 20) + 3;

    // First batch: try intercepted data
    let firstBatch = { tweets: [], nextCursor: null };
    if (!config.cursor) {
      const interceptedTweets = await store.waitFor("UserTweets", 5000);
      if (interceptedTweets) {
        const instructions =
          getUserTimelineInstructions(interceptedTweets?.data?.user?.result);
        let { tweets, nextCursor: nc } = extractTimelineEntries(instructions);

        // Apply filters
        if (!config.includeReplies) tweets = tweets.filter((t) => !t.isReply);
        if (!config.includeRetweets) tweets = tweets.filter((t) => !t.isRetweet);

        firstBatch = { tweets, nextCursor: nc };
        log(`[tweets] Got ${tweets.length} tweets from intercept`);
      }
    }

    if (firstBatch.tweets.length === 0) {
      // Fallback: direct API for first batch
      firstBatch = await fetchTweetsBatch(page, auth, profile.id, cursor, Math.min(config.maxTweets, 40));
    }

    for (const t of firstBatch.tweets) {
      if (t && t.id && !seenIds.has(t.id) && allTweets.length < config.maxTweets) {
        seenIds.add(t.id);
        allTweets.push(t);
      }
    }
    cursor = firstBatch.nextCursor;

    // Continue paginating if needed
    while (allTweets.length < config.maxTweets && cursor && attempts < maxAttempts) {
      attempts++;
      await delay(2500);

      const batch = await fetchTweetsBatch(
        page,
        auth,
        profile.id,
        cursor,
        Math.min(config.maxTweets - allTweets.length, 40)
      );

      let added = 0;
      for (const t of batch.tweets) {
        if (t && t.id && !seenIds.has(t.id) && allTweets.length < config.maxTweets) {
          seenIds.add(t.id);
          allTweets.push(t);
          added++;
        }
      }

      cursor = batch.nextCursor;
      log(`[tweets] Batch ${attempts}: added ${added}, total ${allTweets.length}, hasMore: ${!!cursor}`);

      if (!cursor || batch.tweets.length === 0) break;
    }

    emitResult({
      username: config.username,
      userId: profile.id,
      tweets: allTweets,
      meta: {
        tweetsReturned: allTweets.length,
        hasMore: !!cursor,
        nextCursor: cursor || null,
        includeReplies: config.includeReplies,
        includeRetweets: config.includeRetweets,
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
