#!/usr/bin/env node
/**
 * Apple App Store App Detail Scraper
 *
 * Fetches full metadata and reviews for an iOS app by ID or App Store URL.
 * Uses the public iTunes Lookup API and App Store Reviews RSS JSON feed.
 * No authentication or browser required — pure HTTP.
 *
 * Data Sources:
 *   - iTunes Lookup API: https://itunes.apple.com/lookup?id=<appId>&country=<cc>
 *   - Reviews RSS (JSON): https://itunes.apple.com/<cc>/rss/customerreviews/id=<appId>/page=<n>/sortBy=mostRecent/json
 *
 * Usage:
 *   node app-store-app.mjs <app-id-or-url> [options]
 *
 * Arguments:
 *   <app-id-or-url>      Numeric app ID or App Store URL (required)
 *                        Examples:
 *                          618783545
 *                          https://apps.apple.com/us/app/slack/id618783545
 *                          apps.apple.com/us/app/slack/id618783545
 *
 * Options:
 *   --country <cc>       2-letter country code (default: us)
 *   --max-reviews <N>    Max reviews to fetch (default: 50, 0 = skip reviews)
 *
 * Examples:
 *   node app-store-app.mjs 618783545
 *   node app-store-app.mjs 618783545 --max-reviews 200
 *   node app-store-app.mjs https://apps.apple.com/us/app/slack/id618783545
 *   node app-store-app.mjs 389801252 --country gb --max-reviews 100
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
  fetchJson,
  extractAppId,
  normalizeAppDetail,
  fetchReviews,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node app-store-app.mjs <app-id-or-url> [options]

Arguments:
  <app-id-or-url>   Numeric app ID or App Store URL (required)
                    e.g. 618783545
                         https://apps.apple.com/us/app/slack/id618783545

Options:
  --country <cc>        2-letter country code (default: us)
  --max-reviews <N>     Max reviews to fetch (default: 50, 0 = skip)
  --help                Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const appInput = args[0];
let country = "us";
let maxReviews = 50;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--country" || arg === "-c") && args[i + 1]) {
    country = args[++i].toLowerCase();
  } else if (arg === "--max-reviews" && args[i + 1]) {
    maxReviews = Math.max(0, parseInt(args[++i], 10) || 0);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

// Step 1: Extract app ID
const appId = extractAppId(appInput);
if (!appId) {
  emitError(
    "INVALID_INPUT",
    `Could not extract a valid App Store app ID from: "${appInput}". ` +
      `Provide a numeric ID (e.g. 618783545) or a full App Store URL.`
  );
}

log(`[app-store-app] App ID: ${appId}, country: ${country}, max-reviews: ${maxReviews}`);

// Step 2: Fetch app metadata from iTunes Lookup API
const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}&country=${country}&entity=software`;
log(`[app-store-app] Lookup URL: ${lookupUrl}`);

let lookupData;
try {
  lookupData = await fetchJson(lookupUrl);
} catch (err) {
  emitError("FETCH_ERROR", `Failed to fetch app metadata: ${err.message}`);
}

if (!lookupData || !Array.isArray(lookupData.results) || lookupData.results.length === 0) {
  emitError(
    "NOT_FOUND",
    `No app found for ID "${appId}" in country "${country}". ` +
      `The app may not be available in this region, or the ID may be invalid.`
  );
}

const rawApp = lookupData.results[0];

// Validate it's actually an app (not a song, album, etc.)
if (rawApp.wrapperType !== "software" && rawApp.kind !== "software") {
  emitError(
    "WRONG_TYPE",
    `ID "${appId}" resolved to a non-app item (type: ${rawApp.wrapperType || rawApp.kind}). ` +
      `Please provide an iOS app ID.`
  );
}

const app = normalizeAppDetail(rawApp);
log(`[app-store-app] Found app: "${app.name}" by ${app.developer.name}`);

// Step 3: Fetch reviews (if requested)
if (maxReviews > 0) {
  log(`[app-store-app] Fetching up to ${maxReviews} reviews...`);
  try {
    app.reviews = await fetchReviews(appId, country, maxReviews);
    log(`[app-store-app] Got ${app.reviews.length} reviews`);
  } catch (err) {
    log(`[app-store-app] Warning: Could not fetch reviews: ${err.message}`);
    app.reviews = [];
  }
} else {
  log(`[app-store-app] Skipping reviews (--max-reviews 0)`);
  app.reviews = [];
}

// Step 4: Output
emitResult(app);
