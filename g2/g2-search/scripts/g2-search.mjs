#!/usr/bin/env node
/**
 * g2-search — Search for software products on G2.com.
 *
 * USAGE:
 *   node g2-search.mjs <query> [--max N] [--category <category>]
 *
 * ARGS:
 *   <query>              Required — search query (e.g. "CRM software")
 *   --max N              Optional — max results to return (default: 10)
 *   --category <cat>     Optional — filter by category slug
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "query": string,
 *     "products": [
 *       {
 *         "name": string,
 *         "slug": string,
 *         "url": string,           // https://www.g2.com/products/<slug>/reviews
 *         "logoUrl": string|null,
 *         "rating": number|null,   // 0-5 scale
 *         "reviewCount": number|null,
 *         "category": string|null,
 *         "categories": array,
 *         "shortDescription": string|null,
 *         "pricingInfo": string|null, // "free"/"paid"/"freemium"/"starts at $X/mo"
 *       }
 *     ],
 *     "totalFound": number|null,
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (e.g. "127.0.0.1:11090")
 *
 * ⚠️ STATUS: BLOCKED — G2 uses DataDome bot protection (visual captcha).
 *   - Search page (/search?query=...) works but may hit DataDome after repeated requests
 *   - Product detail pages (/products/<slug>/reviews) are blocked by DataDome rt:'c' (visual captcha)
 *   - Needs residential proxy (SOCKS5_PROXY) to reliably bypass
 */

