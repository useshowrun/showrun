#!/usr/bin/env node
/**
 * goodreads-book — Scrape full book details + reviews from Goodreads.
 *
 * USAGE:
 *   node goodreads-book.mjs <book-url-or-id> [--max-reviews N]
 *   node goodreads-book.mjs '{"id":"44767458","maxReviews":30}'
 *
 * ARGS:
 *   <book-url-or-id>   Full URL, numeric ID, ID-slug (e.g. 44767458-dune), or
 *                      dotted legacy format (e.g. 3.Harry_Potter_...)
 *   --max-reviews N    Max reviews to return (default: 30; max embedded = 30;
 *                      N > 30 uses camoufox for additional reviews via XHR)
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "bookId": string,
 *     "title": string,
 *     "originalTitle": string|null,
 *     "titleComplete": string|null,
 *     "authors": [{ "id": string, "name": string, "url": string, "role": string, ... }],
 *     "isbn": string|null,
 *     "isbn13": string|null,
 *     "asin": string|null,
 *     "rating": number|null,
 *     "ratingsCount": number|null,
 *     "reviewsCount": number|null,
 *     "ratingDistribution": { "1":N, "2":N, "3":N, "4":N, "5":N }|null,
 *     "description": string|null,
 *     "genres": string[],
 *     "series": [{ "title": string, "position": string, "url": string }],
 *     "publisher": string|null,
 *     "publishedDate": string|null,
 *     "pages": number|null,
 *     "language": string|null,
 *     "format": string|null,
 *     "coverUrl": string|null,
 *     "coverImageLarge": string|null,
 *     "awards": [{ "name": string, "year": number, "category": string, "designation": string }],
 *     "places": [{ "name": string, "country": string|null, "url": string }],
 *     "characters": [{ "name": string, "url": string }],
 *     "url": string,
 *     "workId": string|null,
 *     "reviews": [{
 *       "id": string,
 *       "reviewer": { "id": number, "name": string, "url": string, "imageUrl": string|null },
 *       "rating": number|null,
 *       "date": string,
 *       "text": string|null,
 *       "likes": number,
 *       "spoilerStatus": boolean,
 *       "shelves": string|null
 *     }],
 *     "reviewsSource": "embedded"|"browser"|"none"
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (host:port)
 *
 * STRATEGY:
 *   1. Resolve book URL from input
 *   2. Fetch HTML via direct HTTPS (works without browser)
 *   3. Extract __NEXT_DATA__ Apollo state → full book data + 30 embedded reviews
 *   4. Fallback: extract JSON-LD Book schema for basic metadata
 *   5. If maxReviews > 30: launch camoufox, intercept XHR to /query Apollo endpoint
 *      to load additional review pages
 */

import {
  log,
  emitResult,
  emitError,
  fetchHtml,
  resolveBookUrl,
  extractBookId,
  extractNextData,
  extractJsonLd,
  parseApolloState,
  normalizeBook,
  delay,
  createGoodreadsBrowser,
  createGoodreadsContext,
  stripHtml,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  if (!args[0]) {
    emitError('MISSING_ARG', 'Usage: node goodreads-book.mjs <book-url-or-id> [--max-reviews N]');
  }

  // Try JSON arg (only if it looks like an object/string, not a bare number)
  if (args[0].startsWith('{') || args[0].startsWith('"')) {
    try {
      const json = JSON.parse(args[0]);
      if (json && typeof json === 'object') {
        return {
          input: json.id || json.url || json.bookId,
          maxReviews: json.maxReviews || json['max-reviews'] || 30,
        };
      }
    } catch (_) {
      // Not valid JSON — parse positional + flags
    }
  }

  const input = args[0];
  let maxReviews = 30;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--max-reviews' || args[i] === '--maxReviews') && args[i + 1]) {
      maxReviews = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { input, maxReviews };
}

// ---------------------------------------------------------------------------
// Fetch and extract book data from HTML
// ---------------------------------------------------------------------------

