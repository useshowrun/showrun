#!/usr/bin/env node
/**
 * capterra-search — Search for software products on Capterra.com.
 *
 * USAGE:
 *   node capterra-search.mjs <query> [--max N] [--category <category>]
 *
 * ARGS:
 *   <query>              Required — search query (e.g. "CRM software")
 *   --max N              Optional — max results to return (default: 10)
 *   --category <cat>     Optional — category slug (e.g. "crm", "project-management")
 *                         When provided, browses /category-software/ listing instead of search
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "query": string,
 *     "category": string|null,
 *     "searchUrl": string,
 *     "totalFound": number|null,
 *     "products": [
 *       {
 *         "name": string,
 *         "id": string|null,
 *         "slug": string|null,
 *         "url": string,                   // https://www.capterra.com/p/<id>/<slug>/
 *         "logoUrl": string|null,
 *         "rating": number|null,           // 0-5 scale
 *         "reviewCount": number|null,
 *         "shortDescription": string|null,
 *         "pricingInfo": string|null,      // e.g. "Free version", "Starting from $29.00/mo"
 *         "categories": string[],
 *       }
 *     ]
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — REQUIRED for Cloudflare bypass (e.g. "127.0.0.1:11090")
 *                  Capterra uses Cloudflare Managed Challenge — blocks datacenter IPs.
 *                  Residential proxy with real browser fingerprint (camoufox) is required.
 *
 * ⚠️ STATUS: BLOCKED — Capterra uses Cloudflare Managed Challenge on all pages.
 *   - HTTP 403 "Just a moment..." is returned from Turkish/datacenter IPs
 *   - camoufox fingerprinted Firefox is insufficient without a residential proxy
 *   - Needs SOCKS5_PROXY=host:port (residential IP) to bypass Cloudflare
 *   - Once bypassed: data is in __NEXT_DATA__ JSON (Next.js SSR)
 *
 * DATA STRATEGY (when accessible):
 *   1. __NEXT_DATA__ JSON — primary source (Next.js SSR)
 *      - props.pageProps.initialData.searchResults[]
 *      - props.pageProps.productList[] (category pages)
 *   2. JSON-LD ItemList/SoftwareApplication — secondary source
 *   3. XHR interception — Capterra loads some data via API calls
 *   4. DOM extraction (aria/data-* attrs, no fragile CSS classes) — fallback
 */

import { Camoufox } from 'camoufox-js';
import {
  emitResult,
  emitError,
  log,
  delay,
  createCapterraBrowser,
  createCapterraContext,
  checkCloudflareBlock,
  extractNextData,
  extractWindowState,
  extractJsonLd,
  setupXhrInterceptor,
  parseSearchNextData,
  parseSearchProduct,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let query = null;
let maxResults = 10;
let category = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max' && args[i + 1]) {
    maxResults = parseInt(args[++i], 10);
  } else if (args[i] === '--category' && args[i + 1]) {
    category = args[++i];
  } else if (!args[i].startsWith('--') && !query) {
    query = args[i];
  }
}

if (!query && !category) {
  emitError('MISSING_ARG', 'Usage: capterra-search.mjs <query> [--max N] [--category <slug>]');
}

// ---------------------------------------------------------------------------
// DOM extraction — Capterra search/category page layout (2026)
// ---------------------------------------------------------------------------

/**
 * Extract products from Capterra search results page via DOM.
 *
 * Capterra renders product cards with data attributes:
 * - data-testid, data-productid, data-product-name
 * - aria-label attributes on rating elements
 *
 * We use structured data (JSON-LD, data-* attrs) not CSS classes.
 */
