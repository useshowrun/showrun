/**
 * Shared utilities for Medium scraper skills
 *
 * Data sources:
 *   1. Medium RSS feeds (public, no auth):
 *      - Author:      https://medium.com/feed/@username
 *      - Tag:         https://medium.com/feed/tag/<tag>
 *      - Publication: https://<pub>.medium.com/feed
 *   2. Medium GraphQL API (public, no auth):
 *      - POST https://medium.com/_/graphql
 *      - Returns claps, voterCount, responsesCount, word count, tags, etc.
 *   3. Medium post page (HTML) for __APOLLO_STATE__ fallback
 */

import https from "https";
import http from "http";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Standard browser UA for RSS feeds (works fine for medium.com feeds)
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Mobile UA that bypasses Cloudflare managed challenge on medium.com/_/graphql
// Must be combined with medium-frontend-app and medium-frontend-path headers
const MEDIUM_MOBILE_UA = "Medium/1.0 (com.medium.reader; build:1) iOS/17.0";

/**
 * Fetch a URL and return body string + status code.
 * Follows up to 5 redirects automatically.
 */
export function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects ?? 5;
    let redirectsLeft = maxRedirects;

    function doRequest(currentUrl) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          // options.headers can override User-Agent and everything else
          ...(options.headers || {}),
        },
        timeout: options.timeout || 30000,
      };

      const req = lib.request(reqOptions, (res) => {
        // Handle redirects
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          redirectsLeft--;
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith("http")) {
            redirectUrl = new URL(redirectUrl, currentUrl).toString();
          }
          res.resume();
          return doRequest(redirectUrl);
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            finalUrl: currentUrl,
          });
        });
        res.on("error", reject);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out: ${currentUrl}`));
      });
      req.on("error", reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    }

    doRequest(urlStr);
  });
}

/**
 * POST JSON to a URL and parse the JSON response.
 * Uses Medium mobile headers to bypass Cloudflare managed challenge on /_/graphql.
 */
export async function postJson(urlStr, payload, extraHeaders = {}) {
  const bodyStr = JSON.stringify(payload);
  // Medium's GraphQL endpoint requires mobile app headers to bypass CF challenge
  const isMediumGql = urlStr.includes("medium.com/_/graphql");
  const resp = await fetchUrl(urlStr, {
    method: "POST",
    headers: {
      "User-Agent": isMediumGql ? MEDIUM_MOBILE_UA : DEFAULT_UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      ...(isMediumGql
        ? {
            "medium-frontend-app": "lite/1.48.0",
            "medium-frontend-path": "/",
          }
        : {}),
      ...extraHeaders,
    },
    body: bodyStr,
  });
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status} from ${urlStr}: ${resp.body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`Invalid JSON response from ${urlStr}`);
  }
}

// ---------------------------------------------------------------------------
// Medium GraphQL API
// ---------------------------------------------------------------------------

const GQL_URL = "https://medium.com/_/graphql";

/** Full post metadata query */
const POST_DETAIL_QUERY = `query PostDetails($postId: ID!) {
  post(id: $postId) {
    id
    title
    clapCount
    voterCount
    responsesCount
    readingTime
    wordCount
    firstPublishedAt
    latestPublishedAt
    updatedAt
    createdAt
    isLimitedState
    isLockedPreviewOnly
    isLocked
    isSeries
    isShortform
    visibility
    mediumUrl
    uniqueSlug
    previewImage { id }
    creator {
      id
      name
      username
      bio
      imageId
      socialStats { followerCount followingCount }
    }
    collection {
      id
      name
      slug
      description
      domain
      avatar { id }
    }
    tags { id displayTitle }
    extendedPreviewContent { subtitle }
  }
}`;

/** Post content query (paragraphs) */
const POST_CONTENT_QUERY = `query PostContent($postId: ID!) {
  post(id: $postId) {
    id
    isLimitedState
    isLockedPreviewOnly
    content {
      bodyModel {
        paragraphs {
          id
          text
          type
          markups { type start end href }
          hasDropCap
          metadata { id originalHeight originalWidth }
        }
      }
    }
    extendedPreviewContent {
      subtitle
      bodyModel {
        paragraphs {
          id
          text
          type
        }
      }
    }
  }
}`;

/**
 * Fetch post metadata from Medium GraphQL API.
 * @param {string} postId - 12-hex-char post ID (e.g. "1a7cf81e911b")
 * @returns {object|null}
 */
export async function fetchPostMeta(postId) {
  try {
    const data = await postJson(GQL_URL, {
      operationName: "PostDetails",
      variables: { postId },
      query: POST_DETAIL_QUERY,
    });
    return data?.data?.post || null;
  } catch (err) {
    log(`[medium/gql] fetchPostMeta error for ${postId}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch post content (paragraphs) from Medium GraphQL API.
 * @param {string} postId
 * @returns {object|null}
 */
