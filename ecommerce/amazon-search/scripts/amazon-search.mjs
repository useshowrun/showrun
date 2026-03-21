#!/usr/bin/env node

/**
 * Amazon Search Scraper
 *
 * Searches Amazon for products and returns paginated results.
 * No login required.
 *
 * Strategy:
 *   1. Navigate to Amazon search URL with camoufox (fingerprinted Firefox)
 *   2. Extract all search result cards via [data-component-type="s-search-result"]
 *      with data-asin attribute (stable, Amazon-owned identifiers)
 *   3. Parse pricing from .a-price .a-offscreen (screen-reader accessible price)
 *   4. Parse ratings from span[aria-label*="out of 5"] (aria-label = stable)
 *   5. Support pagination via --page argument
 *
 * Usage:
 *   node amazon-search.mjs <query> [maxResults] [--page N] [--country US|UK|DE|...]
 *   node amazon-search.mjs <query> [maxResults] [--sort relevanceblender|price-asc-rank|price-desc-rank|review-rank|date-desc-rank]
 *
 * Examples:
 *   node amazon-search.mjs "wireless headphones" 20
 *   node amazon-search.mjs "laptop stand" 10 --country UK
 *   node amazon-search.mjs "coffee maker" 30 --sort review-rank
 *   node amazon-search.mjs "running shoes" 20 --page 2
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   { query, country, domain, page, totalText, count,
 *     results[]: { asin, title, url, priceRaw, price, originalPriceRaw,
 *                  rating, reviewCount, thumbnailUrl, imageUrl,
 *                  isPrime, isSponsored, deliveryInfo } }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  parsePrice,
  parseCount,
  getAmazonDomain,
  createBrowser,
  createContext,
  extractAmazonSearch,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args[0] || args[0] === "--help") {
  emitError(
    "MISSING_ARG",
    "Usage: node amazon-search.mjs <query> [maxResults] [--page N] [--sort <sort>] [--country US|UK|...]"
  );
}

const query = args[0];
const maxResults = parseInt(args[1]) || 20;

const pageArg = (() => {
  const idx = args.indexOf("--page");
  return idx >= 0 ? parseInt(args[idx + 1]) || 1 : 1;
})();

const sortArg = (() => {
  const idx = args.indexOf("--sort");
  return idx >= 0 ? args[idx + 1] : "relevanceblender"; // default: relevance
})();

const countryArg = (() => {
  const idx = args.indexOf("--country");
  return idx >= 0 ? (args[idx + 1] || "US").toUpperCase() : "US";
})();

const country = countryArg;
const domain = getAmazonDomain(country);

// Valid sort values
const VALID_SORTS = [
  "relevanceblender",  // Relevance (default)
  "price-asc-rank",   // Price: Low to High
  "price-desc-rank",  // Price: High to Low
  "review-rank",      // Avg. Customer Review
  "date-desc-rank",   // Newest Arrivals
  "featured",         // Featured
];

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(query, page, sort, domain) {
  const params = new URLSearchParams({
    k: query,
    page: String(page),
    s: sort,
    ref: `sr_pg_${page}`,
  });
  return `https://www.${domain}/s?${params}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching Amazon for: "${query}"`);
  log(`Country: ${country} (${domain})`);
  log(`Page: ${pageArg}, Max results: ${maxResults}, Sort: ${sortArg}`);

  const browser = await createBrowser();
  const allResults = [];

  try {
    const context = await createContext(browser, country);
    const page = await context.newPage();

    // Block unnecessary resources
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["video", "font", "websocket"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    let currentPage = pageArg;
    let totalText = null;

    while (allResults.length < maxResults) {
      const searchUrl = buildSearchUrl(query, currentPage, sortArg, domain);
      log(`\nFetching page ${currentPage}: ${searchUrl}`);

      const response = await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const status = response ? response.status() : 0;
      log(`Response status: ${status}`);

      if (status === 404 || status === 503) {
        if (currentPage > pageArg) {
          log("No more pages available");
          break;
        }
        emitError("FETCH_FAILED", `Amazon returned ${status} for search page ${currentPage}`);
      }

      await delay(2500);

      // Check for bot detection
      const pageTitle = await page.title();
      log(`Page title: ${pageTitle}`);

      if (
        pageTitle.toLowerCase().includes("robot check") ||
        pageTitle.toLowerCase().includes("captcha")
      ) {
        emitError(
          "BOT_DETECTED",
          `Amazon bot detection triggered on page ${currentPage}. Title: "${pageTitle}"`
        );
      }

      // Wait for search results to appear
      try {
        await page.waitForSelector('[data-component-type="s-search-result"]', {
          timeout: 15000,
        });
      } catch {
        // May be no results or a different layout
        const noResultsEl = await page.$('.s-no-outline, [data-component-type="s-no-results"]');
        if (noResultsEl) {
          log("No results found for this query");
          break;
        }
        log("Warning: search result selector not found within timeout");
      }

      // Extract results from this page
      const pageData = await page.evaluate(extractAmazonSearch);
      log(`Found ${pageData.results.length} results on page ${currentPage}`);

      if (!totalText && pageData.totalText) {
        totalText = pageData.totalText;
        log(`Total results text: ${totalText}`);
      }

      // Parse prices and add to results
      for (const item of pageData.results) {
        if (allResults.length >= maxResults) break;

        const parsed = {
          ...item,
          price: parsePrice(item.priceRaw),
          originalPrice: parsePrice(item.originalPriceRaw),
        };

        allResults.push(parsed);
      }

      log(`Total collected: ${allResults.length}/${maxResults}`);

      // Check if there's a next page
      const nextBtn = await page.$('.s-pagination-next:not(.s-pagination-disabled)');
      if (!nextBtn || allResults.length >= maxResults) {
        log("No more pages or reached maxResults limit");
        break;
      }

      currentPage++;

      // Polite delay between pages
      await delay(2000);
    }

    log(`\nDone. Total products: ${allResults.length}`);

    emitResult({
      query,
      country,
      domain,
      sort: sortArg,
      startPage: pageArg,
      endPage: currentPage,
      totalText: totalText || null,
      count: allResults.length,
      results: allResults,
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
