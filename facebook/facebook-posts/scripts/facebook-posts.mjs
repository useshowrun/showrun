#!/usr/bin/env node
/**
 * Facebook Posts Scraper
 *
 * Extracts posts from public Facebook pages/profiles using browser automation.
 *
 * Strategy:
 *   1. Navigate to facebook.com/<username>/posts (bypasses login redirect)
 *   2. Parse embedded Relay/GraphQL JSON fragments from SSR HTML
 *   3. Extract: profile info + posts (1 post available without login)
 *   4. Optionally attempt GraphQL API for more posts using logged-out session token
 *
 * Limitations without login:
 *   - Only ~1 post available in SSR data (Facebook limits logged-out feed)
 *   - Profile metadata is fully available
 *   - Provide FB_COOKIES env var for authenticated access (see SKILL.md)
 *
 * Usage:
 *   node facebook-posts.mjs <username_or_url> [maxPosts]
 *
 * Examples:
 *   node facebook-posts.mjs natgeo 5
 *   node facebook-posts.mjs https://www.facebook.com/cern 10
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
  extractRelayData,
  extractSessionTokens,
  parseStoryNode,
  parseProfileData,
  extractFollowerCounts,
  extractPageHeaderDom,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const MAX_RETRY_COUNT = 3;

// Timeline feed query doc_id (from Facebook's SSR query variables)
// This may change over time - extracted from adp_ProfileCometTimelineFeedQueryRelayPreloader
const TIMELINE_FEED_DOC_ID = "26666278842978176";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const raw = args[0] || "";
  if (!raw) {
    emitError("MISSING_ARG", "Usage: facebook-posts.mjs <username_or_url> [maxPosts]");
  }

  // Extract username from URL or use as-is
  let username = raw;
  if (raw.includes("facebook.com/")) {
    const parts = raw.replace(/https?:\/\//, "").split("/");
    const fbIdx = parts.findIndex((p) => p.includes("facebook.com"));
    username = parts[fbIdx + 1] || raw;
  }
  // Remove trailing slash and query params
  username = username.replace(/[/?].*$/, "").trim();

  const maxPosts = parseInt(args[1] || "10", 10);

  return { username, maxPosts };
}

// ---------------------------------------------------------------------------
// Cookie injection (for authenticated access)
// ---------------------------------------------------------------------------

async function injectCookies(context, cookiesJson) {
  if (!cookiesJson) return false;

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
    log(`[auth] Injected ${fbCookies.length} cookies for authenticated access`);
    return true;
  } catch (e) {
    log(`[auth] Failed to parse FB_COOKIES: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile URL resolution
// ---------------------------------------------------------------------------

/**
 * Navigate to the page and handle common cases:
 * - Direct URL works → return
 * - Redirected to login → try /posts path
 */
