/**
 * Shared utilities for Google Maps scrapers.
 */

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
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * Wait for page to stabilize (no network requests for a period).
 */
export async function waitForNetworkIdle(page, timeoutMs = 5000) {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    // Timeout is fine — just means page is still loading but we can proceed
  }
}

/**
 * Scroll to bottom of an element to trigger lazy loading.
 */
export async function scrollToBottom(page, selector, times = 5) {
  for (let i = 0; i < times; i++) {
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = el.scrollHeight;
      }, selector);
      await delay(1000);
    } catch {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Google Maps data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Parse rating string like "4.5" or "4,5" to float.
 */
export function parseRating(str) {
  if (!str) return null;
  const cleaned = str.replace(",", ".").replace(/[^0-9.]/g, "");
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

/**
 * Parse review count string like "1,234" or "1.234" or "(1,234)" to integer.
 */
export function parseReviewCount(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^0-9]/g, "");
  const val = parseInt(cleaned, 10);
  return isNaN(val) ? null : val;
}

/**
 * Extract place ID from Google Maps URL.
 * Handles both /place/... and ?cid=... formats.
 */
export function extractPlaceId(url) {
  if (!url) return null;

  // ChIJ format in URL
  const chijMatch = url.match(/place\/[^/]+\/([A-Za-z0-9_-]+)/);
  if (chijMatch) return chijMatch[1];

  // !1s0x... format in URL data
  const dataMatch = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
  if (dataMatch) return dataMatch[1];

  // data= format
  const data2Match = url.match(/data=[^&]*!1s(ChIJ[A-Za-z0-9_-]+)/);
  if (data2Match) return data2Match[1];

  return null;
}

/**
 * Build a Google Maps search URL.
 */
export function buildSearchUrl(query, location) {
  const searchTerm = location ? `${query} in ${location}` : query;
  return `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}/`;
}

/**
 * Build a Google Maps place URL from placeId.
 */
export function buildPlaceUrl(placeId) {
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}