async function extractProductsFromDom(page, maxR) {
  return page.evaluate((maxResults) => {
    const products = [];
    const seen = new Set();

    // -----------------------------------------------------------------------
    // Strategy A: Find product cards via data-testid or data attributes
    // Capterra uses data-testid="product-card" or similar
    // -----------------------------------------------------------------------

    // Try data-testid based product cards first
    const testIdCards = Array.from(document.querySelectorAll(
      '[data-testid*="product"], [data-product-id], [data-productid]'
    ));

    for (const card of testIdCards) {
      if (products.length >= maxResults) break;

      const id = card.getAttribute('data-product-id') ||
                 card.getAttribute('data-productid') ||
                 card.getAttribute('data-id') ||
                 null;

      // Find the product link: Capterra product URLs are /p/<id>/<slug>/
      const link = card.querySelector('a[href*="/p/"]') ||
                   card.querySelector('a[href*="capterra.com/p/"]');
      if (!link) continue;

      const href = link.href || link.getAttribute('href') || '';
      const urlMatch = href.match(/\/p\/(\d+)\/([^/?#]+)/);
      if (!urlMatch) continue;

      const productId = id || urlMatch[1];
      const slug = urlMatch[2];
      const key = productId || slug;
      if (seen.has(key)) continue;
      seen.add(key);

      const url = `https://www.capterra.com/p/${productId || urlMatch[1]}/${slug}/`;

      // Name
      const nameEl = card.querySelector('[data-testid*="name"], [data-product-name], h2, h3');
      const name = nameEl?.innerText?.trim() ||
                   card.getAttribute('data-product-name') ||
                   link.innerText?.trim() ||
                   slug;

      // Rating via aria-label (e.g. "4.5 out of 5 stars" or "4.5/5")
      const ratingEl = card.querySelector(
        '[aria-label*="star"], [aria-label*="rating"], [data-rating], [data-testid*="rating"]'
      );
      let rating = null;
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute('aria-label') || '';
        const dataRating = ratingEl.getAttribute('data-rating') || '';
        const m = (ariaLabel + ' ' + dataRating).match(/([\d.]+)\s*(?:out of 5|\/5|stars)/i)
                  || (ariaLabel + ' ' + dataRating).match(/([\d.]+)/);
        if (m) rating = parseFloat(m[1]);
      }

      // Review count
      const reviewEl = card.querySelector('[data-testid*="review-count"], [data-review-count]');
      let reviewCount = null;
      if (reviewEl) {
        const countText = reviewEl.innerText || reviewEl.getAttribute('data-review-count') || '';
        const m = countText.match(/([\d,]+)/);
        if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
      }

      // If no dedicated rating/review elements, scan the card text
      if (rating === null || reviewCount === null) {
        const text = card.innerText || '';
        if (rating === null) {
          const m = text.match(/([\d.]+)\s*(?:out of 5|\/5)/i);
          if (m) rating = parseFloat(m[1]);
        }
        if (reviewCount === null) {
          const m = text.match(/\(([\d,]+)\s*reviews?\)/i) ||
                    text.match(/([\d,]+)\s*reviews?/i);
          if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        }
      }

      // Logo
      const img = card.querySelector('img');
      let logoUrl = img
        ? (img.getAttribute('data-src') || img.src || null)
        : null;
      if (logoUrl && !logoUrl.startsWith('http')) logoUrl = null;

      // Short description
      const descEl = card.querySelector(
        '[data-testid*="description"], [data-testid*="desc"], p'
      );
      const shortDescription = descEl?.innerText?.trim()?.substring(0, 300) || null;

      // Pricing
      const priceEl = card.querySelector(
        '[data-testid*="price"], [data-testid*="pricing"]'
      );
      let pricingInfo = priceEl?.innerText?.trim() || null;
      if (!pricingInfo) {
        const text = card.innerText || '';
        const m = text.match(/(?:starting from|starts at|from|free version)\s*\$[\d.]+/i) ||
                  text.match(/free version/i);
        if (m) pricingInfo = m[0].trim();
      }

      products.push({
        name,
        id: productId || null,
        slug,
        url,
        logoUrl,
        rating,
        reviewCount,
        shortDescription,
        pricingInfo,
        categories: [],
      });
    }

    if (products.length > 0) return products;

    // -----------------------------------------------------------------------
    // Strategy B: Find all /p/<id>/<slug>/ links and build cards from context
    // Works when data-testid attributes are absent but links are present
    // -----------------------------------------------------------------------

    const allLinks = Array.from(document.querySelectorAll('a[href*="/p/"]'));
    for (const link of allLinks) {
      if (products.length >= maxResults) break;

      const href = link.href || '';
      const urlMatch = href.match(/\/p\/(\d+)\/([^/?#]+)/);
      if (!urlMatch) continue;

      const productId = urlMatch[1];
      const slug = urlMatch[2];
      if (seen.has(productId)) continue;
      seen.add(productId);

      const url = `https://www.capterra.com/p/${productId}/${slug}/`;
      const name = link.innerText?.trim() || slug;

      // Walk up to find card context
      let card = link;
      for (let i = 0; i < 8; i++) {
        if (!card.parentElement) break;
        const parent = card.parentElement;
        // Stop if parent contains multiple product IDs
        const parentLinks = Array.from(parent.querySelectorAll('a[href*="/p/"]'));
        const ids = new Set(
          parentLinks.map(a => {
            const m = a.href?.match(/\/p\/(\d+)\//);
            return m ? m[1] : null;
          }).filter(Boolean)
        );
        if (ids.size > 1) break;
        card = parent;
      }

      const text = card.innerText || '';

      // Rating from text
      let rating = null;
      const rM = text.match(/([\d.]+)\s*(?:out of 5|\/5)/i);
      if (rM) rating = parseFloat(rM[1]);

      // Review count from text
      let reviewCount = null;
      const rcM = text.match(/\(([\d,]+)\s*reviews?\)/i) ||
                  text.match(/([\d,]+)\s*reviews?/i);
      if (rcM) reviewCount = parseInt(rcM[1].replace(/,/g, ''), 10);

      // Logo
      const img = card.querySelector('img');
      let logoUrl = img ? (img.getAttribute('data-src') || img.src || null) : null;
      if (logoUrl && !logoUrl.startsWith('http')) logoUrl = null;

      // Description
      const paragraphs = Array.from(card.querySelectorAll('p'));
      const shortDescription = paragraphs
        .map(p => p.innerText?.trim())
        .filter(t => t && t.length > 20)
        .slice(0, 2)
        .join(' ')
        .substring(0, 300) || null;

      // Pricing
      let pricingInfo = null;
      const priceM = text.match(/(?:starting from|starts at|from)\s*\$[\d.]+/i) ||
                     text.match(/free version/i);
      if (priceM) pricingInfo = priceM[0].trim();

      products.push({
        name,
        id: productId,
        slug,
        url,
        logoUrl,
        rating,
        reviewCount,
        shortDescription,
        pricingInfo,
        categories: [],
      });
    }

    return products;
  }, maxR);
}

/**
 * Extract products from JSON-LD (ItemList or SoftwareApplication schemas).
 */
async function extractProductsFromJsonLd(page, maxR) {
  const jsonLdData = await extractJsonLd(page);
  const products = [];

  for (const ld of jsonLdData) {
    // ItemList with SoftwareApplication items
    if (ld['@type'] === 'ItemList' && Array.isArray(ld.itemListElement)) {
      for (const item of ld.itemListElement) {
        if (products.length >= maxR) break;
        const app = item.item || item;
        if (!app?.name) continue;

        const urlMatch = (app.url || '').match(/\/p\/(\d+)\/([^/?#]+)/);
        if (!urlMatch) continue;

        products.push({
          name: app.name,
          id: urlMatch[1] || null,
          slug: urlMatch[2] || null,
          url: app.url || null,
          logoUrl: app.image || null,
          rating: app.aggregateRating?.ratingValue
            ? parseFloat(app.aggregateRating.ratingValue)
            : null,
          reviewCount: app.aggregateRating?.reviewCount
            ? parseInt(app.aggregateRating.reviewCount, 10)
            : null,
          shortDescription: app.description || null,
          pricingInfo: null,
          categories: [],
        });
      }
    }
    if (products.length >= maxR) break;
  }

  return products;
}

/**
 * Try to extract total count from page text.
 */
async function extractTotalCount(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.substring(0, 5000) || '';
    const m = text.match(/(\d[\d,]*)\s+(?:results?|products?|software tools?)/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);

    // Check aria attrs
    const listEl = document.querySelector('[aria-label*="results"], [data-total-count]');
    if (listEl) {
      const val = listEl.getAttribute('aria-label') || listEl.getAttribute('data-total-count') || '';
      const m2 = val.match(/([\d,]+)/);
      if (m2) return parseInt(m2[1].replace(/,/g, ''), 10);
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const effectiveQuery = query || category;
  log(`Searching Capterra for: "${effectiveQuery}" (max: ${maxResults}${category ? `, category: ${category}` : ''})`);

  // Build search URL
  let searchUrl;
  if (category) {
    // Category browse: https://www.capterra.com/<category>-software/
    const catSlug = category.toLowerCase().replace(/\s+/g, '-').replace(/-software$/, '');
    searchUrl = `https://www.capterra.com/${catSlug}-software/`;
  } else {
    searchUrl = `https://www.capterra.com/search/?query=${encodeURIComponent(query.trim())}`;
  }

  log(`Search URL: ${searchUrl}`);

  if (!process.env.SOCKS5_PROXY) {
    log('WARNING: SOCKS5_PROXY not set — Cloudflare will block from datacenter/Turkish IPs');
  }

  const browser = await createCapterraBrowser(Camoufox);
  const context = await createCapterraContext(browser);
  const page = await context.newPage();

  const xhrResults = setupXhrInterceptor(page);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for Cloudflare challenge to potentially resolve
    await delay(5000);

    // Check if Cloudflare is blocking
    const isBlocked = await checkCloudflareBlock(page);
    if (isBlocked) {
      emitError('BLOCKED',
        'Capterra is protected by Cloudflare Managed Challenge. ' +
        'This IP is blocked — residential proxy required. ' +
        'Set SOCKS5_PROXY=host:port (residential IP) env var to bypass. ' +
        'Cloudflare validates browser fingerprint + IP reputation — camoufox + residential IP needed.'
      );
    }

    const title = await page.title();
    const finalUrl = page.url();
    log(`Page title: "${title}"`);
    log(`Final URL: ${finalUrl}`);

    let products = [];
    let totalFound = null;

    // -----------------------------------------------------------------------
    // Strategy 1: __NEXT_DATA__ (primary — Next.js SSR)
    // -----------------------------------------------------------------------
    log('Attempting __NEXT_DATA__ extraction...');
    const nextData = await extractNextData(page);
    if (nextData) {
      log('__NEXT_DATA__ found, parsing...');
      const parsed = parseSearchNextData(nextData);
      if (parsed?.products?.length > 0) {
        products = parsed.products.map(parseSearchProduct).filter(Boolean);
        totalFound = parsed.totalFound;
        log(`Extracted ${products.length} products from __NEXT_DATA__`);
      } else {
        log('__NEXT_DATA__ present but no products found — checking pageProps structure');
        // Log the structure for debugging
        const keys = Object.keys(nextData?.props?.pageProps || {});
        log(`pageProps keys: ${keys.join(', ')}`);
      }
    } else {
      log('No __NEXT_DATA__ found');
    }

    // -----------------------------------------------------------------------
    // Strategy 2: window.__STATE__ (Gartner alternative SSR blob)
    // -----------------------------------------------------------------------
    if (products.length === 0) {
      log('Attempting window.__STATE__ extraction...');
      const state = await extractWindowState(page);
      if (state) {
        log('window.__STATE__ found, keys:', Object.keys(state).slice(0, 10).join(', '));

        const productList =
          state?.products ||
          state?.searchResults ||
          state?.productList ||
          state?.data?.products ||
          null;

        if (productList && Array.isArray(productList)) {
          products = productList.map(parseSearchProduct).filter(Boolean);
          totalFound = state?.total || state?.totalCount || products.length;
          log(`Extracted ${products.length} products from window.__STATE__`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Strategy 3: XHR intercepted API responses
    // -----------------------------------------------------------------------
    if (products.length === 0 && xhrResults.length > 0) {
      log(`XHR interceptor captured ${xhrResults.length} responses`);
      for (const { url: xhrUrl, body } of xhrResults) {
        const items =
          body?.products ||
          body?.searchResults ||
          body?.data?.products ||
          body?.results ||
          body?.data ||
          null;

        if (Array.isArray(items) && items.length > 0) {
          products = items.map(parseSearchProduct).filter(Boolean);
          totalFound = body?.total || body?.totalCount || items.length;
          log(`Got ${products.length} products from XHR: ${xhrUrl}`);
          break;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Strategy 4: JSON-LD (ItemList / SoftwareApplication schemas)
    // -----------------------------------------------------------------------
    if (products.length === 0) {
      log('Trying JSON-LD extraction...');
      products = await extractProductsFromJsonLd(page, maxResults);
      if (products.length > 0) {
        log(`Got ${products.length} products from JSON-LD`);
      }
    }

    // -----------------------------------------------------------------------
    // Strategy 5: DOM extraction (data-* attrs, aria, product links)
    // -----------------------------------------------------------------------
    if (products.length === 0) {
      log('Extracting from DOM...');

      // Wait for dynamic content to load
      await delay(3000);

      products = await extractProductsFromDom(page, maxResults);
      log(`DOM extraction found ${products.length} products`);
    }

    // Extract total count if not yet known
    if (totalFound === null) {
      totalFound = await extractTotalCount(page);
    }

    // Deduplicate by ID or slug
    const seen = new Set();
    const deduped = [];
    for (const p of products) {
      const key = p.id || p.slug || p.name;
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.push(p);
      } else if (!key) {
        deduped.push(p);
      }
    }

    const final = deduped.slice(0, maxResults);

    if (final.length === 0) {
      const bodyPreview = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      log('Page body preview:', bodyPreview);
      log('No products found — page structure may have changed or Cloudflare is blocking');
    }

    log(`Returning ${final.length} products (total: ${totalFound ?? 'unknown'})`);

    emitResult({
      query: effectiveQuery,
      category: category || null,
      searchUrl: finalUrl,
      totalFound: totalFound ?? null,
      products: final,
    });

  } catch (err) {
    log('Error:', err.message);
    if (err.message.includes('timeout')) {
      emitError('TIMEOUT', 'Page load timed out — Capterra may be slow or Cloudflare is stalling');
    }
    emitError('SCRAPE_ERROR', err.message);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write('[capterra-search] Fatal: ' + err.message + '\n');
  process.exit(1);
});