import { Camoufox } from 'camoufox-js';
import {
  emitResult,
  emitError,
  log,
  delay,
  createG2Browser,
  createG2Context,
  extractGon,
  extractJsonLd,
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

if (!query) {
  emitError('MISSING_ARG', 'Usage: g2-search.mjs <query> [--max N] [--category <category>]');
}

// ---------------------------------------------------------------------------
// DOM extraction — G2 search page layout (2026)
// ---------------------------------------------------------------------------

/**
 * Extract products from G2 search results page.
 *
 * G2 search at /search?query=... renders product cards using elv-* Tailwind classes.
 * Each card shows: name, vendor, rating (X.X/5), review count ((N,NNN)), description.
 *
 * G2 category pages (/categories/<slug>) use product-card__head structure.
 *
 * Strategy: find all unique product links → walk up to card container → extract text.
 */
async function extractProductsFromDom(page) {
  return page.evaluate((maxR) => {
    const products = [];
    const seen = new Set();

    // -----------------------------------------------------------------------
    // Strategy A: Category page — .product-card__head structure
    // G2 redirects many search queries to category pages (/categories/...)
    // -----------------------------------------------------------------------
    const heads = Array.from(document.querySelectorAll('.product-card__head'));
    for (const head of heads) {
      if (products.length >= maxR) break;

      const link = head.querySelector('a[href*="/products/"][href*="/reviews"]');
      if (!link) continue;

      const href = link.href;
      const slug = (href.match(/\/products\/([^/?#]+)/) || [])[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const text = head.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const name = lines[0] || null;
      const vendor = lines[1]?.startsWith('By ') ? lines[1].slice(3) : null;

      const ratingM = text.match(/([\d.]+)\s+out of\s+5/i);
      const rating = ratingM ? parseFloat(ratingM[1]) : null;

      const reviewM = text.match(/\(([\d,]+)\)/);
      const reviewCount = reviewM ? parseInt(reviewM[1].replace(/,/g, ''), 10) : null;

      const img = head.querySelector('img');
      const logoUrl = img
        ? (img.getAttribute('data-deferred-image-src') || img.src || null)
        : null;

      const priceM = text.match(/Entry Level Price:\s*(\$[\d.]+|Free)/i);
      const pricingInfo = priceM ? priceM[1] : null;

      // Short description from parent product-card element
      const parentCard = head.closest('[class*="product-card"]') || head.parentElement;
      let shortDescription = null;
      if (parentCard) {
        const descEl = parentCard.querySelector('[class*="description"]');
        if (descEl) shortDescription = descEl.innerText?.trim()?.substring(0, 300) || null;
      }

      products.push({
        name,
        slug,
        url: 'https://www.g2.com/products/' + slug + '/reviews',
        logoUrl: logoUrl && logoUrl.startsWith('http') ? logoUrl : null,
        rating,
        reviewCount,
        category: null,
        categories: [],
        shortDescription,
        pricingInfo,
        vendor: vendor || null,
      });
    }

    if (products.length > 0) return products;

    // -----------------------------------------------------------------------
    // Strategy B: Search results page (/search?query=...) — elv-* classes
    // Cards have rating shown as "X.X/5" and review count as "(NNN)"
    // Each product card is a self-contained block with the product link + rating + description
    // -----------------------------------------------------------------------

    // Find all product review links (deduplicated by slug)
    const allLinks = Array.from(
      document.querySelectorAll('a[href*="/products/"][href*="/reviews"]')
    );

    for (const link of allLinks) {
      if (products.length >= maxR) break;

      const href = link.href;
      // Skip review-pagination and lead-gen links
      if (href.includes('#reviews') || href.includes('leads') || href.includes('?page=')) continue;

      const slug = (href.match(/\/products\/([^/?#]+)/) || [])[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Walk up to find a card container: stop when we hit a sibling that contains
      // a DIFFERENT product slug (meaning we've crossed a card boundary)
      let card = link;
      for (let i = 0; i < 10; i++) {
        if (!card.parentElement) break;
        const parent = card.parentElement;
        // Stop if parent contains multiple different product slugs
        const parentLinks = Array.from(parent.querySelectorAll('a[href*="/products/"]'));
        const parentSlugs = new Set(
          parentLinks.map(a => (a.href.match(/\/products\/([^/?#]+)/) || [])[1]).filter(Boolean)
        );
        if (parentSlugs.size > 1 && parentSlugs.has(slug)) break;
        card = parent;
      }

      const text = card.innerText || '';

      // Name: text content of the anchor
      const name = link.innerText?.trim() ||
                   link.getAttribute('title') ||
                   slug.replace(/-/g, ' ');

      // Rating: "X.X/5" pattern (G2 search page format)
      const ratingM = text.match(/([\d.]+)\/5/);
      const rating = ratingM ? parseFloat(ratingM[1]) : null;

      // Review count: "(NNN)" or "(N,NNN)"
      const reviewM = text.match(/\(([\d,]+)\)/);
      const reviewCount = reviewM ? parseInt(reviewM[1].replace(/,/g, ''), 10) : null;

      // Logo
      const img = card.querySelector('img');
      const logoUrl = img
        ? (img.getAttribute('data-deferred-image-src') || img.src || null)
        : null;

      // Short description: look for "Product Description" header + following text
      let shortDescription = null;
      if (text.includes('Product Description')) {
        const parts = text.split('Product Description');
        if (parts[1]) {
          shortDescription = parts[1].split('\n').map(l => l.trim()).filter(Boolean)
            .slice(0, 3).join(' ').substring(0, 300) || null;
        }
      } else {
        // Take lines after rating line
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const ratingIdx = lines.findIndex(l => l.match(/\d+\.?\d*\/5/));
        if (ratingIdx >= 0 && ratingIdx + 2 < lines.length) {
          shortDescription = lines.slice(ratingIdx + 2, ratingIdx + 5).join(' ').substring(0, 300) || null;
        }
      }

      // Category: "Related Categories" section
      let category = null;
      if (text.includes('Related Categories')) {
        const after = text.split('Related Categories')[1] || '';
        const catLines = after.split('\n').map(l => l.trim()).filter(Boolean);
        if (catLines.length > 0) category = catLines[0];
      }

      products.push({
        name,
        slug,
        url: 'https://www.g2.com/products/' + slug + '/reviews',
        logoUrl: logoUrl && logoUrl.startsWith('http') ? logoUrl : null,
        rating,
        reviewCount,
        category,
        categories: category ? [category] : [],
        shortDescription,
        pricingInfo: null,
        vendor: null,
      });
    }

    return products;
  }, maxResults);
}

/**
 * Set up XHR interceptor for search API responses.
 */
function setupXhrInterceptor(page) {
  const captured = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (
      (url.includes('/search') || url.includes('/products') || url.includes('/categories')) &&
      url.includes('.json') &&
      res.status() === 200
    ) {
      try {
        const body = await res.json();
        if (body && (body.products || body.results || body.data)) {
          captured.push(body);
        }
      } catch (e) {}
    }
  });
  return captured;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Searching G2 for: "${query}" (max: ${maxResults}${category ? `, category: ${category}` : ''})`);

  const browser = await createG2Browser(Camoufox);
  const context = await createG2Context(browser);
  const page = await context.newPage();

  const xhrResults = setupXhrInterceptor(page);

  try {
    // Build search URL
    const searchParams = new URLSearchParams({ query: query.trim() });
    if (category) searchParams.set('category', category);
    const searchUrl = `https://www.g2.com/search?${searchParams.toString()}`;
    log(`Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(4000);

    const title = await page.title();
    const finalUrl = page.url();
    const bodyLen = await page.evaluate(() => document.body.innerText.length);
    log(`Page title: "${title}"`);
    log(`Final URL: ${finalUrl}`);
    log(`Body length: ${bodyLen}`);

    // Check for bot detection / DataDome visual captcha
    if (
      title === 'g2.com' ||
      bodyLen === 0 ||
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      title.includes('403') ||
      title.includes('Access denied') ||
      finalUrl.includes('cf-chl-bypass')
    ) {
      emitError('BLOCKED',
        'G2 DataDome bot protection active. ' +
        'Search/product pages require residential IP. ' +
        'Set SOCKS5_PROXY=host:port for residential proxy bypass. ' +
        'Note: G2 product detail pages use rt:\'c\' (visual captcha) — ' +
        'even with residential IP, product pages are harder to access than search pages.'
      );
    }

    let products = [];
    let totalFound = null;

    // Strategy 1: Try window.gon (rarely populated on G2 search pages)
    log('Attempting window.gon extraction...');
    const gon = await extractGon(page);
    if (gon) {
      log('window.gon found, keys:', Object.keys(gon).join(', '));
      const gonProducts = gon.products || gon.search?.products || gon.category_products;
      if (gonProducts && gonProducts.length > 0) {
        log(`Extracted ${gonProducts.length} products from window.gon`);
        products = gonProducts.map(parseSearchProduct);
        totalFound = gon.total_count || gon.total || products.length;
      }
    }

    // Strategy 2: XHR intercepted data
    if (products.length === 0 && xhrResults.length > 0) {
      log(`XHR interceptor captured ${xhrResults.length} responses`);
      for (const body of xhrResults) {
        const items = body.products || body.results || body.data || [];
        if (Array.isArray(items) && items.length > 0) {
          products = items.map(parseSearchProduct).filter(p => p.slug);
          totalFound = body.total_count || body.total || items.length;
          log(`Got ${products.length} products from XHR`);
          break;
        }
      }
    }

    // Strategy 3: DOM extraction (primary for G2)
    if (products.length === 0) {
      log('Extracting from DOM...');
      products = await extractProductsFromDom(page);
      log(`DOM extraction found ${products.length} products`);

      // Get total count from page text
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
      const totalMatch = pageText.match(/(\d[\d,]*)\s+(?:results?|products?|software tools?)/i);
      if (totalMatch) totalFound = parseInt(totalMatch[1].replace(/,/g, ''), 10);

      // Check meta numberOfItems
      const metaTotal = await page.evaluate(() => {
        const el = document.querySelector('[itemprop="numberOfItems"]');
        return el ? el.getAttribute('content') : null;
      });
      if (metaTotal) totalFound = parseInt(metaTotal, 10);
    }

    // Strategy 4: JSON-LD ItemList
    if (products.length === 0) {
      log('Trying JSON-LD extraction...');
      const jsonLdData = await extractJsonLd(page);
      for (const ld of jsonLdData) {
        if (ld['@type'] === 'ItemList' && ld.itemListElement) {
          for (const item of ld.itemListElement) {
            const app = item.item || item;
            if (app['@type'] === 'SoftwareApplication') {
              const slugMatch = (app.url || '').match(/\/products\/([^/?#]+)/);
              if (slugMatch) {
                products.push({
                  name: app.name || null,
                  slug: slugMatch[1],
                  url: `https://www.g2.com/products/${slugMatch[1]}/reviews`,
                  logoUrl: app.image || null,
                  rating: app.aggregateRating?.ratingValue
                    ? parseFloat(app.aggregateRating.ratingValue) : null,
                  reviewCount: app.aggregateRating?.reviewCount
                    ? parseInt(app.aggregateRating.reviewCount, 10) : null,
                  category: null,
                  categories: [],
                  shortDescription: app.description || null,
                  pricingInfo: null,
                });
              }
            }
          }
          if (products.length > 0) {
            log(`Got ${products.length} products from JSON-LD`);
            break;
          }
        }
      }
    }

    // Deduplicate by slug
    const seen = new Set();
    const deduped = [];
    for (const p of products) {
      if (p.slug && !seen.has(p.slug)) {
        seen.add(p.slug);
        deduped.push(p);
      } else if (!p.slug) {
        deduped.push(p);
      }
    }

    const final = deduped.slice(0, maxResults);

    if (final.length === 0) {
      const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 500));
      log('Page body preview:', bodyPreview);
      log('No products found — G2 may be blocking or changed its structure');
    }

    log(`Returning ${final.length} products (total: ${totalFound || 'unknown'})`);

    emitResult({
      query: query.trim(),
      category: category || null,
      searchUrl: page.url(),
      totalFound: totalFound || null,
      products: final,
    });

  } catch (err) {
    log('Error:', err.message);
    if (err.message.includes('timeout')) {
      emitError('TIMEOUT', 'Page load timed out — G2 may be slow or blocking');
    }
    emitError('SCRAPE_ERROR', err.message);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write('[g2-search] Fatal: ' + err.message + '\n');
  process.exit(1);
});
