#!/usr/bin/env node
/**
 * g2-product — Get full product details + reviews from G2.com.
 *
 * USAGE:
 *   node g2-product.mjs <product-slug-or-url> [--max-reviews N]
 *
 * ARGS:
 *   <product-slug-or-url>    Required — product slug (e.g. "salesforce-sales-cloud")
 *                             or full URL (e.g. "https://www.g2.com/products/slack/reviews")
 *   --max-reviews N          Optional — max reviews to collect (default: 20)
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "product": {
 *       "name": string,
 *       "slug": string,
 *       "url": string,
 *       "logoUrl": string|null,
 *       "rating": number|null,         // 0-5
 *       "reviewCount": number|null,
 *       "category": string|null,
 *       "categories": array,
 *       "shortDescription": string|null,
 *       "longDescription": string|null,
 *       "pricingInfo": string|null,
 *       "features": string[],
 *       "integrations": string[],
 *       "alternatives": string[],      // competitor slugs/names
 *       "websiteUrl": string|null,
 *     },
 *     "reviews": [
 *       {
 *         "id": string|null,
 *         "title": string|null,
 *         "rating": number|null,
 *         "pros": string|null,
 *         "cons": string|null,
 *         "body": string|null,
 *         "date": string|null,
 *         "helpfulCount": number,
 *         "verified": boolean,
 *         "reviewer": {
 *           "name": string|null,
 *           "title": string|null,
 *           "companySize": string|null,
 *           "industry": string|null,
 *           "company": string|null,
 *         },
 *       }
 *     ],
 *     "reviewsUrl": string,
 *     "pagesScraped": number,
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (e.g. "127.0.0.1:11090")
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
  parseProductSlug,
  buildProductUrl,
  parsePricingInfo,
  parseReview,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let slugOrUrl = null;
let maxReviews = 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-reviews' && args[i + 1]) {
    maxReviews = parseInt(args[++i], 10);
  } else if (!args[i].startsWith('--') && !slugOrUrl) {
    slugOrUrl = args[i];
  }
}

if (!slugOrUrl) {
  emitError('MISSING_ARG', 'Usage: g2-product.mjs <product-slug-or-url> [--max-reviews N]');
}

const slug = parseProductSlug(slugOrUrl);
if (!slug) {
  emitError('INVALID_SLUG', `Could not parse product slug from: "${slugOrUrl}". ` +
    'Expected a slug like "salesforce-sales-cloud" or URL like "https://www.g2.com/products/slack/reviews"');
}

// ---------------------------------------------------------------------------
// Extract product data from window.gon
// ---------------------------------------------------------------------------

function extractProductFromGon(gon) {
  if (!gon) return null;

  // Primary: gon.product
  const product = gon.product || gon.current_product;
  if (!product) return null;

  return {
    name: product.name || product.title || null,
    slug: product.slug || product.product_slug || null,
    logoUrl: product.logo_url || product.image_url || null,
    rating: product.star_rating || product.rating || null,
    reviewCount: product.reviews_count || product.review_count || null,
    category: product.category_name || product.primary_category || null,
    categories: (product.categories || []).map(c =>
      typeof c === 'string' ? c : (c.name || c.category_name || null)
    ).filter(Boolean),
    shortDescription: product.short_description || product.tagline || null,
    longDescription: product.description || product.long_description || null,
    pricingInfo: parsePricingInfo(product),
    features: extractFeatures(product),
    websiteUrl: product.url || product.website_url || null,
  };
}

/**
 * Extract features from various G2 data structures.
 */
function extractFeatures(product) {
  const features = [];

  // From features array
  if (Array.isArray(product.features)) {
    for (const f of product.features) {
      if (typeof f === 'string') features.push(f);
      else if (f.name) features.push(f.name);
      else if (f.feature_name) features.push(f.feature_name);
    }
  }

  // From feature_categories
  if (Array.isArray(product.feature_categories)) {
    for (const cat of product.feature_categories) {
      if (typeof cat === 'string') continue;
      const items = cat.features || cat.items || [];
      for (const item of items) {
        if (typeof item === 'string') features.push(item);
        else if (item.name) features.push(item.name);
      }
    }
  }

  return features;
}

