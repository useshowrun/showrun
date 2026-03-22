#!/usr/bin/env node
/**
 * Google Play Store App Detail Scraper
 *
 * Fetches full metadata and reviews for an Android app by package name or URL.
 * Uses the google-play-scraper npm package (reverse-engineered internal Google
 * Play APIs). No browser or authentication required — pure HTTP.
 *
 * Data Sources:
 *   - App detail API (via google-play-scraper): https://play.google.com/store/apps/details?id=<packageName>
 *   - Reviews API (via google-play-scraper): internal Google Play RPC
 *
 * Usage:
 *   node play-store-app.mjs <package-name-or-url> [options]
 *
 * Arguments:
 *   <package-name-or-url>    Android package name or Google Play URL (required)
 *                            Examples:
 *                              com.Slack
 *                              com.instagram.android
 *                              https://play.google.com/store/apps/details?id=com.whatsapp
 *                              play.google.com/store/apps/details?id=com.whatsapp
 *
 * Options:
 *   --country <cc>           2-letter country code (default: us)
 *   --lang <code>            Language code (default: en)
 *   --max-reviews <N>        Max reviews to fetch (default: 50, 0 = skip reviews)
 *
 * Examples:
 *   node play-store-app.mjs com.Slack
 *   node play-store-app.mjs com.instagram.android --max-reviews 200
 *   node play-store-app.mjs https://play.google.com/store/apps/details?id=com.whatsapp
 *   node play-store-app.mjs com.Slack --country tr --lang tr
 *   node play-store-app.mjs com.Slack --max-reviews 0
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
  gplay,
  emitResult,
  emitError,
  log,
  extractPackageId,
  normalizeAppDetail,
  fetchReviews,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node play-store-app.mjs <package-name-or-url> [options]

Arguments:
  <package-name-or-url>   Android package name or Google Play URL (required)
                          e.g. com.Slack
                               com.instagram.android
                               https://play.google.com/store/apps/details?id=com.whatsapp

Options:
  --country <cc>          2-letter country code (default: us)
  --lang <code>           Language code (default: en)
  --max-reviews <N>       Max reviews to fetch (default: 50, 0 = skip)
  --help                  Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const appInput = args[0];
let country = "us";
let lang = "en";
let maxReviews = 50;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--country" || arg === "-c") && args[i + 1]) {
    country = args[++i].toLowerCase();
  } else if ((arg === "--lang" || arg === "-l") && args[i + 1]) {
    lang = args[++i].toLowerCase();
  } else if (arg === "--max-reviews" && args[i + 1]) {
    maxReviews = Math.max(0, parseInt(args[++i], 10) || 0);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

// Step 1: Extract package ID
const packageId = extractPackageId(appInput);
if (!packageId) {
  emitError(
    "INVALID_INPUT",
    `Could not extract a valid Android package name from: "${appInput}". ` +
      `Provide a package name (e.g. com.Slack) or a Google Play URL ` +
      `(e.g. https://play.google.com/store/apps/details?id=com.Slack).`
  );
}

log(`[play-store-app] Package: ${packageId}, country: ${country}, lang: ${lang}, max-reviews: ${maxReviews}`);

// Step 2: Fetch app metadata
let rawApp;
try {
  rawApp = await gplay.app({
    appId: packageId,
    country,
    lang,
  });
} catch (err) {
  // google-play-scraper throws specific errors for not-found apps
  const msg = err.message || String(err);
  if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found") || msg.includes("App not found")) {
    emitError(
      "NOT_FOUND",
      `App "${packageId}" was not found on Google Play Store (country: ${country}). ` +
        `Check that the package name is correct and the app is available in this region.`
    );
  }
  emitError("FETCH_ERROR", `Failed to fetch app metadata for "${packageId}": ${msg}`);
}

if (!rawApp || !rawApp.appId) {
  emitError(
    "NOT_FOUND",
    `No app data returned for package "${packageId}". ` +
      `The app may not be available in country "${country}".`
  );
}

const app = normalizeAppDetail(rawApp);
log(`[play-store-app] Found app: "${app.title}" by ${app.developer.name}`);
log(`[play-store-app] Score: ${app.score}, Ratings: ${app.ratings}, Installs: ${app.installs}`);

// Step 3: Fetch reviews (if requested)
if (maxReviews > 0) {
  log(`[play-store-app] Fetching up to ${maxReviews} reviews...`);
  try {
    app.reviewsList = await fetchReviews(packageId, lang, country, maxReviews);
    log(`[play-store-app] Got ${app.reviewsList.length} reviews`);
  } catch (err) {
    log(`[play-store-app] Warning: Could not fetch reviews: ${err.message}`);
    app.reviewsList = [];
  }
} else {
  log(`[play-store-app] Skipping reviews (--max-reviews 0)`);
  app.reviewsList = [];
}

// Step 4: Output
emitResult(app);
