#!/usr/bin/env node
/**
 * capterra-product — Get full product details + reviews from Capterra.com.
 *
 * USAGE:
 *   node capterra-product.mjs <product-url-or-slug> [--max-reviews N]
 *
 * ARGS:
 *   <product-url-or-slug>    Required — accepts:
 *                              - Full URL: https://www.capterra.com/p/26943/Slack/
 *                              - ID/slug:  26943/Slack
 *   --max-reviews N          Optional — max reviews to collect (default: 20)
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "product": {
 *       "name": string,
 *       "id": string|null,
 *       "slug": string|null,
 *       "url": string,
 *       "vendor": string|null,
 *       "vendorUrl": string|null,
 *       "logoUrl": string|null,
 *       "description": string|null,
 *       "rating": number|null,          // 0-5 scale
 *       "reviewCount": number|null,
 *       "ratingBreakdown": {
 *         "ease": number|null,          // Ease of Use
 *         "value": number|null,         // Value for Money
 *         "features": number|null,      // Features / Functionality
 *         "support": number|null,       // Customer Support
 *       },
 *       "pricing": {
 *         "hasFreeVersion": boolean,
 *         "hasFreeTrial": boolean,
 *         "startingPrice": string|null, // e.g. "$29.00/mo"
 *         "pricingModel": string|null,  // "Subscription", "One-Time", etc.
 *         "currency": string,
 *       },
 *       "features": string[],
 *       "platforms": string[],          // "Web", "iOS", "Android", "Windows", "Mac"
 *       "categories": string[],
 *       "integrations": string[],
 *     },
 *     "reviews": [
 *       {
 *         "id": string|null,
 *         "title": string|null,
 *         "rating": number|null,
 *         "pros": string|null,
 *         "cons": string|null,
 *         "date": string|null,
 *         "helpful": number,
 *         "author": string|null,
 *         "role": string|null,
 *         "companySize": string|null,
 *         "industry": string|null,
 *         "verified": boolean,
 *       }
 *     ],
 *     "productUrl": string,
 *     "pagesScraped": number,
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
 *   - HTTP 403 "Just a moment..." from Turkish/datacenter IPs even with camoufox
 *   - Needs SOCKS5_PROXY=host:port (residential IP) to bypass Cloudflare
 *   - Once bypassed: data is in __NEXT_DATA__ JSON (Next.js SSR)
 *   - Reviews are paginated — each page load reveals props.pageProps.reviews
 *   - Some reviews may load via XHR to /api/reviews/... endpoint
 *
 * DATA STRATEGY (when accessible):
 *   1. __NEXT_DATA__ JSON — primary source (Next.js SSR)
 *      - props.pageProps.product (product details)
 *      - props.pageProps.reviews (first page of reviews)
 *      - props.pageProps.pricing / props.pageProps.features
 *   2. JSON-LD SoftwareApplication — secondary (rating, review count, description)
 *   3. XHR interception — review pagination API calls
 *   4. DOM extraction (aria/data-* attrs) — fallback
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
  parseProductInput,
  parseProductNextData,
  parseSearchProduct,
  parseReview,
  parseRatingBreakdown,
  parsePricing,
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
  emitError('MISSING_ARG', 'Usage: capterra-product.mjs <product-url-or-slug> [--max-reviews N]');
}

const productInfo = parseProductInput(slugOrUrl);
if (!productInfo) {
  emitError(
    'INVALID_ARG',
    'Could not parse product URL or slug. ' +
    'Expected: full URL (https://www.capterra.com/p/26943/Slack/) ' +
    'or ID/slug (26943/Slack)'
  );
}

const { id: productId, slug: productSlug, url: productUrl } = productInfo;
log(`Product: id=${productId}, slug=${productSlug}`);
log(`URL: ${productUrl}`);

// ---------------------------------------------------------------------------
// DOM extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract product details from DOM when __NEXT_DATA__ is unavailable.
 * Uses data-* attributes, aria labels, and JSON-LD — no CSS class selectors.
 */
