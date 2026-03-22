#!/usr/bin/env node
/**
 * GitHub Search Scraper
 *
 * Searches GitHub for repositories or users by keyword using the GitHub REST API.
 * No authentication required for public data (60 req/hour unauthenticated).
 * Set GITHUB_TOKEN env var for 5000 req/hour.
 *
 * Data Sources:
 *   - Search repos: GET /search/repositories?q=<query>&sort=stars&per_page=30
 *   - Search users: GET /search/users?q=<query>&per_page=20
 *
 * Usage:
 *   node github-search.mjs <query> [options]
 *
 * Arguments:
 *   <query>              Search keyword or query (required)
 *                        Supports GitHub search syntax: "react stars:>1000 language:javascript"
 *
 * Options:
 *   --type repos|users   What to search for (default: repos)
 *   --sort stars|forks|updated|best-match
 *                        Sort order (default: stars for repos, best-match for users)
 *   --max N              Maximum results to return (default: 30, max: 100)
 *   --lang <language>    Filter by programming language (repos only)
 *
 * Examples:
 *   node github-search.mjs "react"
 *   node github-search.mjs "machine learning" --lang python --max 20
 *   node github-search.mjs "vim config" --type repos --sort updated
 *   node github-search.mjs "linus torvalds" --type users
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, "../../lib/utils.mjs");
const { emitResult, emitError, log, fetchJson, normalizeRepo, normalizeUser } = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node github-search.mjs <query> [options]

Arguments:
  <query>              Search keyword or query (required)
                       Supports GitHub syntax: "react stars:>1000 language:javascript"

Options:
  --type repos|users   What to search for (default: repos)
  --sort stars|forks|updated|best-match  Sort order (default: stars)
  --max N              Maximum results (default: 30, max: 100)
  --lang <language>    Filter by programming language (repos only)
  --help               Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const query = args[0];
let type = "repos";
let sort = null;
let max = 30;
let lang = null;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--type" && args[i + 1]) {
    type = args[++i].toLowerCase();
    if (!["repos", "users"].includes(type)) {
      emitError("INVALID_ARG", `--type must be "repos" or "users", got: "${type}"`);
    }
  } else if (arg === "--sort" && args[i + 1]) {
    sort = args[++i].toLowerCase();
  } else if (arg === "--max" && args[i + 1]) {
    max = Math.min(100, Math.max(1, parseInt(args[++i], 10) || 30));
  } else if (arg === "--lang" && args[i + 1]) {
    lang = args[++i];
  }
}

if (!query || query.startsWith("--")) {
  emitError("MISSING_ARG", "Search query is required. Usage: github-search.mjs <query> [options]");
}

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

const BASE = "https://api.github.com";
const perPage = Math.min(max, 100);

let searchQuery = query;
if (lang && type === "repos") {
  // Add language filter if not already in query
  if (!searchQuery.toLowerCase().includes("language:")) {
    searchQuery += ` language:${lang}`;
  }
}

let url;
if (type === "repos") {
  const sortParam = sort || "stars";
  const params = new URLSearchParams({
    q: searchQuery,
    sort: sortParam,
    order: "desc",
    per_page: String(perPage),
  });
  url = `${BASE}/search/repositories?${params}`;
} else {
  // users
  const params = new URLSearchParams({
    q: searchQuery,
    per_page: String(perPage),
  });
  if (sort && sort !== "best-match") {
    params.set("sort", sort);
  }
  url = `${BASE}/search/users?${params}`;
}

log(`[github-search] Searching ${type} for: "${searchQuery}" (max: ${max}, sort: ${sort || "default"})`);
log(`[github-search] URL: ${url}`);

// ---------------------------------------------------------------------------
// Fetch results
// ---------------------------------------------------------------------------

let searchData;
try {
  searchData = await fetchJson(url);
} catch (err) {
  if (err && err.notFound) {
    emitError("NOT_FOUND", `No results found for query: "${query}"`);
  }
  emitError("FETCH_ERROR", `Failed to search GitHub: ${err.message || String(err)}`);
}

if (!searchData || !Array.isArray(searchData.items)) {
  emitError("PARSE_ERROR", "Unexpected response format from GitHub Search API");
}

// ---------------------------------------------------------------------------
// Normalize results
// ---------------------------------------------------------------------------

let results;
if (type === "repos") {
  results = searchData.items.slice(0, max).map((raw) => ({
    ...normalizeRepo(raw),
    // Search API includes score
    score: raw.score,
  }));
} else {
  // For users in search, we get minimal data — normalize what we have
  results = searchData.items.slice(0, max).map((raw) => ({
    login: raw.login,
    type: raw.type || "User",
    avatarUrl: raw.avatar_url,
    url: raw.html_url,
    score: raw.score,
  }));
}

const output = {
  query: searchQuery,
  type,
  sort: sort || (type === "repos" ? "stars" : "best-match"),
  totalCount: searchData.total_count,
  incompleteResults: searchData.incomplete_results ?? false,
  returnedCount: results.length,
  results,
};

log(`[github-search] Found ${searchData.total_count} total, returning ${results.length} results`);

emitResult(output);
