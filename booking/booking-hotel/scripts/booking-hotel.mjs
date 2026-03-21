#!/usr/bin/env node
/**
 * Booking.com Hotel Detail Scraper
 *
 * Scrapes full details for a specific hotel on Booking.com.
 * Works with a full URL or a hotel slug (e.g., "hotel/tr/istanbul-grand-pera").
 *
 * Strategy:
 *   1. Navigate to Booking.com homepage to init session (bypasses AWS WAF)
 *   2. Navigate to hotel detail page with check-in/checkout dates
 *   3. Wait for WAF challenge to complete (~5-10s)
 *   4. Extract data from:
 *      - JSON-LD structured data (most reliable: name, address, rating, description)
 *      - Stable data-testid selectors (facilities, photos, reviews, policies)
 *      - img[src*="bstatic.com"] for hotel photos (Booking.com's CDN)
 *
 * Usage:
 *   node booking-hotel.mjs <url-or-slug> [checkin] [checkout] [options]
 *
 * Examples:
 *   node booking-hotel.mjs "https://www.booking.com/hotel/tr/istanbul-grand-pera.en-gb.html" 2026-04-01 2026-04-02
 *   node booking-hotel.mjs "hotel/pl/teatr" 2026-04-01 2026-04-02
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Auth:
 *   Set BOOKING_COOKIES env var to a JSON array of Booking.com cookies for
 *   authenticated access (Genius discounts, etc.). Not required for public data.
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createBookingBrowser,
  createBookingContext,
  initBookingSession,
  extractHotelDetails,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help") {
  emitError(
    "MISSING_ARG",
    "Usage: node booking-hotel.mjs <hotel-url-or-slug> [checkin] [checkout] [--adults N] [--rooms N]"
  );
}

const input = args[0];

// Date defaults
function defaultCheckin() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}
function defaultCheckout(checkin) {
  const d = new Date(checkin + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

let checkin = null;
let checkout = null;
let adults = 2;
let rooms = 1;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--adults" && args[i + 1]) {
    adults = parseInt(args[++i], 10) || 2;
  } else if (args[i] === "--rooms" && args[i + 1]) {
    rooms = parseInt(args[++i], 10) || 1;
  } else if (!checkin && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
    checkin = args[i];
  } else if (!checkout && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
    checkout = args[i];
  }
}

if (!checkin) checkin = defaultCheckin();
if (!checkout) checkout = defaultCheckout(checkin);

// ---------------------------------------------------------------------------
// Resolve hotel URL
// ---------------------------------------------------------------------------

function resolveHotelUrl(input, checkin, checkout, adults, rooms) {
  let baseUrl;

  if (input.startsWith("http://") || input.startsWith("https://")) {
    // Full URL provided
    try {
      const u = new URL(input);
      // Normalize to en-gb if not already
      let pathname = u.pathname;
      if (!pathname.includes(".en-gb.")) {
        pathname = pathname.replace(/\.([a-z]{2,5})\.html$/, ".en-gb.html");
        if (!pathname.endsWith(".en-gb.html")) {
          pathname = pathname.replace(/\.html$/, ".en-gb.html");
        }
      }
      baseUrl = `https://www.booking.com${pathname}`;
    } catch (_) {
      baseUrl = input;
    }
  } else if (input.startsWith("hotel/")) {
    // Slug provided: "hotel/tr/istanbul-grand-pera"
    const slug = input.endsWith(".html") ? input : input + ".en-gb.html";
    baseUrl = `https://www.booking.com/${slug}`;
  } else {
    // Unknown format — try as-is
    baseUrl = input.startsWith("https://") ? input : `https://www.booking.com/${input}`;
  }

  // Add search params (dates + guests)
  const params = new URLSearchParams({
    checkin,
    checkout,
    group_adults: String(adults),
    no_rooms: String(rooms),
    group_children: "0",
  });

  return `${baseUrl}?${params.toString()}`;
}

const hotelUrl = resolveHotelUrl(input, checkin, checkout, adults, rooms);

log(`[booking-hotel] Input: ${input}`);
log(`[booking-hotel] Hotel URL: ${hotelUrl.substring(0, 200)}`);
log(`[booking-hotel] Dates: ${checkin} → ${checkout}, Adults: ${adults}, Rooms: ${rooms}`);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log("[booking-hotel] Launching browser...");
const browser = await createBookingBrowser(Camoufox);

try {
  const context = await createBookingContext(browser);
  const page = await context.newPage();

  // Step 1: Init session (required for WAF challenge bypass)
  await initBookingSession(page);

  // Step 2: Navigate to hotel page
  log(`[booking-hotel] Navigating to hotel page...`);

  await page.goto(hotelUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Wait for WAF challenge to complete and page to fully render
  // The hotel page initially returns HTTP 202 while the WAF token is processed,
  // then the page reloads with the actual content.
  log("[booking-hotel] Waiting for WAF challenge and page render...");
  await delay(8000);

  // Verify hotel page loaded correctly
  const pageTitle = await page.title();
  const finalUrl = page.url();

  log(`[booking-hotel] Page title: ${pageTitle}`);
  log(`[booking-hotel] Final URL: ${finalUrl.substring(0, 200)}`);

  // Check for redirects to homepage (page didn't load)
  if (
    finalUrl.includes("/index.") ||
    pageTitle.includes("Official site") ||
    pageTitle.includes("largest selection")
  ) {
    await browser.close();
    emitError(
      "PAGE_LOAD_FAILED",
      `Hotel page redirected to homepage. URL may be invalid: ${input}`
    );
  }

  // Check for "page not found" (404)
  if (
    pageTitle.toLowerCase().includes("page not found") ||
    pageTitle === "Booking.com" ||
    pageTitle === ""
  ) {
    await browser.close();
    emitError("NOT_FOUND", `Hotel not found: ${input}`);
  }

  // Check if we got the generic "online hotel reservations" title (WAF still blocking)
  if (pageTitle === "Booking.com online hotel reservations") {
    log("[booking-hotel] WAF challenge still in progress, waiting more...");
    await delay(10000);

    const retryTitle = await page.title();
    if (
      retryTitle === "Booking.com online hotel reservations" ||
      retryTitle.includes("Official site")
    ) {
      await browser.close();
      emitError(
        "WAF_BLOCKED",
        "Booking.com WAF is blocking the request. Hotel detail page could not be loaded."
      );
    }
  }

  // Step 3: Extract hotel details
  log("[booking-hotel] Extracting hotel details...");
  const hotelData = await extractHotelDetails(page);

  // Validate we got meaningful data
  if (!hotelData.name) {
    // Capture debug info
    const bodyPreview = await page.evaluate(() =>
      document.body?.textContent?.replace(/\s+/g, " ").substring(0, 500)
    );
    log(`[booking-hotel] No hotel name found. Body: ${bodyPreview}`);
    await browser.close();
    emitError(
      "EXTRACTION_FAILED",
      "Could not extract hotel name. Page may not have loaded correctly."
    );
  }

  log(`[booking-hotel] Extracted: ${hotelData.name}`);
  log(`[booking-hotel] Stars: ${hotelData.stars}, Score: ${hotelData.reviewScore} (${hotelData.reviewCount} reviews)`);
  log(`[booking-hotel] Photos: ${hotelData.photos.length}, Facilities: ${hotelData.allFacilities.length}`);

  await browser.close();

  emitResult({
    ...hotelData,
    meta: {
      ...hotelData.meta,
      scrapedAt: new Date().toISOString(),
      checkin,
      checkout,
      adults,
      rooms,
      authenticated: !!process.env.BOOKING_COOKIES,
    },
  });
} catch (err) {
  await browser.close().catch(() => {});
  emitError("SCRAPER_ERROR", err.message);
}