/**
 * Extract product data from JSON-LD SoftwareApplication schema.
 */
function extractProductFromJsonLd(jsonLdList) {
  for (const ld of jsonLdList) {
    if (ld['@type'] === 'SoftwareApplication' || ld['@type'] === 'Product') {
      const slugMatch = (ld.url || '').match(/\/products\/([^/?#]+)/);
      return {
        name: ld.name || null,
        slug: slugMatch ? slugMatch[1] : slug,
        logoUrl: ld.image || null,
        rating: ld.aggregateRating?.ratingValue
          ? parseFloat(ld.aggregateRating.ratingValue) : null,
        reviewCount: ld.aggregateRating?.reviewCount
          ? parseInt(ld.aggregateRating.reviewCount, 10) : null,
        category: ld.applicationCategory || null,
        categories: ld.applicationCategory ? [ld.applicationCategory] : [],
        shortDescription: ld.description || null,
        longDescription: null,
        pricingInfo: ld.offers?.price ? `starts at $${ld.offers.price}` : null,
        features: [],
        websiteUrl: ld.url || null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract reviews from page
// ---------------------------------------------------------------------------

/**
 * Set up XHR interceptor for review pagination API.
 * G2 loads additional reviews via AJAX.
 */
function setupReviewXhrInterceptor(page) {
  const captured = [];
  page.on('response', async (res) => {
    const url = res.url();
    // G2 review AJAX endpoints
    if (
      res.status() === 200 &&
      (
        url.includes('/reviews.json') ||
        url.includes('/api/v1/reviews') ||
        (url.includes('/products/') && url.includes('reviews') && url.includes('.json'))
      )
    ) {
      try {
        const body = await res.json();
        if (body && (body.reviews || body.data)) {
          captured.push(body);
          log(`XHR captured review page: ${url.substring(0, 100)}`);
        }
      } catch (e) {}
    }
  });
  return captured;
}

/**
 * Extract reviews from window.gon.
 */
function extractReviewsFromGon(gon) {
  if (!gon) return [];

  // Try various gon paths for reviews
  const reviews = gon.reviews ||
                  gon.product_reviews ||
                  gon.review_data?.reviews ||
                  [];

  return Array.isArray(reviews) ? reviews : [];
}

/**
 * Extract reviews from DOM using stable selectors.
 * G2 review cards use data-* attributes and aria labels.
 */
async function extractReviewsFromDom(page) {
  return page.evaluate(() => {
    const reviews = [];

    // G2 review cards: look for review-specific data attributes or structured containers
    // Primary: find elements with review ID or review-specific data
    const reviewSelectors = [
      '[data-review-id]',
      '[itemprop="review"]',
      'article[id^="review-"]',
      '[id^="review_"]',
    ];

    let reviewCards = [];
    for (const sel of reviewSelectors) {
      reviewCards = Array.from(document.querySelectorAll(sel));
      if (reviewCards.length > 0) break;
    }

    for (const card of reviewCards) {
      const reviewId = card.getAttribute('data-review-id') ||
                       card.getAttribute('id')?.replace(/^review[-_]/, '') || null;

      // Rating: aria-label "N out of 5 stars" or data-star-count
      let rating = null;
      const ratingEl = card.querySelector('[aria-label*="out of 5"]') ||
                       card.querySelector('[data-star-count]') ||
                       card.querySelector('[data-rating]');
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute('aria-label') || '';
        const dataRating = ratingEl.getAttribute('data-star-count') ||
                           ratingEl.getAttribute('data-rating') || '';
        const m = ariaLabel.match(/([\d.]+)\s*out of 5/i) ||
                  dataRating.match(/([\d.]+)/);
        if (m) rating = parseFloat(m[1]);
      }

      // Title
      const titleEl = card.querySelector('[itemprop="name"]') ||
                      card.querySelector('h3') ||
                      card.querySelector('[data-review-title]');
      const title = titleEl?.textContent?.trim() || null;

      // Pros / Cons: G2 uses "What do you like best?" / "What do you dislike?"
      let pros = null;
      let cons = null;
      const proLabels = ['What do you like best', 'Pros', 'What I like'];
      const conLabels = ['What do you dislike', 'Cons', 'What I dislike'];

      // Find sections by label text
      const labelEls = Array.from(card.querySelectorAll('p, span, h4, h5, strong, b'));
      for (let i = 0; i < labelEls.length; i++) {
        const text = labelEls[i].textContent?.trim() || '';
        const isProLabel = proLabels.some(l => text.toLowerCase().includes(l.toLowerCase()));
        const isConLabel = conLabels.some(l => text.toLowerCase().includes(l.toLowerCase()));

        if (isProLabel) {
          // Content is in next sibling or parent's next content
          const next = labelEls[i].nextElementSibling ||
                       labelEls[i].parentElement?.nextElementSibling;
          if (next) pros = next.textContent?.trim() || null;
        }
        if (isConLabel) {
          const next = labelEls[i].nextElementSibling ||
                       labelEls[i].parentElement?.nextElementSibling;
          if (next) cons = next.textContent?.trim() || null;
        }
      }

      // Reviewer info: name, title, company
      const reviewerEl = card.querySelector('[itemprop="author"]') ||
                         card.querySelector('[data-reviewer]');
      let reviewerName = null;
      let reviewerTitle = null;
      let reviewerCompany = null;
      let reviewerCompanySize = null;
      let reviewerIndustry = null;

      if (reviewerEl) {
        reviewerName = reviewerEl.getAttribute('data-reviewer') ||
                       reviewerEl.querySelector('[itemprop="name"]')?.textContent?.trim() ||
                       reviewerEl.textContent?.trim() || null;
      } else {
        // Try to find reviewer name from aria or visible text
        const nameEl = card.querySelector('[data-reviewer-name]');
        if (nameEl) reviewerName = nameEl.textContent?.trim() || null;
      }

      // Date: published date in time[datetime] or data-date
      let date = null;
      const dateEl = card.querySelector('time[datetime]') ||
                     card.querySelector('[data-date]') ||
                     card.querySelector('[itemprop="datePublished"]');
      if (dateEl) {
        date = dateEl.getAttribute('datetime') ||
               dateEl.getAttribute('data-date') ||
               dateEl.getAttribute('content') ||
               dateEl.textContent?.trim() || null;
      }

      // Helpful count
      let helpfulCount = 0;
      const helpfulEl = card.querySelector('[data-helpful-count]') ||
                        card.querySelector('[aria-label*="helpful"]');
      if (helpfulEl) {
        const val = helpfulEl.getAttribute('data-helpful-count') ||
                    helpfulEl.textContent?.match(/\d+/)?.[0] || '0';
        helpfulCount = parseInt(val, 10) || 0;
      }

      // Verified badge
      const verified = !!(
        card.querySelector('[data-verified]') ||
        card.querySelector('[aria-label*="verified"]') ||
        card.textContent?.includes('Verified Current User')
      );

      if (!title && !pros && !cons) continue; // Skip empty cards

      reviews.push({
        id: reviewId,
        title,
        rating,
        pros,
        cons,
        body: pros || null, // Use pros as body if no separate body
        date,
        helpfulCount,
        verified,
        reviewer: {
          name: reviewerName,
          title: reviewerTitle,
          companySize: reviewerCompanySize,
          industry: reviewerIndustry,
          company: reviewerCompany,
        },
      });
    }

    return reviews;
  });
}

/**
 * Extract additional product info from DOM.
 */
async function extractProductFromDom(page, existingProduct) {
  const domData = await page.evaluate(() => {
    // Alternatives / competitors: links in "Alternatives" section
    const alternatives = [];
    const altLinks = Array.from(
      document.querySelectorAll('a[href*="/compare/"][href*="vs"]')
    );
    for (const link of altLinks) {
      const href = link.href;
      // Extract slugs from compare URLs like /compare/slack-vs-zoom
      const parts = href.match(/\/compare\/(.+)/);
      if (parts) {
        alternatives.push(parts[1]);
      }
      if (alternatives.length >= 10) break;
    }

    // Integrations: links or badges mentioning integrations
    const integrations = [];
    const intEls = Array.from(
      document.querySelectorAll('[data-integration-name], [aria-label*="integration"]')
    );
    for (const el of intEls) {
      const name = el.getAttribute('data-integration-name') ||
                   el.textContent?.trim() || null;
      if (name && !integrations.includes(name)) integrations.push(name);
      if (integrations.length >= 20) break;
    }

    // Long description: product description section
    let longDescription = null;
    const descEl = document.querySelector('[data-product-description]') ||
                   document.querySelector('[itemprop="description"]');
    if (descEl) {
      longDescription = descEl.textContent?.trim() || null;
    }

    // Website URL: external link button
    let websiteUrl = null;
    const websiteLink = document.querySelector('[data-vendor-website]') ||
                        document.querySelector('a[href*="?utm_source=g2"]') ||
                        document.querySelector('[aria-label="Visit website"]');
    if (websiteLink) {
      websiteUrl = websiteLink.href || null;
    }

    return { alternatives, integrations, longDescription, websiteUrl };
  });

  return {
    ...existingProduct,
    alternatives: domData.alternatives,
    integrations: domData.integrations,
    longDescription: existingProduct.longDescription || domData.longDescription,
    websiteUrl: existingProduct.websiteUrl || domData.websiteUrl,
  };
}

// ---------------------------------------------------------------------------
// Scrape one page
// ---------------------------------------------------------------------------

async function scrapePage(page, url, xhrCapture) {
  log(`Navigating to: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await delay(4000);

  const title = await page.title();
  const finalUrl = page.url();
  log(`Title: "${title}"`);

  // Check for bot detection
  if (
    title.includes('Just a moment') ||
    title.includes('Attention Required') ||
    title.includes('403') ||
    title.includes('Access denied')
  ) {
    return { blocked: true };
  }

  // Check for 404
  if (title.includes('Page Not Found') || title.includes('404') || finalUrl.includes('/404')) {
    return { notFound: true };
  }

  return { title, finalUrl };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching G2 product: "${slug}" (max reviews: ${maxReviews})`);

  const browser = await createG2Browser(Camoufox);
  const context = await createG2Context(browser);
  const page = await context.newPage();

  // Set up XHR interceptor
  const xhrCapture = setupReviewXhrInterceptor(page);

  try {
    const reviewsUrl = buildProductUrl(slug, 1);
    const result = await scrapePage(page, reviewsUrl, xhrCapture);

    if (result.blocked) {
      emitError('BLOCKED', 'Cloudflare bot protection triggered. Set SOCKS5_PROXY for residential IP.');
    }

    if (result.notFound) {
      emitError('NOT_FOUND', `G2 product not found: "${slug}". Check the slug is correct.`, {
        slug,
        hint: 'Valid slugs look like "salesforce-sales-cloud", "slack", "zoom"',
      });
    }

    let productData = null;
    let allReviews = [];
    let pagesScraped = 0;
    const maxPages = Math.ceil(maxReviews / 20);

    // Extract product data + first page reviews
    log('Extracting window.gon...');
    const gon = await extractGon(page);

    if (gon) {
      log('window.gon found, keys:', Object.keys(gon).slice(0, 20).join(', '));
      productData = extractProductFromGon(gon);

      if (productData) {
        log(`Product from gon: "${productData.name}" - ${productData.reviewCount} reviews`);
      }

      // Reviews from gon
      const gonReviews = extractReviewsFromGon(gon);
      if (gonReviews.length > 0) {
        log(`Got ${gonReviews.length} reviews from window.gon`);
        allReviews = gonReviews.map(parseReview).slice(0, maxReviews);
        pagesScraped = 1;
      }
    }

    // If no product data from gon, try JSON-LD
    if (!productData) {
      log('Trying JSON-LD extraction...');
      const jsonLdData = await extractJsonLd(page);
      productData = extractProductFromJsonLd(jsonLdData);
      if (productData) {
        log(`Product from JSON-LD: "${productData.name}"`);
      }
    }

    // DOM review extraction (first page)
    if (allReviews.length === 0) {
      log('Extracting reviews from DOM...');
      const domReviews = await extractReviewsFromDom(page);
      if (domReviews.length > 0) {
        log(`Got ${domReviews.length} reviews from DOM`);
        allReviews = domReviews.slice(0, maxReviews);
        pagesScraped = 1;
      }
    }

    // Add additional data from DOM (alternatives, integrations)
    if (productData) {
      productData = await extractProductFromDom(page, productData);
      productData.slug = productData.slug || slug;
      productData.url = `https://www.g2.com/products/${slug}/reviews`;
    }

    // Build product if still null (minimum viable)
    if (!productData) {
      log('Warning: Could not extract product data from gon or JSON-LD, building from DOM...');
      const pageTitle = await page.title();
      const nameMatch = pageTitle.match(/^(.+?)\s*(?:Reviews|ratings?|G2)/i);
      productData = {
        name: nameMatch ? nameMatch[1].trim() : slug,
        slug,
        url: `https://www.g2.com/products/${slug}/reviews`,
        logoUrl: null,
        rating: null,
        reviewCount: null,
        category: null,
        categories: [],
        shortDescription: null,
        longDescription: null,
        pricingInfo: null,
        features: [],
        integrations: [],
        alternatives: [],
        websiteUrl: null,
      };
    }

    // Paginate for more reviews if needed
    if (allReviews.length < maxReviews) {
      const gonReviewCount = allReviews.length;
      const totalReviews = productData.reviewCount || 0;
      const pages = Math.min(maxPages, Math.ceil(totalReviews / 20)) || maxPages;

      for (let pageNum = 2; pageNum <= pages && allReviews.length < maxReviews; pageNum++) {
        const url = buildProductUrl(slug, pageNum);
        log(`Scraping review page ${pageNum}...`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(3000);

        const pageTitle = await page.title();
        if (pageTitle.includes('Page Not Found') || pageTitle.includes('404')) {
          log('No more review pages');
          break;
        }

        pagesScraped++;

        // Check XHR captures first
        if (xhrCapture.length > 0) {
          const lastCapture = xhrCapture[xhrCapture.length - 1];
          const xhrReviews = lastCapture.reviews || lastCapture.data || [];
          if (xhrReviews.length > 0) {
            log(`Got ${xhrReviews.length} reviews from XHR page ${pageNum}`);
            for (const r of xhrReviews) {
              if (allReviews.length >= maxReviews) break;
              allReviews.push(parseReview(r));
            }
            continue;
          }
        }

        // Try gon
        const pageGon = await extractGon(page);
        const pageGonReviews = extractReviewsFromGon(pageGon);
        if (pageGonReviews.length > 0) {
          log(`Got ${pageGonReviews.length} reviews from gon page ${pageNum}`);
          for (const r of pageGonReviews) {
            if (allReviews.length >= maxReviews) break;
            allReviews.push(parseReview(r));
          }
          continue;
        }

        // DOM fallback
        const domReviews = await extractReviewsFromDom(page);
        if (domReviews.length === 0) {
          log('No reviews on this page — stopping pagination');
          break;
        }
        log(`Got ${domReviews.length} reviews from DOM page ${pageNum}`);
        for (const r of domReviews) {
          if (allReviews.length >= maxReviews) break;
          allReviews.push(r);
        }

        // Rate limiting
        if (pageNum < pages) await delay(1500);
      }
    }

    log(`Final: ${allReviews.length} reviews across ${pagesScraped} page(s)`);

    emitResult({
      product: productData,
      reviews: allReviews,
      reviewsUrl,
      pagesScraped: pagesScraped || 1,
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
  process.stderr.write('[g2-product] Fatal: ' + err.message + '\n');
  process.exit(1);
});
