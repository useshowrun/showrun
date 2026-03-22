/**
 * Shared utilities for Threads scrapers.
 *
 * Authentication:
 *   Threads requires login for all content (profiles, posts, replies).
 *   Set THREADS_COOKIE env var with the sessionid cookie value from a logged-in
 *   browser session on threads.net or threads.com.
 *
 *   How to get your cookie:
 *   1. Log in to https://www.threads.net in your browser
 *   2. Open DevTools → Application → Cookies → www.threads.net or threads.com
 *   3. Copy the value of `sessionid`
 *   4. Set: export THREADS_COOKIE="<sessionid value>"
 *
 *   Alternatively, set THREADS_COOKIE_JSON with the full cookie header string:
 *   export THREADS_COOKIE_JSON='sessionid=abc123; ds_user_id=456; ...'
 */

import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const THREADS_APP_ID = "238260118697367";
export const THREADS_HOME = "https://www.threads.net/";

// ---------------------------------------------------------------------------
// Cookie management
// ---------------------------------------------------------------------------

const SESSION_FILE = path.join(os.homedir(), ".threads-session.json");

/**
 * Load cookies for Threads from env vars or session file.
 *
 * Priority:
 *   1. THREADS_COOKIE_JSON - full cookie header string
 *      e.g. "sessionid=abc; ds_user_id=123; csrftoken=xyz"
 *   2. THREADS_COOKIE - just the sessionid value
 *      e.g. "abc123def456"
 *   3. ~/.threads-session.json - saved from previous session
 *
 * Returns { cookies: Array<{name, value, domain, path}>, source }
 * Returns null if no cookies available.
 */
export function loadThreadsCookies() {
  // Priority 1: full cookie header string
  const cookieJson = process.env.THREADS_COOKIE_JSON;
  if (cookieJson) {
    const cookies = parseCookieHeader(cookieJson, "threads.net");
    if (cookies.length > 0) {
      log(`Loaded ${cookies.length} cookies from THREADS_COOKIE_JSON`);
      return { cookies, source: "env:THREADS_COOKIE_JSON" };
    }
  }

  // Priority 2: sessionid value only
  const sessionId = process.env.THREADS_COOKIE;
  if (sessionId) {
    const cookies = buildMinimalCookies(sessionId, "threads.net");
    log(`Loaded sessionid cookie from THREADS_COOKIE env`);
    return { cookies, source: "env:THREADS_COOKIE" };
  }

  // Priority 3: session file
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const session = JSON.parse(raw);
    if (session?.cookies && Array.isArray(session.cookies) && session.cookies.length > 0) {
      const savedAt = new Date(session.savedAt);
      const ageDays = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 30) {
        log(`Loaded ${session.cookies.length} cookies from session file (age: ${ageDays.toFixed(1)} days)`);
        return { cookies: session.cookies, source: "file" };
      } else {
        log(`Session file is ${ageDays.toFixed(1)} days old — may be expired`);
        return { cookies: session.cookies, source: "file:stale" };
      }
    }
  } catch {
    // No session file
  }

  return null;
}

/**
 * Save cookies to the session file.
 */
export function saveThreadsSession(cookies, username) {
  const session = {
    cookies,
    username: username || null,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log(`Session saved to ${SESSION_FILE}`);
}

/**
 * Parse a cookie header string into an array of cookie objects.
 * e.g. "sessionid=abc; ds_user_id=123; csrftoken=xyz"
 */
export function parseCookieHeader(cookieStr, domain) {
  return cookieStr.split(";").map(part => {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=").trim();
    return {
      name: name.trim(),
      value,
      domain: `.${domain}`,
      path: "/",
      httpOnly: name.trim() === "sessionid",
      secure: true,
      sameSite: "None",
    };
  }).filter(c => c.name && c.value);
}

/**
 * Build minimal cookies from just a sessionid value.
 */
export function buildMinimalCookies(sessionId, domain) {
  return [
    {
      name: "sessionid",
      value: sessionId,
      domain: `.${domain}`,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
  ];
}

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

/**
 * Create a Camoufox browser instance suitable for Threads.
 */
export async function createThreadsBrowser(Camoufox) {
  return Camoufox({
    headless: "virtual",
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
    os: "windows",
    fonts: ["Arial", "Helvetica", "sans-serif"],
  });
}

/**
 * Create a browser context with Threads-appropriate settings.
 */
export async function createThreadsContext(browser, cookies) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "X-IG-App-ID": THREADS_APP_ID,
    },
  });

  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    log(`Added ${cookies.length} cookies to browser context`);
  }

  return context;
}

