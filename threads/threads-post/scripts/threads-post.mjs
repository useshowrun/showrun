#!/usr/bin/env node
/**
 * Threads Post Scraper
 *
 * Fetches a single Threads post including its content, author, and replies.
 *
 * ⚠️  AUTHENTICATION REQUIRED
 * Threads requires login for all content. Set THREADS_COOKIE env var:
 *
 *   How to get your cookie:
 *   1. Log in at https://www.threads.net in your browser
 *   2. Open DevTools → Application → Cookies → threads.net (or threads.com)
 *   3. Copy the value of the 'sessionid' cookie
 *   4. export THREADS_COOKIE="<sessionid value>"
 *
 *   Or use full cookie string:
 *   export THREADS_COOKIE_JSON="sessionid=abc; ds_user_id=123; csrftoken=xyz"
 *
 * Usage:
 *   node threads-post.mjs <post-url> [--max-replies N]
 *
 * Examples:
 *   node threads-post.mjs https://www.threads.net/@zuck/post/DCqEPYPOFKN
 *   node threads-post.mjs https://www.threads.net/@natgeo/post/C123ABC --max-replies 20
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
  parsePostUrlInput,
  parseThreadsUser,
  parseThreadsPost,
  extractMediaUrls,
  parseArgs,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { positional, maxReplies } = parseArgs(process.argv);
const rawInput = positional[0];

if (!rawInput) {
  emitError(
    "MISSING_ARG",
    "Usage: node threads-post.mjs <post-url-or-id> [--max-replies N]"
  );
}

const parsed = parsePostUrlInput(rawInput);
if (!parsed) {
  emitError("INVALID_ARG", `Cannot parse post URL from: ${rawInput}`);
}

const { username, postId } = parsed;
log(`Fetching Threads post: ${username ? `@${username}/` : ""}${postId}`);

// ---------------------------------------------------------------------------
// Load cookies
// ---------------------------------------------------------------------------

const cookieData = loadThreadsCookies();

if (!cookieData) {
  emitResult({
    error: true,
    code: "BLOCKED",
    blocked: true,
    reason: "Threads requires authentication. Set THREADS_COOKIE env var.",
    postId,
    instructions: [
      "1. Log in to https://www.threads.net in your browser",
      "2. Open DevTools → Application → Cookies → threads.net",
      "3. Copy the value of the 'sessionid' cookie",
      "4. Run: export THREADS_COOKIE=\"<sessionid value>\"",
      "5. Re-run this script",
    ],
  });
  process.exit(1);
}

log(`Cookie source: ${cookieData.source}`);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const browser = await createThreadsBrowser(Camoufox);

  try {
    const context = await createThreadsContext(browser, cookieData.cookies);
    const page = await context.newPage();

    // Intercept GraphQL responses for post data
    const capturedGqlData = [];

    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      if ((url.includes("/api/graphql") || url.includes("/api/v1/text_feed/")) && status === 200) {
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

    if (!csrf && page.url().includes("/login")) {
      emitResult({
        error: true,
        code: "BLOCKED",
        blocked: true,
        reason: "Redirected to login — session cookie is invalid or expired",
        postId,
      });
      process.exit(1);
    }

    await delay(500);

    // Strategy 1: Try the Threads post API directly
    log(`Trying post API for postId: ${postId}...`);

    // The post ID (code) can be used to construct the permalink
    const postRef = username ? `@${username}` : "unknown";

    // Try direct post info endpoint
    const postApiResp = await tryPostApi(page, postId, username, csrf);

    if (postApiResp) {
      emitResult(postApiResp);
      return;
    }

    // Strategy 2: Navigate to post page and intercept GQL
    const postUrl = username
      ? `https://www.threads.net/@${username}/post/${postId}`
      : `https://www.threads.net/t/${postId}`;

    log(`Navigating to post page: ${postUrl}...`);
    capturedGqlData.length = 0;

    await page.goto(postUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await delay(3000);

    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    if (currentUrl.includes("/login")) {
      emitResult({
        error: true,
        code: "BLOCKED",
        blocked: true,
        reason: "Redirected to login — session cookie is invalid or expired",
        postId,
      });
      process.exit(1);
    }

    // Check if post exists
    const pageTitle = await page.title();
    log(`Page title: ${pageTitle}`);

    if (pageTitle.toLowerCase().includes("page not found") ||
        pageTitle.toLowerCase().includes("sorry")) {
      emitError("NOT_FOUND", `Post ${postId} not found on Threads`);
    }

    // Wait for more GQL responses
    await delay(2000);
    log(`Captured ${capturedGqlData.length} API responses`);

    // Try to extract from intercepted GQL data
    const gqlResult = extractPostFromGql(capturedGqlData, postId, username, maxReplies);
    if (gqlResult) {
      emitResult(gqlResult);
      return;
    }

    // Strategy 3: Try embedded page state
    const pageResult = await extractPostFromPage(page, postId, username, maxReplies);
    if (pageResult) {
      emitResult(pageResult);
      return;
    }

    // Strategy 4: Try known GQL doc_ids
    const knownGqlResult = await tryKnownPostGqlQueries(page, postId, username, csrf, maxReplies);
    if (knownGqlResult) {
      emitResult(knownGqlResult);
      return;
    }

    // Could not get data
    emitResult({
      error: false,
      code: "PARTIAL",
      postId,
      note: "Could not extract post data. The session may lack sufficient permissions or Threads structure has changed.",
      post: {
        id: postId,
        url: postUrl,
        text: null,
        likeCount: null,
        replyCount: null,
        repostCount: null,
        quoteCount: null,
        createdAt: null,
        mediaUrls: [],
        author: null,
      },
      replies: [],
      meta: {
        repliesReturned: 0,
        cookieSource: cookieData.source,
      },
    });

  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Post API
// ---------------------------------------------------------------------------

async function tryPostApi(page, postId, username, csrf) {
  const endpoints = [
    // Try v1 post info
    `https://www.threads.net/api/v1/media/${postId}/info/`,
    // Try text feed post
    `https://www.threads.net/api/v1/text_feed/${postId}/replies/`,
  ];

  for (const url of endpoints) {
    try {
      const referer = username
        ? `https://www.threads.net/@${username}/post/${postId}`
        : `https://www.threads.net/t/${postId}`;

      const resp = await threadsFetch(page, url, csrf, referer);
      log(`Post API [${url.split("/api/")[1]}]: ${resp.status}`);

      if (resp.status === 404) {
        emitError("NOT_FOUND", `Post ${postId} not found`);
      }

      if (resp.status === 200 && resp.json) {
        // Handle post info response
        if (resp.json.items?.[0]) {
          const post = parsePostFromItem(resp.json.items[0], username);
          if (post) {
            return {
              post,
              replies: [],
              meta: {
                repliesReturned: 0,
                cookieSource: cookieData.source,
                apiSource: url.split("/api/")[1],
              },
            };
          }
        }

        // Handle replies response
        if (resp.json.threads) {
          const mainThread = resp.json.threads[0];
          if (mainThread) {
            const post = parseThreadsPost(mainThread, username);
            const replies = resp.json.threads.slice(1).map(t => {
              const r = parseThreadsPost(t, username);
              return r ? normalizeReply(r) : null;
            }).filter(Boolean);

            return {
              post,
              replies: replies.slice(0, maxReplies),
              meta: {
                repliesTotal: resp.json.threads.length - 1,
                repliesReturned: Math.min(replies.length, maxReplies),
                cookieSource: cookieData.source,
                apiSource: "text_feed_replies",
              },
            };
          }
        }
      }
    } catch (err) {
      log(`Post API error for ${url}: ${err.message}`);
    }

    await delay(300);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse post from media/info response
// ---------------------------------------------------------------------------

function parsePostFromItem(item, username) {
  if (!item) return null;

  const id = item.pk || item.id;
  const code = item.code || item.shortcode;

  return {
    id,
    code,
    url: code && username
      ? `https://www.threads.net/@${username}/post/${code}`
      : item.permalink || null,
    text: item.caption?.text || null,
    likeCount: item.like_count ?? null,
    replyCount: item.text_post_app_info?.direct_reply_count ?? item.reply_count ?? null,
    repostCount: item.text_post_app_info?.repost_count ?? null,
    quoteCount: item.text_post_app_info?.quote_count ?? null,
    createdAt: item.taken_at
      ? new Date(item.taken_at * 1000).toISOString()
      : null,
    mediaUrls: extractMediaUrls(item),
    author: item.user ? parseThreadsUser(item.user) : null,
  };
}

function normalizeReply(post) {
  return {
    id: post.id,
    text: post.text,
    likeCount: post.likeCount,
    createdAt: post.createdAt,
    author: post.author,
    mediaUrls: post.mediaUrls,
  };
}

// ---------------------------------------------------------------------------
// Strategy 2: Extract post from GQL intercepts
// ---------------------------------------------------------------------------

function extractPostFromGql(gqlData, postId, username, maxReplies) {
  for (const item of gqlData) {
    try {
      const { json } = item;
      if (!json) continue;

      // Look for thread/post data
      if (json.threads) {
        const mainThread = json.threads[0];
        if (mainThread) {
          const post = parseThreadsPost(mainThread, username);
          const replies = json.threads.slice(1).map(t => {
            const r = parseThreadsPost(t, username);
            return r ? normalizeReply(r) : null;
          }).filter(Boolean);

          return {
            post,
            replies: replies.slice(0, maxReplies),
            meta: {
              repliesTotal: json.threads.length - 1,
              repliesReturned: Math.min(replies.length, maxReplies),
              cookieSource: cookieData.source,
              apiSource: "gql_intercept",
            },
          };
        }
      }

      // Look for data in GQL response
      if (json.data) {
        const postData = findNestedPost(json.data, postId);
        if (postData) {
          return {
            post: postData,
            replies: [],
            meta: {
              repliesReturned: 0,
              cookieSource: cookieData.source,
              apiSource: "gql_intercept_data",
            },
          };
        }
      }
    } catch {}
  }
  return null;
}

function findNestedPost(obj, postId, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== "object") return null;

  // Check if this looks like a post
  if (obj.pk && obj.code && obj.caption !== undefined) {
    return parsePostFromItem(obj, null);
  }

  for (const val of Object.values(obj)) {
    if (typeof val === "object") {
      const found = findNestedPost(val, postId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 3: Extract from page state
// ---------------------------------------------------------------------------

async function extractPostFromPage(page, postId, username, maxReplies) {
  try {
    const state = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      const data = [];
      for (const s of scripts) {
        try {
          const parsed = JSON.parse(s.textContent);
          const str = JSON.stringify(parsed);
          if (str.includes('"caption"') || str.includes('"like_count"')) {
            data.push(parsed);
          }
        } catch {}
      }
      return data;
    });

    for (const item of state) {
      const postData = findNestedPost(item, postId);
      if (postData) {
        return {
          post: postData,
          replies: [],
          meta: {
            repliesReturned: 0,
            cookieSource: cookieData.source,
            apiSource: "page_state",
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
// Strategy 4: Known GQL doc_ids for post
// ---------------------------------------------------------------------------

async function tryKnownPostGqlQueries(page, postId, username, csrf, maxReplies) {
  const postDocIds = [
    "6360002537429864",  // BarcelonaPostPageQuery
    "6557167350989556",  // PostPageQuery
    "7509884905759329",  // ThreadQuery
  ];

  const referer = username
    ? `https://www.threads.net/@${username}/post/${postId}`
    : `https://www.threads.net/t/${postId}`;

  for (const docId of postDocIds) {
    try {
      log(`Trying post GQL doc_id: ${docId}...`);
      const vars = {
        postID: postId,
        __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
      };
      const resp = await threadsGqlFetch(page, vars, docId, csrf, referer);

      if (resp.status === 200 && resp.json?.data) {
        const postData = findNestedPost(resp.json.data, postId);
        if (postData) {
          log(`Got data from GQL doc_id ${docId}`);
          return {
            post: postData,
            replies: [],
            meta: {
              repliesReturned: 0,
              cookieSource: cookieData.source,
              apiSource: `gql_doc_${docId}`,
            },
          };
        }
      }
    } catch (err) {
      log(`GQL post doc_id ${docId} error: ${err.message}`);
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
