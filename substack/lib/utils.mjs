/**
 * Shared utilities for Substack scraper skills
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
// HTTP fetch helper (no dependencies)
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
        method: "GET",
        headers: {
          "User-Agent": options.userAgent || DEFAULT_UA,
          Accept: "application/json, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
          ...(options.headers || {}),
        },
        timeout: options.timeout || 25000,
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
      req.end();
    }

    doRequest(urlStr);
  });
}

/**
 * Fetch JSON from a URL (parses response body as JSON).
 */
export async function fetchJson(urlStr, options = {}) {
  const resp = await fetchUrl(urlStr, options);
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status} for ${urlStr}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${urlStr}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Substack domain resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Substack publication input to a base URL.
 * Accepts:
 *   - "simonwillison" → https://simonwillison.substack.com
 *   - "simonwillison.substack.com" → https://simonwillison.substack.com
 *   - "astralcodexten.substack.com" → follows redirect to custom domain
 *   - "www.astralcodexten.com" → uses as-is
 *   - Full URL → extracts hostname
 *
 * Returns the canonical base URL (with trailing slash stripped).
 */
export async function resolvePublication(input) {
  // Strip whitespace and protocol if provided
  let domain = input.trim();
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    domain = new URL(domain).hostname;
  }

  // If no dot → treat as substack subdomain slug
  if (!domain.includes(".")) {
    domain = `${domain}.substack.com`;
  }

  // Return the base URL
  return `https://${domain}`;
}

// ---------------------------------------------------------------------------
// RSS XML parser (minimal, no deps)
// ---------------------------------------------------------------------------

/**
 * Parse a minimal RSS feed XML string into an array of items.
 * Returns an array of objects with title, link, pubDate, description, content.
 */
export function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const item = {
      title: extractCdata(block, "title"),
      link: extractTag(block, "link"),
      guid: extractTag(block, "guid") || extractCdata(block, "guid"),
      pubDate: extractTag(block, "pubDate"),
      creator: extractCdata(block, "dc:creator"),
      description: extractCdata(block, "description"),
      content: extractCdata(block, "content:encoded"),
      enclosureUrl: extractAttr(block, "enclosure", "url"),
    };
    items.push(item);
  }

  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractCdata(xml, tag) {
  // Match CDATA first, then plain
  const reCdata = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    "i"
  );
  const m = xml.match(reCdata);
  if (m) return m[1].trim();
  return extractTag(xml, tag);
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Data normalization helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw Substack API post object to a clean output object.
 */
export function normalizePost(raw, publicationBaseUrl) {
  const authors = (raw.publishedBylines || []).map((b) => ({
    name: b.name,
    handle: b.handle,
    photo_url: b.photo_url || null,
  }));

  // Sum reactions across emoji keys
  let reactionCount = raw.reaction_count;
  if (!reactionCount && raw.reactions && typeof raw.reactions === "object") {
    reactionCount = Object.values(raw.reactions).reduce(
      (s, v) => s + (Number(v) || 0),
      0
    );
  }

  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle || null,
    type: raw.type || "newsletter",
    post_date: raw.post_date,
    canonical_url: raw.canonical_url,
    is_paid: raw.audience === "only_paid",
    is_free_preview: raw.should_send_free_preview || false,
    audience: raw.audience,
    reaction_count: reactionCount || 0,
    comment_count: raw.comment_count || 0,
    word_count: raw.wordcount || null,
    restacks: raw.restacks || 0,
    cover_image: raw.cover_image || null,
    authors,
    tags: (raw.postTags || []).map((t) => t.name || t.slug || t),
    audio_url: raw.podcast_url || raw.podcastFields?.free_podcast_url || null,
    body_html: raw.body_html || null,
    truncated_body: raw.truncated_body_text || null,
  };
}

/**
 * Map a raw Substack publication API object to a clean output object.
 */
export function normalizePublication(raw) {
  return {
    id: raw.id,
    name: raw.name,
    subdomain: raw.subdomain,
    custom_domain: raw.custom_domain || null,
    description: raw.hero_text || null,
    logo_url: raw.logo_url || null,
    author_id: raw.author_id,
    payments_enabled: raw.payments_state === "enabled",
    language: raw.language || "en",
  };
}
