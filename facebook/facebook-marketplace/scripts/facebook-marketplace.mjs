#!/usr/bin/env node
/**
 * Facebook Marketplace Scraper
 *
 * Extracts marketplace listings from the public Facebook Marketplace.
 *
 * Strategy:
 *   1. Navigate to facebook.com/marketplace/ (publicly accessible, no login required)
 *   2. Parse embedded Relay/GraphQL SSR JSON from <script type="application/json"> tags
 *   3. Extract: listing title, price, location, photo, category, seller info, status, delivery types
 *   4. With FB_COOKIES: access search, category pages, and individual item details
 *
 * Without login:
 *   - ~20 "featured" listings for the IP-detected location (e.g., San Francisco, CA)
 *   - No keyword search (search page redirects to login)
 *   - No category browsing (category pages redirect to login)
 *   - No individual item details (item pages redirect to login)
 *
 * With FB_COOKIES (authenticated):
 *   - Full search by keyword, category, location
 *   - Individual item details (description, full seller info, all photos)
 *   - Pagination for more results
 *
 * Usage:
 *   node facebook-marketplace.mjs [options]
 *
 * Options:
 *   --query <text>         Keyword search (requires FB_COOKIES)
 *   --category <id>        Category ID filter (requires FB_COOKIES)
 *   --location <city>      Location slug (e.g., "sanfrancisco", "nyc") (requires FB_COOKIES)
 *   --max <N>              Max listings to return (default: 20)
 *   --sort best_match|price_ascend|price_descend|creation_time_descend
 *                          Sort order (default: best_match, requires FB_COOKIES for search)
 *   --min-price <N>        Minimum price filter (requires FB_COOKIES)
 *   --max-price <N>        Maximum price filter (requires FB_COOKIES)
 *
 * Environment:
 *   FB_COOKIES  JSON array of Facebook cookies for authenticated access
 *
 * Examples:
 *   node facebook-marketplace.mjs
 *   node facebook-marketplace.mjs --max 20
 *   FB_COOKIES='[...]' node facebook-marketplace.mjs --query bicycle --location nyc --max 50
 *   FB_COOKIES='[...]' node facebook-marketplace.mjs --location sanfrancisco --max 30
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createFbBrowser,
  createFbContext,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let query = null;
let category = null;
let location = null;
let maxResults = 20;
let sortBy = "best_match";
let minPrice = null;
let maxPrice = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--query" && args[i + 1]) query = args[++i];
  else if (a === "--category" && args[i + 1]) category = args[++i];
  else if (a === "--location" && args[i + 1]) location = args[++i];
  else if (a === "--max" && args[i + 1]) maxResults = parseInt(args[++i], 10);
  else if (a === "--sort" && args[i + 1]) sortBy = args[++i];
  else if (a === "--min-price" && args[i + 1]) minPrice = parseFloat(args[++i]);
  else if (a === "--max-price" && args[i + 1]) maxPrice = parseFloat(args[++i]);
}

// ---------------------------------------------------------------------------
// Cookie loading
// ---------------------------------------------------------------------------

function loadCookies() {
  const env = process.env.FB_COOKIES;
  if (!env) return null;
  try {
    return JSON.parse(env);
  } catch (e) {
    log("[WARN] Failed to parse FB_COOKIES:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function buildBrowseUrl(locationSlug, categorySlug) {
  if (locationSlug) {
    if (categorySlug) {
      return `https://www.facebook.com/marketplace/${locationSlug}/${categorySlug}/`;
    }
    return `https://www.facebook.com/marketplace/${locationSlug}/`;
  }
  return "https://www.facebook.com/marketplace/";
}

function buildSearchUrl(locationSlug, searchQuery, sortOrder, priceMin, priceMax, categoryId) {
  const base = locationSlug
    ? `https://www.facebook.com/marketplace/${locationSlug}/search/`
    : "https://www.facebook.com/marketplace/search/";

  const params = new URLSearchParams();
  if (searchQuery) params.set("query", searchQuery);
  params.set("sortBy", sortOrder || "best_match");
  if (priceMin !== null) params.set("minPrice", String(priceMin));
  if (priceMax !== null) params.set("maxPrice", String(priceMax));
  if (categoryId) params.set("categoryId", categoryId);
  params.set("exact", "false");

  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Listing extraction from SSR JSON
// ---------------------------------------------------------------------------

/**
 * Recursively find all marketplace listing objects in a parsed JSON tree.
 */
