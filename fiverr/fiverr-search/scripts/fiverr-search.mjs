#!/usr/bin/env node
/**
 * fiverr-search — Search Fiverr for freelance gigs by keyword.
 *
 * Strategy:
 *   1. Navigate to /search/gigs?query=<keyword>&sort_by=<sort>
 *   2. Extract __NEXT_DATA__ from <script id="__NEXT_DATA__"> (primary)
 *      — Next.js SSR embeds the full search results JSON in the page
 *   3. XHR intercept fallback: capture /api/v2/search/gigs or /search/gigs/json
 *   4. If Cloudflare blocks: emit BLOCKED error with proxy guidance
 *
 * Usage:
 *   node fiverr-search.mjs <query> [options]
 *
 * Options:
 *   --max <N>              Max results to return (default: 20, max: 100)
 *   --sort <sort>          Sort order: best_selling|new_arrival|rating (default: best_selling)
 *   --budget-min <N>       Min budget filter (USD)
 *   --budget-max <N>       Max budget filter (USD)
 *
 * Examples:
 *   node fiverr-search.mjs "logo design"
 *   node fiverr-search.mjs "wordpress developer" --max 10 --sort rating
 *   node fiverr-search.mjs "video editing" --budget-min 10 --budget-max 50
 *
 * Output (stdout):
 *   RESULT:{
 *     "query": string,
 *     "sort": string,
 *     "returned": number,
 *     "gigs": [
 *       {
 *         "gigId": string,
 *         "title": string,
 *         "gigUrl": string,
 *         "thumbnailUrl": string|null,
 *         "seller": {
 *           "username": string,
 *           "displayName": string,
 *           "level": string|null,
 *           "rating": number|null,
 *           "reviewCount": number,
 *           "avatarUrl": string|null,
 *           "country": string|null
 *         },
 *         "startingPrice": number|null,
 *         "currency": string,
 *         "deliveryDays": number|null,
 *         "rating": number|null,
 *         "reviewCount": number,
 *         "isProSeller": boolean,
 *         "isPro": boolean
 *       }
 *     ],
 *     "scrapedAt": string
 *   }
 *
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 * LOGS: stderr
 *
 * ENV:
 *   SOCKS5_PROXY — optional, e.g. "127.0.0.1:11091"
 */

import { Camoufox } from 'camoufox-js';
import {
  emitResult,
  emitError,
  log,
  delay,
  createFiverrBrowser,
  createFiverrContext,
  checkCloudflareBlock,
  extractNextData,
  parseSearchNextData,
  setupSearchIntercept,
  normalizeSearchGig,
  deepFind,
  deepFindArray,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  emitError(
    'MISSING_ARG',
    'Usage: node fiverr-search.mjs <query> [--max N] [--sort best_selling|new_arrival|rating] [--budget-min N] [--budget-max N]'
  );
}

const query = args[0];
let maxResults = 20;
let sort = 'best_selling';
let budgetMin = null;
let budgetMax = null;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--max':
      maxResults = parseInt(args[++i], 10);
      break;
    case '--sort':
      sort = args[++i];
      break;
    case '--budget-min':
      budgetMin = parseInt(args[++i], 10);
      break;
    case '--budget-max':
      budgetMax = parseInt(args[++i], 10);
      break;
    default:
      emitError('UNKNOWN_ARG', `Unknown argument: ${args[i]}`);
  }
}

const clampedMax = Math.min(Math.max(maxResults, 1), 100);

