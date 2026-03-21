#!/usr/bin/env node

/**
 * Pinterest Search Scraper
 *
 * Search Pinterest for pins by keyword.
 * No login required — public Pinterest search is accessible without authentication.
 *
 * Strategy:
 *   1. Navigate to pinterest.com/search/pins/?q=<keyword>
 *   2. Intercept BaseSearchResource API responses (JSON data)
 *   3. Parse pin data from resource_response.data.results
 *   4. Use bookmark for pagination (scroll to trigger more API calls)
 *
 * API: Pinterest uses /resource/BaseSearchResource/get/ which returns pin data including:
 *   - id, title, description, seo_alt_text
 *   - images (multiple sizes: 170x, 236x, 474x, 736x, orig)
 *   - pinner (username, full_name)
 *   - board (name, pin_count)
 *   - link (external URL if any)
 *   - domain (external domain if any)
 *   - created_at, reaction_counts
 *
 * Usage:
 *   node pinterest-search.mjs <keyword> [--max <N>]
 *
 * Examples:
 *   node pinterest-search.mjs "coffee latte art"
 *   node pinterest-search.mjs "minimalist home decor" --max 50
 *   node pinterest-search.mjs mountains
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
  createPinterestBrowser,
  createPinterestContext,
  parsePin,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let keyword = null;
let maxPins = 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxPins = parseInt(args[++i], 10);
  } else if (!keyword) {
    keyword = args[i];
  }
}

if (!keyword) {
  emitError("MISSING_ARG", "Usage: pinterest-search.mjs <keyword> [--max N]");
}

const encodedKeyword = encodeURIComponent(keyword);
const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodedKeyword}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching Pinterest for: "${keyword}"`);
  log(`Max pins: ${maxPins}`);
  log(`URL: ${searchUrl}`);

  const browser = await createPinterestBrowser(Camoufox);

  try {
    const context = await createPinterestContext(browser);
    const page = await context.newPage();

    // Intercept BaseSearchResource API calls
    const searchBatches = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("BaseSearchResource")) {
        try {
          const data = await res.json();
          const results = data?.resource_response?.data?.results || [];
          const bookmark = data?.resource_response?.bookmark;
          if (results.length > 0) {
            searchBatches.push({ results, bookmark });
            log(`API batch: ${results.length} pins, bookmark=${bookmark ? "yes" : "no"}`);
          }
        } catch (e) {
          log(`BaseSearchResource parse error: ${e.message}`);
        }
      }
    });

    log("Navigating to Pinterest search...");
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await delay(5000);

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    if (!finalUrl.includes("pinterest.com")) {
      emitError("LOAD_FAILED", "Failed to load Pinterest");
    }

    const title = await page.title();
    log(`Title: ${title}`);

    // Check for login wall
    const hasLoginWall = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes("Log in to see") && text.includes("Sign up");
    });

    if (hasLoginWall) {
      log("Login wall detected — results may be limited");
    }

    // Collect pins from initial batch
    let allPins = new Map(); // id -> pin

    function processBatches() {
      for (const batch of searchBatches) {
        for (const result of batch.results) {
          const pin = parsePin(result);
          if (pin?.id && !allPins.has(pin.id)) {
            allPins.set(pin.id, pin);
          }
        }
      }
    }

    processBatches();
    log(`Initial pins: ${allPins.size}`);

    // Scroll to load more if needed
    let scrollAttempts = 0;
    const maxScrolls = 20;
    let noNewCount = 0;

    while (allPins.size < maxPins && scrollAttempts < maxScrolls) {
      scrollAttempts++;
      const prevCount = allPins.size;
      const prevBatchCount = searchBatches.length;

      const currentScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate((px) => window.scrollTo(0, px), currentScroll + 600);
      await delay(2000);

      if (searchBatches.length > prevBatchCount) {
        processBatches();
        if (allPins.size > prevCount) {
          noNewCount = 0;
          log(`Scroll ${scrollAttempts}: ${allPins.size} unique pins`);
        } else {
          noNewCount++;
        }
      } else {
        noNewCount++;
      }

      if (noNewCount >= 4) {
        log(`${noNewCount} scrolls with no new pins — stopping`);
        break;
      }
    }

    const finalPins = Array.from(allPins.values()).slice(0, maxPins);

    log(`\nFinal result:`);
    log(`  Query: "${keyword}"`);
    log(`  Pins returned: ${finalPins.length}`);
    log(`  Has more: ${allPins.size >= maxPins}`);

    emitResult({
      keyword,
      searchUrl,
      pins: finalPins,
      meta: {
        returned: finalPins.length,
        hasMore: allPins.size >= maxPins,
        loginRequired: hasLoginWall,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
