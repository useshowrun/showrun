#!/usr/bin/env node
/**
 * Twitter/X Search Scraper
 *
 * Searches tweets by keyword, hashtag, or advanced query.
 *
 * Strategy:
 *   Twitter search requires a logged-in session for guest users.
 *   Two modes:
 *
 *   1. Authenticated mode (X_COOKIES env var): Inject cookies from a logged-in
 *      X session, then intercept the SearchTimeline GraphQL call from the search page.
 *      This is the reliable, full-featured mode.
 *
 *   2. Guest mode (no cookies): Twitter blocks search for guests. We try the
 *      SearchTimeline API anyway (may work if queryId is valid), but will likely
 *      return empty results. Consider using twitter-profile for user-specific tweets.
 *
 * X_COOKIES format (JSON array from browser cookie export):
 *   [{"name": "auth_token", "value": "...", "domain": ".x.com", ...}, ...]
 *   Use a browser extension like "EditThisCookie" or "Cookie-Editor" to export.
 *
 * Usage:
 *   node twitter-search.mjs <query> [maxTweets] [--mode latest|top] [--cursor <cursor>]
 *
 * Examples:
 *   X_COOKIES='[...]' node twitter-search.mjs "#SpaceX" 20 --mode latest
 *   X_COOKIES='[...]' node twitter-search.mjs "from:NASA mars" 10
 *   node twitter-search.mjs "OpenAI" 10  # guest mode, may return empty
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
  extractTimelineEntries,
  setupInterception,
  BEARER_TOKEN,
  QUERY_IDS,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);

  const query = args[0];
  if (!query) {
    emitError("MISSING_ARG", "Usage: node twitter-search.mjs <query> [maxTweets] [--mode latest|top] [--cursor <cursor>]");
  }

  const maxTweets = parseInt(args[1] || "20", 10);

  let mode = "Latest"; // "Latest" or "Top"
  let cursor = null;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) {
      const m = args[i + 1].toLowerCase();
      mode = m === "top" ? "Top" : "Latest";
      i++;
    } else if (args[i] === "--cursor" && args[i + 1]) {
      cursor = args[i + 1];
      i++;
    }
  }

  return { query, maxTweets, mode, cursor };
}

const config = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Search features (from observed browser requests)
// ---------------------------------------------------------------------------

const SEARCH_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  premium_content_api_read_enabled: false,
};

// ---------------------------------------------------------------------------
// Cookie injection (for authenticated access)
// ---------------------------------------------------------------------------

async function injectCookies(context, cookiesJson) {
  if (!cookiesJson) return false;

  try {
    const cookies = JSON.parse(cookiesJson);
    const xCookies = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || ".x.com",
      path: c.path || "/",
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || "None",
    }));
    await context.addCookies(xCookies);
    log(`[auth] Injected ${xCookies.length} cookies for authenticated access`);
    return true;
  } catch (e) {
    log(`[auth] Failed to parse X_COOKIES: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search via direct API call
// ---------------------------------------------------------------------------

async function searchViaDirect(page, auth, query, mode, cursor, count) {
  log(`[search] Direct API: "${query}", mode=${mode}, count=${count}`);

  const variables = {
    rawQuery: query,
    count: Math.min(count, 40),
    querySource: "typed_query",
    product: mode, // "Latest" or "Top"
    ...(cursor ? { cursor } : {}),
  };

  const data = await callTwitterAPI(page, {
    endpoint: "SearchTimeline",
    queryId: QUERY_IDS.SearchTimeline,
    variables,
    features: SEARCH_FEATURES,
    bearerToken: BEARER_TOKEN,
    guestToken: auth.guestToken,
    csrfToken: auth.csrfToken,
  });

  if (!data) return { tweets: [], nextCursor: null };

  const instructions =
    data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

  const { tweets, nextCursor } = extractTimelineEntries(instructions);
  log(`[search] Direct API: ${tweets.length} tweets`);

  return { tweets, nextCursor };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching Twitter/X: "${config.query}", max=${config.maxTweets}, mode=${config.mode}`);

  const cookiesJson = process.env.X_COOKIES || null;

  const browser = await createTwBrowser(Camoufox);

  try {
    const context = await createTwContext(browser);

    // Inject cookies for authenticated search
    const isAuthenticated = await injectCookies(context, cookiesJson);
    if (!isAuthenticated) {
      log("[auth] No X_COOKIES provided — search may return empty results (Twitter requires login)");
      log("[auth] Set X_COOKIES env var with your Twitter/X session cookies for full search access");
    }

    const page = await context.newPage();

    // Set up interception
    const store = setupInterception(page, ["SearchTimeline"]);

    // Get bootstrap auth (guest token, csrf)
    const auth = await bootstrapTwitter(page);

    // Navigate to search page — if authenticated, this will trigger SearchTimeline XHR
    const encodedQuery = encodeURIComponent(config.query);
    const tabParam = config.mode === "Top" ? "top" : "live";
    const searchUrl = `https://x.com/search?q=${encodedQuery}&src=typed_query&f=${tabParam}`;

    log(`[nav] Navigating to ${searchUrl}...`);
    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (e) {
      log(`[nav] Navigation warning: ${e.message}`);
    }

    await delay(4000);

    const title = await page.title();
    const finalUrl = page.url();
    log(`[nav] Title: ${title}, URL: ${finalUrl}`);

    const isLoginWall = title.includes("Log in") || finalUrl.includes("/login");
    if (isLoginWall && !isAuthenticated) {
      log("[nav] Login wall detected — search requires authentication");
      log("[nav] Provide X_COOKIES env var to bypass");
    }

    // Paginate results
    const allTweets = [];
    const seenIds = new Set();
    let cursor = config.cursor || null;
    let attempts = 0;
    const maxAttempts = Math.ceil(config.maxTweets / 20) + 3;

    // Try intercepted data first (works with authenticated session)
    let firstBatch = { tweets: [], nextCursor: null };

    if (isAuthenticated || !isLoginWall) {
      const intercepted = await store.waitFor("SearchTimeline", 6000);
      if (intercepted) {
        const instructions =
          intercepted?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
        const { tweets, nextCursor: nc } = extractTimelineEntries(instructions);
        firstBatch = { tweets, nextCursor: nc };
        log(`[search] Got ${tweets.length} tweets from intercepted SearchTimeline`);
      }
    }

    // Fallback: try direct API call
    if (firstBatch.tweets.length === 0) {
      log("[search] Intercepted empty, trying direct API...");
      firstBatch = await searchViaDirect(
        page,
        auth,
        config.query,
        config.mode,
        cursor,
        Math.min(config.maxTweets, 40)
      );
    }

    for (const t of firstBatch.tweets) {
      if (t && t.id && !seenIds.has(t.id) && allTweets.length < config.maxTweets) {
        seenIds.add(t.id);
        allTweets.push(t);
      }
    }
    cursor = firstBatch.nextCursor;

    // Paginate for more (only if authenticated — guest won't have cursor anyway)
    while (allTweets.length < config.maxTweets && cursor && attempts < maxAttempts) {
      attempts++;
      await delay(2500);

      const batch = await searchViaDirect(
        page,
        auth,
        config.query,
        config.mode,
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
      log(`[search] Batch ${attempts}: added ${added}, total ${allTweets.length}`);

      if (!cursor || batch.tweets.length === 0) break;
    }

    emitResult({
      query: config.query,
      mode: config.mode,
      isAuthenticated,
      tweets: allTweets,
      meta: {
        tweetsReturned: allTweets.length,
        hasMore: !!cursor,
        nextCursor: cursor || null,
        note: !isAuthenticated
          ? "Search requires X_COOKIES for full access. Set X_COOKIES env var with your Twitter/X session cookies."
          : undefined,
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