function findListingsInTree(obj, results = [], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 20) return results;
  if (Array.isArray(obj)) {
    for (const item of obj) findListingsInTree(item, results, depth + 1);
    return results;
  }
  // A listing object always has marketplace_listing_title and id
  if (obj.marketplace_listing_title && obj.id && obj.listing_price !== undefined) {
    results.push(obj);
    return results; // Don't recurse into listing itself
  }
  for (const val of Object.values(obj)) {
    findListingsInTree(val, results, depth + 1);
  }
  return results;
}

/**
 * Parse a raw listing object from SSR into a clean output format.
 */
function parseListing(raw) {
  const id = String(raw.id || "");
  const url = id ? `https://www.facebook.com/marketplace/item/${id}/` : null;

  // Price
  const formattedPrice = raw.formatted_price?.text || null;
  const priceAmount = parseFloat(raw.listing_price?.amount || "0") || 0;
  const minListingPrice = raw.min_listing_price ? parseFloat(raw.min_listing_price.amount) : null;
  const maxListingPrice = raw.max_listing_price ? parseFloat(raw.max_listing_price.amount) : null;

  // Location
  const geo = raw.location?.reverse_geocode || {};
  const locationCity = geo.city || null;
  const locationState = geo.state || null;
  const locationDisplay = geo.city_page?.display_name || (locationCity && locationState ? `${locationCity}, ${locationState}` : locationCity || null);

  // Photo
  const photoUri = raw.primary_listing_photo?.image?.uri || null;
  const videoUri = raw.listing_video?.video?.playable_url || null;

  // Seller
  const sellerRaw = raw.marketplace_listing_seller;
  const seller = sellerRaw
    ? {
        name: sellerRaw.name || null,
        id: sellerRaw.id || null,
      }
    : null;

  // Status flags
  const isLive = raw.is_live !== false;
  const isSold = raw.is_sold === true;
  const isPending = raw.is_pending === true;
  const isHidden = raw.is_hidden === true;

  // Category
  const categoryName = raw.marketplace_listing_category_name || null;
  const virtualCategory = raw.marketplace_listing_virtual_taxonomy_category?.name || null;
  const categoryId = raw.marketplace_listing_category_id || null;

  // Tags (e.g., "popular_vehicle")
  const listingTags = raw.listing_tags || [];

  // Delivery types
  const deliveryTypes = raw.delivery_types || [];

  // Creation time
  const createdAt = raw.creation_time
    ? new Date(raw.creation_time * 1000).toISOString()
    : null;

  return {
    id,
    url,
    title: raw.marketplace_listing_title || null,
    customTitle: raw.custom_title || null,
    price: formattedPrice,
    priceAmount,
    minPrice: minListingPrice,
    maxPrice: maxListingPrice,
    location: locationDisplay,
    locationCity,
    locationState,
    photoUrl: photoUri,
    videoUrl: videoUri,
    seller,
    isLive,
    isSold,
    isPending,
    isHidden,
    categoryName,
    virtualCategory,
    categoryId,
    deliveryTypes,
    listingTags,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// SSR data extraction
// ---------------------------------------------------------------------------

/**
 * Extract all marketplace listings from a page's SSR JSON scripts.
 */
async function extractListingsFromSSR(page) {
  const rawListings = await page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/json"]')
    );
    const results = [];
    const seen = new Set();

    for (const script of scripts) {
      if (!script.textContent.includes("marketplace_listing_title")) continue;
      try {
        const data = JSON.parse(script.textContent);
        // Recursive search
        const findListings = (obj, depth = 0) => {
          if (!obj || typeof obj !== "object" || depth > 20) return;
          if (Array.isArray(obj)) {
            obj.forEach((item) => findListings(item, depth + 1));
            return;
          }
          if (
            obj.marketplace_listing_title &&
            obj.id &&
            obj.listing_price !== undefined
          ) {
            if (!seen.has(obj.id)) {
              seen.add(obj.id);
              results.push(obj);
            }
            return;
          }
          Object.values(obj).forEach((v) => findListings(v, depth + 1));
        };
        findListings(data);
      } catch (e) {}
    }
    return results;
  });

  return rawListings.map(parseListing);
}

// ---------------------------------------------------------------------------
// Location metadata extraction
// ---------------------------------------------------------------------------

