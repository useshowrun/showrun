#!/usr/bin/env node
/**
 * tripadvisor-hotel.mjs — Tripadvisor hotel detail scraper
 *
 * Fetches full hotel details from a Tripadvisor hotel review page.
 * Extracts: name, rating, review count, address, coordinates, amenities,
 * photos, and up to 10 reviews (with author, rating, title, text, date).
 *
 * Anti-bot strategy:
 *   1. Load Tripadvisor homepage (establishes Cloudflare session cookies)
 *   2. Navigate to the hotel review page
 *   3. Extract from JSON-LD (primary) + DOM review cards (secondary)
 *   Residential proxy required (SOCKS5_PROXY env var, default: 127.0.0.1:11091)
 *
 * Usage:
 *   HOTEL_URL="..." node scripts/tripadvisor-hotel.mjs
 *   HOTEL_URL="/Hotel_Review-g48561-d115817-Reviews-The_Point-Saranac_Lake_New_York.html" node scripts/tripadvisor-hotel.mjs
 *
 * OR specify locationId directly (shorter):
 *   LOCATION_ID=115817 GEO_ID=48561 node scripts/tripadvisor-hotel.mjs
 *
 * Environment:
 *   HOTEL_URL     — Full or relative TA URL (preferred)
 *   LOCATION_ID   — Tripadvisor hotel locationId (d-number in URL)
 *   GEO_ID        — Tripadvisor geoId (g-number in URL, optional)
 *   SOCKS5_PROXY  — Residential SOCKS5 proxy (default: 127.0.0.1:11091)
 *   TA_COOKIES    — JSON array of cookies for authenticated access
 *   MAX_RETRIES   — Number of retry attempts (default: 2)
 *
 * Output (stdout): RESULT:{...json...}
 * Logs (stderr): Progress and debug information
 */

import { Camoufox } from 'camoufox-js';
import {
  createTripadvisorBrowser,
  createTripadvisorContext,
  initTripadvisorSession,
  extractHotelDetail,
  emitResult,
  emitError,
  log,
  delay,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOTEL_URL = process.env.HOTEL_URL || null;
const LOCATION_ID = process.env.LOCATION_ID || null;
const GEO_ID = process.env.GEO_ID || null;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);

// Build hotel URL
let hotelUrl;
if (HOTEL_URL) {
  // Normalize: ensure full URL
  if (HOTEL_URL.startsWith('http')) {
    hotelUrl = HOTEL_URL;
  } else {
    hotelUrl = 'https://www.tripadvisor.com' + HOTEL_URL;
  }
} else if (LOCATION_ID) {
  // Build minimal URL with just the IDs — TA redirects to full URL
  const geo = GEO_ID || '0';
  hotelUrl = `https://www.tripadvisor.com/Hotel_Review-g${geo}-d${LOCATION_ID}-Reviews-Hotel.html`;
} else {
  emitError('MISSING_PARAM', 'Provide HOTEL_URL or LOCATION_ID environment variable');
}

// Validate URL format
const urlMatch = hotelUrl.match(/Hotel_Review-g(\d+)-d(\d+)-Reviews/);
if (!urlMatch && !LOCATION_ID) {
  emitError('INVALID_PARAM', `Invalid Tripadvisor hotel URL format: "${hotelUrl}"`);
}

// ---------------------------------------------------------------------------
// Main with retry
// ---------------------------------------------------------------------------

log(`=== Tripadvisor Hotel: "${hotelUrl}" ===`);

let lastError = null;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  log(`\nAttempt ${attempt}/${MAX_RETRIES}...`);

  let browser;
  try {
    browser = await createTripadvisorBrowser(Camoufox);
    const context = await createTripadvisorContext(browser);

    // Homepage warmup (establishes Cloudflare session)
    const homePage = await initTripadvisorSession(context);

    // Navigate to hotel page
    log(`[nav] Navigating to hotel page...`);
    await homePage.goto(hotelUrl, {
      waitUntil: 'networkidle',
      timeout: 45000,
    });
    await delay(3000);

    // Check body loaded
    const bodyLen = await homePage.evaluate(() => document.body.innerHTML.length);
    if (bodyLen < 10000) {
      throw new Error(`Hotel page body too small (${bodyLen} bytes) — blocked or not loaded`);
    }

    const finalUrl = homePage.url();
    log(`[nav] Final URL: ${finalUrl} (${bodyLen} bytes)`);

    // Extract hotel detail
    const detail = await extractHotelDetail(homePage);

    if (!detail.name) {
      throw new Error('Failed to extract hotel name — page may not have loaded correctly');
    }

    emitResult(detail);
    process.exit(0);
  } catch (err) {
    lastError = err;
    log(`Attempt ${attempt} failed: ${err.message}`);

    if (attempt < MAX_RETRIES) {
      log(`Retrying in 5s...`);
      await delay(5000);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

emitError('SCRAPE_FAILED', `All ${MAX_RETRIES} attempts failed: ${lastError?.message}`);
