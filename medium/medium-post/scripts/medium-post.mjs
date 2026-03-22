#!/usr/bin/env node
/**
 * Medium Post Scraper
 *
 * Fetches full metadata and content for a single Medium post by URL.
 * Uses Medium's public GraphQL API — no auth required for public posts.
 *
 * Data Sources:
 *   1. GraphQL API (primary):
 *      POST https://medium.com/_/graphql
 *      - PostDetails: title, claps, voterCount, responsesCount, author, tags, etc.
 *      - PostContent: full paragraph bodyModel (for free posts)
 *   2. Author's RSS feed (for full HTML content, free posts only, as supplement)
 *
 * Usage:
 *   node medium-post.mjs <post-url> [options]
 *
 * Arguments:
 *   <post-url>     Full Medium post URL, e.g.:
 *                  https://medium.com/@user/slug-1a7cf81e911b
 *                  https://towardsdatascience.com/slug-2a5047bb66e0
 *                  https://medium.com/p/1a7cf81e911b
 *
 * Options:
 *   --include-content    Include full post content (text + HTML); paywalled posts → excerpt only
 *   --format text|html   Content format: "text" (default) or "html"
 *
 * Examples:
 *   node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b
 *   node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content
 *   node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content --format html
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
  fetchPostMeta,
  fetchPostContent,
  normalizePost,
  extractPostId,
  buildImageUrl,
  buildAvatarUrl,
  paragraphsToText,
  paragraphsToHtml,
  extractSnippet,
  stripHtml,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write(`Usage: node medium-post.mjs <post-url> [options]

Arguments:
  <post-url>     Full Medium post URL

Options:
  --include-content    Include full post content (free posts only)
  --format text|html   Content output format (default: text)
  --help               Show this help

Examples:
  node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b
  node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content
  node medium-post.mjs https://medium.com/@user/my-post-1a7cf81e911b --include-content --format html

Output: RESULT:{json} on stdout, logs on stderr
`);
  process.exit(0);
}

const postUrl = args[0];
let includeContent = false;
let contentFormat = "text";

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--include-content") {
    includeContent = true;
  } else if (arg === "--format" && args[i + 1]) {
    contentFormat = args[++i].toLowerCase();
    if (!["text", "html"].includes(contentFormat)) {
      contentFormat = "text";
    }
  }
}

// ---------------------------------------------------------------------------
// Extract post ID from URL
// ---------------------------------------------------------------------------

log(`[medium-post] URL: ${postUrl}`);

const postId = extractPostId(postUrl);
if (!postId) {
  emitError(
    "INVALID_URL",
    `Could not extract a Medium post ID from URL: ${postUrl}\n` +
      `Expected format: https://medium.com/@user/slug-<12hexchars>\n` +
      `or https://medium.com/p/<12hexchars>`
  );
}

log(`[medium-post] Extracted postId: ${postId}`);

// ---------------------------------------------------------------------------
// Fetch post metadata
// ---------------------------------------------------------------------------

log(`[medium-post] Fetching post metadata via GraphQL...`);
const meta = await fetchPostMeta(postId);

if (!meta) {
  emitError(
    "NOT_FOUND",
    `Post not found or GraphQL query failed for post ID: ${postId}`
  );
}

// Build normalized post using RSS-less normalizer (pass dummy rssItem with guid)
const dummyRssItem = {
  guid: `https://medium.com/p/${postId}`,
  link: postUrl,
  creator: null,
  categories: [],
  description: null,
  content: null,
  pubDate: null,
  updated: null,
};
const post = normalizePost(dummyRssItem, meta);

log(`[medium-post] Got metadata: "${post.title}"`);
log(`[medium-post] isPaywalled: ${post.isPaywalled}, claps: ${post.claps}`);

// ---------------------------------------------------------------------------
// Fetch content (optional)
// ---------------------------------------------------------------------------

let contentData = null;

if (includeContent) {
  log(`[medium-post] Fetching post content via GraphQL...`);
  const rawContent = await fetchPostContent(postId);

  if (rawContent) {
    const isPaywalled = Boolean(
      rawContent.isLimitedState || rawContent.isLockedPreviewOnly
    );
    // Update paywall status from content query
    post.isPaywalled = isPaywalled;

    const contentParagraphs =
      rawContent.content?.bodyModel?.paragraphs || [];
    const previewParagraphs =
      rawContent.extendedPreviewContent?.bodyModel?.paragraphs || [];

    if (isPaywalled) {
      // Paywalled: only preview content available
      log(`[medium-post] Post is paywalled — returning preview content only`);
      const previewText = paragraphsToText(previewParagraphs);
      const previewHtml = paragraphsToHtml(previewParagraphs);
      contentData = {
        isPaywalled: true,
        note: "Full content locked (member-only). Preview excerpt below.",
        paragraphCount: previewParagraphs.length,
        content:
          contentFormat === "html"
            ? previewHtml || null
            : previewText || null,
      };
    } else {
      // Free post: full content available
      const allParagraphs =
        contentParagraphs.length > 0 ? contentParagraphs : previewParagraphs;
      log(
        `[medium-post] Free post — ${allParagraphs.length} paragraphs available`
      );
      const fullText = paragraphsToText(allParagraphs);
      const fullHtml = paragraphsToHtml(allParagraphs);
      contentData = {
        isPaywalled: false,
        paragraphCount: allParagraphs.length,
        content:
          contentFormat === "html" ? fullHtml : fullText,
      };
    }
  } else {
    log(`[medium-post] Content query returned null — may be paywalled or unavailable`);
    contentData = {
      isPaywalled: true,
      note: "Content unavailable — post may be paywalled or deleted",
      content: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------

const output = {
  postId: post.postId,
  title: post.title,
  subtitle: post.subtitle,
  url: post.url || postUrl,
  publishedAt: post.publishedAt,
  updatedAt: post.updatedAt,
  author: post.author,
  publication: post.publication,
  claps: post.claps,
  voters: post.voters,
  responses: post.responses,
  readingTime: post.readingTime,
  wordCount: post.wordCount,
  tags: post.tags,
  excerpt: post.excerpt || null,
  coverImageUrl: post.coverImageUrl,
  isPaywalled: post.isPaywalled,
};

if (includeContent && contentData) {
  output.contentFormat = contentFormat;
  output.contentInfo = {
    isPaywalled: contentData.isPaywalled,
    paragraphCount: contentData.paragraphCount || null,
    note: contentData.note || null,
  };
  output.content = contentData.content;
}

log(`[medium-post] Done`);
emitResult(output);
