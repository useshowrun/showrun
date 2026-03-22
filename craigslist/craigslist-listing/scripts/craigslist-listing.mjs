#!/usr/bin/env node
/**
 * Craigslist Listing Scraper
 *
 * Fetches full details for a single Craigslist listing URL.
 * Parses the listing's LD+JSON structured data and HTML for all available fields.
 *
 * Data Source:
 *   https://{city}.craigslist.org/{subcategory}/d/{slug}/{id}.html
 *   Embedded JSON: LD+JSON <script type="application/ld+json"> (product data)
 *   HTML: attrgroup divs for attributes, postingbody section for description
 *
 * Usage:
 *   node craigslist-listing.mjs <listing-url>
 *
 * Arguments:
 *   <listing-url>   Full URL to a Craigslist listing
 *
 * Examples:
 *   node craigslist-listing.mjs "https://sfbay.craigslist.org/nby/bik/d/petaluma-sully-bmx/7912241254.html"
 *   node craigslist-listing.mjs "https://newyork.craigslist.org/mnh/apa/d/new-york-1br-apartment/1234567890.html"
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
  extractAllLdJson,
  toFullSizeImage,
  extractPostingId,
  stripHtml,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node craigslist-listing.mjs <listing-url>

Arguments:
  <listing-url>   Full Craigslist listing URL

Examples:
  node craigslist-listing.mjs "https://sfbay.craigslist.org/nby/bik/d/petaluma-bmx/7912241254.html"

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const listingUrl = args[0];

// Validate URL format
if (!listingUrl.includes("craigslist.org")) {
  emitError("INVALID_URL", `URL does not appear to be a Craigslist listing: ${listingUrl}`);
}

log(`[craigslist-listing] Fetching: ${listingUrl}`);

// ---------------------------------------------------------------------------
// Fetch listing page
// ---------------------------------------------------------------------------

let resp;
try {
  resp = await fetchUrl(listingUrl);
} catch (err) {
  emitError("FETCH_FAILED", `Failed to fetch listing: ${err.message}`);
}

if (resp.status === 404) {
  // Listing may be expired/deleted
  emitResult({
    url: listingUrl,
    id: extractPostingId(listingUrl),
    error: true,
    code: "NOT_FOUND",
    message: "Listing not found (404) — it may have been deleted or expired.",
  });
  process.exit(0);
}

if (resp.status >= 400) {
  emitError("HTTP_ERROR", `HTTP ${resp.status} from ${listingUrl}`);
}

if (resp.body.includes("Your request has been blocked")) {
  emitError("BLOCKED", "Request was blocked by Craigslist.");
}

if (
  resp.body.includes("This posting has expired") ||
  resp.body.includes("This listing has expired") ||
  resp.body.includes("posting has been deleted")
) {
  emitResult({
    url: listingUrl,
    id: extractPostingId(listingUrl),
    expired: true,
    message: "This listing has expired or been deleted.",
  });
  process.exit(0);
}

log(`[craigslist-listing] Got ${resp.body.length} bytes, status ${resp.status}`);

// ---------------------------------------------------------------------------
// Parse listing HTML
// ---------------------------------------------------------------------------

const html = resp.body;

// --- LD+JSON: Find the product data script ---
const ldJsonAll = extractAllLdJson(html);
log(`[craigslist-listing] Found ${ldJsonAll.length} LD+JSON blocks`);

// Find the one with Product + Offer
const productLd = ldJsonAll.find(
  (d) => d["@type"] === "Product" || (d.offers && d.name)
);

const id = extractPostingId(listingUrl);

// --- Title ---
let title = productLd?.name ?? null;
if (!title) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) title = stripHtml(m[1]);
}
if (!title) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) title = m[1].replace(/ - craigslist$/, "").trim();
}

// --- Price ---
let price = null;
let currency = "USD";
if (productLd?.offers?.price != null) {
  price = parseFloat(productLd.offers.price);
  currency = productLd.offers.priceCurrency ?? "USD";
} else {
  // Fallback: parse from HTML
  const m = html.match(/<span[^>]*class="[^"]*price[^"]*"[^>]*>\s*(\$[\d,]+)/i);
  if (m) {
    price = parseFloat(m[1].replace(/[^0-9.]/g, ""));
  }
}

// --- Location ---
const ldAddress = productLd?.offers?.availableAtOrFrom?.address ?? {};
const ldGeo = productLd?.offers?.availableAtOrFrom?.geo ?? {};

let location = null;
if (ldAddress.addressLocality) {
  location = [ldAddress.addressLocality, ldAddress.addressRegion]
    .filter(Boolean)
    .join(", ");
}
if (!location) {
  const m = html.match(/<div[^>]*class="[^"]*mapaddress[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (m) location = stripHtml(m[1]);
}

// --- Lat/Lng ---
let lat = ldGeo.latitude ? parseFloat(ldGeo.latitude) : null;
let lng = ldGeo.longitude ? parseFloat(ldGeo.longitude) : null;

if (lat == null) {
  // Fallback: look for map data in HTML
  const mLat = html.match(/data-latitude="([^"]+)"/i);
  const mLng = html.match(/data-longitude="([^"]+)"/i);
  if (mLat) lat = parseFloat(mLat[1]);
  if (mLng) lng = parseFloat(mLng[1]);
}

// --- Description ---
let description = productLd?.description ?? null;
if (!description || description.length < 10) {
  // Parse from the postingbody section
  const bodyMatch = html.match(/<section[^>]*id="postingbody"[^>]*>([\s\S]*?)<\/section>/i);
  if (bodyMatch) {
    // Remove the QR code print-only div
    const bodyHtml = bodyMatch[1].replace(
      /<div[^>]*class="[^"]*print-information[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
      ""
    );
    description = stripHtml(bodyHtml);
    // Clean up "show contact info" artifacts
    description = description.replace(/show contac\w*/gi, "").trim();
  }
}

