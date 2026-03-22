#!/usr/bin/env node
/**
 * Google Play Store Search Scraper
 *
 * Searches for Android apps by keyword using the google-play-scraper package,
 * which reverse-engineers Google's internal Play Store APIs. No browser or
 * authentication required — pure HTTP.
 *
 * Data Source:
 *   Google Play internal search API (via google-play-scraper npm package)
 *   Search page: https://play.google.com/store/search?q=<query>&c=apps&hl=en
 *
 * Usage:
 *   node play-store-search.mjs <query> [options]
 *
 * Arguments:
 *   <query>              Search term (required)
 *
 * Options:
 *   --country <cc>       2-letter country code (default: us)
 *   --lang <code>        Language code (default: en)
 *   --max <N>            Max results to return (default: 25)
 *
 * Examples:
 *   node play-store-search.mjs slack
 *   node play-store-search.mjs "photo editor" --max 10
 *   node play-store-search.mjs fitness --country gb --lang en --max 20
 *   node play-store-search.mjs "video editor" --country tr --lang tr
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const { gplay, emitResult, emitError, log, normalizeSearchResult } =
  await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node play-store-search.mjs <query> [options]

Arguments:
  <query>           Search term (required)

Options:
  --country <cc>    2-letter country code (default: us)
  --lang <code>     Language code (default: en)
  --max <N>         Max results (default: 25)
  --help            Show this help

Output: RESULT:{json} on stdout, logs on stderr

Examples:
  node play-store-search.mjs slack
  node play-store-search.mjs "photo editor" --max 10
  node play-store-search.mjs fitness --country tr --lang tr
`);
  process.exit(0);
}

const query = args[0];
let country = "us";
let lang = "en";
let maxResults = 25;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--country" || arg === "-c") && args[i + 1]) {
    country = args[++i].toLowerCase();
  } else if ((arg === "--lang" || arg === "-l") && args[i + 1]) {
    lang = args[++i].toLowerCase();
  } else if ((arg === "--max" || arg === "-n") && args[i + 1]) {
    maxResults = Math.max(1, parseInt(args[++i], 10) || 25);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

log(`[play-store-search] Query: "${query}", country: ${country}, lang: ${lang}, max: ${maxResults}`);

let rawResults;
try {
  rawResults = await gplay.search({
    term: query,
    num: maxResults,
    country,
    lang,
  });
} catch (err) {
  emitError("FETCH_ERROR", `Failed to search Google Play Store: ${err.message}`);
}

if (!Array.isArray(rawResults)) {
  emitError("PARSE_ERROR", "Unexpected response format from Google Play Store search");
}

const apps = rawResults.map(normalizeSearchResult);

log(`[play-store-search] Found ${apps.length} apps`);

emitResult({
  query,
  country,
  lang,
  total: apps.length,
  apps,
});
