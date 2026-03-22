#!/usr/bin/env node
/**
 * Craigslist Search Scraper
 *
 * Search Craigslist listings by city and category.
 * Uses pure HTTP requests against Craigslist's server-rendered HTML
 * and the embedded LD+JSON structured data.
 *
 * Data Sources:
 *   - HTML <li> elements: title, price, location, listing URL
 *   - LD+JSON (ld_searchpage_results): images, lat/lng — matched by title
 *
 * Usage:
 *   node craigslist-search.mjs <city> <category> [options]
 *
 * Arguments:
 *   <city>        City subdomain (e.g. sfbay, newyork, chicago, london)
 *   <category>    Category code (e.g. sss=for-sale, hhh=housing, jjj=jobs)
 *                 Common: sss, hhh, jjj, ggg, svc, ccc, bik, fud, mob, pet
 *
 * Options:
 *   --query <kw>       Search keyword
 *   --min-price <N>    Minimum price filter
 *   --max-price <N>    Maximum price filter
 *   --max <N>          Max results to return (default: 25)
 *   --help             Show help
 *
 * Examples:
 *   node craigslist-search.mjs sfbay sss --query bicycle --max 10
 *   node craigslist-search.mjs newyork hhh --query apartment --min-price 1000 --max-price 3000
 *   node craigslist-search.mjs chicago jjj --query developer
 *   node craigslist-search.mjs london sss
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const {
  emitResult,
  emitError,
  log,
  fetchUrl,
  extractLdJson,
  toFullSizeImage,
  extractPostingId,
  buildSearchUrl,
  stripHtml,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length < 2 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node craigslist-search.mjs <city> <category> [options]

Arguments:
  <city>        Craigslist city subdomain (e.g. sfbay, newyork, chicago)
  <category>    Category code (e.g. sss=for-sale, hhh=housing, jjj=jobs)

Options:
  --query <kw>       Search keyword
  --min-price <N>    Minimum price
  --max-price <N>    Maximum price
  --max <N>          Max results (default: 25)
  --help             Show this help

Common category codes:
  sss  = for sale (all)
  hhh  = housing
  jjj  = jobs
  ggg  = gigs
  svc  = services
  ccc  = community
  bik  = bicycles
  fud  = food+drink
  mob  = mobile phones
  pet  = pets

Examples:
  node craigslist-search.mjs sfbay sss --query bicycle --max 10
  node craigslist-search.mjs newyork hhh --min-price 1000 --max-price 3000
  node craigslist-search.mjs chicago jjj --query developer

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const city = args[0];
const category = args[1];
let query = null;
let minPrice = null;
let maxPrice = null;
let maxResults = 25;

for (let i = 2; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--query" && args[i + 1]) {
    query = args[++i];
  } else if (arg === "--min-price" && args[i + 1]) {
    minPrice = parseInt(args[++i], 10);
  } else if (arg === "--max-price" && args[i + 1]) {
    maxPrice = parseInt(args[++i], 10);
  } else if (arg === "--max" && args[i + 1]) {
    maxResults = parseInt(args[++i], 10) || 25;
  }
}

log(`[craigslist-search] City: ${city}, Category: ${category}`);
if (query) log(`[craigslist-search] Query: "${query}"`);
if (minPrice != null) log(`[craigslist-search] Min price: $${minPrice}`);
if (maxPrice != null) log(`[craigslist-search] Max price: $${maxPrice}`);
log(`[craigslist-search] Max results: ${maxResults}`);

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a div with a specific class (searches within a fragment).
 * Uses a simple regex — avoids class name brittleness by matching class substring.
 */