export async function fetchPostContent(postId) {
  try {
    const data = await postJson(GQL_URL, {
      operationName: "PostContent",
      variables: { postId },
      query: POST_CONTENT_QUERY,
    });
    return data?.data?.post || null;
  } catch (err) {
    log(`[medium/gql] fetchPostContent error for ${postId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Medium RSS parser
// ---------------------------------------------------------------------------

/**
 * Parse Medium RSS feed XML into an array of raw items.
 * Works for both tag feeds (snippet only) and author/publication feeds (full content).
 */
export function parseRssFeed(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const item = {
      title: extractCdata(block, "title"),
      link: extractTagText(block, "link"),
      guid: extractTagText(block, "guid") || extractCdata(block, "guid"),
      pubDate: extractTagText(block, "pubDate"),
      updated: extractTagText(block, "atom:updated"),
      creator: extractCdata(block, "dc:creator"),
      categories: extractAllCdata(block, "category"),
      description: extractCdata(block, "description"),
      content: extractCdata(block, "content:encoded"),
    };
    items.push(item);
  }

  return items;
}

/**
 * Extract the channel-level metadata from RSS XML.
 */
export function parseRssChannel(xml) {
  // Extract channel block (before first <item>)
  const channelMatch = xml.match(/<channel>([\s\S]*?)<item>/i);
  if (!channelMatch) return {};
  const block = channelMatch[1];
  return {
    title: extractCdata(block, "title"),
    description: extractCdata(block, "description"),
    link: extractTagText(block, "link"),
    image: extractTagText(block, "url"),
  };
}

function extractTagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractCdata(xml, tag) {
  const reCdata = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    "i"
  );
  const m = xml.match(reCdata);
  if (m) return m[1].trim();
  return extractTagText(xml, tag);
}

function extractAllCdata(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>(?:\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*|([^<]*))<\\/${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null) {
    const val = (m[1] || m[2] || "").trim();
    if (val) results.push(val);
  }
  return results;
}

// ---------------------------------------------------------------------------
// URL & ID utilities
// ---------------------------------------------------------------------------

/**
 * Extract the Medium post ID (12 hex chars) from a URL or GUID.
 * Examples:
 *   https://medium.com/p/1a7cf81e911b  → "1a7cf81e911b"
 *   https://medium.com/@user/slug-1a7cf81e911b → "1a7cf81e911b"
 */
export function extractPostId(urlOrGuid) {
  if (!urlOrGuid) return null;
  // GUID format: https://medium.com/p/<12hexchars>
  const guidMatch = urlOrGuid.match(/\/p\/([a-f0-9]{12})$/i);
  if (guidMatch) return guidMatch[1];
  // URL format: ends with slug-<12hexchars>
  const slugMatch = urlOrGuid.match(/-([a-f0-9]{12})(?:\?|$)/i);
  if (slugMatch) return slugMatch[1];
  // Fallback: last path segment if 12 hex chars
  const pathMatch = urlOrGuid.match(/\/([a-f0-9]{12})(?:\?|$)/i);
  if (pathMatch) return pathMatch[1];
  return null;
}

/**
 * Clean a Medium post URL by removing source tracking params.
 */
export function cleanUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete("source");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Build Medium image URL from imageId.
 * Medium CDN: https://miro.medium.com/v2/resize:fit:1200/<imageId>
 */
export function buildImageUrl(imageId, size = 1200) {
  if (!imageId || imageId === "") return null;
  // If already a full URL
  if (imageId.startsWith("http")) return imageId;
  return `https://miro.medium.com/v2/resize:fit:${size}/${imageId}`;
}

/**
 * Build Medium author avatar URL from imageId.
 */
export function buildAvatarUrl(imageId) {
  if (!imageId || imageId === "") return null;
  if (imageId.startsWith("http")) return imageId;
  return `https://miro.medium.com/v2/resize:fill:96:96/${imageId}`;
}

/**
 * Strip HTML tags from a string (basic).
 */
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#[0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a snippet (first N chars) from HTML content.
 */
export function extractSnippet(html, maxChars = 300) {
  const text = stripHtml(html);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

/**
 * Extract the cover image URL from RSS item description HTML.
 * Medium RSS description contains <img src="..."> for cover.
 */
export function extractCoverFromDescription(description) {
  if (!description) return null;
  const imgMatch = description.match(/<img[^>]+src="([^"]+)"/i);
  return imgMatch ? imgMatch[1] : null;
}

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

/**
 * Merge RSS item data with GraphQL metadata into a clean post object.
 * @param {object} rssItem - Parsed RSS item
 * @param {object|null} gqlMeta - GraphQL post metadata (may be null)
 * @returns {object} Normalized post
 */
export function normalizePost(rssItem, gqlMeta) {
  const postId = extractPostId(rssItem.guid || rssItem.link);
  const cleanedUrl = cleanUrl(rssItem.link);

  // Determine paywall status:
  //   isLimitedState = member-only (paywall, partial preview shown to non-members)
  //   isLockedPreviewOnly = fully locked (preview only for non-members)
  //   isLocked = locked for non-members
  //   visibility !== "PUBLIC" = restricted visibility
  const isPaywalled = gqlMeta
    ? Boolean(
        gqlMeta.isLimitedState ||
        gqlMeta.isLockedPreviewOnly ||
        gqlMeta.isLocked ||
        (gqlMeta.visibility && gqlMeta.visibility !== "PUBLIC")
      )
    : false;

  // Author info: prefer GraphQL (has bio/avatar), fall back to RSS dc:creator
  let author = null;
  if (gqlMeta?.creator) {
    author = {
      name: gqlMeta.creator.name || null,
      username: gqlMeta.creator.username || null,
      bio: gqlMeta.creator.bio || null,
      avatarUrl: buildAvatarUrl(gqlMeta.creator.imageId),
      url: gqlMeta.creator.username
        ? `https://medium.com/@${gqlMeta.creator.username}`
        : null,
      followerCount: gqlMeta.creator.socialStats?.followerCount ?? null,
    };
  } else if (rssItem.creator) {
    author = {
      name: rssItem.creator,
      username: null,
      bio: null,
      avatarUrl: null,
      url: null,
      followerCount: null,
    };
  }

  // Publication (collection) info from GraphQL
  let publication = null;
  if (gqlMeta?.collection) {
    const col = gqlMeta.collection;
    publication = {
      id: col.id || null,
      name: col.name || null,
      slug: col.slug || null,
      description: col.description || null,
      url: col.domain
        ? `https://${col.domain}`
        : col.slug
        ? `https://medium.com/${col.slug}`
        : null,
    };
  }

  // Tags: prefer GraphQL (has display titles), fall back to RSS categories
  let tags = [];
  if (gqlMeta?.tags?.length) {
    tags = gqlMeta.tags.map((t) => ({
      id: t.id,
      name: t.displayTitle,
    }));
  } else if (rssItem.categories?.length) {
    tags = rssItem.categories.map((c) => ({ id: c, name: c }));
  }

  // Timestamps
  const publishedAt = gqlMeta?.firstPublishedAt
    ? new Date(gqlMeta.firstPublishedAt).toISOString()
    : rssItem.pubDate
    ? new Date(rssItem.pubDate).toISOString()
    : null;

  const updatedAt = gqlMeta?.latestPublishedAt
    ? new Date(gqlMeta.latestPublishedAt).toISOString()
    : rssItem.updated
    ? new Date(rssItem.updated).toISOString()
    : null;

  // Cover image
  const coverImageUrl =
    buildImageUrl(gqlMeta?.previewImage?.id) ||
    extractCoverFromDescription(rssItem.description) ||
    null;

  // Excerpt: prefer RSS content:encoded text, fall back to description snippet
  const contentHtml = rssItem.content || rssItem.description || "";
  const excerpt = extractSnippet(contentHtml, 300);

  // Subtitle from GraphQL extendedPreviewContent
  const subtitle =
    gqlMeta?.extendedPreviewContent?.subtitle || null;

  return {
    postId: postId || (gqlMeta?.id ?? null),
    title: gqlMeta?.title || rssItem.title || null,
    subtitle,
    url: cleanedUrl || (gqlMeta?.mediumUrl ?? null),
    publishedAt,
    updatedAt,
    author,
    publication,
    claps: gqlMeta?.clapCount ?? null,
    voters: gqlMeta?.voterCount ?? null,
    responses: gqlMeta?.responsesCount ?? null,
    readingTime: gqlMeta?.readingTime
      ? Math.round(gqlMeta.readingTime)
      : null,
    wordCount: gqlMeta?.wordCount ?? null,
    tags,
    excerpt,
    coverImageUrl,
    isPaywalled,
  };
}

/**
 * Convert Medium GraphQL paragraph bodyModel to plain text.
 * @param {Array} paragraphs
 * @returns {string}
 */
export function paragraphsToText(paragraphs) {
  if (!Array.isArray(paragraphs)) return "";
  return paragraphs
    .map((p) => {
      switch (p.type) {
        case "H2":
        case "H3":
        case "H4":
          return `\n\n## ${p.text}\n`;
        case "ULI":
          return `- ${p.text}`;
        case "OLI":
          return `1. ${p.text}`;
        case "BQ":
          return `> ${p.text}`;
        case "PRE":
          return `\`\`\`\n${p.text}\n\`\`\``;
        case "IMG":
          return p.metadata ? `[Image]` : "";
        case "MIXTAPE_EMBED":
          return `[Embed: ${p.text}]`;
        default:
          return p.text || "";
      }
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert Medium GraphQL paragraph bodyModel to basic HTML.
 * @param {Array} paragraphs
 * @returns {string}
 */
export function paragraphsToHtml(paragraphs) {
  if (!Array.isArray(paragraphs)) return "";
  return paragraphs
    .map((p) => {
      const text = applyMarkups(p.text || "", p.markups || []);
      switch (p.type) {
        case "H2":
          return `<h2>${text}</h2>`;
        case "H3":
          return `<h3>${text}</h3>`;
        case "H4":
          return `<h4>${text}</h4>`;
        case "ULI":
          return `<li>${text}</li>`;
        case "OLI":
          return `<li>${text}</li>`;
        case "BQ":
          return `<blockquote><p>${text}</p></blockquote>`;
        case "PRE":
          return `<pre><code>${escapeHtml(p.text || "")}</code></pre>`;
        case "IMG":
          return `<!-- [image] -->`;
        default:
          return text ? `<p>${text}</p>` : "";
      }
    })
    .join("\n");
}

function applyMarkups(text, markups) {
  if (!markups || !markups.length) return escapeHtml(text);
  // Sort by start position descending so we insert from end to start
  const sorted = [...markups].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    const before = result.slice(0, m.start);
    const content = result.slice(m.start, m.end);
    const after = result.slice(m.end);
    let wrapped;
    switch (m.type) {
      case "STRONG":
        wrapped = `<strong>${content}</strong>`;
        break;
      case "EM":
        wrapped = `<em>${content}</em>`;
        break;
      case "A":
        wrapped = m.href
          ? `<a href="${m.href}">${content}</a>`
          : `<a>${content}</a>`;
        break;
      case "CODE":
        wrapped = `<code>${content}</code>`;
        break;
      default:
        wrapped = content;
    }
    result = before + wrapped + after;
  }
  return result;
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
