#!/usr/bin/env node
/**
 * fiverr-gig — Scrape full details for a Fiverr gig.
 *
 * Strategy:
 *   1. Navigate to the gig URL
 *   2. Extract __NEXT_DATA__ (primary) — Next.js SSR embeds full gig JSON
 *   3. XHR intercept fallback — capture /api/v2/gigs/ responses
 *   4. DOM fallback — extract visible data via aria/data-* attrs
 *   5. Cloudflare block detection → emit BLOCKED error
 *
 * Usage:
 *   node fiverr-gig.mjs <gig-url-or-path> [options]
 *
 * Args:
 *   <gig-url-or-path>    Full URL or "username/gig-slug" path
 *
 * Options:
 *   --max-reviews <N>    Max reviews to return (default: 20)
 *
 * Examples:
 *   node fiverr-gig.mjs "https://www.fiverr.com/johnsmith/design-a-logo"
 *   node fiverr-gig.mjs "johnsmith/design-a-logo"
 *   node fiverr-gig.mjs "johnsmith/design-a-logo" --max-reviews 50
 *
 * Output (stdout):
 *   RESULT:{
 *     "gigId": string,
 *     "title": string,
 *     "gigUrl": string,
 *     "thumbnailUrl": string|null,
 *     "description": string|null,
 *     "packages": [
 *       {
 *         "name": string,        // "Basic", "Standard", "Premium"
 *         "price": number,
 *         "deliveryDays": number|null,
 *         "description": string,
 *         "revisions": number|null,
 *         "features": string[]
 *       }
 *     ],
 *     "tags": string[],
 *     "categories": string[],
 *     "faqs": [{ "question": string, "answer": string }],
 *     "seller": {
 *       "username": string,
 *       "displayName": string,
 *       "level": string|null,
 *       "rating": number|null,
 *       "reviewCount": number,
 *       "avatarUrl": string|null,
 *       "country": string|null,
 *       "bio": string|null,
 *       "memberSince": string|null,
 *       "responseTime": string|null,
 *       "ordersInQueue": number,
 *       "languages": string[],
 *       "skills": string[]
 *     },
 *     "startingPrice": number|null,
 *     "currency": string,
 *     "deliveryDays": number|null,
 *     "rating": number|null,
 *     "reviewCount": number,
 *     "isProSeller": boolean,
 *     "isPro": boolean,
 *     "reviews": [
 *       {
 *         "id": string,
 *         "reviewer": string,
 *         "rating": number|null,
 *         "text": string,
 *         "date": string|null,
 *         "sellerResponse": string|null
 *       }
 *     ]
 *   }
 *
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 * LOGS: stderr
 *
 * ENV:
 *   SOCKS5_PROXY — optional, e.g. "127.0.0.1:11091"
 */

import { Camoufox } from 'camoufox-js';
import {
  emitResult,
  emitError,
  log,
  delay,
  createFiverrBrowser,
  createFiverrContext,
  checkCloudflareBlock,
  extractNextData,
  parseGigNextData,
  buildGigDetail,
  setupGigIntercept,
  parseGigPath,
  deepFind,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  emitError(
    'MISSING_ARG',
    'Usage: node fiverr-gig.mjs <gig-url-or-path> [--max-reviews N]'
  );
}

const gigInput = args[0];
let maxReviews = 20;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--max-reviews':
      maxReviews = parseInt(args[++i], 10);
      break;
    default:
      emitError('UNKNOWN_ARG', `Unknown argument: ${args[i]}`);
  }
}

// ---------------------------------------------------------------------------
// DOM-based fallback extraction
// ---------------------------------------------------------------------------