// Validate sort
const validSorts = ['best_selling', 'new_arrival', 'rating', 'recommended'];
if (!validSorts.includes(sort)) {
  log(`[fiverr-search] Warning: unknown sort "${sort}", defaulting to best_selling`);
  sort = 'best_selling';
}

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(q, sortBy, page = 1, minBudget = null, maxBudget = null) {
  const params = new URLSearchParams({
    query: q,
    sort_by: sortBy,
  });

  if (page > 1) params.set('page', String(page));
  if (minBudget != null) params.set('min_budget', String(minBudget));
  if (maxBudget != null) params.set('max_budget', String(maxBudget));

  return `https://www.fiverr.com/search/gigs?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Extract gigs from a loaded page
// ---------------------------------------------------------------------------

async function extractGigsFromPage(page, url) {
  // Strategy 1: __NEXT_DATA__
  const nextData = await extractNextData(page);
  if (nextData) {
    log('[fiverr-search] __NEXT_DATA__ found, parsing...');
    const gigs = parseSearchNextData(nextData);
    if (gigs.length > 0) {
      log(`[fiverr-search] Extracted ${gigs.length} gigs from __NEXT_DATA__`);
      return { gigs, source: 'next_data' };
    }
    log('[fiverr-search] __NEXT_DATA__ present but no gigs found in standard paths');

    // Try to find any array with gig-like objects
    const rawListings = deepFindArray(nextData, 'listings', 15)
      || deepFindArray(nextData, 'gigs', 15)
      || deepFindArray(nextData, 'results', 15)
      || deepFindArray(nextData, 'items', 15);

    if (rawListings && rawListings.length > 0) {
      const gigs = rawListings.map(normalizeSearchGig).filter(
        g => g && (g.gigId || g.title)
      );
      if (gigs.length > 0) {
        log(`[fiverr-search] Extracted ${gigs.length} gigs via deep-find fallback`);
        return { gigs, source: 'next_data_deep' };
      }
    }

    // Dump top-level keys for debugging
    const keys = Object.keys(nextData?.props?.pageProps || {});
    log(`[fiverr-search] pageProps keys: ${keys.slice(0, 20).join(', ')}`);
  } else {
    log('[fiverr-search] No __NEXT_DATA__ found on page');
  }

  // Strategy 2: JSON-LD / structured data
  const jsonLdGigs = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const results = [];
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        if (data?.['@type'] === 'ItemList' && data.itemListElement) {
          results.push(...data.itemListElement);
        }
      } catch (e) { /* skip */ }
    }
    return results;
  });

  if (jsonLdGigs.length > 0) {
    log(`[fiverr-search] Found ${jsonLdGigs.length} items in JSON-LD`);
    const gigs = jsonLdGigs.map(item => {
      const g = item.item || item;
      return {
        gigId: String(g['@id'] || '').split('/').filter(Boolean).pop() || '',
        title: g.name || '',
        gigUrl: g.url || g['@id'] || '',
        thumbnailUrl: g.image || null,
        seller: {
          username: '',
          displayName: '',
          level: null,
          rating: g.aggregateRating?.ratingValue ? parseFloat(g.aggregateRating.ratingValue) : null,
          reviewCount: g.aggregateRating?.reviewCount ? parseInt(g.aggregateRating.reviewCount, 10) : 0,
          avatarUrl: null,
          country: null,
        },
        startingPrice: g.offers?.price ? parseFloat(g.offers.price) : null,
        currency: g.offers?.priceCurrency || 'USD',
        deliveryDays: null,
        rating: g.aggregateRating?.ratingValue ? parseFloat(g.aggregateRating.ratingValue) : null,
        reviewCount: g.aggregateRating?.reviewCount ? parseInt(g.aggregateRating.reviewCount, 10) : 0,
        isProSeller: false,
        isPro: false,
      };
    });
    return { gigs, source: 'json_ld' };
  }

  return { gigs: [], source: 'none' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`[fiverr-search] Searching for: "${query}" (max: ${clampedMax}, sort: ${sort})`);

  const browser = await createFiverrBrowser(Camoufox);

  try {
    const context = await createFiverrContext(browser);
    const page = await context.newPage();

    // Block unnecessary resources to speed up loading
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/tracking**', route => route.abort());
    await page.route('**/pixel**', route => route.abort());
    await page.route('**/ads/**', route => route.abort());

    // Set up XHR intercept in parallel
    const xhrPromise = setupSearchIntercept(page);

    const allGigs = [];
    let currentPage = 1;

    while (allGigs.length < clampedMax) {
      const url = buildSearchUrl(query, sort, currentPage, budgetMin, budgetMax);
      log(`[fiverr-search] Loading page ${currentPage}: ${url}`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        log(`[fiverr-search] Navigation note: ${e.message}`);
      }

      // Wait for page to settle
      await delay(4000);

      const title = await page.title().catch(() => '');
      log(`[fiverr-search] Page title: "${title}"`);

      // Check for PerimeterX / Cloudflare block
      const blocked = await checkCloudflareBlock(page);
      if (blocked) {
        log('[fiverr-search] Bot protection block detected (PerimeterX/Cloudflare)');
        if (allGigs.length === 0) {
          emitError(
            'BOT_PROTECTION_BLOCKED',
            'Fiverr blocked the request with PerimeterX ("It needs a human touch"). ' +
            'Fiverr uses PerimeterX (pxAppId: PXK3bezZfO) which requires residential IP reputation. ' +
            'Set SOCKS5_PROXY=host:port to use a residential proxy and retry.'
          );
        }
        break;
      }

      // Check for "no results" page
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (
        pageText.includes('No services found') ||
        pageText.includes('0 services available') ||
        pageText.includes("couldn't find what you're looking for")
      ) {
        log('[fiverr-search] No results found');
        break;
      }

      const { gigs, source } = await extractGigsFromPage(page, url);
      log(`[fiverr-search] Page ${currentPage}: ${gigs.length} gigs (source: ${source})`);

      if (gigs.length === 0) {
        // Check if XHR intercept caught something
        log('[fiverr-search] No gigs from page extraction, checking XHR intercept...');
        const xhrData = await Promise.race([
          xhrPromise,
          delay(3000).then(() => null),
        ]);

        if (xhrData) {
          log('[fiverr-search] XHR intercept data found');
          const xhrGigs = (
            xhrData?.listings ||
            xhrData?.gigs ||
            xhrData?.data?.listings ||
            xhrData?.data?.gigs ||
            []
          ).map(normalizeSearchGig).filter(g => g && (g.gigId || g.title));

          if (xhrGigs.length > 0) {
            allGigs.push(...xhrGigs);
            log(`[fiverr-search] XHR: ${xhrGigs.length} gigs added`);
            break; // XHR usually returns all at once
          }
        }

        log('[fiverr-search] No gigs found on this page, stopping');
        break;
      }

      allGigs.push(...gigs);
      log(`[fiverr-search] Total collected: ${allGigs.length}`);

      if (allGigs.length >= clampedMax) break;

      // Check if there's a next page
      const hasNextPage = await page.evaluate(() => {
        // Look for pagination next button
        const nextBtn = document.querySelector(
          'a[rel="next"], [aria-label="Next page"], [data-testid="pagination-next"]'
        );
        return !!nextBtn;
      }).catch(() => false);

      if (!hasNextPage) {
        log(`[fiverr-search] No next page found, stopping at page ${currentPage}`);
        break;
      }

      currentPage++;
      await delay(2000);
    }

    const limited = allGigs.slice(0, clampedMax);

    if (limited.length === 0) {
      emitResult({
        query,
        sort,
        returned: 0,
        gigs: [],
        note: 'No gigs found. Fiverr may have blocked the request or the query returned no results.',
        scrapedAt: new Date().toISOString(),
      });
      return;
    }

    emitResult({
      query,
      sort,
      returned: limited.length,
      gigs: limited,
      scrapedAt: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  log(`[fiverr-search] Fatal error: ${err.message}`);
  log(err.stack);
  emitError('FATAL', err.message);
});
