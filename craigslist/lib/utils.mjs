/**
 * Shared utilities for Craigslist scraper skills
 */

import https from "https";
import http from "http";
import { URL } from "url";
import zlib from "zlib";

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
// HTTP fetch helper (no external dependencies)
// Supports gzip/deflate/br decompression
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/**
 * Fetch a URL and return body string + status code.
 * Handles gzip/deflate decompression and follows redirects.
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
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
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

        // Handle decompression
        const encoding = res.headers["content-encoding"];
        let stream = res;

        if (encoding === "gzip") {
          stream = zlib.createGunzip();
          res.pipe(stream);
        } else if (encoding === "deflate") {
          stream = zlib.createInflate();
          res.pipe(stream);
        }

        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            finalUrl: currentUrl,
          });
        });
        stream.on("error", reject);

        if (stream === res) {
          // No decompression needed — attach directly
          // Already handled above via chunks
        }
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
 * Fetch JSON from a URL.
 */
export async function fetchJson(urlStr, options = {}) {
  const resp = await fetchUrl(urlStr, {
    ...options,
    headers: {
      Accept: "application/json, text/html, */*",
      ...(options.headers || {}),
    },
  });
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
// Craigslist HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract content between tags (simple, no DOM library needed)
 */
export function extractTag(html, tag, attrs = "") {
  const re = new RegExp(`<${tag}[^>]*${attrs}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract an attribute value from a tag
 */
export function extractAttr(html, attr) {
  const re = new RegExp(`${attr}="([^"]*)"`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Parse the ld+json script by ID from HTML
 */
export function extractLdJson(html, scriptId) {
  const re = new RegExp(
    `<script[^>]*id="${scriptId}"[^>]*>([\\s\\S]*?)<\\/script>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

/**
 * Parse all ld+json scripts from HTML
 */
export function extractAllLdJson(html) {
  const results = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      results.push(JSON.parse(m[1]));
    } catch (e) {
      // skip invalid
    }
  }
  return results;
}

/**
 * Convert a Craigslist image URL to full-size (1200x900 or largest available)
 * Input:  https://images.craigslist.org/00b0b_47hg7cuHCNg_0Mo0Mo_600x450.jpg
 * Output: https://images.craigslist.org/00b0b_47hg7cuHCNg_0Mo0Mo_1200x900.jpg
 */
export function toFullSizeImage(url) {
  if (!url) return url;
  // Replace the size suffix with 1200x900
  return url.replace(/_\d+x\d+(\.\w+)$/, "_1200x900$1");
}

/**
 * Extract the posting ID from a Craigslist URL
 * https://sfbay.craigslist.org/sfc/bik/d/san-francisco-bmx-bike/7912241254.html → 7912241254
 */
export function extractPostingId(url) {
  const m = url.match(/\/(\d+)\.html/);
  return m ? m[1] : null;
}

/**
 * Build a Craigslist search URL
 */
export function buildSearchUrl(city, category, params = {}) {
  const base = `https://${city}.craigslist.org/search/${category}`;
  const qs = new URLSearchParams();
  if (params.query) qs.set("query", params.query);
  if (params.minPrice != null) qs.set("min_price", String(params.minPrice));
  if (params.maxPrice != null) qs.set("max_price", String(params.maxPrice));
  if (params.start) qs.set("start", String(params.start));
  const qsStr = qs.toString();
  return qsStr ? `${base}?${qsStr}` : base;
}

/**
 * Strip HTML tags and normalize whitespace
 */
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
