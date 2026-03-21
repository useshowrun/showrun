#!/usr/bin/env node

/**
 * Etsy Product Search Scraper
 *
 * Searches Etsy for product listings by keyword.
 * No login required — Etsy search is publicly accessible.
 *
 * Strategy:
 *   1. Navigate to etsy.com/search?q=<keyword>
 *   2. Parse DOM listing cards (identified by data-listing-id + data-shop-id attributes)
 *   3. Extract: title, price, rating, review count, listing URL, image URL, shop name
 *   4. Scroll for pagination (Etsy loads more via infinite scroll)
 *
 * Key selectors (stable — not obfuscated class names):
 *   - `[data-listing-id][data-shop-id]` — card containers
 *   - `h3[title]` — listing title (most reliable via title attribute)
 *   - `.currency-symbol` + `.currency-value` — price parts
 *   - `[aria-label*="star rating with"]` — rating + review count
 *   - `a[href*="/listing/"]` — listing URL
 *   - `img.wt-image` or `img[loading="lazy"]` — product image
 *
 * Usage:
 *   node etsy-search.mjs <keyword> [--max <N>] [--min-price <X>] [--max-price <Y>]
 *
 * Options:
 *   --max <N>           Max listings to return (default: 20)
 *   --min-price <X>     Min price filter (USD equivalent)
 *   --max-price <Y>     Max price filter (USD equivalent)
 *   --free-shipping     Filter to free shipping only
 *
 * Examples:
 *   node etsy-search.mjs "handmade ceramic mug"
 *   node etsy-search.mjs "vintage leather wallet" --max 50
 *   node etsy-search.mjs "knitted sweater" --free-shipping
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import { emitResult, emitError, log, delay } from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let keyword = null;
let maxListings = 20;
let minPrice = null;
let maxPrice = null;
let freeShippingOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max" && args[i + 1]) {
    maxListings = parseInt(args[++i], 10);
  } else if (args[i] === "--min-price" && args[i + 1]) {
    minPrice = parseFloat(args[++i]);
  } else if (args[i] === "--max-price" && args[i + 1]) {
    maxPrice = parseFloat(args[++i]);
  } else if (args[i] === "--free-shipping") {
    freeShippingOnly = true;
  } else if (!keyword) {
    keyword = args[i];
  }
}

if (!keyword) {
  emitError("MISSING_ARG", "Usage: etsy-search.mjs <keyword> [--max N] [--min-price X] [--max-price Y] [--free-shipping]");
}

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(offset = 0) {
  const params = new URLSearchParams({ q: keyword });
  if (minPrice !== null) params.set("min", String(minPrice));
  if (maxPrice !== null) params.set("max", String(maxPrice));
  if (freeShippingOnly) params.set("free_shipping", "1");
  if (offset > 0) params.set("offset", String(offset));
  return `https://www.etsy.com/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Parse listing cards from DOM
// ---------------------------------------------------------------------------

async function parseListingsFromDom(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Find all listing cards by their stable data attributes
    // data-listing-id + data-shop-id together identify a unique product card
    const cards = Array.from(
      document.querySelectorAll('[data-listing-id][data-shop-id]')
    );

    for (const card of cards) {
      const listingId = card.getAttribute('data-listing-id');
      const shopId = card.getAttribute('data-shop-id');

      if (!listingId || !shopId || seen.has(listingId)) continue;
      seen.add(listingId);

      // Title: prefer h3[title] (stable, not class-based)
      const titleEl = card.querySelector('h3[title]');
      const title = titleEl?.getAttribute('title')?.trim() || null;

      // Price: currency-symbol + currency-value class names are Etsy stable naming
      const currencySymbol = card.querySelector('.currency-symbol')?.innerText?.trim() || '';
      const currencyValue = card.querySelector('.currency-value')?.innerText?.trim() || '';
      const price = currencySymbol && currencyValue ? `${currencySymbol}${currencyValue}` : null;

      // Also get sale/original price if available
      const originalPriceEl = card.querySelector('.original-price .currency-value');
      const originalPrice = originalPriceEl
        ? `${card.querySelector('.original-price .currency-symbol')?.innerText || ''}${originalPriceEl.innerText}`
        : null;

      // Rating: aria-label="4.9 star rating with 982 reviews" (stable aria attribute)
      const ratingEl = card.querySelector('[aria-label*="star rating with"]');
      let rating = null;
      let reviewCount = null;
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute('aria-label') || '';
        const ratingMatch = ariaLabel.match(/([\d.]+)\s+star/);
        const reviewMatch = ariaLabel.match(/with\s+([\d,]+)\s+review/);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);
        if (reviewMatch) reviewCount = parseInt(reviewMatch[1].replace(/,/g, ''), 10);
      }

      // Listing URL: first link to /listing/ path — strip tracking params
      const listingLink = card.querySelector('a[href*="/listing/"]');
      let listingUrl = null;
      if (listingLink) {
        try {
          const u = new URL(listingLink.href);
          listingUrl = `${u.origin}${u.pathname}`;
        } catch {
          listingUrl = `https://www.etsy.com/listing/${listingId}/`;
        }
      } else {
        listingUrl = `https://www.etsy.com/listing/${listingId}/`;
      }

      // Product image: first img tag in the card
      const imgEl = card.querySelector('img');
      let imageUrl = imgEl?.src || null;
      // Prefer the 340x340 or 570x570 size for better quality
      if (imageUrl && imageUrl.includes('il_300x300')) {
        imageUrl = imageUrl.replace('il_300x300', 'il_570xN');
      }

      // Shop name: from shop link or rating area
      let shopName = null;
      const shopLink = card.querySelector('a[href*="/shop/"]');
      if (shopLink) {
        const shopMatch = shopLink.href?.match(/\/shop\/([^/?#]+)/);
        shopName = shopMatch ? shopMatch[1] : null;
      }
      if (!shopName) {
        // Try to extract from text after "By " pattern
        const cardText = card.innerText || '';
        const byMatch = cardText.match(/(?:By|From shop)\s+([A-Za-z0-9]+)/);
        if (byMatch) shopName = byMatch[1];
      }

      // Free shipping flag
      const hasFreeShipping =
        card.innerText?.toLowerCase().includes('free shipping') || false;

      // Badges (Bestseller, Etsy's Pick, etc.)
      const badges = [];
      const badgeEls = card.querySelectorAll('[class*="badge"], [class*="Badge"]');
      for (const badge of badgeEls) {
        const t = badge.innerText?.trim();
        if (t && t.length < 30) badges.push(t);
      }

      // Is sponsored/ad?
      const isAd = card.getAttribute('data-ad-listing') === 'true' ||
        card.innerText?.toLowerCase().includes('ad from shop') ||
        card.innerText?.toLowerCase().includes('ad・by') ||
        false;

      results.push({
        listingId,
        shopId,
        title,
        price,
        originalPrice,
        rating,
        reviewCount,
        hasFreeShipping,
        shopName,
        listingUrl,
        imageUrl,
        badges: badges.length > 0 ? [...new Set(badges)].slice(0, 3) : [],
        isAd,
      });
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const searchUrl = buildSearchUrl();
  log(`Searching Etsy for: "${keyword}"`);
  log(`Max listings: ${maxListings}`);
  log(`URL: ${searchUrl}`);

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

    log("Navigating to Etsy search...");
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await delay(5000);

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    const title = await page.title();
    log(`Title: ${title}`);

    if (title === "" || title.toLowerCase().includes("robot") || title.includes("CAPTCHA")) {
      emitError("BLOCKED", "Etsy is blocking this request (CAPTCHA or bot detection).");
    }

    // Get total result count
    const totalCountText = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const match = bodyText.match(/([\d,]+)\s+results?/i);
      return match ? match[0] : null;
    });
    log(`Total results: ${totalCountText}`);

    // Parse initial listings
    let allListings = new Map(); // listingId -> listing

    async function processPage() {
      const listings = await parseListingsFromDom(page);
      let newCount = 0;
      for (const listing of listings) {
        if (!allListings.has(listing.listingId)) {
          allListings.set(listing.listingId, listing);
          newCount++;
        }
      }
      return newCount;
    }

    await processPage();
    log(`Initial listings: ${allListings.size}`);

    // Scroll for more listings
    let scrollAttempts = 0;
    const maxScrolls = 20;
    let noNewCount = 0;

    while (allListings.size < maxListings && scrollAttempts < maxScrolls) {
      scrollAttempts++;
      const currentScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate((px) => window.scrollTo(0, px), currentScroll + 800);
      await delay(2500);

      const newCount = await processPage();
      if (newCount > 0) {
        noNewCount = 0;
        log(`Scroll ${scrollAttempts}: ${allListings.size} unique listings`);
      } else {
        noNewCount++;
        if (noNewCount >= 4) {
          log(`${noNewCount} consecutive scrolls with no new listings — stopping`);
          break;
        }
      }
    }

    const finalListings = Array.from(allListings.values()).slice(0, maxListings);

    log(`\nFinal result:`);
    log(`  Total results: ${totalCountText}`);
    log(`  Listings returned: ${finalListings.length}`);

    emitResult({
      keyword,
      searchUrl,
      totalCountText,
      listings: finalListings,
      meta: {
        returned: finalListings.length,
        hasMore: allListings.size >= maxListings,
        filters: {
          minPrice,
          maxPrice,
          freeShippingOnly,
        },
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
