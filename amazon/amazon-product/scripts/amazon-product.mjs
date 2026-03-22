#!/usr/bin/env node

/**
 * Amazon Product Scraper
 *
 * Fetches full product details from an Amazon product page.
 * No login required for public product pages.
 *
 * Strategy:
 *   1. Resolve ASIN from URL or bare ASIN string
 *   2. Navigate to the product page with camoufox (fingerprinted Firefox)
 *   3. Extract all product data via stable DOM selectors:
 *      - data-asin, #productTitle, aria-label stars, #acrCustomerReviewText
 *      - data-a-dynamic-image JSON for high-res images
 *      - #feature-bullets, #productDescription, spec tables
 *   4. Optionally scrape first page of customer reviews
 *
 * Usage:
 *   node amazon-product.mjs <asin|url> [--reviews] [--country US|UK|DE|...]
 *
 * Examples:
 *   node amazon-product.mjs B0CRMZHDG8
 *   node amazon-product.mjs "https://www.amazon.com/dp/B0CRMZHDG8" --reviews
 *   node amazon-product.mjs B0CRMZHDG8 --country UK
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   { asin, title, brand, url, priceRaw, price { amount, currency },
 *     originalPriceRaw, originalPrice, discountPercent,
 *     rating, reviewCount, availability, inStock,
 *     images[], features[], description, specifications{},
 *     categories[], variants[], soldBy, soldByAmazon,
 *     bestSellersRank[], reviews[] (if --reviews) }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  parsePrice,
  parseCount,
  extractAsin,
  detectCountryFromUrl,
  getAmazonDomain,
  createBrowser,
  createContext,
  extractAmazonProduct,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args[0] || args[0] === "--help") {
  emitError(
    "MISSING_ARG",
    "Usage: node amazon-product.mjs <asin|url> [--reviews] [--country US|UK|DE|...]"
  );
}

const input = args[0];
const includeReviews = args.includes("--reviews");
const countryArg = (() => {
  const idx = args.indexOf("--country");
  return idx >= 0 ? (args[idx + 1] || "US").toUpperCase() : null;
})();

// Determine country from URL or arg
let country = countryArg || detectCountryFromUrl(input) || "US";
const domain = getAmazonDomain(country);

// Extract ASIN
const asin = extractAsin(input);
if (!asin) {
  emitError("INVALID_ASIN", `Could not extract a valid ASIN from: ${input}`);
}

const productUrl = `https://www.${domain}/dp/${asin}`;

// ---------------------------------------------------------------------------
// Reviews extraction (browser context)
// ---------------------------------------------------------------------------

const extractReviewsScript = `
(function() {
  const reviews = [];
  
  function text(el) {
    if (!el) return null;
    return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() || null;
  }
  function attr(el, a) {
    if (!el) return null;
    return el.getAttribute(a) || null;
  }

  // Review cards: [data-hook="review"]
  document.querySelectorAll('[data-hook="review"]').forEach(card => {
    try {
      const review = {};

      // Reviewer name
      review.reviewerName = text(card.querySelector('[data-hook="genome-widget"] span, .a-profile-name'));

      // Rating
      const ratingEl = card.querySelector('[data-hook="review-star-rating"] span.a-icon-alt, i[data-hook="review-star-rating"] span.a-icon-alt');
      if (ratingEl) {
        const m = (text(ratingEl) || '').match(/([\\d.]+)/);
        if (m) review.rating = parseFloat(m[1]);
      }

      // Review title
      review.title = text(card.querySelector('[data-hook="review-title"] span:not(.a-icon-alt)'));

      // Date / verified purchase
      const dateEl = card.querySelector('[data-hook="review-date"]');
      if (dateEl) {
        const dateText = text(dateEl) || '';
        review.date = dateText;
        review.verifiedPurchase = !!card.querySelector('[data-hook="avp-badge"]');
      }

      // Review body
      review.body = text(card.querySelector('[data-hook="review-body"] span'));

      // Helpful votes
      const helpfulEl = card.querySelector('[data-hook="helpful-vote-statement"]');
      if (helpfulEl) {
        review.helpfulVotes = text(helpfulEl);
      }

      // Review ID
      review.reviewId = attr(card, 'id') || null;

      if (review.body) {
        reviews.push(review);
      }
    } catch {}
  });

  return reviews;
})()
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching Amazon product: ${asin}`);
  log(`URL: ${productUrl}`);
  log(`Country: ${country}`);

  const browser = await createBrowser();

  try {
    const context = await createContext(browser, country);
    const page = await context.newPage();

    // Block unnecessary resources to speed up loading
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["video", "font", "websocket"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    log("Navigating to product page...");
    const response = await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const status = response ? response.status() : 0;
    log(`Response status: ${status}`);

    if (status === 404) {
      emitError("PRODUCT_NOT_FOUND", `Product ${asin} not found on ${domain}`);
    }

    // Wait for main content to load
    await delay(3000);

    // Check for CAPTCHA / bot detection
    const pageTitle = await page.title();
    log(`Page title: ${pageTitle}`);

    if (
      pageTitle.toLowerCase().includes("robot check") ||
      pageTitle.toLowerCase().includes("captcha") ||
      pageTitle.toLowerCase().includes("sorry")
    ) {
      emitError(
        "BOT_DETECTED",
        `Amazon bot detection triggered. Title: "${pageTitle}". Try again later or use a different IP.`
      );
    }

    // Wait for key elements
    try {
      await page.waitForSelector("#productTitle, #title, h1", {
        timeout: 10000,
      });
    } catch {
      log("Warning: product title element not found within timeout");
    }

    // Extract product data
    log("Extracting product data...");
    const rawData = await page.evaluate(extractAmazonProduct);

    if (!rawData || !rawData.title) {
      // Check if we got a product page at all
      const bodyText = await page.evaluate(
        () => document.body?.innerText?.substring(0, 500) || ""
      );
      log("Body text sample:", bodyText);
      emitError(
        "EXTRACTION_FAILED",
        "Could not extract product title. Page may have changed layout or bot detection active."
      );
    }

    // Parse prices
    const price = parsePrice(rawData.priceRaw);
    const originalPrice = parsePrice(rawData.originalPriceRaw);

    // Fix ASIN if not found on page
    if (!rawData.asin) rawData.asin = asin;

    log(`\nExtracted: "${rawData.title}"`);
    log(`  Brand: ${rawData.brand}`);
    log(`  Price: ${rawData.priceRaw}`);
    log(`  Rating: ${rawData.rating} (${rawData.reviewCount} reviews)`);
    log(`  In Stock: ${rawData.inStock}`);
    log(`  Images: ${rawData.images.length}`);
    log(`  Features: ${rawData.features.length}`);
    log(`  Specs: ${Object.keys(rawData.specifications).length} entries`);

    const result = {
      asin: rawData.asin,
      title: rawData.title,
      brand: rawData.brand,
      url: rawData.url || productUrl,
      country,
      domain,

      // Pricing
      priceRaw: rawData.priceRaw || null,
      price: price || null,
      originalPriceRaw: rawData.originalPriceRaw || null,
      originalPrice: originalPrice || null,
      discountPercent: rawData.discountPercent || null,

      // Ratings
      rating: rawData.rating || null,
      reviewCount: rawData.reviewCount || null,

      // Availability
      availability: rawData.availability || null,
      inStock: rawData.inStock ?? true,

      // Content
      images: rawData.images || [],
      features: rawData.features || [],
      description: rawData.description || null,
      specifications: rawData.specifications || {},
      categories: rawData.categories || [],
      bestSellersRank: rawData.bestSellersRank || [],
      variants: rawData.variants || [],

      // Seller
      soldBy: rawData.soldBy || null,
      soldByAmazon: rawData.soldByAmazon ?? false,

      // Package
      packageQuantity: rawData.packageQuantity || null,
    };

    // Optionally fetch reviews
    if (includeReviews) {
      log("\nFetching customer reviews...");
      
      // First try to click the reviews link from the product page (bypasses geo-block)
      let reviews = [];
      try {
        // Look for "See all reviews" or review count link on current product page
        const reviewLink = await page.$('a[data-hook="see-all-reviews-link-foot"], a[href*="product-reviews"][href*="' + asin + '"], #acrCustomerReviewLink, a[href*="#customerReviews"]');
        
        if (reviewLink) {
          const href = await reviewLink.getAttribute("href");
          if (href && href.includes("product-reviews")) {
            // Navigate to reviews page (from within Amazon session)
            const reviewsUrl = href.startsWith("http") ? href : `https://www.${domain}${href}`;
            log(`  Navigating to reviews: ${reviewsUrl.substring(0, 80)}...`);
            await page.goto(reviewsUrl + (href.includes("?") ? "&" : "?") + "sortBy=recent", {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
          } else {
            // Navigate via product URL pattern
            await page.goto(`https://www.${domain}/product-reviews/${asin}?pageNumber=1&sortBy=recent`, {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
          }
        } else {
          // Try direct URL
          await page.goto(`https://www.${domain}/product-reviews/${asin}?pageNumber=1&sortBy=recent`, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
        }
        
        await delay(2000);
        
        // Check if reviews page loaded or if we got redirected
        const reviewsTitle = await page.title();
        log(`  Reviews page title: ${reviewsTitle}`);
        
        reviews = await page.evaluate(extractReviewsScript);
        
        if (reviews.length === 0) {
          log("  No reviews found on dedicated reviews page. Trying inline reviews from product page...");
          // Navigate back to product page and extract inline reviews
          await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
          await delay(2000);
          reviews = await page.evaluate(extractReviewsScript);
        }
      } catch (e) {
        log(`  Review fetch error: ${e.message}`);
      }
      
      result.reviews = reviews;
      log(`  Got ${reviews.length} reviews`);
    }

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
