#!/usr/bin/env node
/**
 * airbnb-search — Scrape Airbnb property search results.
 *
 * INPUT (JSON via stdin or args):
 *   {
 *     "location": "New York, NY, United States",   // Required
 *     "checkin":  "2026-04-10",                    // Optional (YYYY-MM-DD)
 *     "checkout": "2026-04-11",                    // Optional (YYYY-MM-DD)
 *     "adults":   2,                               // Optional (default: 1)
 *     "children": 0,                               // Optional
 *     "infants":  0,                               // Optional
 *     "pets":     0,                               // Optional
 *     "placeId":  "ChIJOwg_06VPwokRYv534QaPC8g",  // Optional (Google Place ID)
 *     "maxPages": 3,                               // Max pages to scrape (default: 1)
 *     "currency": "USD",                           // Optional (default: "USD")
 *   }
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "location": string,
 *     "totalCount": number|null,
 *     "listings": [
 *       {
 *         "listingId": string,
 *         "propertyId": string,
 *         "url": string,
 *         "title": string,
 *         "subtitle": string,           // e.g. "Hotel in Midtown East"
 *         "name": string,               // localized name
 *         "rating": number|null,
 *         "reviewCount": number|null,
 *         "ratingLabel": string|null,   // raw label
 *         "priceLabel": string|null,    // e.g. "$150 for 1 night"
 *         "thumbnailUrl": string|null,
 *         "photos": string[],
 *         "latitude": number|null,
 *         "longitude": number|null,
 *         "badges": string[],
 *       }
 *     ],
 *     "hasMore": boolean,
 *     "pagesScraped": number,
 *     "searchUrl": string,
 *   }
 *
 * LOGS: stderr (all progress, errors, debug info)
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
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
  createAirbnbBrowser,
  createAirbnbContext,
  extractNiobeData,
  decodeAirbnbId,
  extractRating,
  extractPriceLabel,
  buildSearchUrl,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse input
// ---------------------------------------------------------------------------

async function readInput() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    try {
      return JSON.parse(args[0]);
    } catch (e) {
      emitError('INVALID_INPUT', `Failed to parse JSON argument: ${e.message}`);
    }
  }

  // Read from stdin
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      if (!buf.trim()) {
        // Use defaults for testing
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error(`Failed to parse stdin JSON: ${e.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Scrape one page of results
// ---------------------------------------------------------------------------

/**
 * Parse the niobeClientData for StaysSearch results.
 * Returns { listings, paginationInfo, totalCount }.
 */
function parseSearchResults(niobeData, inputParams) {
  if (!niobeData || !niobeData.niobeClientData) {
    return null;
  }

  // Find StaysSearch entry
  const staysEntry = niobeData.niobeClientData.find(
    ([key]) => key && key.startsWith('StaysSearch:')
  );
  if (!staysEntry) return null;

  const val = staysEntry[1];
  if (!val?.data?.presentation?.staysSearch?.results) return null;

  const results = val.data.presentation.staysSearch.results;
  const searchResults = results.searchResults || [];
  const paginationInfo = results.paginationInfo || {};

  // Extract total count from section config
  const sectionConfig = results.sectionConfiguration;
  let totalCount = null;
  try {
    const titleSections = sectionConfig?.pageTitleSections?.sections || [];
    for (const sect of titleSections) {
      const title = sect?.sectionData?.structuredTitle || '';
      // e.g. "85 hotels in New York"
      const match = title.match(/^(\d+)\s+/);
      if (match) {
        totalCount = parseInt(match[1], 10);
        break;
      }
    }
  } catch (e) { /* ignore */ }

  // Parse each listing
  const listings = searchResults.map(r => {
    // Get room ID from demandStayListing.id (base64 decoded)
    const dsl = r.demandStayListing || {};
    const listingId = decodeAirbnbId(dsl.id);
    const propertyId = r.propertyId || null;

    // Build URL
    const listingUrl = listingId
      ? buildListingUrlFromSearch(listingId, inputParams)
      : null;

    // Rating
    const { rating, reviewCount } = extractRating(r);

    // Price
    const priceLabel = extractPriceLabel(r.structuredDisplayPrice);

    // Photos
    const photos = (r.contextualPictures || [])
      .map(p => p.picture)
      .filter(Boolean);
    const thumbnailUrl = photos[0] || null;

    // Coordinates
    const coord = dsl.location?.coordinate || {};
    const latitude = coord.latitude ?? null;
    const longitude = coord.longitude ?? null;

    // Badges
    const badges = (r.badges || []).map(b => b.text || b.id || '').filter(Boolean);

    // Name
    const name = r.nameLocalized?.localizedStringWithTranslationPreference
      || r.nameLocalized?.localizedString
      || r.title
      || null;

    return {
      listingId,
      propertyId: propertyId ? String(propertyId) : null,
      url: listingUrl,
      title: r.title || null,
      subtitle: r.subtitle || null,
      name,
      rating,
      reviewCount,
      ratingLabel: r.avgRatingA11yLabel || null,
      priceLabel,
      thumbnailUrl,
      photos,
      latitude,
      longitude,
      badges,
    };
  });

  return {
    listings,
    paginationInfo,
    totalCount,
  };
}

