#!/usr/bin/env node

/**
 * Google Maps Search Scraper
 *
 * Searches Google Maps for businesses/places by query and location.
 * Uses camoufox-js for anti-detect browser automation.
 *
 * Usage:
 *   node google-maps-search.mjs <query> [location] [maxResults]
 *
 * Examples:
 *   node google-maps-search.mjs "coffee shops" "Istanbul" 20
 *   node google-maps-search.mjs "coffee" "Ankara" 10
 *   node google-maps-search.mjs "restaurants" "Berlin" 15
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
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const query = process.argv[2];
const location = process.argv[3] || "";
const maxResults = parseInt(process.argv[4] || "20", 10);

if (!query) {
  emitError(
    "MISSING_ARG",
    "Usage: node google-maps-search.mjs <query> [location] [maxResults]"
  );
}

// ---------------------------------------------------------------------------
// Build search URL with English locale
// ---------------------------------------------------------------------------

function buildSearchUrl(query, location) {
  const searchTerm = location ? `${query} in ${location}` : query;
  return `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}/?hl=en`;
}

// ---------------------------------------------------------------------------
// Extract place data from a result card article element
// Uses stable selectors only: aria-label, data-*, href patterns, text content
// ---------------------------------------------------------------------------

async function extractPlaceFromCard(card) {
  try {
    return await card.evaluate((el) => {
      // Only process actual place articles
      const article = el.querySelector('[role="article"]') ||
                      (el.getAttribute("role") === "article" ? el : null);
      if (!article) return null;

      // Name: from aria-label on the article (stable)
      const name = article.getAttribute("aria-label");
      if (!name || name.length === 0) return null;

      // URL: from the first <a> with href containing "/maps/place/" (stable)
      const link = article.querySelector('a[href*="/maps/place/"]');
      const href = link ? link.href : null;

      // Extract place ID from URL (in !19s segment) — URL structure is stable
      let placeId = null;
      if (href) {
        const m = href.match(/!19s(ChIJ[A-Za-z0-9_-]+)/);
        if (m) placeId = m[1];
      }

      // ---------------------------------------------------------------------------
      // Rating: look for span[aria-label] containing "stars" or "star"
      // Google Maps adds aria-label like "4.8 stars" or "4.8 out of 5"
      // ---------------------------------------------------------------------------
      let rating = null;
      const allSpans = Array.from(article.querySelectorAll("span[aria-label]"));
      for (const span of allSpans) {
        const label = span.getAttribute("aria-label") || "";
        // Match "4.8 stars" or "Rated 4.8 out of 5" or similar
        const m = label.match(/([0-9]+[.,][0-9])\s*star/i) ||
                  label.match(/([0-9]+[.,][0-9])\s*out\s*of/i);
        if (m) {
          rating = parseFloat(m[1].replace(",", "."));
          break;
        }
      }
      
      // Fallback: look for span with text matching a number between 1-5 with decimal
      if (!rating) {
        // Look for role="img" with aria-label
        const starImg = article.querySelector('[role="img"][aria-label*="star"]');
        if (starImg) {
          const label = starImg.getAttribute("aria-label") || "";
          const m = label.match(/([0-9]+[.,][0-9])/);
          if (m) rating = parseFloat(m[1].replace(",", "."));
        }
      }

      // ---------------------------------------------------------------------------
      // Review count: look for span[aria-label] containing "review"
      // Or span containing text like "(179)" or "1,234"
      // ---------------------------------------------------------------------------
      let reviewCount = null;
      for (const span of allSpans) {
        const label = span.getAttribute("aria-label") || "";
        const m = label.match(/([0-9,]+)\s*review/i);
        if (m) {
          reviewCount = parseInt(m[1].replace(/,/g, ""), 10);
          break;
        }
      }
      // Fallback: look for text matching "(1,234)" pattern near rating
      if (!reviewCount) {
        const allLeafSpans = Array.from(article.querySelectorAll("span")).filter(
          s => s.children.length === 0
        );
        for (const span of allLeafSpans) {
          const text = span.textContent.trim();
          // Match "(179)" or "(1,234)" or just "179" after a rating
          const m = text.match(/^\(([0-9,]+)\)$/) || text.match(/^([0-9,]+)$/);
          if (m) {
            const n = parseInt(m[1].replace(/,/g, ""), 10);
            if (n > 0 && n < 10000000) {
              // Verify there's a rating nearby (sibling or parent context)
              reviewCount = n;
              break;
            }
          }
        }
      }

      // ---------------------------------------------------------------------------
      // Category and address: use structural position + text content
      // Google Maps places: category is typically a short word like "Coffee shop",
      // address contains street numbers/names
      //
      // Strategy: collect all leaf text spans in the article, skip the name and
      // rating/count, identify category (no digits at start, relatively short) and
      // address (may start with digits or have typical address patterns)
      // ---------------------------------------------------------------------------
      let category = null;
      let address = null;
      let openStatus = null;

      // Get all leaf text nodes that aren't in the aria-label spans we already processed
      const leafTexts = Array.from(article.querySelectorAll("span, div"))
        .filter(el => el.children.length === 0)
        .map(el => el.textContent.trim())
        .filter(t => t && t !== "·" && t !== "⋅" && t !== "," && t.length > 1)
        .filter(t => {
          // Skip price indicators
          if (/^[₺$€£¥]/.test(t)) return false;
          // Skip pure numbers (could be ratings/counts)
          if (/^\(?\d+[,.]?\d*\)?$/.test(t)) return false;
          // Skip star ratings
          if (/^[0-9]+[.,][0-9]\s*stars?/i.test(t)) return false;
          return true;
        });

      // Deduplicate while preserving order
      const seen = new Set();
      const uniqueTexts = leafTexts.filter(t => {
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });

      // Remove name from candidates
      const candidates = uniqueTexts.filter(t => t !== name);

      // Open/Closed status: find a leaf span with Open/Closed text, then get parent text
      // to capture the full "Open · Closes 9:30 pm" string
      const allArticleSpans = Array.from(article.querySelectorAll("span")).filter(s => s.children.length === 0);
      for (const span of allArticleSpans) {
        const t = span.textContent.trim();
        if (/^(Open|Closed|Opens|Closes)\b/i.test(t)) {
          // Walk up to find the full status text
          const parentText = span.parentElement ? span.parentElement.textContent.trim() : t;
          const grandParentText = span.parentElement?.parentElement ? span.parentElement.parentElement.textContent.trim() : parentText;
          // Use the shortest meaningful text that includes the status
          const fullStatus = (parentText.length < 80 && parentText.length >= t.length) ? parentText : t;
          openStatus = fullStatus;
          break;
        }
      }

      for (const txt of candidates) {
        // Open/Closed status — already handled above via parent traversal
        if (/^(Open|Closed|Opens|Closes)/i.test(txt) || 
            (txt.includes("·") && /Open|Closed/i.test(txt))) {
          continue; // skip, already got it
        }
        
        // Category: relatively short, no digits at start, not an address pattern
        if (!category && txt.length < 60 && !/^\d/.test(txt) &&
            !txt.match(/\d{1,5}\s+[A-Za-z]/) && // not "123 Main St"
            !txt.match(/[A-Z]{2}\s+\d{5}/) &&    // not "NY 10001"
            txt.split(" ").length <= 5) {
          category = txt;
          continue;
        }
        
        // Address: has digits or looks like a street address
        if (!address && category && txt !== category) {
          address = txt;
        }
      }

      // Thumbnail image
      const img = article.querySelector("img");
      const thumbnail = img ? img.src : null;

      return {
        name,
        address: address || null,
        rating,
        reviewCount,
        category: category || null,
        openStatus: openStatus || null,
        placeId,
        url: href,
        thumbnail,
      };
    });
  } catch (err) {
    log(`Error extracting card data: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main scraping
// ---------------------------------------------------------------------------

async function scrapeSearchResults(page, targetCount) {
  const results = [];
  const seenIds = new Set();

  log("Waiting for search results to load...");

  // Wait for actual place result cards (role="article") — stable ARIA attribute
  let resultsFound = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const count = await page.locator('div[role="feed"] div[role="article"]').count();
    if (count > 0) {
      log(`Found ${count} place articles in feed`);
      resultsFound = true;
      break;
    }
    await delay(1000);
  }

  if (!resultsFound) {
    log("No place articles found after 30s");
    return results;
  }

  let scrollAttempts = 0;
  const maxScrollAttempts = 25;
  let noNewResultsCount = 0;

  while (results.length < targetCount && scrollAttempts < maxScrollAttempts) {
    scrollAttempts++;

    const cards = await page.locator('div[role="feed"] > div').all();
    log(`Scroll attempt ${scrollAttempts}: ${cards.length} feed items`);

    let newThisRound = 0;
    for (const card of cards) {
      const data = await extractPlaceFromCard(card);
      if (!data || !data.name) continue;

      const key = data.placeId || data.name;
      if (seenIds.has(key)) continue;

      seenIds.add(key);
      results.push(data);
      newThisRound++;

      if (results.length >= targetCount) break;
    }

    log(`New: ${newThisRound}, total: ${results.length}`);

    if (results.length >= targetCount) break;

    if (newThisRound === 0) {
      noNewResultsCount++;
      if (noNewResultsCount >= 3) {
        log("No new results in 3 consecutive scrolls, stopping");
        break;
      }
    } else {
      noNewResultsCount = 0;
    }

    // Scroll the feed to load more results
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) feed.scrollTop = feed.scrollHeight;
    });
    await delay(2000);

    // Check for end of list
    const atEnd = await page.evaluate(() => {
      const body = document.body.innerText;
      return body.includes("reached the end") || body.includes("No more results") ||
             body.includes("You've reached the end");
    });
    if (atEnd) {
      log("Reached end of results list");
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const searchUrl = buildSearchUrl(query, location);
  log(`Searching Google Maps: "${query}" in "${location || "any location"}"`);
  log(`URL: ${searchUrl}`);
  log(`Target: ${maxResults} results`);

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

    log("Navigating to Google Maps...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Handle cookie consent
    await delay(2000);
    try {
      const consentBtn = page
        .locator('button[aria-label*="Accept all"], button:has-text("Accept all"), form[action*="consent"] button')
        .first();
      if (await consentBtn.isVisible({ timeout: 3000 })) {
        log("Dismissing cookie consent...");
        await consentBtn.click();
        await delay(1500);
      }
    } catch {
      // No consent dialog
    }

    await delay(2000);

    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    const results = await scrapeSearchResults(page, maxResults);

    if (results.length === 0) {
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      log(`Page title: ${title}`);
      log(`Page text preview: ${bodyText}`);
      emitError("NO_RESULTS", "Could not extract any results from Google Maps");
    }

    log(`\nExtracted ${results.length} places`);

    emitResult({
      query,
      location,
      count: results.length,
      places: results,
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