async function fetchBookData(bookUrl) {
  log(`Fetching: ${bookUrl}`);

  let html, finalUrl;
  try {
    const result = await fetchHtml(bookUrl);
    html = result.html;
    finalUrl = result.url;
    log(`Fetched ${html.length} bytes from: ${finalUrl}`);
  } catch (err) {
    if (err.code === 'NOT_FOUND' || err.status === 404) {
      emitError('NOT_FOUND', `Book not found: ${bookUrl}`);
    }
    emitError('FETCH_ERROR', `Failed to fetch book page: ${err.message}`);
  }

  // Detect bot block
  if (html.includes('Robot Check') || html.includes('captcha') || html.includes('Type the characters')) {
    emitError('BOT_DETECTED', 'Goodreads returned a bot-check page — try SOCKS5_PROXY');
  }

  // Check for "page not found" in HTML content
  if (html.includes('The page you') && html.includes("doesn't exist")) {
    emitError('NOT_FOUND', `Book page not found: ${bookUrl}`);
  }

  const nextData = extractNextData(html);
  const jsonLd = extractJsonLd(html);

  log(`__NEXT_DATA__: ${nextData ? 'found' : 'not found'}`);
  log(`JSON-LD: ${jsonLd ? 'found (type=' + jsonLd['@type'] + ')' : 'not found'}`);

  const apolloState = nextData?.props?.pageProps?.apolloState || null;
  const apolloParsed = apolloState ? parseApolloState(apolloState) : null;

  if (!apolloParsed && !jsonLd) {
    emitError('PARSE_ERROR', 'Could not extract book data from page (no __NEXT_DATA__ or JSON-LD found)');
  }

  const bookData = normalizeBook(apolloParsed, jsonLd, finalUrl);

  // Use URL-extracted ID if not found
  if (!bookData.bookId) {
    bookData.bookId = extractBookId(finalUrl);
  }

  const reviews = apolloParsed?.reviews || [];
  log(`Embedded reviews: ${reviews.length}`);

  return { bookData, reviews, finalUrl };
}

// ---------------------------------------------------------------------------
// Extended reviews via camoufox + XHR intercept
// ---------------------------------------------------------------------------

/**
 * Parse review objects from Goodreads Apollo GraphQL XHR response.
 * Handles the typical review edge structure from the book page API.
 */
function parseXhrReviews(responseData) {
  const reviews = [];

  // Goodreads GraphQL returns data.getReviews.edges or similar structures
  const tryPaths = [
    () => responseData?.data?.getReviews?.edges,
    () => responseData?.data?.book?.reviews?.edges,
    () => responseData?.data?.work?.reviews?.edges,
    () => responseData?.extensions?.reviews,
  ];

  let edges = null;
  for (const tryPath of tryPaths) {
    try {
      const result = tryPath();
      if (Array.isArray(result) && result.length > 0) {
        edges = result;
        break;
      }
    } catch (_) {}
  }

  if (!edges) return reviews;

  for (const edge of edges) {
    const r = edge.node || edge;
    if (!r) continue;

    const creator = r.creator || r.reviewer || {};
    reviews.push({
      id: r.id || null,
      rating: r.rating ?? null,
      text: r.text ? stripHtml(r.text) : null,
      textHtml: r.text || null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      spoilerStatus: r.spoilerStatus || false,
      likeCount: r.likeCount ?? 0,
      commentCount: r.commentCount ?? 0,
      shelving: r.shelving || null,
      reviewer: creator.name ? {
        id: creator.legacyId || creator.id || null,
        name: creator.name || null,
        webUrl: creator.webUrl || null,
        imageUrl: creator.imageUrlSquare || null,
        isAuthor: creator.isAuthor || false,
        followersCount: creator.followersCount || null,
        textReviewsCount: creator.textReviewsCount || null,
      } : null,
    });
  }

  return reviews;
}

/**
 * Use camoufox browser to load additional reviews by intercepting XHR/fetch
 * to Goodreads' internal Apollo GraphQL endpoint.
 */
