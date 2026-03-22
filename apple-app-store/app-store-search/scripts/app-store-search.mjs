#!/usr/bin/env node
/**
 * Apple App Store Search Scraper
 *
 * Searches for iOS apps by keyword using the public iTunes Search API.
 * No authentication or browser required — pure HTTP.
 *
 * Data Source:
 *   iTunes Search API: https://itunes.apple.com/search
 *   Documentation: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
 *
 * Usage:
 *   node app-store-search.mjs <query> [options]
 *
 * Arguments:
 *   <query>              Search term (required)
 *
 * Options:
 *   --country <cc>       2-letter country code (default: us)
 *   --max <N>            Max results to return (default: 25, max: 200)
 *   --type <entity>      App type: software (iOS) | mac_software | tv_software (default: software)
 *
 * Examples:
 *   node app-store-search.mjs slack
 *   node app-store-search.mjs "photo editor" --max 10
 *   node app-store-search.mjs fitness --country gb --max 20
 *   node app-store-search.mjs "video editor" --type software --max 15
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const { emitResult, emitError, log, fetchJson, normalizeAppSummary } =
  await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node app-store-search.mjs <query> [options]

Arguments:
  <query>           Search term (required)

Options:
  --country <cc>    2-letter country code (default: us)
  --max <N>         Max results (default: 25, max: 200)
  --type <entity>   App type: software | mac_software | tv_software (default: software)
  --help            Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const query = args[0];
let country = "us";
let maxResults = 25;
let entity = "software";

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--country" || arg === "-c") && args[i + 1]) {
    country = args[++i].toLowerCase();
  } else if ((arg === "--max" || arg === "-n") && args[i + 1]) {
    maxResults = Math.min(200, Math.max(1, parseInt(args[++i], 10) || 25));
  } else if (arg === "--type" && args[i + 1]) {
    entity = args[++i];
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

log(`[app-store-search] Query: "${query}", country: ${country}, max: ${maxResults}, type: ${entity}`);

// iTunes Search API accepts limit 1-200
const apiUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=${entity}&country=${country}&limit=${maxResults}&lang=en_us`;
log(`[app-store-search] API URL: ${apiUrl}`);

let data;
try {
  data = await fetchJson(apiUrl);
} catch (err) {
  emitError("FETCH_ERROR", `Failed to fetch search results: ${err.message}`);
}

if (!data || !Array.isArray(data.results)) {
  emitError("PARSE_ERROR", "Unexpected response format from iTunes Search API");
}

const apps = data.results
  .filter((r) => r.kind === "software" || r.wrapperType === "software")
  .map(normalizeAppSummary);

log(`[app-store-search] Found ${apps.length} apps (API returned ${data.resultCount} results)`);

emitResult({
  query,
  country,
  entity,
  total: apps.length,
  apps,
});