async function extractProductFromDom(page) {
  return page.evaluate(() => {
    const product = {
      name: null,
      vendor: null,
      vendorUrl: null,
      logoUrl: null,
      description: null,
      rating: null,
      reviewCount: null,
      ratingBreakdown: { ease: null, value: null, features: null, support: null },
      pricing: { hasFreeVersion: false, hasFreeTrial: false, startingPrice: null, pricingModel: null, currency: 'USD' },
      features: [],
      platforms: [],
      categories: [],
      integrations: [],
    };

    // Name: look for h1, title, og:title
    const h1 = document.querySelector('h1');
    if (h1) product.name = h1.innerText?.trim() || null;
    if (!product.name) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) product.name = ogTitle.getAttribute('content')?.split(' Reviews')[0]?.trim() || null;
    }

    // Logo
    const logoImg = document.querySelector(
      '[data-testid*="logo"] img, [alt*="logo" i], img[data-testid*="product"]'
    );
    if (logoImg) product.logoUrl = logoImg.src || logoImg.getAttribute('data-src') || null;

    // Rating from aria-label on rating element
    const ratingEls = document.querySelectorAll(
      '[aria-label*="star"], [aria-label*="rating"], [data-rating], [data-testid*="rating"]'
    );
    for (const el of ratingEls) {
      const label = el.getAttribute('aria-label') || '';
      const dataRating = el.getAttribute('data-rating') || '';
      const text = label + ' ' + dataRating;
      const m = text.match(/([\d.]+)\s*(?:out of 5|\/5|stars)/i) || text.match(/([\d.]+)/);
      if (m) {
        const r = parseFloat(m[1]);
        if (r >= 0 && r <= 5) {
          product.rating = r;
          break;
        }
      }
    }

    // Review count
    const reviewCountEls = document.querySelectorAll(
      '[data-testid*="review-count"], [data-review-count], [aria-label*="reviews"]'
    );
    for (const el of reviewCountEls) {
      const text = el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-review-count') || '';
      const m = text.match(/([\d,]+)\s*reviews?/i) || text.match(/([\d,]+)/);
      if (m) {
        product.reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        break;
      }
    }

    // Description: og:description or first descriptive paragraph
    const ogDesc = document.querySelector('meta[property="og:description"], meta[name="description"]');
    if (ogDesc) product.description = ogDesc.getAttribute('content') || null;

    // Vendor: look for "by <vendor>" pattern or link to vendor site
    const vendorLinks = document.querySelectorAll('a[href*="capterra.com/vendors/"], a[data-vendor-id]');
    if (vendorLinks.length > 0) {
      product.vendor = vendorLinks[0].innerText?.trim() || null;
      product.vendorUrl = vendorLinks[0].href || null;
    }

    // Features: find feature list items with data attributes
    const featureEls = document.querySelectorAll(
      '[data-testid*="feature"], [data-feature], [itemprop="feature"]'
    );
    product.features = Array.from(featureEls)
      .map(el => el.innerText?.trim() || el.getAttribute('content') || '')
      .filter(t => t.length > 0)
      .slice(0, 50);

    // Platforms
    const platformKeywords = ['Web', 'iOS', 'Android', 'Windows', 'Mac', 'Linux', 'SaaS', 'Cloud'];
    const platformText = document.body?.innerText || '';
    product.platforms = platformKeywords.filter(p =>
      new RegExp(`\\b${p}\\b`, 'i').test(platformText)
    );

    // Pricing from text patterns
    const bodyText = document.body?.innerText?.substring(0, 10000) || '';
    const priceM = bodyText.match(/starting (?:from|at|price[:\s]*)\s*\$([\d.,]+)/i) ||
                   bodyText.match(/\$([\d.,]+)\s*\/\s*(?:month|mo|year|user)/i);
    if (priceM) product.pricing.startingPrice = `$${priceM[1]}`;
    product.pricing.hasFreeVersion = /free version/i.test(bodyText);
    product.pricing.hasFreeTrial = /free trial/i.test(bodyText);

    return product;
  });
}

/**
 * Extract reviews from DOM using data-* attributes and aria.
 */