async function fetchExtendedReviews(bookUrl, maxReviews, existingCount) {
  log(`Launching browser for extended reviews (need ${maxReviews - existingCount} more)...`);

  let Camoufox;
  try {
    Camoufox = (await import('camoufox-js')).Camoufox;
  } catch (e) {
    log(`Warning: camoufox-js not installed — cannot fetch extended reviews: ${e.message}`);
    return [];
  }

  const browser = await createGoodreadsBrowser(Camoufox);
  const context = await createGoodreadsContext(browser);
  const page = await context.newPage();

  const interceptedReviews = [];

  // Intercept XHR responses from Goodreads' GraphQL endpoint
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    // Goodreads uses /query or similar for Apollo GraphQL
    if (
      (url.includes('/graphql') || url.includes('/query') || url.includes('goodreads.com')) &&
      contentType.includes('json')
    ) {
      try {
        const body = await response.json();
        // Look for review data in response
        const reviews = parseXhrReviews(body);
        if (reviews.length > 0) {
          log(`XHR: captured ${reviews.length} reviews from ${url}`);
          interceptedReviews.push(...reviews);
        }
      } catch (_) {
        // Ignore parse failures
      }
    }
  });

  try {
    log(`Navigating to: ${bookUrl}`);
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(3000);

    const title = await page.title();
    log(`Page title: "${title}"`);

    // Check for bot block
    if (title.includes('Robot Check') || title.includes('captcha')) {
      log('Warning: Bot detection on browser page — extended reviews unavailable');
      return [];
    }

    // Extract reviews from __NEXT_DATA__ in the browser-rendered page
    const browserReviews = await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      if (!el) return [];
      try {
        const data = JSON.parse(el.textContent);
        const apollo = data?.props?.pageProps?.apolloState || {};
        return Object.keys(apollo)
          .filter(k => k.startsWith('Review:'))
          .map(k => apollo[k]);
      } catch (_) {
        return [];
      }
    });

    if (browserReviews.length > existingCount) {
      log(`Browser extracted ${browserReviews.length} reviews from __NEXT_DATA__`);
    }

    // Try scrolling/clicking to load more reviews
    if (interceptedReviews.length + browserReviews.length < maxReviews) {
      // Look for "Show more reviews" button or pagination
      try {
        const showMoreBtn = await page.$('[data-testid="loadMoreReviews"], button:has-text("More reviews"), a:has-text("More reviews")');
        if (showMoreBtn) {
          log('Clicking "more reviews" button...');
          await showMoreBtn.click();
          await delay(2000);
        }
      } catch (_) {
        // No such button
      }
    }

    await delay(1500);

  } catch (err) {
    log(`Browser error: ${err.message}`);
  } finally {
    await browser.close();
  }

  // Combine XHR-intercepted and browser-extracted reviews
  // Deduplicate by review ID
  const allReviews = [...interceptedReviews];
  const seenIds = new Set(allReviews.map(r => r.id).filter(Boolean));

  return allReviews;
}

// ---------------------------------------------------------------------------
// Normalize review for output
// ---------------------------------------------------------------------------

function normalizeReview(r) {
  return {
    id: r.id || null,
    reviewer: r.reviewer || null,
    rating: r.rating ?? null,
    date: r.createdAt || r.updatedAt || null,
    text: r.text || null,
    likes: r.likeCount ?? 0,
    spoilerStatus: r.spoilerStatus || false,
    shelves: r.shelving || null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { input, maxReviews } = parseArgs();

  if (!input || !input.toString().trim()) {
    emitError('MISSING_ARG', 'Book URL or ID is required');
  }

  const bookUrl = resolveBookUrl(input.toString().trim());
  if (!bookUrl) {
    emitError('INVALID_INPUT', `Cannot resolve a Goodreads URL from: ${input}`);
  }

  log(`Resolving book: ${bookUrl}`);
  log(`Max reviews: ${maxReviews}`);

  // Fetch book data (HTML fetch — no browser needed)
  const { bookData, reviews: embeddedReviews, finalUrl } = await fetchBookData(bookUrl);

  log(`Book: "${bookData.title}" by ${bookData.authors.map(a => a.name).join(', ')}`);
  log(`Rating: ${bookData.rating} (${bookData.ratingsCount?.toLocaleString()} ratings)`);

  let reviews = embeddedReviews;
  let reviewsSource = 'embedded';

  // If we need more reviews than embedded, use browser
  if (maxReviews > reviews.length && reviews.length > 0) {
    log(`Need ${maxReviews} reviews but only have ${reviews.length} embedded — trying browser`);
    const extraReviews = await fetchExtendedReviews(finalUrl, maxReviews, reviews.length);
    if (extraReviews.length > 0) {
      // Merge with embedded, dedup by ID
      const seenIds = new Set(reviews.map(r => r.id).filter(Boolean));
      for (const r of extraReviews) {
        if (!r.id || !seenIds.has(r.id)) {
          reviews.push(r);
          if (r.id) seenIds.add(r.id);
        }
      }
      reviewsSource = 'browser';
    }
  } else if (reviews.length === 0 && bookData.reviewsCount > 0) {
    reviewsSource = 'none';
  }

  // Trim to max
  const finalReviews = reviews.slice(0, maxReviews).map(normalizeReview);

  log(`Final reviews count: ${finalReviews.length} (source: ${reviewsSource})`);

  emitResult({
    ...bookData,
    reviews: finalReviews,
    reviewsSource,
  });
}

main().catch(err => {
  process.stderr.write('[goodreads-book] Fatal: ' + err.message + '\n');
  process.exit(1);
});