async function navigateToPage(page, username) {
  const postsUrl = `https://www.facebook.com/${username}/posts`;

  log(`[nav] Navigating to ${postsUrl}`);

  try {
    await page.goto(postsUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
  } catch (e) {
    log(`[nav] Navigation error: ${e.message}`);
    throw new Error(`Failed to navigate to Facebook page: ${e.message}`);
  }

  // Wait for page to stabilize
  await delay(5000);

  const finalUrl = page.url();
  const title = await page.title();

  log(`[nav] Final URL: ${finalUrl}`);
  log(`[nav] Title: ${title}`);

  // Check if we're on the login page
  if (finalUrl.includes("/login/") || title === "Facebook") {
    // Try without /posts
    log(`[nav] Hit login wall, trying base URL`);
    try {
      await page.goto(`https://www.facebook.com/${username}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await delay(3000);
    } catch (e) {
      log(`[nav] Base URL also failed: ${e.message}`);
    }
  }

  return {
    finalUrl: page.url(),
    title: await page.title(),
  };
}

// ---------------------------------------------------------------------------
// Main post extraction from Relay SSR data
// ---------------------------------------------------------------------------

async function extractPostsFromRelay(relayEntries, username) {
  const posts = [];

  for (const entry of relayEntries) {
    const result = entry.bbox?.result;
    if (!result) continue;

    // Look for timeline feed data
    if (!entry.name?.includes("TimelineFeed")) continue;

    const data = result.data;
    const user = data?.user;

    if (!user?.timeline_list_feed_units?.edges) continue;

    const edges = user.timeline_list_feed_units.edges;
    log(`[relay] Found ${edges.length} post edge(s) in relay data`);

    for (const edge of edges) {
      const node = edge.node;
      if (!node || node.__typename !== "Story") continue;

      // Skip sponsored posts
      if (node.sponsored_data) {
        log("[relay] Skipping sponsored post");
        continue;
      }

      const parsed = parseStoryNode(node, username);
      if (parsed) {
        posts.push(parsed);
        log(`[relay] Extracted post: ${parsed.postId || parsed.storyId}`);
      }
    }
  }

  return posts;
}

// ---------------------------------------------------------------------------
// GraphQL API call for more posts (uses logged-out session token)
// ---------------------------------------------------------------------------

async function fetchMorePostsViaGraphQL(page, { userId, lsd, cursor, count }) {
  log(`[graphql] Fetching ${count} posts via GraphQL API (cursor: ${cursor ? "yes" : "none"})`);

  const variables = {
    count,
    feedbackSource: 0,
    feedLocation: "TIMELINE",
    omitPinnedPost: true,
    privacySelectorRenderLocation: "COMET_STREAM",
    renderLocation: "timeline",
    scale: 1,
    stream_count: 1,
    userID: userId,
    ...(cursor ? { cursor } : {}),
    // Relay provider flags (from SSR variables)
    "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": false,
    "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": false,
    "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
    "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
    "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
    "__relay_internal__pv__IsWorkUserrelayprovider": false,
    "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
    "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": false,
    "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": false,
    "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
    "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
    "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
    "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": false,
    "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": true,
    "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": 0,
    "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": false,
    "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": false,
    "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": false,
    "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": false,
    "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": false,
    "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
    "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": false,
  };

  const result = await page.evaluate(
    async ({ lsd, variables, docId, graphqlUrl }) => {
      const body = new URLSearchParams();
      body.append("av", "0");
      body.append("__user", "0");
      body.append("__a", "1");
      body.append("__req", "k");
      body.append("dpr", "1");
      body.append("__ccg", "GOOD");
      body.append("__comet_req", "15");
      body.append("lsd", lsd);
      body.append("fb_api_caller_class", "RelayModern");
      body.append("fb_api_req_friendly_name", "ProfileCometTimelineFeedQuery");
      body.append("variables", JSON.stringify(variables));
      body.append("server_timestamps", "true");
      body.append("doc_id", docId);

      try {
        const resp = await fetch(graphqlUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-fb-lsd": lsd,
            "x-fb-friendly-name": "ProfileCometTimelineFeedQuery",
          },
          body: body.toString(),
          credentials: "include",
        });
        const text = await resp.text();
        return { status: resp.status, text };
      } catch (e) {
        return { error: e.message };
      }
    },
    { lsd, variables, docId: TIMELINE_FEED_DOC_ID, graphqlUrl: GRAPHQL_URL }
  );

  if (result.error) {
    log(`[graphql] Error: ${result.error}`);
    return null;
  }

  if (result.status !== 200) {
    log(`[graphql] HTTP ${result.status}`);
    return null;
  }

  // Parse the response - Facebook sometimes returns multiple JSON objects
  const text = result.text;

  // Check for rate limit
  if (text.includes("Rate limit exceeded")) {
    log("[graphql] Rate limited by Facebook");
    return null;
  }

  // Check for auth required
  if (text.includes('"www_signup_dialog"') || text.includes("not_logged_in")) {
    log("[graphql] Authentication required for more posts");
    return null;
  }

  try {
    const data = JSON.parse(text);
    if (data.errors) {
      log(`[graphql] API error: ${JSON.stringify(data.errors)}`);
      return null;
    }
    return data;
  } catch (e) {
    // Try NDJSON format (multiple JSON lines)
    const lines = text.split("\n").filter((l) => l.trim());
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_) {}
    }
    if (parsed.length > 0) return parsed[0];
    log(`[graphql] Failed to parse response: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse GraphQL API response for posts
// ---------------------------------------------------------------------------

function parseGraphQLResponse(data, username) {
  if (!data) return { posts: [], pageInfo: null };

  const user =
    data.data?.user ||
    data.data?.node ||
    data.data?.viewer?.actor;

  if (!user) {
    log("[graphql] No user node in response");
    return { posts: [], pageInfo: null };
  }

  const feedUnits = user.timeline_list_feed_units;
  if (!feedUnits) {
    log("[graphql] No timeline_list_feed_units in response");
    return { posts: [], pageInfo: null };
  }

  const posts = [];
  const edges = feedUnits.edges || [];

  for (const edge of edges) {
    const node = edge.node;
    if (!node || node.__typename !== "Story") continue;
    if (node.sponsored_data) continue;

    const parsed = parseStoryNode(node, username);
    if (parsed) posts.push(parsed);
  }

  const pageInfo = feedUnits.page_info || null;

  return { posts, pageInfo };
}

// ---------------------------------------------------------------------------
// Extract end_cursor from Relay SSR data
// ---------------------------------------------------------------------------

function extractEndCursorFromRelay(relayEntries) {
  for (const entry of relayEntries) {
    if (!entry.name?.includes("TimelineFeed")) continue;
    const result = entry.bbox?.result;

    // The page_info is in a deferred fragment with label
    if (result?.label?.includes("page_info")) {
      const pageInfo = result.data?.page_info;
      if (pageInfo) {
        log(`[relay] Found page_info: has_next_page=${pageInfo.has_next_page}, cursor=${pageInfo.end_cursor ? "yes" : "no"}`);
        return pageInfo;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract user ID from Relay data
// ---------------------------------------------------------------------------

function extractUserIdFromRelay(relayEntries) {
  for (const entry of relayEntries) {
    const result = entry.bbox?.result;
    if (!result) continue;

    const user = result.data?.user;
    if (user?.id) return user.id;

    const mainTiles = result.data?.mainColumnTiles;
    if (mainTiles?.id) return mainTiles.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const { username, maxPosts } = parseArgs(args);

  log(`[main] Scraping Facebook posts for: ${username}`);
  log(`[main] Max posts: ${maxPosts}`);

  // Check for authenticated cookies in environment
  const cookiesJson = process.env.FB_COOKIES || null;

  let browser;
  try {
    browser = await createFbBrowser(Camoufox);
  } catch (e) {
    emitError("BROWSER_LAUNCH_FAILED", `Failed to launch browser: ${e.message}`);
  }

  try {
    const context = await createFbContext(browser);

    // Inject cookies if provided
    const isAuthenticated = await injectCookies(context, cookiesJson);

    const page = await context.newPage();

    // Navigate to the page
    const { finalUrl, title } = await navigateToPage(page, username);

    // Check if we got the profile page
    const isLoginPage = finalUrl.includes("/login/") || title === "Facebook";
    if (isLoginPage && !isAuthenticated) {
      log("[main] Warning: Showing login page - limited data available");
    }

    // Wait for network to stabilize and SSR data to load
    await delay(3000);

    // Extract all Relay data from embedded JSON scripts
    log("[relay] Extracting SSR Relay data...");
    const relayEntries = await extractRelayData(page);
    log(`[relay] Found ${relayEntries.length} relay cache entries`);

    // Extract session tokens for potential GraphQL calls
    const tokens = await extractSessionTokens(page);
    log(`[tokens] LSD: ${tokens.lsd ? "found" : "not found"}, DTSG: ${tokens.dtsg ? "found" : "not found"}`);

    // Parse profile data
    log("[profile] Parsing profile data...");
    const profile = parseProfileData(relayEntries, username);

    // Extract follower counts from DOM (more reliable for logged-out)
    const domFollowers = await extractFollowerCounts(page);
    if (domFollowers.followerCount !== null) {
      profile.followerCount = domFollowers.followerCount;
      log(`[profile] Followers: ${domFollowers.followerText}`);
    }

    // Fill in profile holes from DOM
    const domHeader = await extractPageHeaderDom(page);
    if (!profile.name && domHeader.h2Names.length > 0) {
      profile.name = domHeader.h2Names[0];
    }

    // Extract posts from SSR Relay data
    log("[posts] Extracting posts from relay data...");
    const relayPosts = await extractPostsFromRelay(relayEntries, username);
    log(`[posts] Got ${relayPosts.length} posts from relay data`);

    // Get pagination cursor from relay data
    const relayPageInfo = extractEndCursorFromRelay(relayEntries);
    const userId = extractUserIdFromRelay(relayEntries);

    if (userId) {
      log(`[profile] User/Page ID: ${userId}`);
      profile.id = userId;
    }

    // Combine all posts
    const allPosts = [...relayPosts];
    const postIds = new Set(relayPosts.map((p) => p.postId || p.storyId));

    // Try to get more posts via GraphQL API if we need more and have a token
    let nextCursor = relayPageInfo?.end_cursor || null;
    let hasNextPage = relayPageInfo?.has_next_page ?? false;

    if (allPosts.length < maxPosts && tokens.lsd && userId) {
      log(`[graphql] Have ${allPosts.length}/${maxPosts} posts, attempting GraphQL API for more...`);

      let attempts = 0;
      const maxAttempts = Math.ceil((maxPosts - allPosts.length) / 5) + 1;

      while (allPosts.length < maxPosts && attempts < maxAttempts) {
        attempts++;

        // Rate limit protection
        if (attempts > 1) await delay(3000);

        const gqlData = await fetchMorePostsViaGraphQL(page, {
          userId,
          lsd: tokens.lsd,
          cursor: nextCursor,
          count: Math.min(maxPosts - allPosts.length, 5),
        });

        if (!gqlData) {
          log("[graphql] No more data from API - stopping");
          break;
        }

        const { posts: newPosts, pageInfo: newPageInfo } = parseGraphQLResponse(gqlData, username);

        // Deduplicate
        const uniqueNew = newPosts.filter(
          (p) => !postIds.has(p.postId || p.storyId)
        );

        for (const p of uniqueNew) {
          postIds.add(p.postId || p.storyId);
          allPosts.push(p);
        }

        log(`[graphql] Got ${uniqueNew.length} new posts, total: ${allPosts.length}`);

        if (newPageInfo?.has_next_page && newPageInfo?.end_cursor) {
          nextCursor = newPageInfo.end_cursor;
          hasNextPage = true;
        } else {
          hasNextPage = false;
          break;
        }

        if (uniqueNew.length === 0) {
          log("[graphql] No new posts in this batch - stopping");
          break;
        }
      }
    } else if (allPosts.length < maxPosts && !tokens.lsd) {
      log("[info] No LSD token available - cannot fetch more posts via GraphQL");
      log("[info] Provide FB_COOKIES env var for authenticated access to more posts");
    }

    // Trim to maxPosts
    const finalPosts = allPosts.slice(0, maxPosts);

    // Build the result
    const result = {
      // Profile/page info
      username,
      pageId: profile.id,
      name: profile.name,
      profileUrl: profile.pageUrl,
      profilePicUrl: profile.profilePicUrl,
      coverPhotoUrl: profile.coverPhotoUrl,
      bio: profile.bio,
      website: profile.website,
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      categoryName: profile.categoryName,
      isVerified: profile.isVerified,

      // Posts
      posts: finalPosts,
      postsCount: finalPosts.length,
      hasMorePosts: hasNextPage,
      nextCursor: hasNextPage ? nextCursor : null,

      // Auth status
      isAuthenticated,
      scrapedAt: new Date().toISOString(),
    };

    log(`[main] Done! Profile: ${profile.name}, Posts: ${finalPosts.length}`);
    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  log(`[fatal] ${e.stack || e.message}`);
  emitError("FATAL", e.message);
});