// --- Images ---
// Collect unique image IDs from data-imgid attributes
const imgIdSet = new Set();
const imgIdMatches = html.matchAll(/data-imgid="([^"]+)"/gi);
for (const m of imgIdMatches) {
  imgIdSet.add(m[1]);
}

// Build full-size image URLs from IDs
// Pattern: https://images.craigslist.org/{prefix}_{imgid}_{size}.jpg
// We need to find the prefix from existing image URLs in the LD+JSON
const imagesFromLd = (productLd?.image ?? []).map((img) => toFullSizeImage(img));

// Also collect from data-img-id and existing img URLs in page
const imgUrlMatches = [...html.matchAll(/https:\/\/images\.craigslist\.org\/([^"'\s]+)/g)];
const imgUrlSet = new Set();
for (const m of imgUrlMatches) {
  const fullUrl = "https://images.craigslist.org/" + m[1];
  // Convert to full size
  imgUrlSet.add(toFullSizeImage(fullUrl));
}

// Remove thumbnail versions (50x50c)
const images = [...imgUrlSet].filter(
  (url) => !url.includes("50x50") && !url.includes("300x225")
);

// Prefer LD+JSON images if available (they're already deduped)
const finalImages = imagesFromLd.length > 0 ? imagesFromLd : images;

// --- Posted/Updated dates ---
let postedAt = null;
let updatedAt = null;

const datetimes = [...html.matchAll(/datetime="([^"]+)"/g)].map((m) => m[1]);
log(`[craigslist-listing] Datetimes: ${JSON.stringify(datetimes)}`);

if (datetimes.length > 0) {
  // First datetime is typically posted date, last is updated
  postedAt = datetimes[0] ?? null;
  if (datetimes.length > 1) {
    updatedAt = datetimes[datetimes.length - 1] ?? null;
    // If all are same, don't set updatedAt
    if (updatedAt === postedAt) updatedAt = null;
  }
}

// --- Attributes (make, model, condition, size, etc.) ---
const attributes = {};

// Strategy: scan the full HTML for attribute patterns directly
// Craigslist uses these structures (in .attrgroup divs):
//   1. Labeled: <div class="attr key_name"><span class="labl">Label:</span><span class="valu">Value</span></div>
//   2. Unlabeled: <div class="attr"><span class="valu"><a href="?key=N">Value</a></span></div>
//   3. Important: <span class="attr important">Summary text</span> (e.g., "3BR / 1Ba")

// 1. Labeled attributes (div.attr with labl + valu spans)
for (const am of html.matchAll(
  /<div[^>]*class="attr[^"]*"[^>]*>\s*<span[^>]*class="[^"]*labl[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*class="[^"]*valu[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
)) {
  const key = stripHtml(am[1]).replace(/:$/, "").trim().toLowerCase().replace(/\s+/g, "_");
  const val = stripHtml(am[2]).trim();
  if (key && val) attributes[key] = val;
}

// 2. Unlabeled value spans (div.attr with only a valu span)
for (const am of html.matchAll(
  /<div[^>]*class="attr[^"]*"[^>]*>\s*<span[^>]*class="[^"]*valu[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
)) {
  const valuHtml = am[1];
  const val = stripHtml(valuHtml).trim();
  // Skip if already captured by labeled pass
  if (!val || Object.values(attributes).includes(val)) continue;
  // Try to infer key from a link URL query param (e.g., ?housing_type=1)
  const qpMatch = valuHtml.match(/[?&]([a-z_]+)=\d+/i);
  const key = qpMatch ? qpMatch[1] : null;
  if (key && val) {
    attributes[key] = val;
  } else if (val && !attributes.type) {
    attributes.type = val;
  }
}

// 3. Important summary spans (e.g., "3BR / 1Ba", "600ft²")
const importantVals = [];
for (const im of html.matchAll(
  /<span[^>]*class="[^"]*attr[^"]*important[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
)) {
  const val = stripHtml(im[1]).trim();
  if (val) importantVals.push(val);
}
if (importantVals.length > 0) {
  attributes.summary = importantVals.join(", ");
}

// Extract the city and category from the listing URL
const urlMatch = listingUrl.match(/https?:\/\/([a-z0-9]+)\.craigslist\.org\/([a-z]+)\//);
const listingCity = urlMatch?.[1] ?? null;
const listingSubcategory = urlMatch?.[2] ?? null;

// --- Compile result ---
const result = {
  id,
  url: listingUrl,
  title,
  price,
  currency,
  location,
  lat,
  lng,
  description,
  images: finalImages,
  postedAt,
  updatedAt,
  attributes,
  city: listingCity,
  subcategory: listingSubcategory,
};

log(`[craigslist-listing] Done: ${title}`);
emitResult(result);