async function extractLocationFromSSR(page) {
  return page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/json"]')
    );
    for (const script of scripts) {
      const text = script.textContent;
      if (text.includes("buy_location") && text.includes("display_name")) {
        // Find buy_location
        const idx = text.indexOf('"buy_location"');
        if (idx >= 0) {
          const snippet = text.substring(idx, idx + 400);
          const match = snippet.match(/"display_name":"([^"]+)"/);
          if (match) return match[1];
        }
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------

async function main() {
  const cookies = loadCookies();
  const isAuthenticated = !!cookies;

  if (query && !isAuthenticated) {
    log("[WARN] Keyword search requires FB_COOKIES. Showing featured listings instead.");
    log("[INFO] Set FB_COOKIES env var with your Facebook session cookies for search support.");
  }
  if (category && !isAuthenticated) {
    log("[WARN] Category filtering requires FB_COOKIES. Showing featured listings instead.");
  }

  log(`[INFO] Starting Facebook Marketplace scraper`);
  log(`[INFO] Query: ${query || "(browse featured)"}, Location: ${location || "(IP-detected)"}`);
  log(`[INFO] Auth: ${isAuthenticated ? "authenticated" : "logged-out (limited data)"}`);

  const browser = await createFbBrowser(Camoufox);
  const ctx = await createFbContext(browser);

  try {
    if (isAuthenticated) {
      log("[INFO] Loading FB cookies...");
      await ctx.addCookies(cookies);
    }

    const page = await ctx.newPage();

    // Determine the URL to navigate to
    let targetUrl;
    if (isAuthenticated && query) {
      targetUrl = buildSearchUrl(location, query, sortBy, minPrice, maxPrice, category);
    } else if (isAuthenticated && location) {
      targetUrl = buildBrowseUrl(location, category);
    } else {
      targetUrl = "https://www.facebook.com/marketplace/";
    }

    log(`[INFO] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(5000);

    const finalUrl = page.url();
    log(`[INFO] Final URL: ${finalUrl}`);

    // Check for login redirect
    if (finalUrl.includes("/login/")) {
      if (isAuthenticated) {
        emitError("SESSION_EXPIRED", "FB_COOKIES is expired or invalid. Please refresh your Facebook session cookies.");
      }
      // Not authenticated — use base marketplace page
      log("[INFO] Search/category requires login. Falling back to base marketplace page...");
      await page.goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await delay(5000);
    }

    // Extract location metadata
    const detectedLocation = await extractLocationFromSSR(page);
    log(`[INFO] Detected location: ${detectedLocation || "unknown"}`);

    // Extract listings from SSR data
    log("[INFO] Extracting listings from SSR data...");
    let listings = await extractListingsFromSSR(page);
    log(`[INFO] Found ${listings.length} listings in initial SSR`);

    // If authenticated and on search/browse page, try to scroll for more
    if (isAuthenticated && !page.url().includes("/login/") && maxResults > listings.length) {
      log("[INFO] Scrolling to load more listings...");
      const prevCount = listings.length;
      let scrollAttempts = 0;
      const maxScrolls = Math.ceil((maxResults - listings.length) / 10) + 3;

      while (listings.length < maxResults && scrollAttempts < maxScrolls) {
        await page.evaluate(() => window.scrollBy(0, 2000));
        await delay(2500);
        listings = await extractListingsFromSSR(page);
        log(`[INFO] After scroll ${scrollAttempts + 1}: ${listings.length} listings`);

        if (listings.length === prevCount && scrollAttempts > 2) {
          log("[INFO] No new listings loaded after scrolling, stopping");
          break;
        }
        scrollAttempts++;
      }
    }

    // Apply max limit
    listings = listings.slice(0, maxResults);

    const isLoginRedirected = !page.url().includes("marketplace");
    const result = {
      query: query || null,
      location: location || detectedLocation || null,
      category: category || null,
      sortBy: query ? sortBy : null,
      isAuthenticated,
      totalLoaded: listings.length,
      hasMore: listings.length >= maxResults,
      listings,
      meta: {
        note: !isAuthenticated
          ? "Logged-out mode: only ~20 featured listings available. Set FB_COOKIES for search/category/location-specific results."
          : null,
        url: targetUrl,
        scrapedAt: new Date().toISOString(),
      },
    };

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("SCRAPER_ERROR", String(err.message || err));
});
