#!/usr/bin/env node

/**
 * Google Maps Reviews Scraper
 *
 * Fetches paginated reviews for a Google Maps place.
 * Uses camoufox-js for anti-detect browser, intercepts the internal
 * listugcposts XHR endpoint to paginate all reviews efficiently.
 *
 * Usage:
 *   node google-maps-reviews.mjs <placeId|url> [--max N] [--sort SORT_MODE]
 *
 * Examples:
 *   node google-maps-reviews.mjs "ChIJi4Zj86xP0xQRNsqp2ceMJ38"
 *   node google-maps-reviews.mjs "ChIJi4Zj86xP0xQRNsqp2ceMJ38" --max 100 --sort newest
 *   node google-maps-reviews.mjs "https://www.google.com/maps/place/..." --max 50
 *
 * Sort modes:
 *   most_relevant (default), newest, highest_rating, lowest_rating
 *
 * Output:
 *   RESULT:{json} to stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));

if (!input) {
  emitError(
    "MISSING_ARG",
    "Usage: node google-maps-reviews.mjs <placeId|url> [--max N] [--sort SORT_MODE]"
  );
}

const maxArg = args.indexOf("--max");
const maxReviews = maxArg !== -1 ? parseInt(args[maxArg + 1], 10) : 50;

const sortArg = args.indexOf("--sort");
const sortMode = sortArg !== -1 ? args[sortArg + 1] : "most_relevant";

// Map sort mode to Google Maps internal sort value
// 1 = most_relevant, 2 = newest, 3 = highest_rating, 4 = lowest_rating
const SORT_MAP = {
  most_relevant: 1,
  newest: 2,
  highest_rating: 3,
  lowest_rating: 4,
};
const sortValue = SORT_MAP[sortMode] || 1;

// ---------------------------------------------------------------------------
// Build target URL
// ---------------------------------------------------------------------------

const isUrl = input.startsWith("http://") || input.startsWith("https://");

let targetUrl;
if (isUrl) {
  const u = new URL(input);
  u.searchParams.set("hl", "en");
  targetUrl = u.toString();
} else {
  targetUrl = `https://www.google.com/maps/place/?q=place_id:${input}&hl=en`;
}

// ---------------------------------------------------------------------------
// Parse a single review from the listugcposts response item.
//
// Data structure (reverse engineered):
//   reviewItem = [ mainBlock, null, batchToken ]
//   mainBlock[0] = reviewId (string)
//   mainBlock[1] = meta array (length 16):
//     [0] = placeFeatureId ("0x...:0x...")
//     [2] = createTimestamp (microseconds)
//     [4] = authorInfo array:
//       [5] = authorDetail array:
//         [0] = name, [1] = avatarUrl, [2][0] = profileUrl
//         [3] = contributorId, [5] = reviewCount (int), [6] = photoCount (int)
//         [8] = [localGuideFlag, level, ?] — level>0 means IS local guide
//         [10][0] = reviewCountString ("8 reviews", "Local Guide · 185 reviews")
//     [6] = relativeTime string ("a year ago")
//   mainBlock[2] = rating+photos block (length 16):
//     [0][0] = star rating (1-5 integer)
//     [2][i][1][6][0] = photo URL
//     [15][0][0] = review text
//   mainBlock[3] = owner response block (length 15):
//     [3] = ownerResponse relativeTime
//     [14][0][0] = ownerResponse text
//   mainBlock[4][6][1][0][0] = likes count (int)
// ---------------------------------------------------------------------------

function parseReview(reviewItem) {
  try {
    const mainBlock = reviewItem[0];
    if (!mainBlock || !Array.isArray(mainBlock)) return null;

    const reviewId = typeof mainBlock[0] === "string" ? mainBlock[0] : null;

    const meta = mainBlock[1];
    let authorName = null, avatarUrl = null, profileUrl = null;
    let contributorId = null, localGuide = false, reviewCount = null;
    let relativeTime = null, absoluteDate = null;

    if (Array.isArray(meta)) {
      relativeTime = typeof meta[6] === "string" ? meta[6] : null;

      // Timestamp in microseconds
      if (typeof meta[2] === "number" && meta[2] > 0) {
        absoluteDate = new Date(meta[2] / 1000).toISOString().split("T")[0];
      }

      const authorInfo = meta[4];
      if (Array.isArray(authorInfo) && Array.isArray(authorInfo[5])) {
        const ad = authorInfo[5];
        authorName = typeof ad[0] === "string" ? ad[0] : null;
        avatarUrl = typeof ad[1] === "string" ? ad[1] : null;
        profileUrl = Array.isArray(ad[2]) && typeof ad[2][0] === "string"
          ? ad[2][0] : null;
        contributorId = typeof ad[3] === "string" ? ad[3] : null;
        reviewCount = typeof ad[5] === "number" ? ad[5] : null;

        // Local Guide detection: ad[8] = [localGuideFlag, level, ?]
        // Level > 0 → is a Local Guide
        if (Array.isArray(ad[8]) && ad[8].length >= 2) {
          localGuide = Number(ad[8][1]) > 0;
        }
        // Also check count string "Local Guide · N reviews"
        if (!localGuide && Array.isArray(ad[10]) && typeof ad[10][0] === "string") {
          localGuide = ad[10][0].toLowerCase().includes("local guide");
        }
        if (!localGuide && ad[9] === 1) localGuide = true;
      }
    }

    // Rating, photos, text
    const rpBlock = mainBlock[2];
    let rating = null, reviewText = null;
    const photos = [];

    if (Array.isArray(rpBlock)) {
      // Rating: [0][0]
      if (Array.isArray(rpBlock[0]) && typeof rpBlock[0][0] === "number") {
        rating = rpBlock[0][0];
      }
      // Text: [15][0][0]
      if (Array.isArray(rpBlock[15]) && Array.isArray(rpBlock[15][0])) {
        const t = rpBlock[15][0][0];
        if (typeof t === "string") reviewText = t;
      }
      // Photos: [2][i] → [1][6][0]
      if (Array.isArray(rpBlock[2])) {
        for (const pe of rpBlock[2]) {
          try {
            const detail = pe[1];
            if (Array.isArray(detail) && Array.isArray(detail[6]) && typeof detail[6][0] === "string") {
              photos.push(detail[6][0]);
            }
          } catch { /* skip */ }
        }
      }
    }

    // Owner response
    let ownerResponse = null;
    const ownerBlock = mainBlock[3];
    if (Array.isArray(ownerBlock)) {
      let ownerText = null;
      if (Array.isArray(ownerBlock[14]) && Array.isArray(ownerBlock[14][0])) {
        const t = ownerBlock[14][0][0];
        if (typeof t === "string") ownerText = t;
      }
      const ownerRelTime = typeof ownerBlock[3] === "string" ? ownerBlock[3] : null;
      let ownerDate = null;
      if (typeof ownerBlock[1] === "number" && ownerBlock[1] > 0) {
        ownerDate = new Date(ownerBlock[1] / 1000).toISOString().split("T")[0];
      }
      if (ownerText) {
        ownerResponse = { text: ownerText, relativeTime: ownerRelTime, date: ownerDate };
      }
    }

    // Likes
    let likes = null;
    try {
      const linksBlock = mainBlock[4];
      if (Array.isArray(linksBlock) && Array.isArray(linksBlock[6])) {
        const likeArr = linksBlock[6][1];
        if (Array.isArray(likeArr) && Array.isArray(likeArr[0]) && typeof likeArr[0][0] === "number") {
          likes = likeArr[0][0];
        }
      }
    } catch { /* likes not available */ }

    return {
      reviewId,
      rating,
      text: reviewText,
      relativeTime,
      absoluteDate,
      author: {
        name: authorName,
        profileUrl,
        avatarUrl,
        contributorId,
        localGuide,
        reviewCount,
      },
      ownerResponse,
      photos,
      likes,
    };
  } catch (err) {
    log(`Error parsing review: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Paginate reviews using the captured XHR URL template.
// Strategy: capture the first listugcposts URL, then replay it with the
// pagination token substituted in the pb parameter.
//
// The pb param has the structure:
//   !1m6!1s<featureId>...  <- place info
//   !2m2!1i<N>!2s<token>   <- page size + page token
//   ...                    <- session + feature flags
//
// To paginate: replace !2s<empty> with !2s<nextPageToken>
// The next page token comes from data[1] in the response.
// ---------------------------------------------------------------------------

async function paginateReviews(page, templateUrl, sortVal, maxCount) {
  const reviews = [];
  const seenIds = new Set();

  // Parse the template URL to extract its parts
  const urlObj = new URL(templateUrl);
  const basePb = decodeURIComponent(urlObj.searchParams.get("pb") || "");

  log(`Template URL pb: ${basePb.substring(0, 100)}...`);

  // Apply sort if needed: modify !3i<N> sort param in pb
  // The sort value appears after !2m2 block
  let pbTemplate = basePb;
  if (sortVal !== 1) {
    // Check if !3i already exists; if so, replace; otherwise add after !2m2!...!2s...
    const sortPattern = /!3i\d+/;
    if (sortPattern.test(pbTemplate)) {
      pbTemplate = pbTemplate.replace(sortPattern, `!3i${sortVal}`);
    } else {
      // Insert !3iN after the !2m2 block
      pbTemplate = pbTemplate.replace(
        /(!2m2!1i\d+!2s[^!]*)/,
        `$1!3i${sortVal}`
      );
    }
    log(`Applied sort ${sortVal} to pb template`);
  }

  async function fetchPage(pageToken) {
    // Substitute the page token in the pb parameter
    // Replace !2s<anything> (which is the token part) with !2s<newToken>
    const newPb = pbTemplate.replace(
      /!2m2!1i(\d+)!2s[^!]*/,
      `!2m2!1i$1!2s${pageToken}`
    );

    urlObj.searchParams.set("pb", newPb);
    const fetchUrl = urlObj.toString();

    const responseText = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { "Accept": "*/*" }
        });
        return await resp.text();
      } catch (e) {
        return null;
      }
    }, fetchUrl);

    if (!responseText) return { items: [], nextToken: null };

    try {
      const json = responseText.replace(/^\)\]\}'\s*/, "");
      const data = JSON.parse(json);
      return {
        items: Array.isArray(data[2]) ? data[2] : [],
        nextToken: typeof data[1] === "string" ? data[1] : null,
      };
    } catch (e) {
      log(`Parse error: ${e.message}`);
      return { items: [], nextToken: null };
    }
  }

  let pageToken = "";
  let pageNum = 0;
  let noNewCount = 0;

  while (reviews.length < maxCount) {
    pageNum++;
    log(`Page ${pageNum} (collected: ${reviews.length}/${maxCount})...`);

    const { items, nextToken } = await fetchPage(pageToken);
    log(`  Raw items: ${items.length}, next token: ${nextToken ? "yes" : "no"}`);

    if (items.length === 0) {
      log("No reviews returned — reached end");
      break;
    }

    let newCount = 0;
    for (const item of items) {
      const parsed = parseReview(item);
      if (!parsed || !parsed.reviewId) continue;
      if (seenIds.has(parsed.reviewId)) continue;
      seenIds.add(parsed.reviewId);
      reviews.push(parsed);
      newCount++;
      if (reviews.length >= maxCount) break;
    }

    log(`  New: ${newCount}. Total: ${reviews.length}`);

    if (newCount === 0) {
      noNewCount++;
      if (noNewCount >= 2) {
        log("No new reviews in 2 consecutive pages — stopping");
        break;
      }
    } else {
      noNewCount = 0;
    }

    if (!nextToken || reviews.length >= maxCount) break;

    pageToken = nextToken;
    await delay(800);
  }

  return reviews;
}

// ---------------------------------------------------------------------------
// Extract place metadata from loaded page
// ---------------------------------------------------------------------------

async function extractPlaceInfo(page) {
  return await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const name = h1 ? h1.textContent.trim() : null;

    let totalReviewCount = null;
    const reviewSpan =
      document.querySelector('span[aria-label*=" reviews"]') ||
      document.querySelector('span[aria-label*=" review"]');
    if (reviewSpan) {
      const m = (reviewSpan.getAttribute("aria-label") || "").match(/([0-9,]+)\s+reviews?/i);
      if (m) totalReviewCount = parseInt(m[1].replace(/,/g, ""), 10);
    }

    let rating = null;
    for (const el of document.querySelectorAll('[role="img"][aria-label], span[aria-label]')) {
      const label = el.getAttribute("aria-label") || "";
      const m = label.match(/([0-9]+[.,][0-9])\s*stars?/i);
      if (m) { rating = parseFloat(m[1].replace(",", ".")); break; }
    }

    const url = window.location.href;
    const placeIdMatch = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);

    return {
      name,
      totalReviewCount,
      rating,
      url,
      placeId: placeIdMatch ? placeIdMatch[1] : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Google Maps Reviews Scraper`);
  log(`Input: ${input}`);
  log(`Max: ${maxReviews}, Sort: ${sortMode} (internal: ${sortValue})`);

  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Capture the first listugcposts XHR
    let capturedXhrUrl = null;

    context.on("request", (req) => {
      const url = req.url();
      if (url.includes("listugcposts") && !capturedXhrUrl) {
        capturedXhrUrl = url;
        log(`Captured listugcposts XHR URL`);
      }
    });

    const page = await context.newPage();

    log("Navigating...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Handle consent
    await delay(2000);
    try {
      const btn = page.locator('button[aria-label*="Accept all"], form[action*="consent"] button').first();
      if (await btn.isVisible({ timeout: 3000 })) {
        log("Dismissing consent...");
        await btn.click();
        await delay(1500);
      }
    } catch { /* no consent */ }

    // Wait for place to load
    log("Waiting for place page...");
    let loaded = false;
    for (let i = 0; i < 20; i++) {
      const h1 = await page.locator("h1").count();
      if (h1 > 0) {
        const text = await page.locator("h1").first().textContent();
        if (text && text.trim() && text.trim() !== "Google Maps") {
          log(`Loaded: "${text.trim()}"`);
          loaded = true;
          break;
        }
      }
      await delay(1000);
    }

    if (!loaded) emitError("PLACE_NOT_LOADED", "Place details page did not load");

    await delay(1000);
    const placeInfo = await extractPlaceInfo(page);
    log(`Place: ${placeInfo.name}, Rating: ${placeInfo.rating}, Reviews: ${placeInfo.totalReviewCount}`);

    // Handle no reviews case
    if (placeInfo.totalReviewCount === 0) {
      emitResult({
        placeId: placeInfo.placeId || (!isUrl ? input : null),
        name: placeInfo.name,
        rating: placeInfo.rating,
        totalReviewCount: 0,
        sort: sortMode,
        reviewsFetched: 0,
        reviews: [],
        url: placeInfo.url,
      });
      return;
    }

    // Click Reviews tab to trigger the listugcposts XHR
    log("Clicking Reviews tab...");
    const reviewTabSelectors = [
      'button[aria-label*="Reviews for"]',
      'button[aria-label*="Reviews,"]',
      'button:has-text("Reviews")',
    ];
    
    for (const sel of reviewTabSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          log(`Clicked: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    // Wait for XHR to fire (up to 10s)
    log("Waiting for listugcposts XHR...");
    for (let i = 0; i < 20 && !capturedXhrUrl; i++) {
      await delay(500);
    }

    if (!capturedXhrUrl) {
      emitError(
        "NO_REVIEWS_XHR",
        "Could not capture the reviews XHR. The place may not support reviews, or the page did not trigger the XHR."
      );
    }

    log(`Using XHR template: ${capturedXhrUrl.substring(0, 100)}...`);

    // Apply sort if needed: click sort button
    if (sortValue !== 1) {
      log(`Applying sort: ${sortMode}...`);
      try {
        const sortBtn = page.locator('button[aria-label="Sort reviews"]').first();
        if (await sortBtn.isVisible({ timeout: 3000 })) {
          await sortBtn.click();
          await delay(1000);
          const sortLabels = { 2: "Newest", 3: "Highest rating", 4: "Lowest rating" };
          const lbl = sortLabels[sortValue];
          if (lbl) {
            const opt = page.locator(`[role="menuitem"]:has-text("${lbl}")`).first();
            if (await opt.isVisible({ timeout: 2000 })) {
              await opt.click();
              log(`Sort applied: ${lbl}`);
              await delay(2000);
              // Capture the new XHR URL that fires after sort change
              // Wait briefly for a new XHR
              let sortXhrWait = 0;
              const prevUrl = capturedXhrUrl;
              while (capturedXhrUrl === prevUrl && sortXhrWait < 5000) {
                await delay(200);
                sortXhrWait += 200;
              }
              // Note: capturedXhrUrl is updated by the listener when a new XHR fires
            }
          }
        }
      } catch (e) {
        log(`Sort error: ${e.message}`);
      }
    }

    // Paginate reviews
    log(`\nPaginating reviews (max: ${maxReviews})...`);
    const reviews = await paginateReviews(page, capturedXhrUrl, sortValue, maxReviews);

    // Resolve place ID
    let placeId = placeInfo.placeId;
    if (!placeId && !isUrl && input.startsWith("ChIJ")) placeId = input;
    if (!placeId) {
      const m = page.url().match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
      if (m) placeId = m[1];
    }

    log(`\n✓ Done: ${reviews.length} reviews for "${placeInfo.name}"`);

    emitResult({
      placeId: placeId || null,
      name: placeInfo.name,
      rating: placeInfo.rating,
      totalReviewCount: placeInfo.totalReviewCount,
      sort: sortMode,
      reviewsFetched: reviews.length,
      reviews,
      url: placeInfo.url,
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