async function extractReviewsFromDom(page, maxR) {
  return page.evaluate((maxReviews) => {
    const reviews = [];
    const seen = new Set();

    // Find review containers via data-testid or data-review-id
    const reviewEls = document.querySelectorAll(
      '[data-testid*="review"], [data-review-id], [itemtype*="Review"]'
    );

    for (const el of reviewEls) {
      if (reviews.length >= maxReviews) break;

      const id = el.getAttribute('data-review-id') ||
                 el.getAttribute('data-testid') ||
                 null;

      if (id && seen.has(id)) continue;
      if (id) seen.add(id);

      const text = el.innerText || '';

      // Title
      const titleEl = el.querySelector('h3, h4, [data-testid*="title"], [itemprop="name"]');
      const title = titleEl?.innerText?.trim() || null;

      // Rating
      const ratingEl = el.querySelector('[aria-label*="star"], [data-rating], [itemprop="ratingValue"]');
      let rating = null;
      if (ratingEl) {
        const label = ratingEl.getAttribute('aria-label') ||
                      ratingEl.getAttribute('data-rating') ||
                      ratingEl.getAttribute('content') || '';
        const m = label.match(/([\d.]+)/);
        if (m) rating = parseFloat(m[1]);
      }

      // Pros/Cons (Capterra uses structured pros/cons)
      const prosEl = el.querySelector('[data-testid*="pros"], [data-testid*="positive"]');
      const consEl = el.querySelector('[data-testid*="cons"], [data-testid*="negative"]');
      const pros = prosEl?.innerText?.trim() || null;
      const cons = consEl?.innerText?.trim() || null;

      // Date
      const dateEl = el.querySelector('time, [datetime], [data-date], [itemprop="datePublished"]');
      const date = dateEl?.getAttribute('datetime') ||
                   dateEl?.getAttribute('data-date') ||
                   dateEl?.getAttribute('content') ||
                   dateEl?.innerText?.trim() ||
                   null;

      // Helpful votes
      const helpfulEl = el.querySelector('[data-testid*="helpful"], [aria-label*="helpful"]');
      let helpful = 0;
      if (helpfulEl) {
        const m = (helpfulEl.innerText || '').match(/([\d,]+)/);
        if (m) helpful = parseInt(m[1].replace(/,/g, ''), 10);
      }

      // Author info
      const authorEl = el.querySelector('[data-testid*="author"], [itemprop="author"]');
      const author = authorEl?.innerText?.trim() || null;

      const roleEl = el.querySelector('[data-testid*="role"], [data-testid*="job"], [itemprop="jobTitle"]');
      const role = roleEl?.innerText?.trim() || null;

      const industryEl = el.querySelector('[data-testid*="industry"]');
      const industry = industryEl?.innerText?.trim() || null;

      const companySizeEl = el.querySelector('[data-testid*="company-size"], [data-testid*="companySize"]');
      const companySize = companySizeEl?.innerText?.trim() || null;

      if (title || rating || pros || cons) {
        reviews.push({
          id: id || null,
          title,
          rating,
          pros,
          cons,
          date,
          helpful,
          author,
          role,
          companySize,
          industry,
          verified: el.querySelector('[data-testid*="verified"]') !== null,
        });
      }
    }

    return reviews;
  }, maxR);
}

/**
 * Extract product info from JSON-LD SoftwareApplication schema.
 */
