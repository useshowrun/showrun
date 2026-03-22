/**
 * Shared utilities for Apple App Store scraper skills
 *
 * Data Sources:
 *   - iTunes Search API: https://itunes.apple.com/search
 *   - iTunes Lookup API: https://itunes.apple.com/lookup
 *   - App Store Reviews RSS (JSON): https://itunes.apple.com/{country}/rss/customerreviews/id={id}/page={n}/sortBy=mostRecent/json
 *
 * No authentication required — all endpoints are public.
 */

import https from "https";
import http from "http";
import { URL } from "url";

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
// HTTP fetch helper (no external dependencies)
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch a URL and return body string + status code.
 * Follows up to 5 redirects automatically.
 */
export function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects ?? 5;
    let redirectsLeft = maxRedirects;

    function doRequest(currentUrl) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": options.userAgent || DEFAULT_UA,
          Accept: "application/json, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
          ...(options.headers || {}),
        },
        timeout: options.timeout || 25000,
      };

      const req = lib.request(reqOptions, (res) => {
        // Handle redirects
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          redirectsLeft--;
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith("http")) {
            redirectUrl = new URL(redirectUrl, currentUrl).toString();
          }
          res.resume();
          return doRequest(redirectUrl);
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            finalUrl: currentUrl,
          });
        });
        res.on("error", reject);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out: ${currentUrl}`));
      });
      req.on("error", reject);
      req.end();
    }

    doRequest(urlStr);
  });
}

/**
 * Fetch and parse JSON from a URL.
 */
export async function fetchJson(urlStr, options = {}) {
  const resp = await fetchUrl(urlStr, options);
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status} for ${urlStr}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${urlStr}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// App ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract a numeric App Store app ID from various input formats:
 *   - "618783545"                              → "618783545"
 *   - "https://apps.apple.com/us/app/slack/id618783545" → "618783545"
 *   - "apps.apple.com/us/app/slack/id618783545"         → "618783545"
 *   - "id618783545"                            → "618783545"
 *
 * Returns the numeric ID string, or null if not found.
 */
export function extractAppId(input) {
  input = input.trim();

  // Plain numeric ID
  if (/^\d+$/.test(input)) {
    return input;
  }

  // "id123456" prefix
  const idPrefix = input.match(/^id(\d+)$/i);
  if (idPrefix) return idPrefix[1];

  // URL pattern: /id<digits>
  const urlMatch = input.match(/\/id(\d+)/i);
  if (urlMatch) return urlMatch[1];

  return null;
}

// ---------------------------------------------------------------------------
// App data normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw iTunes API result object into a clean app summary (for search).
 */
export function normalizeAppSummary(raw) {
  return {
    id: String(raw.trackId),
    name: raw.trackName,
    bundleId: raw.bundleId || null,
    developer: raw.artistName || null,
    rating: raw.averageUserRating != null ? Math.round(raw.averageUserRating * 100) / 100 : null,
    ratingCount: raw.userRatingCount ?? 0,
    price: raw.price ?? 0,
    currency: raw.currency || "USD",
    genre: (raw.genres && raw.genres[0]) || null,
    iconUrl: raw.artworkUrl512 || raw.artworkUrl100 || null,
    url: raw.trackViewUrl || `https://apps.apple.com/app/id${raw.trackId}`,
  };
}

/**
 * Normalize a raw iTunes API result object into a full app detail object.
 */
export function normalizeAppDetail(raw) {
  return {
    id: String(raw.trackId),
    name: raw.trackName,
    bundleId: raw.bundleId || null,
    developer: {
      name: raw.artistName || null,
      artistId: raw.artistId ? String(raw.artistId) : null,
    },
    url: raw.trackViewUrl || `https://apps.apple.com/app/id${raw.trackId}`,
    description: raw.description || null,
    rating: raw.averageUserRating != null ? Math.round(raw.averageUserRating * 100) / 100 : null,
    ratingCount: raw.userRatingCount ?? 0,
    currentVersionRating: raw.averageUserRatingForCurrentVersion != null
      ? Math.round(raw.averageUserRatingForCurrentVersion * 100) / 100
      : null,
    currentVersionRatingCount: raw.userRatingCountForCurrentVersion ?? 0,
    price: raw.price ?? 0,
    currency: raw.currency || "USD",
    inAppPurchases: raw.isGameCenterEnabled === undefined
      ? (raw.formattedPrice === "Free" ? false : null)
      : null, // iTunes API doesn't directly expose IAP flag; set null
    genres: raw.genres || [],
    primaryGenre: raw.primaryGenreName || (raw.genres && raw.genres[0]) || null,
    artworkUrl: raw.artworkUrl512 || raw.artworkUrl100 || null,
    screenshotUrls: raw.screenshotUrls || [],
    ipadScreenshotUrls: raw.ipadScreenshotUrls || [],
    minimumOsVersion: raw.minimumOsVersion || null,
    fileSizeBytes: raw.fileSizeBytes ? Number(raw.fileSizeBytes) : null,
    version: raw.version || null,
    releaseNotes: raw.releaseNotes || null,
    releaseDate: raw.releaseDate || null,
    currentVersionReleaseDate: raw.currentVersionReleaseDate || null,
    contentAdvisoryRating: raw.contentAdvisoryRating || null,
    languagesISO2A: raw.languageCodesISO2A || [],
    reviews: [], // populated separately
  };
}

// ---------------------------------------------------------------------------
// Reviews fetching
// ---------------------------------------------------------------------------

/**
 * Normalize a single review entry from the iTunes RSS JSON feed.
 */
export function normalizeReview(entry) {
  return {
    id: entry.id?.label || null,
    rating: entry["im:rating"] ? parseInt(entry["im:rating"].label, 10) : null,
    title: entry.title?.label || null,
    body: entry.content?.label || null,
    author: entry.author?.name?.label || null,
    version: entry["im:version"]?.label || null,
    date: entry.updated?.label || null,
    helpful: entry["im:voteCount"] ? parseInt(entry["im:voteCount"].label, 10) : 0,
  };
}

/**
 * Fetch reviews for an app from the iTunes RSS JSON feed.
 * Paginates from page 1 to page 10 (50 reviews/page max) until maxReviews reached or no more data.
 *
 * @param {string} appId     - Numeric app ID
 * @param {string} country   - 2-letter country code (default: "us")
 * @param {number} maxReviews - Max reviews to return (default: 100)
 * @returns {Promise<Array>} - Array of normalized review objects
 */
export async function fetchReviews(appId, country = "us", maxReviews = 100) {
  const reviews = [];
  const maxPages = 10; // iTunes RSS caps at 10 pages

  for (let page = 1; page <= maxPages && reviews.length < maxReviews; page++) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/id=${appId}/page=${page}/sortBy=mostRecent/json`;
    log(`[reviews] Fetching page ${page}: ${url}`);

    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      log(`[reviews] Error on page ${page}: ${err.message}`);
      break;
    }

    const feed = data?.feed;
    if (!feed) {
      log(`[reviews] No feed object on page ${page}`);
      break;
    }

    const entries = feed.entry;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      log(`[reviews] No entries on page ${page} — stopping pagination`);
      break;
    }

    for (const entry of entries) {
      if (reviews.length >= maxReviews) break;
      reviews.push(normalizeReview(entry));
    }

    log(`[reviews] Page ${page}: got ${entries.length} reviews (total so far: ${reviews.length})`);

    // If fewer than 50 results, we've reached the last page
    if (entries.length < 50) {
      log(`[reviews] Last page reached (${entries.length} < 50)`);
      break;
    }
  }

  return reviews;
}
