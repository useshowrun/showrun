#!/usr/bin/env node
/**
 * Medium Feed Scraper
 *
 * Fetches blog posts from Medium by tag, author username, or publication.
 * Uses Medium's public RSS feeds for listing + GraphQL API for metadata enrichment.
 *
 * Data Sources:
 *   1. RSS Feed (primary listing):
 *      - Tag:         https://medium.com/feed/tag/<tag>
 *      - Author:      https://medium.com/feed/@<username>
 *      - Publication: https://<pub>.medium.com/feed
 *   2. GraphQL API (metadata enrichment — claps, voterCount, etc.):
 *      POST https://medium.com/_/graphql
 *      No auth required for public posts.
 *
 * Usage:
 *   node medium-feed.mjs <tag-or-username> [options]
 *
 * Arguments:
 *   <tag-or-username>     Tag name, @username, or publication domain
 *                         Detection:
 *                           @username  → author feed
 *                           Contains "." (or --type publication) → publication
 *                           Otherwise → tag feed
 *
 * Options:
 *   --type tag|author|publication    Force feed type (optional; auto-detected by default)
 *   --max <N>                        Max posts to return (default: 10)
 *   --no-enrich                      Skip GraphQL enrichment (faster, no claps/responses)
 *
 * Examples:
 *   node medium-feed.mjs javascript
 *   node medium-feed.mjs artificial-intelligence --max 5
 *   node medium-feed.mjs @towardsdatascience
 *   node medium-feed.mjs towardsdatascience --type author
 *   node medium-feed.mjs towardsdatascience.medium.com --type publication
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
  fetchPostMeta,
  parseRssFeed,
  parseRssChannel,
  normalizePost,
  extractPostId,
  cleanUrl,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node medium-feed.mjs <tag-or-username> [options]

Arguments:
  <tag-or-username>     Medium tag, @username, or publication domain
                        Auto-detected: @user → author, contains "." → publication, else → tag

Options:
  --type tag|author|publication   Force feed type (optional)
  --max <N>                       Max posts to return (default: 10)
  --no-enrich                     Skip GraphQL enrichment (faster)
  --help                          Show this help

Examples:
  node medium-feed.mjs javascript
  node medium-feed.mjs @towardsdatascience
  node medium-feed.mjs artificial-intelligence --max 5
  node medium-feed.mjs towardsdatascience.medium.com --type publication

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

let inputRaw = args[0];
let forceType = null;
let maxPosts = 10;
let enrich = true;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--type" && args[i + 1]) {
    forceType = args[++i].toLowerCase();
  } else if (arg === "--max" && args[i + 1]) {
    maxPosts = Math.max(1, parseInt(args[++i], 10) || 10);
  } else if (arg === "--no-enrich") {
    enrich = false;
  }
}

// ---------------------------------------------------------------------------
// Determine feed type and RSS URL
// ---------------------------------------------------------------------------

let feedType;
let rssUrl;
let feedLabel;

// Auto-detect type
if (forceType) {
  feedType = forceType;
} else if (inputRaw.startsWith("@")) {
  feedType = "author";
} else if (inputRaw.includes(".")) {
  feedType = "publication";
} else {
  feedType = "tag";
}

// Normalize input
const inputClean = inputRaw.replace(/^@/, "").trim();

switch (feedType) {
  case "author":
    rssUrl = `https://medium.com/feed/@${inputClean}`;
    feedLabel = `@${inputClean}`;
    break;
  case "publication": {
    // Could be "pub.medium.com" or just "pub"
    const domain = inputClean.includes(".")
      ? inputClean
      : `${inputClean}.medium.com`;
    rssUrl = `https://${domain}/feed`;
    feedLabel = domain;
    break;
  }
  default: // tag
    // Tags use hyphens on medium; replace underscores/spaces
    const tagSlug = inputClean.replace(/[\s_]+/g, "-").toLowerCase();
    rssUrl = `https://medium.com/feed/tag/${tagSlug}`;
    feedLabel = tagSlug;
    break;
}

log(`[medium-feed] Type: ${feedType}, Input: ${feedLabel}`);
log(`[medium-feed] RSS URL: ${rssUrl}`);
log(`[medium-feed] Max: ${maxPosts}, Enrich: ${enrich}`);

// ---------------------------------------------------------------------------
// Fetch RSS feed
// ---------------------------------------------------------------------------

let rssBody;
try {
  const resp = await fetchUrl(rssUrl, {
    headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" },
  });

  if (resp.status === 404) {
    emitResult({
      query: feedLabel,
      type: feedType,
      total: 0,
      posts: [],
      source: "rss",
      rssUrl,
      note: "Feed not found (404) — tag or author may not exist on Medium",
    });
    process.exit(0);
  }

  if (resp.status >= 400) {
    emitError(
      "RSS_ERROR",
      `RSS feed returned HTTP ${resp.status} for ${rssUrl}`
    );
  }

  rssBody = resp.body;
} catch (err) {
  emitError("FETCH_ERROR", `Could not fetch RSS feed: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Parse RSS
// ---------------------------------------------------------------------------

const channel = parseRssChannel(rssBody);
const items = parseRssFeed(rssBody);

log(`[medium-feed] RSS parsed: ${items.length} items, channel: "${channel.title}"`);

if (items.length === 0) {
  emitResult({
    query: feedLabel,
    type: feedType,
    feedTitle: channel.title || null,
    feedDescription: channel.description || null,
    rssUrl,
    total: 0,
    enriched: enrich,
    posts: [],
  });
  process.exit(0);
}

// Limit to max
const selectedItems = items.slice(0, maxPosts);

// ---------------------------------------------------------------------------
// Enrich with GraphQL metadata
// ---------------------------------------------------------------------------

let posts = [];

if (enrich) {
  log(`[medium-feed] Enriching ${selectedItems.length} posts via GraphQL...`);

  // Fetch in batches of 5 (be polite to the API)
  const BATCH = 5;
  for (let i = 0; i < selectedItems.length; i += BATCH) {
    const batch = selectedItems.slice(i, i + BATCH);
    const metaResults = await Promise.all(
      batch.map((item) => {
        const postId = extractPostId(item.guid || item.link);
        if (!postId) {
          log(`[medium-feed] Could not extract postId from: ${item.guid || item.link}`);
          return Promise.resolve(null);
        }
        return fetchPostMeta(postId);
      })
    );

    for (let j = 0; j < batch.length; j++) {
      posts.push(normalizePost(batch[j], metaResults[j]));
    }

    // Small delay between batches
    if (i + BATCH < selectedItems.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
} else {
  // No enrichment — use RSS data only
  posts = selectedItems.map((item) => normalizePost(item, null));
}

log(`[medium-feed] Done: ${posts.length} posts ready`);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

emitResult({
  query: feedLabel,
  type: feedType,
  feedTitle: channel.title || null,
  feedDescription: channel.description || null,
  rssUrl,
  total: posts.length,
  enriched: enrich,
  posts,
});