async function extractFromDom(page, gigUrl) {
  return page.evaluate((url) => {
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? (el.innerText || el.textContent || '').trim() : null;
    };

    const getAttr = (selector, attr) => {
      const el = document.querySelector(selector);
      return el ? el.getAttribute(attr) : null;
    };

    // Title — try multiple stable selectors
    const title =
      getText('h1[class*="title"]') ||
      getText('[data-testid="gig-title"]') ||
      getText('h1') ||
      null;

    // Description
    const description =
      getText('[data-testid="gig-description"]') ||
      getText('[class*="description"]') ||
      null;

    // Rating
    const ratingEl = document.querySelector('[data-testid="rating-score"], [aria-label*="rating"]');
    const rating = ratingEl
      ? parseFloat(ratingEl.getAttribute('aria-label')?.match(/[\d.]+/)?.[0] || ratingEl.innerText)
      : null;

    // Review count
    const reviewCountEl = document.querySelector('[data-testid="review-count"], [aria-label*="reviews"]');
    const reviewCount = reviewCountEl
      ? parseInt((reviewCountEl.innerText || '').replace(/\D/g, ''), 10) || 0
      : 0;

    // Packages — look for pricing tables
    const packages = [];
    const pkgEls = document.querySelectorAll('[data-testid*="package"], [class*="package-row"], [class*="package-tab"]');
    pkgEls.forEach((el, idx) => {
      const nameEl = el.querySelector('[class*="package-title"], [class*="tab-header"]');
      const priceEl = el.querySelector('[class*="price"]');
      const descEl = el.querySelector('[class*="description"]');
      const deliveryEl = el.querySelector('[class*="delivery"]');

      if (nameEl || priceEl) {
        const priceText = priceEl?.innerText?.replace(/[^0-9.]/g, '') || '0';
        packages.push({
          name: nameEl?.innerText?.trim() || ['Basic', 'Standard', 'Premium'][idx] || `Package ${idx + 1}`,
          price: parseFloat(priceText) || null,
          deliveryDays: null,
          description: descEl?.innerText?.trim() || '',
          revisions: null,
          features: [],
        });
      }
    });

    // Seller info
    const sellerEl = document.querySelector('[data-testid="seller-card"], [class*="seller-profile"]');
    const username =
      getAttr('[data-testid="seller-username"]', 'data-username') ||
      getText('[data-testid="seller-username"]') ||
      url.split('/')[3] || '';

    // Tags
    const tagEls = document.querySelectorAll('[data-testid="gig-tag"], [class*="gig-tag"]');
    const tags = Array.from(tagEls).map(el => el.innerText?.trim()).filter(Boolean);

    // Reviews
    const reviewEls = document.querySelectorAll('[data-testid*="review"], [class*="review-item"]');
    const reviews = Array.from(reviewEls).slice(0, 20).map(el => {
      const reviewerEl = el.querySelector('[class*="reviewer"], [data-testid*="reviewer"]');
      const ratingEl = el.querySelector('[aria-label*="rating"], [class*="stars"]');
      const textEl = el.querySelector('[class*="review-text"], [data-testid*="review-text"]');
      const dateEl = el.querySelector('[class*="review-date"], time');
      return {
        id: '',
        reviewer: reviewerEl?.innerText?.trim() || '',
        rating: ratingEl ? parseFloat(ratingEl.getAttribute('aria-label')?.match(/[\d.]+/)?.[0] || 0) : null,
        text: textEl?.innerText?.trim() || '',
        date: dateEl?.getAttribute('datetime') || dateEl?.innerText?.trim() || null,
        sellerResponse: null,
      };
    }).filter(r => r.reviewer || r.text);

    return {
      title,
      description,
      rating,
      reviewCount,
      packages,
      tags,
      seller: {
        username,
        displayName: '',
        level: null,
        rating: null,
        reviewCount: 0,
        avatarUrl: null,
        country: null,
        bio: null,
        memberSince: null,
        responseTime: null,
        ordersInQueue: 0,
        languages: [],
        skills: [],
      },
      reviews,
    };
  }, gigUrl);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse gig path
  const parsed = parseGigPath(gigInput);
  if (!parsed) {
    emitError(
      'INVALID_INPUT',
      `Invalid gig URL or path: "${gigInput}". Use format: "username/gig-slug" or full Fiverr URL.`
    );
  }

  const { username, slug, gigUrl } = parsed;
  log(`[fiverr-gig] Fetching gig: ${gigUrl}`);

  const browser = await createFiverrBrowser(Camoufox);

  try {
    const context = await createFiverrContext(browser);
    const page = await context.newPage();

    // Block unnecessary resources
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/tracking**', route => route.abort());
    await page.route('**/pixel**', route => route.abort());

    // Set up XHR intercept in parallel
    const xhrPromise = setupGigIntercept(page);

    let retries = 0;
    let gigDetail = null;
    let domFallback = null;

    while (retries < 3) {
      try {
        await page.goto(gigUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        log(`[fiverr-gig] Navigation note: ${e.message}`);
      }

      await delay(4000);

      const title = await page.title().catch(() => '');
      log(`[fiverr-gig] Page title: "${title}"`);

      // Check for PerimeterX / Cloudflare block
      const blocked = await checkCloudflareBlock(page);
      if (blocked) {
        log('[fiverr-gig] Bot protection block detected (PerimeterX/Cloudflare)');
        emitError(
          'BOT_PROTECTION_BLOCKED',
          'Fiverr blocked the request with PerimeterX ("It needs a human touch"). ' +
          'Fiverr uses PerimeterX (pxAppId: PXK3bezZfO) which requires residential IP reputation. ' +
          'Set SOCKS5_PROXY=host:port to use a residential proxy and retry.'
        );
      }

      // Check for 404 / seller not found
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (
        title.includes('404') ||
        title.includes('Page Not Found') ||
        pageText.includes("This gig isn't available") ||
        pageText.includes("Oops! That page can't be found") ||
        pageText.includes('page not found')
      ) {
        emitError(
          'NOT_FOUND',
          `Gig not found: ${gigUrl}`
        );
      }

      // Strategy 1: __NEXT_DATA__
      const nextData = await extractNextData(page);
      if (nextData) {
        log('[fiverr-gig] __NEXT_DATA__ found, parsing...');

        // Log available pageProps keys for debugging
        const pagePropsKeys = Object.keys(nextData?.props?.pageProps || {});
        log(`[fiverr-gig] pageProps keys: ${pagePropsKeys.slice(0, 20).join(', ')}`);

        gigDetail = parseGigNextData(nextData, gigUrl);

        if (gigDetail) {
          log(`[fiverr-gig] Successfully parsed gig: "${gigDetail.title}"`);
          break;
        }

        log('[fiverr-gig] __NEXT_DATA__ present but gig data not in standard paths');

        // Try to find any gig-like object deep in the tree
        const deepGigData = deepFind(nextData, 'gigData', 15)
          || deepFind(nextData, 'gig', 15)
          || deepFind(nextData, 'overview', 15);

        if (deepGigData && typeof deepGigData === 'object') {
          log('[fiverr-gig] Trying deep-found gig data...');
          gigDetail = buildGigDetail(deepGigData, null, null, null, gigUrl, nextData?.props?.pageProps);
          if (gigDetail && gigDetail.title) {
            log(`[fiverr-gig] Deep-found gig: "${gigDetail.title}"`);
            break;
          }
        }
      } else {
        log('[fiverr-gig] No __NEXT_DATA__ found');
      }

      retries++;
      if (retries < 3) {
        log(`[fiverr-gig] Retry ${retries}...`);
        await delay(3000 * retries);
      }
    }

    // Strategy 2: XHR intercept
    if (!gigDetail) {
      log('[fiverr-gig] Trying XHR intercept...');
      const xhrData = await Promise.race([
        xhrPromise,
        delay(5000).then(() => null),
      ]);

      if (xhrData) {
        log('[fiverr-gig] XHR data intercepted');
        const rawGig =
          xhrData?.gig ||
          xhrData?.gigData ||
          xhrData?.data?.gig ||
          xhrData?.data?.gigData ||
          null;

        if (rawGig) {
          gigDetail = buildGigDetail(rawGig, null, null, null, gigUrl, null);
          if (gigDetail && gigDetail.title) {
            log(`[fiverr-gig] XHR gig: "${gigDetail.title}"`);
          }
        }
      }
    }

    // Strategy 3: DOM fallback
    if (!gigDetail) {
      log('[fiverr-gig] Falling back to DOM extraction...');
      domFallback = await extractFromDom(page, gigUrl);

      if (domFallback && domFallback.title) {
        log(`[fiverr-gig] DOM fallback gig: "${domFallback.title}"`);
        gigDetail = {
          gigId: `${username}/${slug}`,
          title: domFallback.title,
          gigUrl,
          thumbnailUrl: null,
          description: domFallback.description,
          packages: domFallback.packages,
          tags: domFallback.tags,
          categories: [],
          faqs: [],
          seller: {
            ...domFallback.seller,
            username,
          },
          startingPrice: domFallback.packages[0]?.price || null,
          currency: 'USD',
          deliveryDays: null,
          rating: domFallback.rating,
          reviewCount: domFallback.reviewCount,
          isProSeller: false,
          isPro: false,
          reviews: domFallback.reviews,
        };
      }
    }

    if (!gigDetail || !gigDetail.title) {
      emitError(
        'NO_DATA',
        `Could not extract gig data from ${gigUrl}. The page structure may have changed or the gig may be unavailable.`
      );
    }

    // Limit reviews
    if (gigDetail.reviews && gigDetail.reviews.length > maxReviews) {
      gigDetail.reviews = gigDetail.reviews.slice(0, maxReviews);
    }

    log(`[fiverr-gig] Done: "${gigDetail.title}" | ${gigDetail.reviews?.length || 0} reviews | ${gigDetail.packages?.length || 0} packages`);
    emitResult(gigDetail);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  log(`[fiverr-gig] Fatal error: ${err.message}`);
  log(err.stack);
  emitError('FATAL', err.message);
});
