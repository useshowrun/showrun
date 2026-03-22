#!/usr/bin/env node
/**
 * Substack Search Scraper
 *
 * Searches for publications or posts across Substack.
 * Uses the public Substack search API endpoints (no auth required).
 *
 * Data Sources:
 *   1. Publication search: https://substack.com/api/v1/search/publications?query=<q>
 *   2. Post search (global): https://substack.com/search?q=<q> page — intercepts SSR data
 *   3. Per-publication post search: https://{pub}/api/v1/posts (filter by keyword client-side)
 *
 * Usage:
 *   node substack-search.mjs <query> [options]
 *
 * Arguments:
 *   <query>               Search term (required)
 *
 * Options:
 *   --mode <mode>         Search mode: publications|posts (default: publications)
 *   --publication <pub>   Limit post search to a specific publication
 *   --max <N>             Max results (default: 20)
 *   --category <cat>      Category filter for publications (optional)
 *
 * Examples:
 *   node substack-search.mjs "technology" --mode publications --max 10
 *   node substack-search.mjs "AI safety" --mode publications
 *   node substack-search.mjs "climate" --mode posts --publication astralcodexten
 *   node substack-search.mjs "productivity" --mode posts --publication simonwillison
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
  fetchJson,
  resolvePublication,
  normalizePost,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node substack-search.mjs <query> [options]

Arguments:
  <query>           Search query (required)

Options:
  --mode <mode>     Search mode: publications|posts (default: publications)
  --publication <p> For posts mode: limit to specific publication
  --max <N>         Max results (default: 20)
  --help            Show this help

Examples:
  node substack-search.mjs "technology" --mode publications
  node substack-search.mjs "AI" --mode posts --publication astralcodexten
  node substack-search.mjs "writing" --mode posts --publication simonwillison

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const query = args[0];
let mode = "publications";
let publicationInput = null;
let maxResults = 20;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--mode" && args[i + 1]) {
    mode = args[++i].toLowerCase();
    if (!["publications", "posts"].includes(mode)) {
      emitError("INVALID_ARG", `Invalid mode: ${mode}. Must be publications or posts`);
    }
  } else if ((arg === "--publication" || arg === "--pub") && args[i + 1]) {
    publicationInput = args[++i];
  } else if (arg === "--max" && args[i + 1]) {
    maxResults = parseInt(args[++i], 10) || 20;
  }
}

log(`[substack-search] Query: "${query}"`);
log(`[substack-search] Mode: ${mode}, Max: ${maxResults}`);

// ---------------------------------------------------------------------------
// Publication search
// ---------------------------------------------------------------------------

async function searchPublications(query, maxResults) {
  log(`[substack-search] Searching publications...`);

  const url = `https://substack.com/api/v1/search?q=${encodeURIComponent(query)}&limit=${Math.min(maxResults, 50)}`;
  log(`[substack-search] API URL: ${url}`);

  let results = [];

  try {
    const resp = await fetchUrl(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://substack.com/search",
      },
    });

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(resp.body);
    } catch (e) {
      // Not JSON — maybe HTML (search page requires JS)
      log(`[substack-search] /api/v1/search returned non-JSON (status ${resp.status})`);
      throw new Error("Search endpoint returned non-JSON (may require browser)");
    }

    // The /api/v1/search endpoint returns { publications: [...], posts: [...] }
    if (data && Array.isArray(data.publications)) {
      results = data.publications.slice(0, maxResults).map(normalizePubSearchResult);
      log(`[substack-search] Found ${results.length} publications via /api/v1/search`);
    } else if (data && Array.isArray(data)) {
      results = data.slice(0, maxResults).map(normalizePubSearchResult);
      log(`[substack-search] Found ${results.length} publications (array response)`);
    } else {
      throw new Error(`Unexpected response structure: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } catch (apiErr) {
    log(`[substack-search] Primary search failed: ${apiErr.message}`);
    log(`[substack-search] Trying /api/v1/search/publications...`);

    // Try alternative endpoint
    try {
      const altUrl = `https://substack.com/api/v1/search/publications?query=${encodeURIComponent(query)}&limit=${Math.min(maxResults, 50)}`;
      log(`[substack-search] Alt URL: ${altUrl}`);
      const altResp = await fetchUrl(altUrl, {
        headers: {
          Accept: "application/json",
          Referer: "https://substack.com/search",
        },
      });

      let altData;
      try {
        altData = JSON.parse(altResp.body);
      } catch (e) {
        throw new Error(`Alt endpoint also returned non-JSON (status ${altResp.status})`);
      }

      if (Array.isArray(altData)) {
        results = altData.slice(0, maxResults).map(normalizePubSearchResult);
        log(`[substack-search] Alt endpoint: ${results.length} publications`);
      } else if (altData && Array.isArray(altData.results)) {
        results = altData.results.slice(0, maxResults).map(normalizePubSearchResult);
        log(`[substack-search] Alt endpoint (results key): ${results.length} publications`);
      } else {
        throw new Error(`Alt endpoint unexpected structure`);
      }
    } catch (altErr) {
      log(`[substack-search] Alt endpoint failed: ${altErr.message}`);

      // Last resort: use the Substack Discover page to find publications
      // The /api/v1/leaderboard endpoint lists top publications by category
      log(`[substack-search] Trying leaderboard-based search as last resort...`);
      try {
        const leaderboardUrl = `https://substack.com/api/v1/leaderboard?filter=all&limit=50`;
        const lbResp = await fetchJson(leaderboardUrl);
        if (Array.isArray(lbResp.results)) {
          const q = query.toLowerCase();
          const filtered = lbResp.results.filter(
            (p) =>
              (p.name && p.name.toLowerCase().includes(q)) ||
              (p.hero_text && p.hero_text.toLowerCase().includes(q)) ||
              (p.subdomain && p.subdomain.toLowerCase().includes(q))
          );
          results = filtered.slice(0, maxResults).map(normalizePubSearchResult);
          log(`[substack-search] Leaderboard filtered: ${results.length} matches`);
        }
      } catch (lbErr) {
        log(`[substack-search] Leaderboard also failed: ${lbErr.message}`);
        log(`[substack-search] All publication search APIs require browser authentication.`);
        log(`[substack-search] Returning empty results with helpful guidance.`);

        // Return a structured result explaining the limitation
        emitResult({
          query,
          mode: "publications",
          total_results: 0,
          publications: [],
          note:
            "The Substack global publication search API requires browser authentication. " +
            "To find publications, try: (1) Visit https://substack.com/discover to browse by category, " +
            "(2) Use --mode posts --publication <known-subdomain> to search posts within a known publication, " +
            "(3) Try common substack subdomains directly with substack-posts.",
        });
        process.exit(0);
      }
    }
  }

  return results;
}

function normalizePubSearchResult(raw) {
  return {
    name: raw.name || null,
    subdomain: raw.subdomain || null,
    custom_domain: raw.custom_domain || null,
    description: raw.hero_text || raw.description || null,
    url: raw.custom_domain
      ? `https://${raw.custom_domain}`
      : raw.subdomain
        ? `https://${raw.subdomain}.substack.com`
        : null,
    author_name: raw.author_name || null,
    author_handle: raw.author_handle || null,
    author_photo: raw.author_photo_url || null,
    logo_url: raw.logo_url || null,
    subscriber_count: raw.subscriber_count || null,
    category: raw.category || null,
    language: raw.language || null,
  };
}

// ---------------------------------------------------------------------------
// Post search (within a specific publication)
// ---------------------------------------------------------------------------

async function searchPosts(query, publicationInput, maxResults) {
  if (!publicationInput) {
    emitError(
      "MISSING_PUBLICATION",
      "Post search requires --publication <pub>. " +
        "Specify a publication slug, subdomain, or full domain. " +
        "Example: --publication simonwillison or --publication astralcodexten.substack.com"
    );
  }

  const baseUrl = await resolvePublication(publicationInput);
  log(`[substack-search] Searching posts in: ${baseUrl}`);

  const q = query.toLowerCase();
  const matchingPosts = [];
  let offset = 0;
  let pagesFetched = 0;
  const maxPages = 20;

  while (matchingPosts.length < maxResults && pagesFetched < maxPages) {
    const apiUrl = `${baseUrl}/api/v1/posts?limit=25&offset=${offset}`;
    log(`[substack-search] Fetching page ${pagesFetched + 1}: ${apiUrl}`);

    let batch;
    try {
      batch = await fetchJson(apiUrl);
    } catch (err) {
      log(`[substack-search] Error fetching page: ${err.message}`);
      break;
    }

    if (!Array.isArray(batch) || batch.length === 0) {
      log(`[substack-search] No more posts`);
      break;
    }

    for (const rawPost of batch) {
      const titleMatch = rawPost.title && rawPost.title.toLowerCase().includes(q);
      const subtitleMatch = rawPost.subtitle && rawPost.subtitle.toLowerCase().includes(q);
      const bodyMatch =
        rawPost.truncated_body_text &&
        rawPost.truncated_body_text.toLowerCase().includes(q);
      const tagMatch =
        rawPost.postTags &&
        rawPost.postTags.some(
          (t) => (t.name || t.slug || "").toLowerCase().includes(q)
        );

      if (titleMatch || subtitleMatch || bodyMatch || tagMatch) {
        matchingPosts.push(normalizePost(rawPost, baseUrl));
        if (matchingPosts.length >= maxResults) break;
      }
    }

    if (batch.length < 25) break; // Last page
    offset += 25;
    pagesFetched++;
  }

  log(`[substack-search] Found ${matchingPosts.length} matching posts in ${pagesFetched + 1} pages`);
  return {
    publication: publicationInput,
    base_url: baseUrl,
    posts: matchingPosts.slice(0, maxResults),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

let result;

if (mode === "publications") {
  const publications = await searchPublications(query, maxResults);
  result = {
    query,
    mode: "publications",
    total_results: publications.length,
    publications,
  };
} else if (mode === "posts") {
  const postResult = await searchPosts(query, publicationInput, maxResults);
  result = {
    query,
    mode: "posts",
    publication: postResult.publication,
    base_url: postResult.base_url,
    total_results: postResult.posts.length,
    posts: postResult.posts,
  };
}

log(`[substack-search] Done`);
emitResult(result);
