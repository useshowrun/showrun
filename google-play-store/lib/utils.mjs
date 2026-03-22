/**
 * Shared utilities for Google Play Store scraper skills
 *
 * Data Sources:
 *   - google-play-scraper npm package (reverse-engineered internal Google Play APIs)
 *   - App page: https://play.google.com/store/apps/details?id=<packageName>&hl=en
 *   - Search: https://play.google.com/store/search?q=<query>&c=apps&hl=en
 *
 * No authentication required — uses Google's internal (but public) endpoints.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

// Resolve require relative to this file so google-play-scraper is found
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(path.join(__dirname, "../package.json"));
const _gplay = require("google-play-scraper");

// The package exports a default object with the API methods
export const gplay = _gplay.default || _gplay;

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
// Package ID / URL extraction
// ---------------------------------------------------------------------------

/**
 * Extract a package name from various input formats:
 *   - "com.Slack"                                              → "com.Slack"
 *   - "https://play.google.com/store/apps/details?id=com.Slack" → "com.Slack"
 *   - "play.google.com/store/apps/details?id=com.Slack"       → "com.Slack"
 *
 * Returns the package name string, or null if not found.
 */
export function extractPackageId(input) {
  input = input.trim();

  // Check if it looks like a URL (contains play.google.com or ?id=)
  if (input.includes("play.google.com") || input.includes("?id=") || input.includes("&id=")) {
    // Try to extract ?id= query param
    const match = input.match(/[?&]id=([^&\s]+)/);
    if (match) return match[1];
  }

  // If it looks like a package name (com.something or similar dotted identifier), return as-is
  // Android package names: letters, digits, underscores, dots — must have at least one dot
  if (/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(input)) {
    return input;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw google-play-scraper search result into a clean app summary.
 */
export function normalizeSearchResult(raw) {
  return {
    appId: raw.appId || null,
    title: raw.title || null,
    developer: raw.developer || null,
    developerId: raw.developerId || null,
    score: raw.score != null ? Math.round(raw.score * 100) / 100 : null,
    scoreText: raw.scoreText || null,
    price: raw.price ?? null,
    free: raw.free ?? null,
    currency: raw.currency || null,
    priceText: raw.priceText || null,
    summary: raw.summary || null,
    icon: raw.icon || null,
    url: raw.url || (raw.appId ? `https://play.google.com/store/apps/details?id=${raw.appId}` : null),
  };
}

/**
 * Normalize a raw google-play-scraper app detail object into a clean app detail.
 */
export function normalizeAppDetail(raw) {
  return {
    appId: raw.appId || null,
    title: raw.title || null,
    description: raw.description || null,
    summary: raw.summary || null,
    url: raw.url || (raw.appId ? `https://play.google.com/store/apps/details?id=${raw.appId}` : null),

    // Developer
    developer: {
      name: raw.developer || null,
      devId: raw.developerId || null,
      email: raw.developerEmail || null,
      website: raw.developerWebsite || null,
      address: raw.developerLegalAddress || null,
      legalName: raw.developerLegalName || null,
    },

    // Ratings & reviews
    score: raw.score != null ? Math.round(raw.score * 1000) / 1000 : null,
    scoreText: raw.scoreText || null,
    ratings: raw.ratings ?? null,
    reviews: raw.reviews ?? null,
    histogram: raw.histogram
      ? {
          1: raw.histogram["1"] ?? 0,
          2: raw.histogram["2"] ?? 0,
          3: raw.histogram["3"] ?? 0,
          4: raw.histogram["4"] ?? 0,
          5: raw.histogram["5"] ?? 0,
        }
      : null,

    // Pricing
    price: raw.price ?? null,
    free: raw.free ?? null,
    currency: raw.currency || null,
    priceText: raw.priceText || null,
    offersIAP: raw.offersIAP ?? null,
    inAppProductPrice: raw.inAppProductPrice || null,

    // Genre & categories
    genre: raw.genre || null,
    genreId: raw.genreId || null,
    categories: raw.categories || [],

    // Media
    icon: raw.icon || null,
    headerImage: raw.headerImage || null,
    screenshots: raw.screenshots || [],
    video: raw.video || null,
    videoImage: raw.videoImage || null,

    // Content rating
    contentRating: raw.contentRating || null,
    contentRatingDescription: raw.contentRatingDescription || null,
    adSupported: raw.adSupported ?? null,

    // Version & compatibility
    released: raw.released || null,
    updated: raw.updated ? new Date(raw.updated).toISOString() : null,
    version: raw.version || null,
    androidVersion: raw.androidVersion || null,
    androidVersionText: raw.androidVersionText || null,

    // Install counts
    installs: raw.installs || null,
    minInstalls: raw.minInstalls ?? null,
    maxInstalls: raw.maxInstalls ?? null,

    // Other
    available: raw.available ?? null,
    privacyPolicy: raw.privacyPolicy || null,
    recentChanges: raw.recentChanges || null,
    preregister: raw.preregister ?? null,

    // Reviews are populated separately
    reviewsList: [],
  };
}

/**
 * Normalize a single review from google-play-scraper reviews() result.
 */
export function normalizeReview(raw) {
  return {
    id: raw.id || null,
    userName: raw.userName || null,
    userImage: raw.userImage || null,
    score: raw.score ?? null,
    thumbsUp: raw.thumbsUp ?? 0,
    reviewCreatedVersion: raw.version || null,
    at: raw.date ? (raw.date instanceof Date ? raw.date.toISOString() : raw.date) : null,
    replyDate: raw.replyDate ? (raw.replyDate instanceof Date ? raw.replyDate.toISOString() : raw.replyDate) : null,
    replyText: raw.replyText || null,
    title: raw.title || null,
    text: raw.text || null,
    url: raw.url || null,
  };
}

// ---------------------------------------------------------------------------
// Reviews fetching (paginated)
// ---------------------------------------------------------------------------

/**
 * Fetch reviews for a Play Store app. Paginates using nextPaginationToken.
 *
 * @param {string} appId       - Package name (e.g. "com.Slack")
 * @param {string} lang        - Language code (default: "en")
 * @param {string} country     - Country code (default: "us")
 * @param {number} maxReviews  - Max reviews to fetch (default: 100)
 * @returns {Promise<Array>}   - Array of normalized review objects
 */
export async function fetchReviews(appId, lang = "en", country = "us", maxReviews = 100) {
  const reviews = [];
  let nextPaginationToken = undefined;
  const batchSize = Math.min(150, maxReviews); // google-play-scraper max per call is ~150

  while (reviews.length < maxReviews) {
    const remaining = maxReviews - reviews.length;
    const num = Math.min(batchSize, remaining);

    log(`[reviews] Fetching ${num} reviews (total so far: ${reviews.length})...`);

    let result;
    try {
      const params = {
        appId,
        lang,
        country,
        num,
        sort: gplay.sort?.NEWEST || 2, // Sort by newest
      };
      if (nextPaginationToken) {
        params.nextPaginationToken = nextPaginationToken;
      }
      result = await gplay.reviews(params);
    } catch (err) {
      log(`[reviews] Error fetching reviews: ${err.message}`);
      break;
    }

    const batch = result.data || [];
    if (batch.length === 0) {
      log(`[reviews] No more reviews available`);
      break;
    }

    for (const r of batch) {
      if (reviews.length >= maxReviews) break;
      reviews.push(normalizeReview(r));
    }

    log(`[reviews] Got ${batch.length} reviews (total: ${reviews.length})`);

    nextPaginationToken = result.nextPaginationToken;
    if (!nextPaginationToken) {
      log(`[reviews] No more pages`);
      break;
    }
  }

  return reviews;
}