async function extractProductFromJsonLd(page) {
  const jsonLdData = await extractJsonLd(page);

  for (const ld of jsonLdData) {
    if (ld['@type'] === 'SoftwareApplication' || ld['@type'] === 'Product') {
      return {
        name: ld.name || null,
        description: ld.description || null,
        rating: ld.aggregateRating?.ratingValue
          ? parseFloat(ld.aggregateRating.ratingValue)
          : null,
        reviewCount: ld.aggregateRating?.reviewCount
          ? parseInt(ld.aggregateRating.reviewCount, 10)
          : null,
        logoUrl: ld.image || null,
        vendor: ld.author?.name || ld.brand?.name || null,
        vendorUrl: ld.author?.url || null,
        platforms: Array.isArray(ld.operatingSystem)
          ? ld.operatingSystem
          : ld.operatingSystem
            ? [ld.operatingSystem]
            : [],
        applicationCategory: ld.applicationCategory || null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build product object from __NEXT_DATA__
// ---------------------------------------------------------------------------

function buildProductFromNextData(pageProps, jsonLdProduct) {
  const {
    product: rawProduct,
    pricingData,
    featuresData,
    reviewsData,
  } = pageProps;

  const product = {
    name: rawProduct?.productName || rawProduct?.name || jsonLdProduct?.name || null,
    id: rawProduct?.id ? String(rawProduct.id) : productId,
    slug: rawProduct?.uniqueName || rawProduct?.slug || productSlug,
    url: productUrl,
    vendor: rawProduct?.vendor?.name || rawProduct?.vendorName || jsonLdProduct?.vendor || null,
    vendorUrl: rawProduct?.vendor?.url || rawProduct?.vendorUrl || jsonLdProduct?.vendorUrl || null,
    logoUrl: rawProduct?.logoUrl || rawProduct?.logo || jsonLdProduct?.logoUrl || null,
    description: rawProduct?.description || rawProduct?.fullDescription || jsonLdProduct?.description || null,
    rating: rawProduct?.overallRating != null
      ? parseFloat(rawProduct.overallRating)
      : jsonLdProduct?.rating ?? null,
    reviewCount: rawProduct?.reviewCount != null
      ? parseInt(rawProduct.reviewCount, 10)
      : jsonLdProduct?.reviewCount ?? null,
    ratingBreakdown: parseRatingBreakdown(
      rawProduct?.ratingBreakdown ||
      rawProduct?.ratings ||
      rawProduct || // some schemas embed ratings at root
      null
    ),
    pricing: parsePricing(
      pricingData ||
      rawProduct?.pricing ||
      rawProduct?.pricingDetails ||
      null
    ),
    features: [],
    platforms: [],
    categories: [],
    integrations: [],
  };

  // Pricing fallbacks from product root
  if (!product.pricing.startingPrice) {
    product.pricing.hasFreeVersion = rawProduct?.hasFreeVersion || false;
    product.pricing.hasFreeTrial = rawProduct?.hasFreeTrial || false;
    product.pricing.startingPrice = rawProduct?.startingPrice ||
                                    rawProduct?.priceDisplayText ||
                                    null;
    product.pricing.pricingModel = rawProduct?.pricingModel || null;
  }

  // Logo URL fix
  if (product.logoUrl && !product.logoUrl.startsWith('http')) {
    product.logoUrl = `https:${product.logoUrl}`;
  }

  // Features
  if (featuresData && Array.isArray(featuresData)) {
    product.features = featuresData.map(f => f.name || f.featureName || f || '').filter(String);
  } else if (rawProduct?.features && Array.isArray(rawProduct.features)) {
    product.features = rawProduct.features.map(f => f.name || f || '').filter(String);
  }

  // Platforms
  const platforms = rawProduct?.platforms || rawProduct?.operatingSystems || [];
  if (Array.isArray(platforms)) {
    product.platforms = platforms.map(p => p.name || p || '').filter(String);
  } else if (jsonLdProduct?.platforms?.length) {
    product.platforms = jsonLdProduct.platforms;
  }

  // Categories
  const cats = rawProduct?.categories || rawProduct?.categoryNames || [];
  product.categories = Array.isArray(cats)
    ? cats.map(c => c.name || c || '').filter(String)
    : [];

  // Integrations
  const intgs = rawProduct?.integrations || rawProduct?.integrationList || [];
  product.integrations = Array.isArray(intgs)
    ? intgs.map(i => i.name || i || '').filter(String).slice(0, 50)
    : [];

  return product;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.SOCKS5_PROXY) {
    log('WARNING: SOCKS5_PROXY not set — Cloudflare will block from datacenter/Turkish IPs');
  }

  const browser = await createCapterraBrowser(Camoufox);
  const context = await createCapterraContext(browser);
  const page = await context.newPage();

  const xhrResults = setupXhrInterceptor(page);

  let pagesScraped = 0;
  const allReviews = [];

  try {
    // Load the product page
    log(`Loading: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(5000);
    pagesScraped++;

    // Check Cloudflare
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

    // Handle redirect: if URL changed significantly (e.g. to category page), warn
    if (!finalUrl.includes('/p/') && !finalUrl.includes(productSlug)) {
      log(`Warning: page redirected to ${finalUrl} — product may not exist`);
    }

    // -----------------------------------------------------------------------
    // Extract product details
    // -----------------------------------------------------------------------

    let product = null;
    let nextDataRaw = null;

    // Strategy 1: __NEXT_DATA__
    log('Attempting __NEXT_DATA__ extraction...');
    nextDataRaw = await extractNextData(page);
    if (nextDataRaw) {
      log('__NEXT_DATA__ found');
      const parsed = parseProductNextData(nextDataRaw);
      if (parsed?.product) {
        log('Product data found in __NEXT_DATA__');
        const jsonLdProduct = await extractProductFromJsonLd(page);
        product = buildProductFromNextData(parsed, jsonLdProduct);

        // Extract reviews from __NEXT_DATA__
        const rawReviews = parsed.reviewsData?.reviews ||
                          parsed.reviewsData?.items ||
                          (Array.isArray(parsed.reviewsData) ? parsed.reviewsData : null);

        if (rawReviews && Array.isArray(rawReviews)) {
          log(`Found ${rawReviews.length} reviews in __NEXT_DATA__`);
          allReviews.push(...rawReviews.map(parseReview).filter(Boolean));
        }
      } else {
        const keys = Object.keys(nextDataRaw?.props?.pageProps || {});
        log(`__NEXT_DATA__ pageProps keys: ${keys.join(', ')}`);
      }
    }

    // Strategy 2: window.__STATE__
    if (!product) {
      log('Attempting window.__STATE__ extraction...');
      const state = await extractWindowState(page);
      if (state) {
        log('window.__STATE__ found, keys:', Object.keys(state).slice(0, 10).join(', '));
        const rawProduct = state?.product || state?.productDetails || null;
        if (rawProduct) {
          product = buildProductFromNextData(
            { product: rawProduct, pricingData: null, featuresData: null, reviewsData: null },
            null
          );
        }
      }
    }

    // Strategy 3: JSON-LD
    if (!product) {
      log('Extracting from JSON-LD...');
      const jsonLdProduct = await extractProductFromJsonLd(page);
      if (jsonLdProduct) {
        product = {
          name: jsonLdProduct.name,
          id: productId,
          slug: productSlug,
          url: productUrl,
          vendor: jsonLdProduct.vendor || null,
          vendorUrl: jsonLdProduct.vendorUrl || null,
          logoUrl: jsonLdProduct.logoUrl || null,
          description: jsonLdProduct.description || null,
          rating: jsonLdProduct.rating,
          reviewCount: jsonLdProduct.reviewCount,
          ratingBreakdown: { ease: null, value: null, features: null, support: null },
          pricing: { hasFreeVersion: false, hasFreeTrial: false, startingPrice: null, pricingModel: null, currency: 'USD' },
          features: [],
          platforms: jsonLdProduct.platforms || [],
          categories: jsonLdProduct.applicationCategory ? [jsonLdProduct.applicationCategory] : [],
          integrations: [],
        };
        log('Product extracted from JSON-LD');
      }
    }

    // Strategy 4: DOM fallback
    if (!product) {
      log('Extracting product from DOM...');
      await delay(3000);
      const domProduct = await extractProductFromDom(page);
      product = {
        ...domProduct,
        id: productId,
        slug: productSlug,
        url: productUrl,
      };
      log(`DOM extraction: name="${product.name}", rating=${product.rating}`);
    }

    // -----------------------------------------------------------------------
    // Extract reviews
    // -----------------------------------------------------------------------

    // Check XHR for review data
    if (allReviews.length === 0 && xhrResults.length > 0) {
      log(`XHR interceptor captured ${xhrResults.length} responses — scanning for reviews`);
      for (const { url: xhrUrl, body } of xhrResults) {
        const rawReviews =
          body?.reviews ||
          body?.data?.reviews ||
          body?.items ||
          (Array.isArray(body) ? body : null);

        if (rawReviews && Array.isArray(rawReviews) && rawReviews.length > 0) {
          log(`Found ${rawReviews.length} reviews in XHR: ${xhrUrl}`);
          allReviews.push(...rawReviews.map(parseReview).filter(Boolean));
        }
      }
    }

    // DOM review extraction if still empty
    if (allReviews.length === 0) {
      log('Extracting reviews from DOM...');
      const domReviews = await extractReviewsFromDom(page, maxReviews);
      log(`DOM review extraction: ${domReviews.length} reviews`);
      allReviews.push(...domReviews);
    }

    // -----------------------------------------------------------------------
    // Paginate reviews (click "next page" or load more) up to maxReviews
    // -----------------------------------------------------------------------
    if (allReviews.length < maxReviews) {
      log(`Have ${allReviews.length} reviews, need up to ${maxReviews} — trying pagination...`);

      // Capterra review pagination: look for "Next" button or page numbers
      let pageNum = 2;
      while (allReviews.length < maxReviews && pageNum <= 10) {
        // Try clicking "Next" button
        const nextBtn = await page.$(
          '[aria-label="Next page"], [data-testid="next-page"], button[aria-label*="next" i]'
        );

        if (nextBtn) {
          log(`Clicking "Next" for page ${pageNum}...`);
          await nextBtn.click();
          await delay(3000);
          pagesScraped++;

          // Extract new reviews
          const newNextData = await extractNextData(page);
          if (newNextData) {
            const parsed = parseProductNextData(newNextData);
            const rawReviews = parsed?.reviewsData?.reviews ||
                               parsed?.reviewsData?.items ||
                               (Array.isArray(parsed?.reviewsData) ? parsed.reviewsData : null);

            if (rawReviews && rawReviews.length > 0) {
              log(`Page ${pageNum}: ${rawReviews.length} reviews from __NEXT_DATA__`);
              allReviews.push(...rawReviews.map(parseReview).filter(Boolean));
            } else {
              // Try DOM
              const domReviews = await extractReviewsFromDom(page, maxReviews - allReviews.length);
              if (domReviews.length === 0) break; // No more reviews
              allReviews.push(...domReviews);
            }
          }
        } else {
          // Try URL-based pagination: add ?page=N to current URL
          const reviewsUrl = new URL(finalUrl);
          reviewsUrl.searchParams.set('page', String(pageNum));
          log(`Navigating to review page ${pageNum}: ${reviewsUrl.toString()}`);

          await page.goto(reviewsUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(3000);
          pagesScraped++;

          // Check if still valid
          const newBlocked = await checkCloudflareBlock(page);
          if (newBlocked) {
            log('Cloudflare blocked review pagination page — stopping');
            break;
          }

          // Extract reviews
          const newNextData = await extractNextData(page);
          let pageReviews = [];
          if (newNextData) {
            const parsed = parseProductNextData(newNextData);
            const rawReviews = parsed?.reviewsData?.reviews ||
                               parsed?.reviewsData?.items ||
                               (Array.isArray(parsed?.reviewsData) ? parsed.reviewsData : null);
            if (rawReviews && rawReviews.length > 0) {
              pageReviews = rawReviews.map(parseReview).filter(Boolean);
            }
          }

          if (pageReviews.length === 0) {
            pageReviews = await extractReviewsFromDom(page, maxReviews - allReviews.length);
          }

          if (pageReviews.length === 0) {
            log('No reviews on pagination page — stopping');
            break;
          }

          log(`Page ${pageNum}: ${pageReviews.length} reviews`);
          allReviews.push(...pageReviews);
        }

        pageNum++;
      }
    }

    // Deduplicate reviews by ID
    const seenReviews = new Set();
    const dedupedReviews = [];
    for (const r of allReviews) {
      const key = r.id || `${r.author}|${r.date}|${r.title}`;
      if (!seenReviews.has(key)) {
        seenReviews.add(key);
        dedupedReviews.push(r);
      }
    }

    const finalReviews = dedupedReviews.slice(0, maxReviews);

    log(`Product: "${product?.name}", Rating: ${product?.rating}, Reviews: ${product?.reviewCount}`);
    log(`Returning ${finalReviews.length} reviews (${pagesScraped} pages scraped)`);

    emitResult({
      product: product || null,
      reviews: finalReviews,
      productUrl: finalUrl,
      pagesScraped,
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
  process.stderr.write('[capterra-product] Fatal: ' + err.message + '\n');
  process.exit(1);
});
