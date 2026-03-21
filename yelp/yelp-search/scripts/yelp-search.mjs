#!/usr/bin/env node
/**
 * yelp-search.mjs — Yelp business search scraper
 *
 * Searches Yelp for businesses by keyword and location.
 * Bypasses DataDome using camoufox + residential proxy.
 *
 * Anti-bot strategy:
 *   Yelp's /search page is blocked by DataDome (persistent IP-level block).
 *   Instead, this scraper uses the homepage typeahead (searchSuggestFrontend GQL)
 *   which returns business slugs for the query+location without navigating to /search.
 *
 *   Flow:
 *   1. Load Yelp homepage (establishes DataDome cookie via JS challenge)
 *   2. Type query into search box character by character (triggers GQL suggest)
 *   3. Collect type:"business" entries from searchSuggestFrontend GQL responses
 *   4. Optionally load each /biz/ page for detailed data (set INCLUDE_DETAIL=1)
 *   5. Return structured results
 *
 * Usage:
 *   QUERY="coffee" LOCATION="San Francisco, CA" node scripts/yelp-search.mjs
 *   QUERY="pizza" LOCATION="New York, NY" INCLUDE_DETAIL=1 node scripts/yelp-search.mjs
 *
 * Options (env vars):
 *   QUERY          — required: search term (e.g. "coffee", "sushi")
 *   LOCATION       — required: location string (e.g. "San Francisco, CA")
 *   MAX_RESULTS    — max businesses to return (default: 10)
 *   INCLUDE_DETAIL — set to "1" to fetch full data for each business (slower)
 *   SOCKS5_PROXY   — SOCKS5 proxy (default: 127.0.0.1:11091)
 *   MAX_RETRIES    — retry attempts on failure (default: 3)
 *
 * Output (stdout): RESULT:{...json...}
 * Logs (stderr): Progress and debug information
 */

import { Camoufox } from 'camoufox-js';
import {
  createYelpBrowser,
  createYelpContext,
  initYelpSession,
  searchViaSuggest,
  extractBusinessDetail,
  emitResult,
  emitError,
  log,
  delay,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QUERY = process.env.QUERY;
const LOCATION = process.env.LOCATION;
const MAX_RESULTS = Math.min(parseInt(process.env.MAX_RESULTS || '10', 10), 20);
const INCLUDE_DETAIL = process.env.INCLUDE_DETAIL === '1';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

if (!QUERY) emitError('MISSING_PARAM', 'QUERY environment variable is required');
if (!LOCATION) emitError('MISSING_PARAM', 'LOCATION environment variable is required');

// ---------------------------------------------------------------------------
// Main with retry
// ---------------------------------------------------------------------------
log(`=== Yelp Search: "${QUERY}" in "${LOCATION}" (typeahead strategy) ===`);

let lastError = null;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  log(`\nAttempt ${attempt}/${MAX_RETRIES}...`);

  let browser;
  try {
    browser = await createYelpBrowser(Camoufox);
    const context = await createYelpContext(browser);

    // Initialize session (homepage + DataDome)
    const page = await initYelpSession(context);

    // Search via typeahead GQL interception (avoids blocked /search page)
    const slugResults = await searchViaSuggest(page, QUERY, LOCATION);

    if (slugResults.length === 0) {
      throw new Error(
        `No businesses found via typeahead for "${QUERY}" in "${LOCATION}". ` +
        'Try a more specific query (e.g. include location in query: "coffee San Francisco").'
      );
    }

    log(`Typeahead returned ${slugResults.length} businesses`);

    const toProcess = slugResults.slice(0, MAX_RESULTS);
    let businesses;

    if (INCLUDE_DETAIL) {
      // Load each business page for full GQL data
      log(`Loading full detail for ${toProcess.length} businesses...`);
      businesses = [];
      for (const [i, r] of toProcess.entries()) {
        log(`  [${i + 1}/${toProcess.length}] Loading /biz/${r.slug}`);
        try {
          const detail = await extractBusinessDetail(page, r.slug);
          businesses.push({ rank: i + 1, ...detail });
          // Small delay between requests to avoid rate limiting
          if (i < toProcess.length - 1) await delay(2000);
        } catch (err) {
          log(`  Failed to load ${r.slug}: ${err.message}`);
          // Include partial result from typeahead
          businesses.push({
            rank: i + 1,
            name: r.name,
            slug: r.slug,
            url: `https://www.yelp.com/biz/${r.slug}`,
            address: r.address,
            error: err.message,
          });
        }
      }
    } else {
      // Quick results from typeahead only (no biz page loads)
      businesses = toProcess.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        slug: r.slug,
        url: `https://www.yelp.com/biz/${r.slug}`,
        address: r.address,
        rating: null,
        reviewCount: null,
        priceRange: null,
        categories: [],
        isSponsored: false,
        thumbnailUrl: r.thumbnailUrl || null,
      }));
    }

    emitResult({
      businesses,
      total: businesses.length,
      returned: businesses.length,
      query: QUERY,
      location: LOCATION,
      includeDetail: INCLUDE_DETAIL,
      searchMethod: 'typeahead-gql',
      note: 'Results from homepage typeahead suggestions — most relevant businesses for the query+location. For broader search, Yelp Fusion API requires an API key.',
    });

    // Success
    process.exit(0);

  } catch (err) {
    lastError = err;
    log(`Attempt ${attempt} failed: ${err.message}`);

    if (attempt < MAX_RETRIES) {
      const waitMs = attempt * 8000;
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
  `Search failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
);