function extractDivByClass(fragment, className) {
  // Match divs containing this class name (not brittle — class name is semantic)
  const re = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, "i");
  const m = fragment.match(re);
  return m ? stripHtml(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Parse search HTML
// ---------------------------------------------------------------------------

/**
 * Parse search result HTML page into listings.
 *
 * Strategy:
 *   1. Parse <li> elements with listing anchor links → title, price, location, URL
 *   2. Parse LD+JSON (ld_searchpage_results) → images, lat/lng per listing, keyed by title
 *   3. Merge: for each <li> listing, look up LD+JSON by title for enrichment
 */
function parseSearchHtml(html, category) {
  // --- Build LD+JSON lookup by title ---
  const ldData = extractLdJson(html, "ld_searchpage_results");
  const ldByTitle = new Map();
  if (ldData?.itemListElement) {
    for (const entry of ldData.itemListElement) {
      const name = entry.item?.name;
      if (name) ldByTitle.set(name.toLowerCase(), entry.item);
    }
  }
  log(`[craigslist-search] LD+JSON index: ${ldByTitle.size} titles`);

  // --- Extract listings from <li> elements ---
  const listings = [];
  const seenUrls = new Set();

  // Each result is a <li> with an <a> link to a /d/ URL
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;

  while ((liMatch = liRegex.exec(html)) !== null) {
    const liHtml = liMatch[1];

    // Must contain a craigslist /d/ listing URL
    const hrefMatch = liHtml.match(
      /href="(https?:\/\/[a-z0-9]+\.craigslist\.org\/[a-z0-9]+\/[a-z0-9]+\/d\/[^"]+\.html)"/i
    );
    if (!hrefMatch) continue;

    const url = hrefMatch[1];
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Extract title from <div class="title">
    const titleText = extractDivByClass(liHtml, "title");
    if (!titleText) continue;

    // Extract price from <div class="price">
    const priceText = extractDivByClass(liHtml, "price");
    let price = null;
    if (priceText) {
      const priceMatch = priceText.match(/[\d,]+/);
      if (priceMatch) price = parseFloat(priceMatch[0].replace(/,/g, ""));
    }

    // Extract location from <div class="location">
    const locationText = extractDivByClass(liHtml, "location");

    // Extract posting ID from URL
    const id = extractPostingId(url);

    // Enrich with LD+JSON data (images, lat/lng)
    const ldItem = ldByTitle.get(titleText.toLowerCase()) ?? {};
    const ldImages = (ldItem.image ?? []).map((img) => toFullSizeImage(img));
    const ldOffers = ldItem.offers ?? {};
    const ldGeo = ldOffers.availableAtOrFrom?.geo ?? {};
    const ldAddress = ldOffers.availableAtOrFrom?.address ?? {};

    // Build location from LD+JSON if not in HTML
    let location = locationText || null;
    if (!location && ldAddress.addressLocality) {
      location = [ldAddress.addressLocality, ldAddress.addressRegion]
        .filter(Boolean)
        .join(", ");
    }

    listings.push({
      id,
      title: titleText,
      price,
      currency: ldOffers.priceCurrency ?? "USD",
      location,
      url,
      thumbnailUrl: ldImages[0] ?? null,
      images: ldImages,
      lat: ldGeo.latitude ? parseFloat(ldGeo.latitude) : null,
      lng: ldGeo.longitude ? parseFloat(ldGeo.longitude) : null,
      category,
      postedAt: null, // Not in search results — fetch listing for this
    });
  }

  return listings;
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

async function searchCraigslist(city, category, params, maxResults) {
  const allListings = [];
  let start = 0;

  while (allListings.length < maxResults) {
    const url = buildSearchUrl(city, category, { ...params, start });
    log(`[craigslist-search] Fetching: ${url}`);

    let resp;
    try {
      resp = await fetchUrl(url);
    } catch (err) {
      if (allListings.length === 0) {
        emitError("FETCH_FAILED", `Failed to fetch ${url}: ${err.message}`);
      }
      break;
    }

    if (resp.status === 404) {
      emitError(
        "INVALID_CITY_OR_CATEGORY",
        `City "${city}" or category "${category}" not found (404). ` +
          `Check city subdomain (e.g. sfbay, newyork, chicago) and category code (e.g. sss, hhh, jjj).`
      );
    }

    if (resp.status >= 400) {
      if (allListings.length === 0) {
        emitError("HTTP_ERROR", `HTTP ${resp.status} from ${url}`);
      }
      break;
    }

    if (resp.body.includes("Your request has been blocked")) {
      emitError("BLOCKED", "Request was blocked by Craigslist. Try again later.");
    }

    const pageListings = parseSearchHtml(resp.body, category);
    log(`[craigslist-search] Page listings parsed: ${pageListings.length}`);

    if (pageListings.length === 0) {
      break; // No more results
    }

    // Add new listings (avoid duplicates across pages)
    const existingUrls = new Set(allListings.map((l) => l.url));
    for (const listing of pageListings) {
      if (!existingUrls.has(listing.url)) {
        allListings.push(listing);
        existingUrls.add(listing.url);
      }
    }

    // Craigslist paginates at 120 per page typically
    if (pageListings.length < 100) {
      break; // Likely the last page
    }

    start += pageListings.length;
  }

  return allListings.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const params = { query, minPrice, maxPrice };
const listings = await searchCraigslist(city, category, params, maxResults);

log(`[craigslist-search] Total found: ${listings.length}`);

emitResult({
  city,
  category,
  query: query ?? null,
  minPrice: minPrice ?? null,
  maxPrice: maxPrice ?? null,
  totalFound: listings.length,
  listings,
});
