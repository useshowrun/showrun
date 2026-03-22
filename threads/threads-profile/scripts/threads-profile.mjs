#!/usr/bin/env node
/**
 * Threads Profile Scraper
 *
 * Fetches a Threads profile including bio, follower counts, and recent posts.
 *
 * ⚠️  AUTHENTICATION REQUIRED
 * Threads requires login for all content. Set THREADS_COOKIE env var:
 *
 *   How to get your cookie:
 *   1. Log in at https://www.threads.net in Chrome/Firefox
 *   2. DevTools → Application → Cookies → threads.net (or threads.com)
 *   3. Copy the `sessionid` cookie value
 *   4. export THREADS_COOKIE="<sessionid value>"
 *
 *   Or use full cookie string:
 *   export THREADS_COOKIE_JSON="sessionid=abc; ds_user_id=123; csrftoken=xyz"
 *
 * Usage:
 *   node threads-profile.mjs <@username-or-url> [--max-posts N]
 *
 * Examples:
 *   node threads-profile.mjs @zuck
 *   node threads-profile.mjs https://www.threads.net/@natgeo --max-posts 10
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
  createThreadsBrowser,
  createThreadsContext,
  loadThreadsCookies,
  initThreadsSession,
  threadsFetch,
  threadsGqlFetch,
  parseUsernameInput,
  parseThreadsUser,
  parseThreadsPost,
  parseArgs,
  THREADS_HOME,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { positional, maxPosts } = parseArgs(process.argv);
const rawInput = positional[0];

if (!rawInput) {
  emitError(
    "MISSING_ARG",
    "Usage: node threads-profile.mjs <@username-or-url> [--max-posts N]"
  );
}

const parsed = parseUsernameInput(rawInput);
if (!parsed) {
  emitError("INVALID_ARG", `Cannot parse username from: ${rawInput}`);
}

const { username } = parsed;
log(`Fetching Threads profile: @${username}`);

// ---------------------------------------------------------------------------
// Load cookies
// ---------------------------------------------------------------------------

// Threads public API: profile info (/api/v1/users/web_profile_info/) works without auth.
// Threads posts API (/api/v1/text_feed/) requires authentication (sessionid cookie).
const cookieData = loadThreadsCookies();
const isAuthenticated = !!cookieData;

if (cookieData) {
  log(`Cookie source: ${cookieData.source}`);
} else {
  log("No auth cookies — will fetch profile info only (no posts).");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const browser = await createThreadsBrowser(Camoufox);

  try {
    const context = await createThreadsContext(browser, cookieData?.cookies || []);
    const page = await context.newPage();

    // Intercept GraphQL responses for profile data
    const capturedGqlData = [];

    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      if (url.includes("/api/graphql") && status === 200) {
        try {
          const text = await response.text();
          const cleaned = text.startsWith("for (;;);") ? text.slice(9) : text;
          const json = JSON.parse(cleaned);
          capturedGqlData.push({ url, json });
        } catch {
          // Ignore parse errors
        }
      }
    });

    // Initialize session
    const csrf = await initThreadsSession(context, page);

    // Note: login redirect is expected for the homepage without auth.
    // The profile API endpoint still works without sessionid (semi-public).
    if (csrf) {
      log(`CSRF/LSD token acquired: ${csrf.substring(0, 8)}...`);
    } else {
      log("No CSRF token — proceeding with browser cookies only");
    }

    await delay(1000);

    // Strategy 1: Try the Instagram/Threads web profile API
    log(`Trying web profile info API for @${username}...`);
    const profileApiUrl = `https://www.threads.net/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const profileResp = await threadsFetch(page, profileApiUrl, csrf, `https://www.threads.net/@${username}`);

    log(`Profile API response: ${profileResp.status}`);

    if (profileResp.status === 200 && profileResp.json?.data?.user) {
      // Got profile data from web API
      return await handleWebApiProfile(profileResp.json, username, maxPosts, page, csrf, capturedGqlData);
    }

    if (profileResp.status === 404) {
      emitError("NOT_FOUND", `User @${username} not found on Threads`);
    }

    // Strategy 2: Navigate to profile page and intercept GQL
    log(`Web API returned ${profileResp.status}, trying page navigation...`);
    capturedGqlData.length = 0; // clear previous captures

    const profileUrl = `https://www.threads.net/@${username}`;
    log(`Navigating to ${profileUrl}...`);

    await page.goto(profileUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await delay(3000);

    const currentUrl = page.url();
    log(`Current URL after navigation: ${currentUrl}`);

    if (currentUrl.includes("/login")) {
      emitResult({
        error: true,
        code: "BLOCKED",
        blocked: true,
        reason: "Redirected to login — session cookie is invalid or expired",
        username,
      });
      process.exit(1);
    }

    // Check if profile exists (404 page)
    const pageTitle = await page.title();
    log(`Page title: ${pageTitle}`);

    if (pageTitle.toLowerCase().includes("page not found") ||
        pageTitle.toLowerCase().includes("sorry")) {
      emitError("NOT_FOUND", `User @${username} not found on Threads`);
    }

    // Wait for more GQL responses
    await delay(2000);

    // Try to extract data from captured GQL responses
    log(`Captured ${capturedGqlData.length} GQL responses`);

    const profileData = extractProfileFromGql(capturedGqlData, username);

    if (profileData) {
      log(`Got profile from GQL: ${JSON.stringify(profileData.profile).substring(0, 100)}`);
      emitResult(profileData);
      return;
    }

    // Strategy 3: Try extracting from embedded page JSON state
    log("Trying embedded page state extraction...");
    const pageState = await extractPageState(page, username);

    if (pageState) {
      emitResult(pageState);
      return;
    }

    // Strategy 4: Try direct GQL query with known doc_ids
    log("Trying direct GQL queries with known doc_ids...");
    const gqlResult = await tryKnownGqlQueries(page, username, csrf, maxPosts);

    if (gqlResult) {
      emitResult(gqlResult);
      return;
    }

    // Could not get data — return what we know
    emitResult({
      error: false,
      code: "PARTIAL",
      username,
      note: "Could not extract full profile data. The session may lack sufficient permissions or Threads structure has changed.",
      profile: {
        username,
        displayName: null,
        bio: null,
        avatarUrl: null,
        followersCount: null,
        followingCount: null,
        isVerified: null,
        isPrivate: null,
      },
      posts: [],
      meta: {
        postsReturned: 0,
        cookieSource: cookieData.source,
      },
    });

  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Handle Web API profile response
// ---------------------------------------------------------------------------

async function handleWebApiProfile(data, username, maxPosts, page, csrf, capturedGqlData) {
  const user = data.data.user;
  log(`Got profile via web API: ${user.full_name} (@${user.username})`);

  // Pass user object directly — parseThreadsUser handles both Instagram-style
  // (edge_followed_by.count) and Threads-style (follower_count) field names
  const profile = parseThreadsUser(user);

  // Try to get posts via threads feed API (requires auth)
  const userId = user.pk || user.id;
  let posts = [];
  let postsNote = null;

  if (isAuthenticated) {
    log(`Fetching posts for user ID: ${userId}...`);
    posts = await fetchUserThreads(page, userId, username, csrf, maxPosts);
  } else {
    postsNote = "Posts require authentication. Set THREADS_COOKIE env var to get posts.";
    log(postsNote);
  }

  const result = {
    username: profile.username,
    profile,
    posts,
    meta: {
      postsReturned: posts.length,
      postsTotal: profile.threadCount,
      authenticated: isAuthenticated,
      cookieSource: cookieData?.source || null,
      apiSource: "web_profile_info",
    },
  };

  if (postsNote) result.meta.note = postsNote;

  emitResult(result);
}

// ---------------------------------------------------------------------------
// Fetch user threads (posts)
// ---------------------------------------------------------------------------

async function fetchUserThreads(page, userId, username, csrf, maxPosts) {
  const threads = [];

  try {
    // Try the threads feed endpoint
    const feedUrl = `https://www.threads.net/api/v1/text_feed/${userId}/profile/?count=${Math.min(maxPosts, 25)}`;
    const feedResp = await threadsFetch(page, feedUrl, csrf, `https://www.threads.net/@${username}`);

    log(`Threads feed API: ${feedResp.status}`);

    if (feedResp.status === 200 && feedResp.json?.threads) {
      for (const thread of feedResp.json.threads.slice(0, maxPosts)) {
        const post = parseThreadsPost(thread, username);
        if (post) threads.push(post);
      }
      log(`Got ${threads.length} posts from feed API`);
      return threads;
    }

    // Try alternative endpoint
    const altFeedUrl = `https://www.threads.net/api/v1/text_feed/${userId}/profile/`;
    const altResp = await threadsFetch(page, altFeedUrl, csrf, `https://www.threads.net/@${username}`);
    log(`Alt threads feed: ${altResp.status}`);

    if (altResp.status === 200 && altResp.json?.threads) {
      for (const thread of altResp.json.threads.slice(0, maxPosts)) {
        const post = parseThreadsPost(thread, username);
        if (post) threads.push(post);
      }
      log(`Got ${threads.length} posts from alt feed API`);
    }

  } catch (err) {
    log(`Error fetching threads: ${err.message}`);
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Strategy 2: Extract profile from GQL responses
// ---------------------------------------------------------------------------

function extractProfileFromGql(gqlData, username) {
  for (const item of gqlData) {
    try {
      const { json } = item;
      if (!json) continue;

      // Look for profile data patterns
      const str = JSON.stringify(json);

      // Check for user data
      const userData = findNestedUser(json, username);
      if (userData) {
        const profile = parseThreadsUser(userData);
        const posts = findNestedPosts(json, username);
        return {
          username: profile.username || username,
          profile,
          posts,
          meta: {
            postsReturned: posts.length,
            cookieSource: cookieData.source,
            apiSource: "gql_intercept",
          },
        };
      }
    } catch {}
  }
  return null;
}

function findNestedUser(obj, username, depth = 0) {
  if (depth > 10) return null;
  if (!obj || typeof obj !== "object") return null;

  // Check if this object looks like a user
  if (obj.username && (obj.full_name !== undefined || obj.biography !== undefined)) {
    if (!username || obj.username === username) {
      return obj;
    }
  }

  for (const val of Object.values(obj)) {
    if (typeof val === "object") {
      const found = findNestedUser(val, username, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findNestedPosts(obj, username, depth = 0) {
  const posts = [];
  if (depth > 10 || !obj || typeof obj !== "object") return posts;

  // Look for threads/items arrays
  if (Array.isArray(obj.threads)) {
    for (const t of obj.threads) {
      const post = parseThreadsPost(t, username);
      if (post) posts.push(post);
    }
    return posts;
  }

  for (const val of Object.values(obj)) {
    if (typeof val === "object") {
      const found = findNestedPosts(val, username, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Strategy 3: Extract from embedded page state
// ---------------------------------------------------------------------------

async function extractPageState(page, username) {
  try {
    const state = await page.evaluate(() => {
      // Try __bbox embedded data
      const scripts = document.querySelectorAll('script[type="application/json"]');
      const data = [];
      for (const s of scripts) {
        try {
          const parsed = JSON.parse(s.textContent);
          if (JSON.stringify(parsed).includes("follower")) {
            data.push(parsed);
          }
        } catch {}
      }
      return data;
    });

    for (const item of state) {
      const user = findNestedUser(item, username);
      if (user && user.username) {
        const profile = parseThreadsUser(user);
        return {
          username: profile.username,
          profile,
          posts: [],
          meta: {
            postsReturned: 0,
            cookieSource: cookieData.source,
            apiSource: "page_state",
            note: "Limited data extracted from page state",
          },
        };
      }
    }
  } catch (err) {
    log(`Page state extraction error: ${err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 4: Known GQL doc_ids
// ---------------------------------------------------------------------------

async function tryKnownGqlQueries(page, username, csrf, maxPosts) {
  // Known Threads GQL doc_ids (these may change with app updates)
  const profileDocIds = [
    "23996318473300828",  // BarcelonaProfileRootWithThreadsQuery
    "6232751443445612",   // BarcelonaProfileQuery
    "7357840180958557",   // ProfileQuery
  ];

  for (const docId of profileDocIds) {
    try {
      log(`Trying GQL doc_id: ${docId}...`);
      const vars = { username, __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true };
      const resp = await threadsGqlFetch(page, vars, docId, csrf, `https://www.threads.net/@${username}`);

      if (resp.status === 200 && resp.json?.data) {
        const user = findNestedUser(resp.json.data, username);
        if (user && user.username) {
          const profile = parseThreadsUser(user);
          const posts = findNestedPosts(resp.json.data, username);
          log(`Got data from GQL doc_id ${docId}`);
          return {
            username: profile.username,
            profile,
            posts: posts.slice(0, maxPosts),
            meta: {
              postsReturned: Math.min(posts.length, maxPosts),
              cookieSource: cookieData.source,
              apiSource: `gql_doc_${docId}`,
            },
          };
        }
      }
    } catch (err) {
      log(`GQL doc_id ${docId} error: ${err.message}`);
    }

    await delay(500);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  log(`Unexpected error: ${err.stack}`);
  emitError("UNEXPECTED_ERROR", err.message);
});
