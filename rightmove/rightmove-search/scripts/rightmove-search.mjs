#!/usr/bin/env node
/**
 * Rightmove Search Scraper
 *
 * Search Rightmove (rightmove.co.uk) for UK property listings.
 * Uses pure HTTP — extracts __NEXT_DATA__ JSON from SSR pages.
 *
 * Data Sources:
 *   - Search page: /property-for-sale/find.html?locationIdentifier=...
 *     embeds __NEXT_DATA__.props.pageProps.searchResults with full listing data
 *   - Location resolution: /property-for-sale/{Location}.html
 *     resolves place names to locationIdentifier (REGION^ID)
 *
 * Usage:
 *   node rightmove-search.mjs <location> [options]
 *
 * Arguments:
 *   <location>        UK place name (e.g. "London", "Manchester", "Edinburgh")
 *
 * Options:
 *   --type sale|rent          Transaction type (default: sale)
 *   --min-price <N>           Minimum price
 *   --max-price <N>           Maximum price
 *   --min-beds <N>            Minimum bedrooms
 *   --max-beds <N>            Maximum bedrooms
 *   --max <N>                 Max results to return (default: 25)
 *   --property-type <type>    Filter by type: house, flat, bungalow, land
 *                             (maps to Rightmove propertyTypes values)
 *   --radius <N>              Search radius in miles (default: 0.0)
 *   --help                    Show help
 *
 * Property type mappings:
 *   house     → detached,semi-detached,terraced,mews,cluster-house,town-house,cottage,villa,link-detached-house
 *   flat      → flat,studio
 *   bungalow  → bungalow,park-home
 *   land      → land
 *
 * Examples:
 *   node rightmove-search.mjs London
 *   node rightmove-search.mjs Manchester --type rent --max-beds 2 --max-price 2000
 *   node rightmove-search.mjs Edinburgh --min-beds 3 --max-beds 4 --max-price 600000
 *   node rightmove-search.mjs "Oxford" --property-type flat --max 50
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
  extractNextData,
  resolveLocation,
  normaliseSearchProperty,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Property type mappings (user-friendly → Rightmove propertyTypes param)
// ---------------------------------------------------------------------------

const PROPERTY_TYPE_MAP = {
  house: "detached,semi-detached,terraced,mews,cluster-house,town-house,cottage,villa,link-detached-house",
  flat: "flat,studio",
  bungalow: "bungalow,park-home",
  land: "land",
  // Pass-through for direct Rightmove values
  detached: "detached",
  "semi-detached": "semi-detached",
  terraced: "terraced",
  studio: "studio",
  maisonette: "maisonette",
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node rightmove-search.mjs <location> [options]

Arguments:
  <location>        UK place name (e.g. "London", "Manchester", "Edinburgh")

Options:
  --type sale|rent          Transaction type (default: sale)
  --min-price <N>           Minimum price
  --max-price <N>           Maximum price
  --min-beds <N>            Minimum bedrooms
  --max-beds <N>            Maximum bedrooms
  --max <N>                 Max results (default: 25)
  --property-type <type>    Filter: house, flat, bungalow, land
  --radius <N>              Search radius in miles (default: 0.0)
  --help                    Show this help

Examples:
  node rightmove-search.mjs London
  node rightmove-search.mjs Manchester --type rent --max-beds 2 --max-price 2000
  node rightmove-search.mjs Edinburgh --min-beds 3 --max-price 600000
  node rightmove-search.mjs Oxford --property-type flat --max 50
`);
  process.exit(0);
}

// First positional = location
let locationArg = null;
let typeArg = "sale";
let minPrice = null;
let maxPrice = null;
let minBeds = null;
let maxBeds = null;
let maxResults = 25;
let propertyTypeArg = null;
let radiusArg = "0.0";

let i = 0;
// First non-flag arg is location
while (i < args.length && args[i].startsWith("--")) i++;
if (i < args.length) {
  locationArg = args[i];
  i++;
}

for (; i < args.length; i++) {
  switch (args[i]) {
    case "--type":
      typeArg = args[++i];
      break;
    case "--min-price":
      minPrice = parseInt(args[++i], 10);
      break;
    case "--max-price":
      maxPrice = parseInt(args[++i], 10);
      break;
    case "--min-beds":
      minBeds = parseInt(args[++i], 10);
      break;
    case "--max-beds":
      maxBeds = parseInt(args[++i], 10);
      break;
    case "--max":
      maxResults = parseInt(args[++i], 10);
      break;
    case "--property-type":
      propertyTypeArg = args[++i];
      break;
    case "--radius":
      radiusArg = args[++i];
      break;
    default:
      // If it doesn't start with --, treat as location if we don't have one
      if (!args[i].startsWith("--") && !locationArg) {
        locationArg = args[i];
      }
  }
}

if (!locationArg) {
  emitError("MISSING_ARGS", "Location argument is required. Usage: node rightmove-search.mjs <location>");
}

const channel = typeArg === "rent" ? "RENT" : "BUY";
const searchType = channel === "RENT" ? "RENT" : "SALE";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  // Step 1: Resolve location name → locationIdentifier
  let locationInfo;
  try {
    locationInfo = await resolveLocation(locationArg, channel);
  } catch (e) {
    emitError("LOCATION_NOT_FOUND", e.message);
  }

  log(`Resolved: "${locationArg}" → ${locationInfo.locationIdentifier} (${locationInfo.displayName})`);

  // Step 2: Build search URL
  const baseSearchUrl =
    channel === "RENT"
      ? "https://www.rightmove.co.uk/property-to-rent/find.html"
      : "https://www.rightmove.co.uk/property-for-sale/find.html";

  // Build propertyTypes param
  let propertyTypesParam = "";
  if (propertyTypeArg) {
    const mapped = PROPERTY_TYPE_MAP[propertyTypeArg.toLowerCase()];
    if (mapped) {
      propertyTypesParam = mapped;
    } else {
      // pass through unknown values directly
      propertyTypesParam = propertyTypeArg;
    }
  }

  const results = [];
  let pageIndex = 0;
  const perPage = 24; // Rightmove returns 24-25 per page

  while (results.length < maxResults) {
    const params = new URLSearchParams({
      searchType,
      locationIdentifier: locationInfo.locationIdentifier,
      radius: radiusArg,
      index: pageIndex.toString(),
    });

    if (minPrice !== null) params.set("minPrice", minPrice.toString());
    if (maxPrice !== null) params.set("maxPrice", maxPrice.toString());
    if (minBeds !== null) params.set("minBedrooms", minBeds.toString());
    if (maxBeds !== null) params.set("maxBedrooms", maxBeds.toString());
    if (propertyTypesParam) params.set("propertyTypes", propertyTypesParam);

    const searchUrl = `${baseSearchUrl}?${params.toString()}`;
    log(`Fetching page (index=${pageIndex}): ${searchUrl}`);

    const resp = await fetchUrl(searchUrl);

    if (resp.status === 307) {
      // Redirect to page-not-found — likely a bad filter combination
      break;
    }

    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status} for search URL`);
    }

    const pageProps = extractNextData(resp.body);
    if (!pageProps?.searchResults) {
      throw new Error("Could not extract search results from page");
    }

    const sr = pageProps.searchResults;
    const properties = sr.properties || [];

    if (properties.length === 0) break;

    for (const prop of properties) {
      if (results.length >= maxResults) break;
      results.push(normaliseSearchProperty(prop));
    }

    // Check if there are more pages
    const pagination = sr.pagination || {};
    const nextIndex = pagination.next ? parseInt(pagination.next, 10) : null;

    if (!nextIndex || results.length >= maxResults) break;
    if (nextIndex <= pageIndex) break; // safety guard

    pageIndex = nextIndex;

    // Small delay between pages
    await new Promise((r) => setTimeout(r, 500));
  }

  emitResult({
    location: locationInfo,
    searchType: channel,
    totalFound: results.length,
    properties: results,
  });
} catch (e) {
  emitError("SCRAPE_ERROR", e.message);
}
