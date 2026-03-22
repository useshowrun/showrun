/**
 * Shared utilities for Rightmove scraper skills
 *
 * Data sources:
 *   - Search pages: __NEXT_DATA__ JSON embedded in <script> tag
 *   - Listing pages: window.PAGE_MODEL = {...} embedded in HTML
 *   - Location resolution: GET /property-for-sale/{Location}.html or
 *                               /property-to-rent/{Location}.html (SSR location info)
 */

import https from "https";
import zlib from "zlib";
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
// HTTP fetch helper (no external dependencies)
// Supports gzip/deflate decompression and follows redirects
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/**
 * Fetch a URL and return { status, body, headers, finalUrl }.
 * Does NOT follow redirects by default (Rightmove uses 307 for bad URLs).
 */
export function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": options.userAgent || DEFAULT_UA,
        Accept:
          options.json
            ? "application/json, text/html, */*"
            : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://www.rightmove.co.uk/",
        Connection: "keep-alive",
        ...(options.headers || {}),
      },
      timeout: options.timeout || 30000,
    };

    const req = https.request(reqOptions, (res) => {
      // Detect decompression
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
          finalUrl: urlStr,
          location: res.headers.location,
        });
      });
      stream.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out: ${urlStr}`));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Rightmove-specific helpers
// ---------------------------------------------------------------------------

/**
 * Extract __NEXT_DATA__ JSON from a Rightmove search page.
 * Returns pageProps or null.
 */
export function extractNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return data.props?.pageProps || null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract window.PAGE_MODEL from a Rightmove listing page.
 * Returns the PAGE_MODEL object or null.
 */
export function extractPageModel(html) {
  const markerIdx = html.indexOf("window.PAGE_MODEL = ");
  if (markerIdx === -1) return null;

  const after = html.substring(markerIdx + "window.PAGE_MODEL = ".length);

  // Walk the JSON to find matching closing brace
  let depth = 0;
  let endIdx = 0;
  let inStr = false;
  let escape = false;

  for (let i = 0; i < after.length; i++) {
    const c = after[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (c === "\\" && inStr) {
      escape = true;
      continue;
    }

    if (c === '"') {
      inStr = !inStr;
      continue;
    }

    if (!inStr) {
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
  }

  if (endIdx === 0) return null;

  try {
    return JSON.parse(after.substring(0, endIdx));
  } catch (e) {
    return null;
  }
}

/**
 * Resolve a location name to a Rightmove locationIdentifier.
 *
 * Strategy: fetch /property-for-sale/{Location}.html (SSR page) — Rightmove
 * does a text-match redirect to the canonical location and embeds the
 * locationIdentifier in __NEXT_DATA__.
 *
 * Returns { locationIdentifier, displayName, locationType, id } or throws.
 */
export async function resolveLocation(locationName, channel = "BUY") {
  // Build slug: capitalise first letter of each word for the URL
  const slug = locationName
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");

  const baseUrl =
    channel === "RENT"
      ? `https://www.rightmove.co.uk/property-to-rent/${encodeURIComponent(slug)}.html`
      : `https://www.rightmove.co.uk/property-for-sale/${encodeURIComponent(slug)}.html`;

  log(`Resolving location: "${locationName}" → ${baseUrl}`);

  const resp = await fetchUrl(baseUrl);

  // Rightmove uses 307 for invalid locations (redirects to page-not-found)
  if (resp.status === 307) {
    throw new Error(
      `Location not found: "${locationName}". Try a UK city, postcode, or region name.`
    );
  }

  if (resp.status !== 200) {
    throw new Error(
      `Unexpected HTTP ${resp.status} for location: "${locationName}"`
    );
  }

  const pageProps = extractNextData(resp.body);
  if (!pageProps) {
    throw new Error(
      `Could not parse page data for location: "${locationName}"`
    );
  }

  const sr = pageProps.searchResults;
  if (!sr || !sr.location) {
    throw new Error(`No location data found for: "${locationName}"`);
  }

  const loc = sr.location;
  return {
    locationIdentifier: `${loc.locationType}^${loc.id}`,
    displayName: loc.displayName,
    locationType: loc.locationType,
    id: loc.id,
  };
}

/**
 * Normalise a property object from search results __NEXT_DATA__.
 */
export function normaliseSearchProperty(prop) {
  const price = prop.price || {};
  const customer = prop.customer || {};
  const listingUpdate = prop.listingUpdate || {};
  const thumbnail = prop.images?.[0]?.srcUrl || null;

  return {
    propertyId: prop.id,
    url: prop.propertyUrl
      ? `https://www.rightmove.co.uk${prop.propertyUrl.replace(/#.*$/, "")}`
      : null,
    displayAddress: prop.displayAddress || null,
    bedrooms: prop.bedrooms ?? null,
    bathrooms: prop.bathrooms ?? null,
    propertySubType: prop.propertySubType || null,
    price: {
      amount: price.amount ?? null,
      currency: price.currencyCode || "GBP",
      frequency: price.frequency || null,
      displayPrice: price.displayPrices?.[0]?.displayPrice || null,
      qualifier: price.displayPrices?.[0]?.displayPriceQualifier || null,
    },
    listingUpdate: {
      reason: listingUpdate.listingUpdateReason || null,
      date: listingUpdate.listingUpdateDate || null,
    },
    thumbnailUrl: thumbnail,
    featuredProperty: prop.featuredProperty || false,
    isPremiumListing: prop.premiumListing || false,
    firstVisibleDate: prop.firstVisibleDate || null,
    addedDate: prop.firstVisibleDate || listingUpdate.listingUpdateDate || null,
    tenure: prop.tenure?.tenureType || null,
    agent: {
      name: customer.brandTradingName || customer.branchDisplayName || null,
      branchName: customer.branchDisplayName || null,
      phone: customer.contactTelephone || null,
      branchUrl: customer.branchLandingPageUrl
        ? `https://www.rightmove.co.uk${customer.branchLandingPageUrl}`
        : null,
      logoUrl: customer.brandPlusLogoUrl || null,
    },
    location: prop.location
      ? { lat: prop.location.latitude, lng: prop.location.longitude }
      : null,
    displaySize: prop.displaySize || null,
    channel: prop.channel || null,
  };
}

/**
 * Strip HTML tags from a string.
 */
export function stripHtml(str) {
  if (!str) return null;
  return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build a full image URL from a Rightmove media URL path.
 */
export function buildImageUrl(path) {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `https://media.rightmove.co.uk/${path}`;
}
