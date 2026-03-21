#!/usr/bin/env node
/**
 * yelp-business.mjs — Yelp business detail scraper
 *
 * Gets detailed information about a specific Yelp business by slug/alias.
 * Bypasses DataDome using camoufox + residential proxy.
 *
 * Anti-bot strategy:
 *   1. Load Yelp homepage (establishes DataDome cookie via JS challenge)
 *   2. Navigate to the business page /biz/{slug}
 *   3. Intercept /gql/batch responses for structured data
 *   4. Extract from GQL data (name, rating, hours, reviews, photos, etc.)
 *
 * Business pages are less aggressively protected than search pages.
 * This skill is highly reliable after homepage warmup.
 *
 * Usage:
 *   SLUG="sightglass-coffee-san-francisco-7" node scripts/yelp-business.mjs
 *
 * Output (stdout): RESULT:{...json...}
 * Logs (stderr): Progress and debug information
 */

import { Camoufox } from 'camoufox-js';
import {
  createYelpBrowser,
  createYelpContext,
  initYelpSession,
  extractBusinessDetail,
  emitResult,
  emitError,
  log,
  delay,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SLUG = process.env.SLUG;
const INCLUDE_REVIEWS = process.env.INCLUDE_REVIEWS !== '0';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);

if (!SLUG) emitError('MISSING_PARAM', 'SLUG environment variable is required');

// Normalize: strip full URL if provided
const slug = SLUG.replace(/.*\/biz\//, '').replace(/[?#].*/, '').trim();
if (!slug) emitError('INVALID_PARAM', `Invalid slug: "${SLUG}"`);

// ---------------------------------------------------------------------------
// Main with retry
// ---------------------------------------------------------------------------
log(`=== Yelp Business: "${slug}" ===`);

let lastError = null;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  log(`\nAttempt ${attempt}/${MAX_RETRIES}...`);

  let browser;
  try {
    browser = await createYelpBrowser(Camoufox);
    const context = await createYelpContext(browser);

    // Initialize session (homepage warmup)
    const page = await initYelpSession(context);

    // Extract business detail
    const detail = await extractBusinessDetail(page, slug);

    // Strip reviews if not wanted
    if (!INCLUDE_REVIEWS) {
      detail.reviews = [];
    }

    emitResult(detail);
    process.exit(0);
  } catch (err) {
    lastError = err;
    log(`Attempt ${attempt} failed: ${err.message}`);

    if (attempt < MAX_RETRIES) {
      const waitMs = attempt * 3000;
      log(`Waiting ${waitMs / 1000}s before retry...`);
      await delay(waitMs);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

log('All attempts failed. Last error:', lastError?.message);
emitError(
  'SCRAPE_ERROR',
  `Business scrape failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
);
