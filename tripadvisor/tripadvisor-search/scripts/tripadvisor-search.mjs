#!/usr/bin/env node
/**
 * tripadvisor-search.mjs — Tripadvisor hotel search scraper
 *
 * Searches for hotels in a city by name and returns a list of hotels
 * with ratings, review counts, and prices.
 *
 * Anti-bot strategy:
 *   1. Load Tripadvisor homepage (warmup + session)
 *   2. Type city name into search box → intercept Typeahead_autocomplete GQL
 *      → get locationId (geoId) for the city
 *   3. Navigate to /Hotels-g{geoId}-{City}-Hotels.html
 *   4. Extract hotel cards using stable URL-based IDs and SVG title ratings
 *   Residential proxy required (SOCKS5_PROXY env var, default: 127.0.0.1:11091)
 *
 * Usage:
 *   CITY="New York City" node scripts/tripadvisor-search.mjs
 *   CITY="Istanbul" MAX_RESULTS=20 node scripts/tripadvisor-search.mjs
 *   CITY="Paris" GEO_ID=187147 node scripts/tripadvisor-search.mjs  # skip typeahead
 *
 * Environment:
 *   CITY         — City name to search hotels in (required)
 *   MAX_RESULTS  — Maximum hotels to return (default: 30)
 *   GEO_ID       — Known geoId to skip typeahead lookup (optional)
 *   CITY_SLUG    — Known city URL slug for direct URL (optional, e.g. "New_York_City_New_York")
 *   SOCKS5_PROXY — Residential SOCKS5 proxy (default: 127.0.0.1:11091)
 *   TA_COOKIES   — JSON array of cookies for authenticated access
 *
 * Output (stdout): RESULT:{...json...}
 * Logs (stderr): Progress and debug information
 */

import { Camoufox } from 'camoufox-js';
import {
  createTripadvisorBrowser,
  createTripadvisorContext,
  initTripadvisorSession,
  lookupLocation,
  buildHotelListingUrl,
  extractHotelListing,
  emitResult,
  emitError,
  log,
  delay,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CITY = process.env.CITY;
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS || '30', 10);
const GEO_ID = process.env.GEO_ID || null;
const CITY_SLUG = process.env.CITY_SLUG || null;

if (!CITY && !GEO_ID) {
  emitError('MISSING_PARAM', 'CITY (or GEO_ID) environment variable is required');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(`=== Tripadvisor Hotel Search: "${CITY || 'geoId=' + GEO_ID}" ===`);

let browser;
try {
  browser = await createTripadvisorBrowser(Camoufox);
  const context = await createTripadvisorContext(browser);

  // Homepage warmup
  const page = await initTripadvisorSession(context);

  // Resolve location to geoId
  let geoId = GEO_ID;
  let locationName = CITY;
  let citySlug = CITY_SLUG;

  if (!geoId) {
    log(`[search] Looking up location: "${CITY}"`);
    const location = await lookupLocation(page, CITY);
    geoId = location.locationId;
    locationName = location.localizedName || CITY;
    log(`[search] Resolved "${CITY}" → geoId=${geoId} (${locationName})`);
  }

  // Build hotel listing URL
  const listingUrl = buildHotelListingUrl(geoId, citySlug);
  log(`[search] Loading hotel listing: ${listingUrl}`);

  await page.goto(listingUrl, {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await delay(3000);

  // Check page loaded
  const bodyLen = await page.evaluate(() => document.body.innerHTML.length);
  const pageTitle = await page.title();
  log(`[search] Listing page: "${pageTitle}" (${bodyLen} bytes)`);

  if (bodyLen < 10000) {
    emitError('BLOCKED', `Hotel listing page body too small (${bodyLen} bytes) — try increasing proxy warmup`);
  }

  // Extract hotel cards
  const hotels = await extractHotelListing(page, MAX_RESULTS);

  if (hotels.length === 0) {
    emitError('NO_RESULTS', `No hotels found for "${CITY || 'geoId=' + GEO_ID}"`);
  }

  emitResult({
    city: locationName,
    geoId,
    listingUrl,
    total: hotels.length,
    hotels,
  });
} catch (err) {
  emitError('SCRAPE_FAILED', err.message);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