// ---------------------------------------------------------------------------
// HTTP fetch via page.evaluate
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request via the browser page.
 * Returns { status, json, text }
 */
export async function threadsFetch(page, url, csrfToken, referer) {
  const result = await page.evaluate(
    async ([fetchUrl, csrf, ref, appId]) => {
      try {
        const resp = await fetch(fetchUrl, {
          method: "GET",
          headers: {
            Accept: "application/json, text/javascript, */*",
            "X-IG-App-ID": appId,
            "X-Requested-With": "XMLHttpRequest",
            ...(csrf ? { "X-CSRFToken": csrf, "X-FB-LSD": csrf } : {}),
            ...(ref ? { Referer: ref } : {}),
          },
          credentials: "include",
          redirect: "manual",
        });
        const text = await resp.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: resp.status, text, json };
      } catch (err) {
        return { status: 0, text: err.message, json: null };
      }
    },
    [url, csrfToken, referer, THREADS_APP_ID]
  );
  return result;
}

/**
 * Make a POST request to the Threads GQL API.
 */
export async function threadsGqlFetch(page, variables, docId, csrfToken, referer) {
  const result = await page.evaluate(
    async ([vars, doc, csrf, ref, appId]) => {
      try {
        const formData = new URLSearchParams();
        formData.append("variables", typeof vars === "string" ? vars : JSON.stringify(vars));
        formData.append("doc_id", doc);
        if (csrf) formData.append("lsd", csrf);

        const resp = await fetch("/api/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "*/*",
            "X-IG-App-ID": appId,
            ...(csrf ? { "X-FB-LSD": csrf } : {}),
            ...(ref ? { Referer: ref } : {}),
            "X-Requested-With": "XMLHttpRequest",
          },
          body: formData.toString(),
          credentials: "include",
        });
        const text = await resp.text();
        // Strip for(;;); prefix used by Meta's AJAX responses
        const cleaned = text.startsWith("for (;;);") ? text.slice(9) : text;
        let json = null;
        try {
          json = JSON.parse(cleaned);
        } catch {}
        return { status: resp.status, text: cleaned, json };
      } catch (err) {
        return { status: 0, text: err.message, json: null };
      }
    },
    [variables, docId, csrfToken, referer, THREADS_APP_ID]
  );
  return result;
}

// ---------------------------------------------------------------------------
// Page initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a Threads session and extract lsd/csrf token.
 * Navigates to the login page (always accessible) to get browser cookies,
 * then navigates to threads.net to establish the correct domain cookies.
 * Returns the csrf token string (or null).
 */
export async function initThreadsSession(context, page) {
  log("Initializing Threads session...");

  // First navigate to login page to get base cookies (always accessible)
  await page.goto("https://www.threads.net/login/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await delay(1000);

  const currentUrl = page.url();
  log(`Current URL: ${currentUrl}`);

  // Extract lsd token from page
  const lsd = await page.evaluate(() => {
    // Try from __eqmc script tag
    const eqmc = document.getElementById("__eqmc");
    if (eqmc) {
      try {
        const data = JSON.parse(eqmc.textContent);
        if (data.l) return data.l;
      } catch {}
    }
    // Try from LSD config
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const text = JSON.stringify(data);
        const match = text.match(/"token":"([A-Za-z0-9_-]{10,})"/);
        if (match) return match[1];
      } catch {}
    }
    return null;
  });

  if (lsd) {
    log(`LSD token: ${lsd.substring(0, 12)}...`);
  }

  // Get CSRF token from cookies
  const cookies = await context.cookies();
  const csrfCookie = cookies.find(c => c.name === "csrftoken");
  const csrf = csrfCookie?.value || lsd;

  log(`CSRF token: ${csrf ? csrf.substring(0, 12) + "..." : "not found"}`);

  return csrf;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Threads URL or username string.
 * Accepts:
 *   - @username
 *   - username
 *   - https://www.threads.net/@username
 * Returns { username }
 */
export function parseUsernameInput(input) {
  if (!input) return null;

  // Full URL
  if (input.startsWith("http")) {
    const url = new URL(input);
    const match = url.pathname.match(/^\/@?([^/]+)/);
    if (match) return { username: match[1] };
    return null;
  }

  // @username or username
  return { username: input.replace(/^@/, "") };
}

/**
 * Parse a Threads post URL.
 * Accepts:
 *   - https://www.threads.net/@username/post/POST_ID
 * Returns { username, postId }
 */
export function parsePostUrlInput(input) {
  if (!input) return null;

  if (input.startsWith("http")) {
    const url = new URL(input);
    const match = url.pathname.match(/^\/@?([^/]+)\/post\/([^/]+)/);
    if (match) return { username: match[1], postId: match[2] };
    return null;
  }

  // Try as postId directly
  return { username: null, postId: input };
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract media URLs from a Threads post node.
 */
export function extractMediaUrls(node) {
  const urls = [];

  // Single image
  if (node?.image_versions2?.candidates?.[0]?.url) {
    urls.push(node.image_versions2.candidates[0].url);
  }

  // Video
  if (node?.video_versions?.[0]?.url) {
    urls.push(node.video_versions[0].url);
  }

  // Carousel media
  if (Array.isArray(node?.carousel_media)) {
    for (const item of node.carousel_media) {
      if (item?.image_versions2?.candidates?.[0]?.url) {
        urls.push(item.image_versions2.candidates[0].url);
      }
      if (item?.video_versions?.[0]?.url) {
        urls.push(item.video_versions[0].url);
      }
    }
  }

  return [...new Set(urls)]; // deduplicate
}

/**
 * Parse a Threads user node into a normalized profile object.
 * Handles both Instagram-style fields (edge_followed_by.count) and
 * Threads-style fields (follower_count).
 */
export function parseThreadsUser(user) {
  if (!user) return null;
  return {
    id: user.pk || user.id || null,
    username: user.username || null,
    displayName: user.full_name || user.name || null,
    bio: user.biography || user.bio || null,
    avatarUrl: user.profile_pic_url || user.profile_image_url || null,
    // Instagram-style: edge_followed_by.count | Threads-style: follower_count
    followersCount:
      user.edge_followed_by?.count ??
      user.follower_count ??
      user.followers_count ??
      null,
    // Instagram-style: edge_follow.count | Threads-style: following_count
    followingCount:
      user.edge_follow?.count ??
      user.following_count ??
      null,
    isVerified: user.is_verified ?? false,
    isPrivate: user.is_private ?? false,
    threadCount: user.media_count ?? null,
    externalUrl: user.external_url || null,
  };
}

/**
 * Parse a Threads post/thread node into a normalized post object.
 */
export function parseThreadsPost(thread, username) {
  if (!thread) return null;

  // The post is often nested as thread_items[0].post
  const post = thread.thread_items?.[0]?.post || thread.post || thread;

  if (!post) return null;

  const id = post.pk || post.id || null;
  const code = post.code || post.shortcode || null;

  return {
    id,
    code,
    url: code && username
      ? `https://www.threads.net/@${username}/post/${code}`
      : post.permalink || null,
    text: post.caption?.text || post.text || null,
    likeCount: post.like_count ?? post.text_post_app_info?.like_count ?? null,
    replyCount: post.text_post_app_info?.direct_reply_count ?? post.reply_count ?? null,
    repostCount: post.text_post_app_info?.repost_count ?? post.repost_count ?? null,
    quoteCount: post.text_post_app_info?.quote_count ?? null,
    createdAt: post.taken_at
      ? new Date(post.taken_at * 1000).toISOString()
      : null,
    mediaUrls: extractMediaUrls(post),
    mediaType: post.media_type || null,
    author: post.user ? parseThreadsUser(post.user) : null,
  };
}

/**
 * Parse args: extract --max-posts N and --max-replies N.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { positional: [], maxPosts: 20, maxReplies: 20 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-posts" && args[i + 1]) {
      result.maxPosts = parseInt(args[i + 1], 10) || 20;
      i++;
    } else if (args[i] === "--max-replies" && args[i + 1]) {
      result.maxReplies = parseInt(args[i + 1], 10) || 20;
      i++;
    } else {
      result.positional.push(args[i]);
    }
  }

  return result;
}
