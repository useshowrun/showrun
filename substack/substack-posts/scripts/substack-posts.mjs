#!/usr/bin/env node
/**
 * Substack Posts Scraper
 *
 * Fetches posts from a specific Substack publication using the public REST API.
 * Works for both .substack.com domains and custom domains (e.g. platformer.news).
 * Falls back to RSS feed parsing if the API is unavailable.
 *
 * Data Sources:
 *   1. Substack Public API: https://{pub}.substack.com/api/v1/posts
 *      - Returns full JSON for public posts (no auth required)
 *      - Supports pagination via limit/offset
 *      - Also fetches publication metadata from /api/v1/publication
 *   2. RSS Feed: https://{pub}.substack.com/feed
 *      - Standard RSS/Atom XML fallback
 *
 * Usage:
 *   node substack-posts.mjs <publication> [options]
 *
 * Arguments:
 *   <publication>         Publication slug, subdomain, or full domain
 *                         Examples:
 *                           simonwillison
 *                           simonwillison.substack.com
 *                           astralcodexten.substack.com
 *                           www.astralcodexten.com
 *
 * Options:
 *   --max <N>             Max posts to fetch (default: 20)
 *   --offset <N>          Pagination offset (default: 0)
 *   --type <type>         Filter by type: newsletter|podcast|thread|video (optional)
 *   --free-only           Only return posts accessible without a paid subscription
 *   --include-body        Include full body HTML (free posts only; large!)
 *   --publication-info    Include publication metadata in output
 *
 * Examples:
 *   node substack-posts.mjs simonwillison --max 10
 *   node substack-posts.mjs astralcodexten.substack.com --max 5 --type newsletter
 *   node substack-posts.mjs astralcodexten.substack.com --free-only --max 20
 *   node substack-posts.mjs platformer.news --max 10
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
  parseRss,
  normalizePost,
  normalizePublication,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node substack-posts.mjs <publication> [options]

Arguments:
  <publication>     Substack publication: slug, subdomain, or full domain
                    e.g. "simonwillison", "simonwillison.substack.com",
                         "astralcodexten.substack.com", "platformer.news"

Options:
  --max <N>         Max posts (default: 20)
  --offset <N>      Pagination offset (default: 0)
  --type <type>     Filter: newsletter|podcast|thread|video
  --free-only       Only free/public posts
  --include-body    Include full HTML body (free posts only)
  --publication-info Include publication metadata
  --help            Show this help

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

let publicationInput = args[0];
let maxPosts = 20;
let offset = 0;
let filterType = null;
let freeOnly = false;
let includeBody = false;
let includePublicationInfo = false;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--max" && args[i + 1]) {
    maxPosts = parseInt(args[++i], 10) || 20;
  } else if (arg === "--offset" && args[i + 1]) {
    offset = parseInt(args[++i], 10) || 0;
  } else if (arg === "--type" && args[i + 1]) {
    filterType = args[++i].toLowerCase();
  } else if (arg === "--free-only") {
    freeOnly = true;
  } else if (arg === "--include-body") {
    includeBody = true;
  } else if (arg === "--publication-info") {
    includePublicationInfo = true;
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

log(`[substack-posts] Publication: ${publicationInput}`);
log(`[substack-posts] Max: ${maxPosts}, Offset: ${offset}`);
if (filterType) log(`[substack-posts] Filter type: ${filterType}`);
if (freeOnly) log(`[substack-posts] Free posts only`);

// Step 1: Resolve the base URL
const baseUrl = await resolvePublication(publicationInput);
log(`[substack-posts] Base URL: ${baseUrl}`);

// Step 2: Fetch publication metadata (optional but good for context)
let publicationData = null;
if (includePublicationInfo) {
  try {
    const pubUrl = `${baseUrl}/api/v1/publication`;
    log(`[substack-posts] Fetching publication info: ${pubUrl}`);
    const raw = await fetchJson(pubUrl);
    publicationData = normalizePublication(raw);
    log(`[substack-posts] Publication: ${publicationData.name}`);
  } catch (err) {
    log(`[substack-posts] Warning: Could not fetch publication info: ${err.message}`);
  }
}

// Step 3: Fetch posts via the public API
let posts = [];
let usedFallback = false;
let apiSuccess = false;

// Calculate how many to request (account for type filtering)
const fetchLimit = Math.min(25, maxPosts * (filterType ? 4 : 1) + offset);

try {
  const apiUrl = `${baseUrl}/api/v1/posts?limit=${Math.min(fetchLimit, 25)}&offset=${offset}`;
  log(`[substack-posts] Fetching posts: ${apiUrl}`);
  const rawPosts = await fetchJson(apiUrl);

  if (Array.isArray(rawPosts)) {
    log(`[substack-posts] API returned ${rawPosts.length} posts`);
    apiSuccess = true;

    // Normalize posts
    let normalized = rawPosts.map((p) => normalizePost(p, baseUrl));

    // Apply filters
    if (filterType) {
      normalized = normalized.filter((p) => p.type === filterType);
    }
    if (freeOnly) {
      normalized = normalized.filter((p) => !p.is_paid || p.is_free_preview);
    }

    // If we need more posts and have a filter, paginate
    if (normalized.length < maxPosts && rawPosts.length === 25 && filterType) {
      let nextOffset = offset + 25;
      let attempts = 0;
      while (normalized.length < maxPosts && attempts < 8) {
        attempts++;
        try {
          const moreUrl = `${baseUrl}/api/v1/posts?limit=25&offset=${nextOffset}`;
          log(`[substack-posts] Paginating: ${moreUrl}`);
          const morePosts = await fetchJson(moreUrl);
          if (!Array.isArray(morePosts) || morePosts.length === 0) break;

          let moreNorm = morePosts.map((p) => normalizePost(p, baseUrl));
          if (filterType) moreNorm = moreNorm.filter((p) => p.type === filterType);
          if (freeOnly) moreNorm = moreNorm.filter((p) => !p.is_paid || p.is_free_preview);

          normalized.push(...moreNorm);
          nextOffset += 25;
          if (morePosts.length < 25) break;
        } catch (err) {
          log(`[substack-posts] Pagination error: ${err.message}`);
          break;
        }
      }
    }

    // Remove body from non-free posts if requested, apply max
    posts = normalized.slice(0, maxPosts).map((p) => {
      if (!includeBody) {
        const { body_html, ...rest } = p;
        return rest;
      }
      return p;
    });

  } else {
    throw new Error("API did not return an array");
  }
} catch (apiError) {
  log(`[substack-posts] API error: ${apiError.message}`);
  log(`[substack-posts] Falling back to RSS feed...`);
  usedFallback = true;

  // RSS fallback
  try {
    const rssUrl = `${baseUrl}/feed`;
    log(`[substack-posts] Fetching RSS: ${rssUrl}`);
    const resp = await fetchUrl(rssUrl);

    if (resp.status >= 400) {
      throw new Error(`RSS returned HTTP ${resp.status}`);
    }

    const items = parseRss(resp.body);
    log(`[substack-posts] RSS returned ${items.length} items`);

    // Convert RSS items to normalized format
    let normalized = items.map((item) => ({
      id: null,
      slug: item.link ? item.link.split("/").pop() : null,
      title: item.title,
      subtitle: null,
      type: "newsletter",
      post_date: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      canonical_url: item.link,
      is_paid: false,
      is_free_preview: false,
      audience: "everyone",
      reaction_count: 0,
      comment_count: 0,
      word_count: null,
      restacks: 0,
      cover_image: item.enclosureUrl || null,
      authors: item.creator ? [{ name: item.creator, handle: null, photo_url: null }] : [],
      tags: [],
      audio_url: null,
      body_html: includeBody ? item.content : null,
      truncated_body: item.description,
    }));

    if (freeOnly) {
      normalized = normalized.filter((p) => !p.is_paid);
    }

    posts = normalized.slice(0, maxPosts);
  } catch (rssError) {
    emitError(
      "FETCH_ERROR",
      `Could not fetch posts from ${publicationInput}. API error: ${apiError.message}. RSS error: ${rssError.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  publication: publicationInput,
  base_url: baseUrl,
  total_fetched: posts.length,
  offset,
  source: usedFallback ? "rss" : "api",
  filters: {
    type: filterType || null,
    free_only: freeOnly,
  },
  posts,
};

if (publicationData) {
  result.publication_info = publicationData;
}

log(`[substack-posts] Done: ${posts.length} posts`);
emitResult(result);