function buildListingUrlFromSearch(listingId, { checkin, checkout, adults = 1 }) {
  const params = new URLSearchParams();
  if (checkin) params.set('check_in', checkin);
  if (checkout) params.set('check_out', checkout);
  if (adults > 0) params.set('adults', String(adults));
  params.set('currency', 'USD');
  return `https://www.airbnb.com/rooms/${listingId}?${params.toString()}`;
}

/**
 * Get next page's items_offset from paginationInfo.
 */
function getNextOffset(paginationInfo, currentOffset) {
  const cursor = paginationInfo.nextPageCursor;
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed.items_offset;
  } catch (e) {
    // Fallback: add 18 to current offset
    return currentOffset + 18;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    input = await readInput();
  } catch (e) {
    emitError('INVALID_INPUT', e.message);
  }

  const {
    location = 'New York, NY, United States',
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    placeId,
    maxPages = 1,
    currency = 'USD',
  } = input;

  if (!location) {
    emitError('MISSING_PARAM', 'location is required');
  }

  log(`[airbnb-search] Searching: ${location}`);
  if (checkin) log(`  checkin: ${checkin}, checkout: ${checkout}, adults: ${adults}`);
  log(`  maxPages: ${maxPages}`);

  const browser = await createAirbnbBrowser(Camoufox);
  const context = await createAirbnbContext(browser);

  try {
    const page = await context.newPage();

    // Suppress non-essential requests to speed up loading
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/tracking**', route => route.abort());
    await page.route('**/marketing_event_tracking**', route => route.abort());

    const allListings = [];
    let pagesScraped = 0;
    let hasMore = false;
    let itemsOffset = 0;
    let totalCount = null;
    let firstSearchUrl = null;

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const searchUrl = buildSearchUrl({
        location,
        checkin,
        checkout,
        adults,
        children,
        infants,
        pets,
        placeId,
        itemsOffset,
        refinementPath: '/homes',
      });

      if (pageNum === 0) firstSearchUrl = searchUrl;

      log(`[airbnb-search] Page ${pageNum + 1}/${maxPages}: ${searchUrl}`);

      let retries = 0;
      let niobeData = null;

      while (retries < 3 && !niobeData) {
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

          // Wait for the SSR data script to be attached (script tags are hidden, not visible)
          await page.waitForSelector('script[data-deferred-state-0="true"], #data-deferred-state-0', {
            timeout: 15000,
            state: 'attached',
          });

          niobeData = await extractNiobeData(page);
        } catch (e) {
          retries++;
          log(`[airbnb-search] Attempt ${retries} failed: ${e.message}`);
          if (retries < 3) {
            await delay(3000 * retries);
          }
        }
      }

      if (!niobeData) {
        log(`[airbnb-search] Failed to load page ${pageNum + 1}, stopping`);
        break;
      }

      const parsed = parseSearchResults(niobeData, { checkin, checkout, adults });

      if (!parsed) {
        log(`[airbnb-search] Could not find StaysSearch data on page ${pageNum + 1}`);

        // Try to detect if it's a bot block
        const title = await page.title();
        log(`[airbnb-search] Page title: ${title}`);

        if (title.includes('Access denied') || title.includes('403') || title.includes('Just a moment')) {
          emitError('BOT_DETECTED', `Bot detection triggered: page title is "${title}"`);
        }

        if (pageNum === 0) {
          emitError('NO_DATA', 'Could not extract search results from Airbnb page');
        }
        break;
      }

      if (totalCount === null) {
        totalCount = parsed.totalCount;
      }

      log(`[airbnb-search] Page ${pageNum + 1}: got ${parsed.listings.length} listings`);
      allListings.push(...parsed.listings);
      pagesScraped++;

      // Check if there's a next page
      const nextOffset = getNextOffset(parsed.paginationInfo, itemsOffset);
      if (nextOffset !== null && pageNum + 1 < maxPages) {
        itemsOffset = nextOffset;
        hasMore = true;
        await delay(1500); // polite pause between pages
      } else {
        hasMore = nextOffset !== null;
        break;
      }
    }

    emitResult({
      location,
      totalCount,
      listings: allListings,
      hasMore,
      pagesScraped,
      searchUrl: firstSearchUrl,
    });

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  log(`[airbnb-search] Fatal error: ${e.message}`);
  log(e.stack);
  emitError('UNEXPECTED_ERROR', e.message);
});
