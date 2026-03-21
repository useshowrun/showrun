#!/usr/bin/env node
/**
 * Shopify Products Scraper
 *
 * Extracts product catalog from any public Shopify store.
 *
 * Strategy:
 *   1. Call the public Shopify JSON API: /<store>/products.json?limit=250&page=N
 *   2. This API is available on ALL Shopify stores (no auth required)
 *   3. Paginate until maxProducts is reached or no more products
 *   4. Optionally filter by collection: /collections/<handle>/products.json
 *   5. Fall back to camoufox if direct API returns HTTP errors (e.g., Cloudflare)
 *
 * Shopify JSON API endpoints (all public, no auth):
 *   /products.json                          All products, paginated
 *   /products/<handle>.json                 Single product by handle
 *   /collections.json                       All collections
 *   /collections/<handle>/products.json     Products in a specific collection
 *
 * Usage:
 *   node shopify-products.mjs <store_url> [options]
 *
 * Options:
 *   --max <N>                 Max products to return (default: 50)
 *   --collection <handle>     Filter by collection handle (e.g., "shoes", "sale")
 *   --product <handle>        Get a single product by handle
 *   --collections             List all collections instead of products
 *   --page <N>                Start page (default: 1)
 *   --browser                 Force camoufox browser mode (for Cloudflare-protected stores)
 *
 * Examples:
 *   node shopify-products.mjs allbirds.com --max 20
 *   node shopify-products.mjs gymshark.com --collection sale --max 50
 *   node shopify-products.mjs kylie.com --product "lip-kit-red" 
 *   node shopify-products.mjs allbirds.com --collections
 *   node shopify-products.mjs store.example.com --browser --max 30
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import https from "https";
import http from "http";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let storeInput = null;
let maxProducts = 50;
let collectionHandle = null;
let productHandle = null;
let listCollections = false;
let startPage = 1;
let forceBrowser = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--max" && args[i + 1]) maxProducts = parseInt(args[++i], 10);
  else if (a === "--collection" && args[i + 1]) collectionHandle = args[++i];
  else if (a === "--product" && args[i + 1]) productHandle = args[++i];
  else if (a === "--collections") listCollections = true;
  else if (a === "--page" && args[i + 1]) startPage = parseInt(args[++i], 10);
  else if (a === "--browser") forceBrowser = true;
  else if (!storeInput && !a.startsWith("--")) storeInput = a;
}

if (!storeInput) {
  emitError(
    "MISSING_ARG",
    "Usage: shopify-products.mjs <store_url> [--max N] [--collection handle] [--product handle] [--collections] [--browser]"
  );
}

// ---------------------------------------------------------------------------
// Store URL normalization
// ---------------------------------------------------------------------------

function normalizeStoreUrl(input) {
  // Add protocol if missing
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    input = "https://" + input;
  }
  const url = new URL(input);
  // Use the hostname (strip path, query, trailing slash)
  return `https://${url.hostname}`;
}

const storeBase = normalizeStoreUrl(storeInput);
log(`[INFO] Store: ${storeBase}`);

// ---------------------------------------------------------------------------
// HTTP fetch helper (no browser)
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

function fetchJson(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: DEFAULT_HEADERS,
      timeout: 30000,
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, error: "JSON parse error", raw: data.substring(0, 200) });
          }
        } else if (res.statusCode === 404) {
          resolve({ ok: false, status: 404, error: "Not found" });
        } else if (res.statusCode === 429) {
          resolve({ ok: false, status: 429, error: "Rate limited" });
        } else if (res.statusCode >= 300 && res.statusCode < 400) {
          // Redirect
          const location = res.headers["location"];
          resolve({ ok: false, status: res.statusCode, error: `Redirect to ${location}`, redirect: location });
        } else {
          resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, raw: data.substring(0, 200) });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      if (retries > 0) {
        log(`[WARN] Timeout, retrying... (${retries} left)`);
        fetchJson(url, retries - 1).then(resolve).catch(reject);
      } else {
        resolve({ ok: false, status: 0, error: "Request timeout after retries" });
      }
    });

    req.on("error", (e) => {
      if (retries > 0) {
        log(`[WARN] Request error: ${e.message}, retrying... (${retries} left)`);
        delay(2000).then(() => fetchJson(url, retries - 1).then(resolve).catch(reject));
      } else {
        // Return error object instead of rejecting to allow graceful handling
        resolve({ ok: false, status: 0, error: e.message });
      }
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Product parsing
// ---------------------------------------------------------------------------

function parseProduct(raw, storeUrl) {
  // Compute primary image
  const primaryImage = raw.images && raw.images.length > 0
    ? {
        id: raw.images[0].id,
        src: raw.images[0].src,
        alt: raw.images[0].alt || null,
        width: raw.images[0].width,
        height: raw.images[0].height,
      }
    : null;

  // All images
  const allImages = (raw.images || []).map((img) => ({
    id: img.id,
    src: img.src,
    alt: img.alt || null,
    width: img.width,
    height: img.height,
    variantIds: img.variant_ids || [],
  }));

  // Variants
  const variants = (raw.variants || []).map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku || null,
    price: v.price ? parseFloat(v.price) : null,
    compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    available: v.available,
    option1: v.option1 || null,
    option2: v.option2 || null,
    option3: v.option3 || null,
    requiresShipping: v.requires_shipping,
    inventoryQuantity: v.inventory_quantity !== undefined ? v.inventory_quantity : null,
    barcode: v.barcode || null,
    weight: v.grams ? v.grams / 1000 : null, // convert grams to kg
  }));

  // Price range
  const prices = variants
    .map((v) => v.price)
    .filter((p) => p !== null && p >= 0);
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;

  // Availability
  const isAvailable = variants.some((v) => v.available);

  // Options (Size, Color, Material, etc.)
  const options = (raw.options || []).map((o) => ({
    name: o.name,
    values: o.values || [],
  }));

  // Tags
  const tags = typeof raw.tags === "string"
    ? raw.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : raw.tags || [];

  return {
    id: raw.id,
    handle: raw.handle,
    url: `${storeUrl}/products/${raw.handle}`,
    title: raw.title,
    vendor: raw.vendor || null,
    productType: raw.product_type || null,
    description: raw.body_html
      ? raw.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : null,
    descriptionHtml: raw.body_html || null,
    tags,
    isAvailable,
    minPrice,
    maxPrice,
    currency: null, // Not in products.json; use storefront API for currency
    options,
    variants,
    primaryImage,
    images: allImages,
    publishedAt: raw.published_at || null,
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
  };
}

// ---------------------------------------------------------------------------
// Collections parsing
// ---------------------------------------------------------------------------

function parseCollection(raw, storeUrl) {
  return {
    id: raw.id,
    handle: raw.handle,
    url: `${storeUrl}/collections/${raw.handle}`,
    title: raw.title,
    description: raw.description
      ? raw.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : null,
    productsCount: raw.products_count !== undefined ? raw.products_count : null,
    image: raw.image
      ? { src: raw.image.src, alt: raw.image.alt || null }
      : null,
    publishedAt: raw.published_at || null,
    updatedAt: raw.updated_at || null,
  };
}

// ---------------------------------------------------------------------------
// API mode: direct HTTP requests
// ---------------------------------------------------------------------------

async function fetchProductsApi() {
  const products = [];
  let page = startPage;
  const pageSize = Math.min(250, maxProducts);

  while (products.length < maxProducts) {
    const limit = Math.min(250, maxProducts - products.length);
    let apiUrl;

    if (collectionHandle) {
      apiUrl = `${storeBase}/collections/${collectionHandle}/products.json?limit=${limit}&page=${page}`;
    } else {
      apiUrl = `${storeBase}/products.json?limit=${limit}&page=${page}`;
    }

    log(`[INFO] Fetching page ${page}: ${apiUrl}`);
    const result = await fetchJson(apiUrl);

    if (!result.ok) {
      if (result.status === 429) {
        log("[WARN] Rate limited, waiting 5s...");
        await delay(5000);
        continue;
      }
      if (result.status === 0) {
        // Network error
        return { error: true, status: 0, message: `Network error: ${result.error}` };
      }
      return { error: true, status: result.status, message: result.error };
    }

    const pageProducts = result.data.products || [];
    log(`[INFO] Got ${pageProducts.length} products on page ${page}`);

    if (pageProducts.length === 0) break; // No more products

    products.push(...pageProducts);

    if (pageProducts.length < limit) break; // Last page

    page++;
    await delay(500); // Rate limiting courtesy
  }

  return { products: products.slice(0, maxProducts) };
}

async function fetchSingleProduct() {
  const apiUrl = `${storeBase}/products/${productHandle}.json`;
  log(`[INFO] Fetching single product: ${apiUrl}`);
  const result = await fetchJson(apiUrl);

  if (!result.ok) {
    return { error: true, status: result.status, message: result.error };
  }

  return { product: result.data.product };
}

async function fetchCollectionsApi() {
  const collections = [];
  let page = 1;

  while (true) {
    const apiUrl = `${storeBase}/collections.json?limit=250&page=${page}`;
    log(`[INFO] Fetching collections page ${page}: ${apiUrl}`);
    const result = await fetchJson(apiUrl);

    if (!result.ok) {
      return { error: true, status: result.status, message: result.error };
    }

    const pageCollections = result.data.collections || [];
    log(`[INFO] Got ${pageCollections.length} collections`);

    if (pageCollections.length === 0) break;

    collections.push(...pageCollections);

    if (pageCollections.length < 250) break;

    page++;
    await delay(300);
  }

  return { collections };
}

// ---------------------------------------------------------------------------
// Browser mode: use camoufox to bypass Cloudflare/bot protection
// ---------------------------------------------------------------------------

async function fetchViaBrowser(targetUrl) {
  const { Camoufox } = await import("camoufox-js");

  log("[INFO] Launching camoufox browser for protected store...");
  const browser = await Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  const ctx = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  const page = await ctx.newPage();

  try {
    log(`[INFO] Browser navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(3000);

    const content = await page.content();
    const finalUrl = page.url();
    log(`[INFO] Final URL: ${finalUrl}`);

    // Extract JSON from the page
    const jsonText = await page.evaluate(() => document.body.innerText);
    try {
      const data = JSON.parse(jsonText);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: "JSON parse failed", raw: jsonText.substring(0, 200) };
    }
  } finally {
    await browser.close();
  }
}

async function fetchProductsBrowser() {
  const products = [];
  let page = startPage;

  while (products.length < maxProducts) {
    const limit = Math.min(250, maxProducts - products.length);
    let apiUrl;

    if (collectionHandle) {
      apiUrl = `${storeBase}/collections/${collectionHandle}/products.json?limit=${limit}&page=${page}`;
    } else {
      apiUrl = `${storeBase}/products.json?limit=${limit}&page=${page}`;
    }

    const result = await fetchViaBrowser(apiUrl);

    if (!result.ok) {
      return { error: true, message: result.error };
    }

    const pageProducts = result.data.products || [];
    log(`[INFO] Browser got ${pageProducts.length} products on page ${page}`);

    if (pageProducts.length === 0) break;

    products.push(...pageProducts);

    if (pageProducts.length < limit) break;

    page++;
  }

  return { products: products.slice(0, maxProducts) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let rawData;
  let mode = "api";

  if (forceBrowser) {
    log("[INFO] Browser mode forced");
    mode = "browser";

    if (productHandle) {
      const apiUrl = `${storeBase}/products/${productHandle}.json`;
      const result = await fetchViaBrowser(apiUrl);
      if (!result.ok) {
        emitError("FETCH_ERROR", result.error || "Browser fetch failed");
      }
      rawData = { product: result.data.product };
    } else if (listCollections) {
      const apiUrl = `${storeBase}/collections.json?limit=250`;
      const result = await fetchViaBrowser(apiUrl);
      if (!result.ok) {
        emitError("FETCH_ERROR", result.error || "Browser fetch failed");
      }
      rawData = { collections: result.data.collections || [] };
    } else {
      rawData = await fetchProductsBrowser();
    }
  } else {
    // API mode first, fall back to browser if Cloudflare blocked
    if (productHandle) {
      rawData = await fetchSingleProduct();
    } else if (listCollections) {
      rawData = await fetchCollectionsApi();
    } else {
      rawData = await fetchProductsApi();
    }

    // Detect Cloudflare block or other errors
    if (rawData.error) {
      if (rawData.status === 403 || rawData.status === 503 || rawData.status === 429) {
        log(`[WARN] Direct API blocked (HTTP ${rawData.status}). Retrying with browser...`);
        mode = "browser-fallback";

        if (productHandle) {
          const apiUrl = `${storeBase}/products/${productHandle}.json`;
          const browserResult = await fetchViaBrowser(apiUrl);
          if (browserResult.ok) {
            rawData = { product: browserResult.data.product };
          } else {
            emitError("BLOCKED", `Store blocked both API and browser requests: ${rawData.message}`);
          }
        } else if (listCollections) {
          const apiUrl = `${storeBase}/collections.json?limit=250`;
          const browserResult = await fetchViaBrowser(apiUrl);
          if (browserResult.ok) {
            rawData = { collections: browserResult.data.collections || [] };
          } else {
            emitError("BLOCKED", `Store blocked both API and browser requests: ${rawData.message}`);
          }
        } else {
          rawData = await fetchProductsBrowser();
          if (rawData.error) {
            emitError("BLOCKED", `Store blocked both API and browser requests: ${rawData.message}`);
          }
        }
      } else {
        emitError("FETCH_ERROR", rawData.message || "Unknown error");
      }
    }
  }

  // Format output
  if (rawData.error) {
    emitError("FETCH_ERROR", rawData.message || "Unknown fetch error");
  }

  let output;

  if (listCollections) {
    const collections = (rawData.collections || []).map((c) =>
      parseCollection(c, storeBase)
    );
    output = {
      storeUrl: storeBase,
      mode,
      type: "collections",
      totalLoaded: collections.length,
      collections,
      scrapedAt: new Date().toISOString(),
    };
  } else if (productHandle) {
    if (!rawData.product) {
      emitError("NOT_FOUND", `Product '${productHandle}' not found at ${storeBase}`);
    }
    const product = parseProduct(rawData.product, storeBase);
    output = {
      storeUrl: storeBase,
      mode,
      type: "product",
      product,
      scrapedAt: new Date().toISOString(),
    };
  } else {
    const products = (rawData.products || []).map((p) => parseProduct(p, storeBase));
    output = {
      storeUrl: storeBase,
      mode,
      type: "products",
      collection: collectionHandle || null,
      totalLoaded: products.length,
      products,
      scrapedAt: new Date().toISOString(),
    };
  }

  emitResult(output);
}

main().catch((err) => {
  emitError("SCRAPER_ERROR", String(err.message || err));
});
