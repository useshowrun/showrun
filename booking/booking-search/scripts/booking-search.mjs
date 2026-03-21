#!/usr/bin/env node
/**
 * Booking.com Hotel Search Scraper
 *
 * Searches Booking.com for hotels/properties in any city with check-in/checkout dates.
 * Returns up to 25 properties per page with full metadata.
 *
 * Strategy:
 *   1. Navigate to Booking.com homepage to initialize session/cookies (bypasses AWS WAF)
 *   2. Use autocomplete GraphQL API (autoCompleteSuggestions) to resolve dest_id for city
 *   3. Navigate to search results URL with dest_id (SSR HTML — no GraphQL for results)
 *   4. Extract data from [data-testid="property-card"] elements using stable selectors
 *
 * Usage:
 *   node booking-search.mjs <location> [checkin] [checkout] [options]
 *
 * Examples:
 *   node booking-search.mjs "Istanbul" 2026-04-01 2026-04-02
 *   node booking-search.mjs "Paris" 2026-06-15 2026-06-20 --sort price --offset 25
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
  lookupDestination,
  buildSearchUrl,
  extractSearchResults,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help") {
  emitError(
    "MISSING_ARG",
    "Usage: node booking-search.mjs <location> [checkin] [checkout] [--adults N] [--rooms N] [--offset N] [--sort key]"
  );
}

const location = args[0];

// Date defaults: tomorrow and day after
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
let offset = 0;
let sortBy = "popularity";

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--adults" && args[i + 1]) {
    adults = parseInt(args[++i], 10) || 2;
  } else if (args[i] === "--rooms" && args[i + 1]) {
    rooms = parseInt(args[++i], 10) || 1;
  } else if (args[i] === "--offset" && args[i + 1]) {
    offset = parseInt(args[++i], 10) || 0;
  } else if (args[i] === "--sort" && args[i + 1]) {
    sortBy = args[++i];
  } else if (!checkin && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
    checkin = args[i];
  } else if (!checkout && /^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
    checkout = args[i];
  }
}

if (!checkin) checkin = defaultCheckin();
if (!checkout) checkout = defaultCheckout(checkin);

// Calculate nights
const nights = Math.round(
  (new Date(checkout).getTime() - new Date(checkin).getTime()) / (1000 * 60 * 60 * 24)
);

log(`[booking-search] Location: "${location}"`);
log(`[booking-search] Dates: ${checkin} → ${checkout} (${nights} night${nights !== 1 ? "s" : ""})`);
log(`[booking-search] Adults: ${adults}, Rooms: ${rooms}, Offset: ${offset}, Sort: ${sortBy}`);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log("[booking-search] Launching browser...");

async function main() {
const browser = await createBookingBrowser(Camoufox);

try {
  const context = await createBookingContext(browser);
  const page = await context.newPage();

  // Step 1: Init session (required for WAF bypass + cookies)
  await initBookingSession(page);

  // Step 2: Look up destination ID
  log(`[booking-search] Looking up destination: "${location}"...`);
  const dest = await lookupDestination(page, location);

  if (!dest) {
    await browser.close();
    emitError(
      "DESTINATION_NOT_FOUND",
      `Could not find destination: "${location}". Try a more specific city name.`
    );
  }

  log(`[booking-search] Destination: ${dest.label} (destId=${dest.destId}, type=${dest.destType})`);

  // Step 3: Build search URL and navigate
  const searchUrl = buildSearchUrl({
    location: dest.label,
    destId: dest.destId,
    destType: dest.destType.toLowerCase(),
    checkin,
    checkout,
    adults,
    rooms,
    offset,
    sortBy,
  });

  log(`[booking-search] Navigating to search results: ${searchUrl.substring(0, 150)}...`);

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Wait for SSR content to be present
  await delay(6000);

  // Verify we're on the search results page
  const pageTitle = await page.title();
  const finalUrl = page.url();
  log(`[booking-search] Page title: ${pageTitle}`);
  log(`[booking-search] Final URL: ${finalUrl.substring(0, 200)}`);

  // Check if redirected to homepage (destination not found / WAF issue)
  if (
    finalUrl.includes("/index.") ||
    pageTitle.includes("Official site") ||
    pageTitle.includes("largest selection")
  ) {
    await browser.close();
    emitError(
      "SEARCH_FAILED",
      `Search redirected to homepage. Destination "${location}" may not be valid, or try again.`
    );
  }

  // Step 4: Extract hotel cards
  const results = await extractSearchResults(page);

  log(`[booking-search] Extracted ${results.length} properties`);

  if (results.length === 0) {
    // Check if page has no results message
    const noResults = await page.evaluate(() => {
      return document.body?.textContent?.includes("no results") ||
             document.body?.textContent?.includes("No properties found") ||
             document.querySelectorAll('[data-testid="property-card"]').length === 0;
    });

    if (noResults) {
      await browser.close();
      emitResult({
        location: dest.label,
        destId: dest.destId,
        destType: dest.destType,
        destLabel: dest.label,
        checkin,
        checkout,
        totalNights: nights,
        offset,
        results: [],
        meta: {
          note: "No properties found for this search",
          scrapedAt: new Date().toISOString(),
          authenticated: !!process.env.BOOKING_COOKIES,
        },
      });
      return;
    }
  }

  await browser.close();

  emitResult({
    location,
    destId: dest.destId,
    destType: dest.destType,
    destLabel: dest.label,
    checkin,
    checkout,
    totalNights: nights,
    adults,
    rooms,
    offset,
    sortBy,
    results,
    meta: {
      pageTitle,
      scrapedAt: new Date().toISOString(),
      authenticated: !!process.env.BOOKING_COOKIES,
    },
  });
} catch (err) {
  await browser.close().catch(() => {});
  emitError("SCRAPER_ERROR", err.message);
}
}

main();
