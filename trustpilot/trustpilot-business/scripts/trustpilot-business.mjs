#!/usr/bin/env node
/**
 * trustpilot-business — Scrape full business details + reviews from Trustpilot.
 *
 * INPUT (JSON arg or env vars):
 *   {
 *     "domain":     "amazon.com",  // Required — business domain
 *     "maxReviews": 20,            // Optional — max reviews (default: 20, max: 200)
 *     "language":   "en",          // Optional — language filter (default: "en", "all" = all)
 *     "sort":       "recency",     // Optional — "recency" or "relevance" (default: "recency")
 *     "stars":      null,          // Optional — filter by rating 1-5
 *   }
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "business": { ... full business unit data },
 *     "filters": { ... pagination + filter state },
 *     "reviews": [ ... array of reviews ],
 *     "pagesScraped": number,
 *     "reviewsUrl": string,
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
  createTrustpilotBrowser,
  createTrustpilotContext,
  extractNextData,
  parseReview,
  parseBusinessUnit,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse input
// ---------------------------------------------------------------------------

function parseInput() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    try {
      return JSON.parse(args[0]);
    } catch (e) {
      // Not JSON — treat as bare domain
      return { domain: args[0] };
    }
  }
  const domain = process.env.DOMAIN;
  if (!domain) {
    emitError('MISSING_INPUT', 'Provide a JSON argument or DOMAIN env var');
  }
  return {
    domain,
    maxReviews: process.env.MAX_REVIEWS ? parseInt(process.env.MAX_REVIEWS, 10) : undefined,
    language: process.env.LANGUAGE,
    sort: process.env.SORT,
    stars: process.env.STARS ? parseInt(process.env.STARS, 10) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Build URL
// ---------------------------------------------------------------------------

function buildPageUrl(domain, page, language, sort) {
  // Normalize domain — remove https://, trailing slashes, etc.
  let cleanDomain = domain.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  const params = new URLSearchParams();
  params.set('page', String(page));
  if (language && language !== 'all') {
    params.set('languages', language);
  }
  if (sort) {
    params.set('sort', sort);
  }
  // NOTE: Trustpilot strips the "stars" URL param server-side (SSR).
  // Star rating filtering is applied client-side via SPA navigation only.
  // We apply it as a post-filter below instead.

  return `https://www.trustpilot.com/review/${cleanDomain}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Scrape one page
// ---------------------------------------------------------------------------

async function scrapePage(page_, url) {
  log(`Navigating to: ${url}`);
  await page_.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(4000);

  const title = await page_.title();
  const finalUrl = page_.url();
  log(`Title: "${title}"`);

  // Check for blocks
  if (title.includes('Access to this page') || title.includes('captcha') || title.includes('denied')) {
    throw new Error('BOT_DETECTED: PerimeterX captcha triggered');
  }

  // Check for 404 / no results
  if (title.includes('Page not found') || finalUrl.includes('/404')) {
    return null; // Caller handles NOT_FOUND
  }

  const nextDataRaw = await extractNextData(page_);
  const pageProps = nextDataRaw?.props?.pageProps;
  if (!pageProps) {
    log('Warning: No __NEXT_DATA__ found on page');
    return null;
  }

  // Trustpilot returns a "not found" page with statusCode in __NEXT_DATA__
  // and no businessUnit key — detect this case
  if (pageProps.statusCode === 404 || (!pageProps.businessUnit && !pageProps.reviews)) {
    log('Page not found (no businessUnit in pageProps, statusCode:', pageProps.statusCode, ')');
    return { notFound: true };
  }

  return pageProps;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = parseInput();
  const {
    domain,
    maxReviews = 20,
    language = 'en',
    sort = 'recency',
    stars = null,
  } = input;

  if (!domain || domain.trim() === '') {
    emitError('MISSING_INPUT', '"domain" is required (e.g. "amazon.com")');
  }

  log(`Scraping Trustpilot business: ${domain}`);
  log(`Options: maxReviews=${maxReviews}, language=${language}, sort=${sort}, stars=${stars || 'any'}`);

  const browser = await createTrustpilotBrowser(Camoufox);
  const context = await createTrustpilotContext(browser);
  const page_ = await context.newPage();

  try {
    const maxPages = Math.ceil(maxReviews / 20);
    let allReviews = [];
    let businessData = null;
    let filtersData = null;
    let pagesScraped = 0;
    let reviewsUrl = null;

    for (let pageNum = 1; pageNum <= maxPages && allReviews.length < maxReviews; pageNum++) {
      const url = buildPageUrl(domain, pageNum, language, sort);
      if (pageNum === 1) reviewsUrl = url;

      log(`Scraping page ${pageNum}/${maxPages}...`);
      const pageProps = await scrapePage(page_, url);

      if (!pageProps || pageProps.notFound) {
        if (pageNum === 1) {
          // First page failed — domain not found
          emitError('NOT_FOUND', `No Trustpilot page found for domain: ${domain}`);
        }
        log('No data on this page — stopping pagination');
        break;
      }

      pagesScraped++;

      // Extract business unit on first page
      if (pageNum === 1) {
        const bu = pageProps.businessUnit;
        if (!bu) {
          emitError('PARSE_ERROR', 'Could not extract business unit from page data');
        }
        businessData = parseBusinessUnit(bu, pageProps.sidebarData, pageProps.filters);
        filtersData = pageProps.filters || null;

        log(`Business: "${businessData.name}" — ${businessData.numberOfReviews} reviews, ${businessData.trustScore} trust score`);
      }

      // Extract reviews
      const rawReviews = pageProps.reviews || [];
      log(`Page ${pageNum}: ${rawReviews.length} reviews (star filter: ${stars || 'all'})`);

      for (const r of rawReviews) {
        if (allReviews.length >= maxReviews) break;
        // Apply star rating post-filter (Trustpilot doesn't support SSR star filter via URL)
        if (stars && r.rating !== stars) continue;
        allReviews.push(parseReview(r));
      }

      // Check if there are more pages
      const pagination = pageProps.filters?.pagination;
      if (pagination && pageNum >= pagination.totalPages) {
        log(`Reached last page (${pageNum}/${pagination.totalPages})`);
        break;
      }

      // Delay between pages (be polite)
      if (pageNum < maxPages) {
        await delay(1500);
      }
    }

    log(`Scraped ${allReviews.length} reviews across ${pagesScraped} page(s)`);

    emitResult({
      business: businessData,
      filters: filtersData,
      reviews: allReviews,
      pagesScraped,
      reviewsUrl,
    });

  } catch (err) {
    log('Error:', err.message);
    if (err.message.startsWith('BOT_DETECTED')) {
      emitError('BOT_DETECTED', 'PerimeterX captcha triggered — use a residential proxy (SOCKS5_PROXY)');
    }
    emitError('SCRAPE_ERROR', err.message);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write('[trustpilot] Fatal: ' + err.message + '\n');
  process.exit(1);
});
