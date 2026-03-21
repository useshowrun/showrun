/**
 * Shared utilities for Instagram scrapers.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

// Session file stores cookies for authenticated Instagram access.
// Location: ~/.instagram-session.json
const SESSION_FILE = path.join(os.homedir(), ".instagram-session.json");

/**
 * Load a saved Instagram session from disk.
 * Returns null if no session exists or it's invalid JSON.
 */
export function loadSession() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save an Instagram session to disk.
 * @param {Array} cookies - Playwright cookie objects
 * @param {string} username - Instagram username
 */
export function saveSession(cookies, username) {
  const session = {
    cookies,
    username: username || null,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log(`Session saved to ${SESSION_FILE}`);
  return session;
}

/**
 * Check if a session is still likely valid (Instagram sessions last ~90 days).
 * We consider a session valid if it's less than 30 days old.
 */
export function isSessionValid(session) {
  if (!session || !session.cookies || !Array.isArray(session.cookies)) return false;
  const savedAt = new Date(session.savedAt);
  const ageMs = Date.now() - savedAt.getTime();
  return ageMs < 30 * 24 * 60 * 60 * 1000; // 30 days
}

/**
 * Load cookies from env var IG_COOKIES (JSON array).
 * Returns null if not set or invalid.
 */
export function loadCookiesFromEnv() {
  const cookiesEnv = process.env.IG_COOKIES;
  if (!cookiesEnv) return null;
  try {
    const cookies = JSON.parse(cookiesEnv);
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies;
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

/**
 * Add authentication cookies to a browser context.
 * Priority: IG_COOKIES env → session file → no auth (logged-out mode)
 * Returns true if cookies were loaded, false if running without auth.
 */
export async function loadAuthCookies(context) {
  // Priority 1: IG_COOKIES env var
  const envCookies = loadCookiesFromEnv();
  if (envCookies) {
    await context.addCookies(envCookies);
    log(`Loaded ${envCookies.length} cookies from IG_COOKIES env`);
    return true;
  }

  // Priority 2: session file
  const session = loadSession();
  if (session && isSessionValid(session)) {
    await context.addCookies(session.cookies);
    log(`Loaded ${session.cookies.length} cookies from session file (user: @${session.username || "unknown"})`);
    return true;
  }

  if (session && !isSessionValid(session)) {
    log("Warning: Saved session is older than 30 days — may be expired. Re-run instagram-login to refresh.");
  }

  log("No authentication cookies found. Running in logged-out mode (limited data).");
  log("Run instagram-login skill to authenticate: node instagram-login/scripts/instagram-login.mjs");
  return false;
}

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
// Instagram constants
// ---------------------------------------------------------------------------

export const IG_APP_ID = "936619743392459";
export const IG_HOME = "https://www.instagram.com/";

// ---------------------------------------------------------------------------
// Instagram browser setup
// ---------------------------------------------------------------------------

/**
 * Initialize a camoufox browser with Instagram-appropriate settings.
 */
export async function createIgBrowser(Camoufox) {
  return Camoufox({
    headless: "virtual",
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createIgContext(browser) {
  return browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
  });
}

/**
 * Navigate to Instagram home to establish session cookies, then return CSRF token.
 * Must be called before any API fetch calls.
 */
export async function initSession(context, page) {
  await page.goto(IG_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await delay(5000);

  const cookies = await context.cookies(IG_HOME);
  const csrf = cookies.find((c) => c.name === "csrftoken")?.value;

  if (!csrf) {
    throw new Error("Failed to get CSRF token from Instagram");
  }

  return csrf;
}

// ---------------------------------------------------------------------------
// Instagram API fetch helper
// ---------------------------------------------------------------------------

/**
 * Make an Instagram API request from within the browser page context.
 * This bypasses CORS/header restrictions by running inside the browser.
 *
 * @param {Page} page - Playwright page
 * @param {string} url - API endpoint URL
 * @param {string} csrf - CSRF token
 * @param {string} referer - Referer header (default: instagram home)
 * @returns {{ status: number, json: object|null, text: string }}
 */
export async function igFetch(page, url, csrf, referer = IG_HOME) {
  return page.evaluate(
    async ({ url, csrf, referer, appId }) => {
      const resp = await fetch(url, {
        headers: {
          "x-ig-app-id": appId,
          "x-csrftoken": csrf,
          "x-requested-with": "XMLHttpRequest",
          accept: "application/json",
          referer,
        },
        credentials: "include",
      });
      const text = await resp.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Not JSON
      }
      return { status: resp.status, text, json };
    },
    { url, csrf, referer, appId: IG_APP_ID }
  );
}

// ---------------------------------------------------------------------------
// Post extraction helpers
// ---------------------------------------------------------------------------

/**
 * Parse a post node from edge_owner_to_timeline_media.edges[].node
 * into a clean, normalized post object.
 */
export function parsePostNode(node) {
  if (!node) return null;

  const typename = node.__typename; // GraphImage, GraphVideo, GraphSidecar
  const isVideo = node.is_video || typename === "GraphVideo";
  const isCarousel = typename === "GraphSidecar";

  // Caption text
  const caption =
    node.edge_media_to_caption?.edges?.[0]?.node?.text || null;

  // Hashtags from caption
  const hashtags = caption ? (caption.match(/#[\w\u0400-\u04FF]+/g) || []) : [];

  // Image URL — best available
  const imageUrl =
    node.display_url ||
    node.thumbnail_src ||
    node.thumbnail_tall_src ||
    null;

  // Video URL
  const videoUrl = isVideo ? node.video_url || null : null;

  // Carousel children
  const carouselMedia = isCarousel
    ? (node.edge_sidecar_to_children?.edges || []).map((e) => ({
        id: e.node.id,
        shortcode: e.node.shortcode,
        isVideo: e.node.is_video,
        imageUrl: e.node.display_url,
        videoUrl: e.node.is_video ? e.node.video_url : null,
        width: e.node.dimensions?.width,
        height: e.node.dimensions?.height,
      }))
    : null;

  return {
    id: node.id,
    shortcode: node.shortcode,
    url: `https://www.instagram.com/p/${node.shortcode}/`,
    type: isCarousel ? "carousel" : isVideo ? "video" : "image",
    takenAt: node.taken_at_timestamp
      ? new Date(node.taken_at_timestamp * 1000).toISOString()
      : null,
    caption,
    hashtags,
    likeCount: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? null,
    commentCount: node.edge_media_to_comment?.count ?? null,
    imageUrl,
    videoUrl,
    videoViewCount: node.video_view_count ?? null,
    width: node.dimensions?.width ?? null,
    height: node.dimensions?.height ?? null,
    location: node.location
      ? {
          id: node.location.id,
          name: node.location.name,
          slug: node.location.slug,
        }
      : null,
    accessibilityCaption: node.accessibility_caption || null,
    carouselMedia,
    owner: {
      id: node.owner?.id,
      username: node.owner?.username,
    },
  };
}

/**
 * Parse the user object from web_profile_info response.
 */
export function parseProfileUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    biography: user.biography,
    bioLinks: (user.bio_links || []).map((l) => ({
      url: l.url,
      title: l.title || null,
    })),
    externalUrl: user.external_url || null,
    profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
    followerCount: user.edge_followed_by?.count ?? null,
    followingCount: user.edge_follow?.count ?? null,
    postCount: user.edge_owner_to_timeline_media?.count ?? null,
    isVerified: user.is_verified ?? false,
    isPrivate: user.is_private ?? false,
    isBusinessAccount: user.is_business_account ?? false,
    categoryName: user.category_name || user.business_category_name || null,
    hasClips: user.has_clips ?? false,
  };
}
