#!/usr/bin/env node
/**
 * Product Hunt Search Scraper
 *
 * Searches Product Hunt for products by keyword using browser automation.
 *
 * Strategy:
 *   1. Navigate to /search?q=<keyword>[&page=N]
 *   2. Extract product data from Apollo SSR inline scripts (primary)
 *      — gives: id, name, tagline, slug, productUrl, reviewsRating, reviewsCount, thumbnail
 *   3. Fall back to DOM scraping via [data-test="spotlight-result-product-<id>"] (fallback)
 *
 * Product Hunt uses Cloudflare. camoufox-js (headless Firefox) handles bot bypass.
 * Search results are rendered server-side (Next.js + Apollo) — the data is embedded
 * in inline <script> tags as Apollo SSR cache transport.
 *
 * Pagination: URL-based via ?page=N (10 products per page)
 *
 * Usage:
 *   node producthunt-search.mjs <query> [options]
 *
 * Options:
 *   --max <N>      Max products to return (default: 20, max 100)
 *   --page <N>     Start from this page number (default: 1)
 *
 * Examples:
 *   node producthunt-search.mjs "AI coding tools"
 *   node producthunt-search.mjs "password manager" --max 10
 *   node producthunt-search.mjs "productivity" --max 30
 *   node producthunt-search.mjs "developer tools" --page 2 --max 10
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  extractSearchFromApollo,
  scrapeSearchItemsFromDom,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
  emitError(
    "MISSING_ARG",
    "Usage: node producthunt-search.mjs <query> [--max N] [--page N]"
  );
}

const query = args[0];
let maxResults = 20;
let startPage = 1;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case "--max":  maxResults = parseInt(args[++i], 10); break;
    case "--page": startPage = parseInt(args[++i], 10); break;
    default:
      emitError("UNKNOWN_ARG", `Unknown argument: ${args[i]}`);
  }
}

const clampedMax = Math.min(Math.max(maxResults, 1), 100);

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(q, page = 1) {
  const params = new URLSearchParams({ q });
  if (page > 1) params.set("page", String(page));
  return `https://www.producthunt.com/search?${params}`;
}

// ---------------------------------------------------------------------------
// Scrape one page of search results
// ---------------------------------------------------------------------------

async function scrapePage(page, url) {
  log(`Loading: ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`Navigation note: ${e.message}`);
  }

  await delay(6000);

  const title = await page.title().catch(() => "");
  log(`Page title: "${title}"`);

  if (title.includes("Just a moment") || title.includes("Attention Required")) {
    log("Cloudflare challenge detected, waiting...");
    await delay(10000);
  }

  // Primary: extract from Apollo SSR inline scripts
  let items = await page.evaluate(extractSearchFromApollo);
  log(`Apollo SSR: found ${items.length} products`);

  // Fallback: DOM scraping if Apollo didn't work
  if (items.length === 0) {
    log("Apollo SSR empty, falling back to DOM scraping...");
    items = await page.evaluate(scrapeSearchItemsFromDom);
    log(`DOM scraping: found ${items.length} products`);
  }

  // Get max page from pagination links
  const paginationInfo = await page.evaluate(() => {
    const allPageLinks = document.querySelectorAll('a[href*="page="]');
    let maxPage = 1;
    for (const link of allPageLinks) {
      const href = link.getAttribute("href") || "";
      const m = href.match(/page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxPage) maxPage = n;
      }
    }
    return { maxPage };
  });

  return { items, maxPage: paginationInfo.maxPage };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching Product Hunt for: "${query}" (max: ${clampedMax}, start page: ${startPage})`);

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

    const page = await context.newPage();

    const allProducts = [];
    let currentPage = startPage;

    // Scrape pages until we have enough results or run out
    while (allProducts.length < clampedMax) {
      const url = buildSearchUrl(query, currentPage);
      const { items, maxPage } = await scrapePage(page, url);

      if (items.length === 0) {
        log(`No items on page ${currentPage}, stopping`);
        break;
      }

      allProducts.push(...items);
      log(`Total collected: ${allProducts.length}`);

      if (currentPage >= maxPage) {
        log(`Reached last page (${maxPage}), stopping`);
        break;
      }

      if (allProducts.length >= clampedMax) {
        log("Reached max results limit");
        break;
      }

      currentPage++;
      await delay(2000);
    }

    if (allProducts.length === 0) {
      const bodyText = await page
        .evaluate(() => document.body?.innerText || "")
        .catch(() => "");
      const isNoResults =
        bodyText.includes("No results") ||
        bodyText.includes("couldn't find") ||
        bodyText.includes("0 results");

      if (isNoResults) {
        emitResult({
          query,
          returned: 0,
          products: [],
          note: "No results found for this query",
          scrapedAt: new Date().toISOString(),
        });
        return;
      }

      emitError(
        "NO_DATA",
        "Could not extract products from page. Site structure may have changed."
      );
    }

    const limited = allProducts.slice(0, clampedMax);

    emitResult({
      query,
      totalFound: allProducts.length,
      returned: limited.length,
      products: limited,
      scrapedAt: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("FATAL", err.message);
});
