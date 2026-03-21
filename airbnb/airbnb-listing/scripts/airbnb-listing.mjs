#!/usr/bin/env node
/**
 * airbnb-listing — Scrape full detail for a single Airbnb listing.
 *
 * INPUT (JSON via stdin or first arg):
 *   {
 *     "listingId": "1158653190110852406",  // Required (room ID from URL)
 *     "checkin":   "2026-04-10",           // Optional (YYYY-MM-DD)
 *     "checkout":  "2026-04-11",           // Optional
 *     "adults":    2,                      // Optional (default: 1)
 *   }
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "listingId": string,
 *     "url": string,
 *     "title": string,
 *     "propertyType": string,       // e.g. "Room in hotel"
 *     "location": string,           // e.g. "New York"
 *     "address": string|null,       // Full address (if available)
 *     "description": string|null,
 *     "highlights": [{ title, subtitle }],
 *     "amenities": [{ title, available, group }],
 *     "photos": string[],
 *     "rating": number|null,
 *     "reviewCount": number|null,
 *     "categoryRatings": [{ category, rating, label }],
 *     "latitude": number|null,
 *     "longitude": number|null,
 *     "capacity": number|null,       // max guests
 *     "roomDetails": [string],       // e.g. ["1 bed", "1 private bath"]
 *     "houseRules": [string],
 *     "checkinTime": string|null,
 *     "checkoutTime": string|null,
 *     "petsAllowed": boolean|null,
 *   }
 *
 * LOGS: stderr
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
  buildListingUrl,
  findSection,
  getSectionData,
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

  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      if (!buf.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error(`Failed to parse stdin JSON: ${e.message}`)); }
    });
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the StaysPdpSections niobeClientData entry into a structured listing.
 */
function parsePdpData(niobeData, listingId, url) {
  if (!niobeData || !niobeData.niobeClientData) return null;

  // Find StaysPdpSections entry
  const pdpEntry = niobeData.niobeClientData.find(
    ([key]) => key && key.startsWith('StaysPdpSections:')
  );
  if (!pdpEntry) return null;

  const val = pdpEntry[1];
  const presentation = val?.data?.presentation;
  const node = val?.data?.node;

  if (!presentation?.stayProductDetailPage) return null;

  const sectionsContainer = presentation.stayProductDetailPage.sections;
  const sectionsList = sectionsContainer.sections || [];

  // Helper: find section and get its data
  const getSection = (type) => {
    const s = findSection(sectionsList, type);
    return s ? (s.section || s.sectionData || null) : null;
  };

  // --- TITLE_DEFAULT ---
  const titleSec = getSection('TITLE_DEFAULT');
  const title = titleSec?.title || null;

  // --- AVAILABILITY_CALENDAR_DEFAULT (has property overview) ---
  const calSec = getSection('AVAILABILITY_CALENDAR_DEFAULT');
  const roomDetails = (calSec?.descriptionItems || []).map(d => d.title).filter(Boolean);
  const capacity = calSec?.maxGuestCapacity || null;

  // --- DESCRIPTION_DEFAULT ---
  const descSec = getSection('DESCRIPTION_DEFAULT');
  const description = descSec?.htmlDescription?.htmlText
    || descSec?.descriptionSummary?.htmlText
    || null;

  // --- HIGHLIGHTS_DEFAULT ---
  const highlightsSec = getSection('HIGHLIGHTS_DEFAULT');
  const highlights = (highlightsSec?.highlights || []).map(h => ({
    title: h.title,
    subtitle: h.subtitle,
  }));

  // --- HERO_DEFAULT (gallery images) ---
  const heroSec = getSection('HERO_DEFAULT');
  const heroPhotos = (heroSec?.previewImages || []).map(img => img.baseUrl).filter(Boolean);

  // Also get full gallery from PHOTO_TOUR_SCROLLABLE
  const photoTourSec = getSection('PHOTO_TOUR_SCROLLABLE');
  const tourPhotos = (photoTourSec?.mediaItems || []).map(img => img.baseUrl).filter(Boolean);

  // Merge photos, hero first (deduplicated)
  const allPhotos = [...new Set([...heroPhotos, ...tourPhotos])];

  // --- AMENITIES_DEFAULT ---
  const amenitiesSec = getSection('AMENITIES_DEFAULT');
  const amenities = [];
  const amenityGroups = amenitiesSec?.previewAmenitiesGroups || [];
  for (const group of amenityGroups) {
    const groupTitle = group.title || null;
    for (const a of (group.amenities || [])) {
      amenities.push({
        title: a.title,
        available: a.available !== false,
        group: groupTitle,
      });
    }
  }
  // Check for full amenities list (may be under different field)
  const allAmenityGroups = amenitiesSec?.allAmenitiesGroups || amenitiesSec?.seeAllAmenitiesGroups || [];
  for (const group of allAmenityGroups) {
    const groupTitle = group.title || null;
    for (const a of (group.amenities || [])) {
      // Only add if not already in the list
      if (!amenities.find(ex => ex.title === a.title)) {
        amenities.push({
          title: a.title,
          available: a.available !== false,
          group: groupTitle,
        });
      }
    }
  }

  // --- REVIEWS_DEFAULT ---
  const reviewsSec = getSection('REVIEWS_DEFAULT');
  const categoryRatings = (reviewsSec?.ratings || []).map(r => ({
    category: r.categoryType,
    rating: parseFloat(r.localizedRating),
    label: r.label,
  }));

  // Get overall rating from BOOK_IT_NAV section
  const bookItNavSec = getSection('BOOK_IT_NAV');
  let rating = null;
  let reviewCount = null;
  const reviewItem = bookItNavSec?.reviewItem;
  if (reviewItem) {
    // title: "4.86 ·", subtitle: "79 reviews"
    const ratingMatch = (reviewItem.title || '').match(/([\d.]+)/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);
    const countMatch = (reviewItem.subtitle || '').match(/([\d,]+)\s+reviews?/);
    if (countMatch) reviewCount = parseInt(countMatch[1].replace(',', ''), 10);
  }

  // Fallback: sharingConfig title e.g. "Park Terrace Hotel · ★4.86 · Hotel in New York"
  const sharingConfig = sectionsContainer.metadata?.sharingConfig || {};
  if (!rating) {
    const shareTitle = sharingConfig.title || '';
    const ratingMatch = shareTitle.match(/★([\d.]+)/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);
  }
  if (!reviewCount) {
    const reviewCountFromMeta = sectionsContainer.metadata?.sharingConfig?.reviewCount;
    if (reviewCountFromMeta) reviewCount = reviewCountFromMeta;
  }

  // --- LOCATION_PDP ---
  const locationSec = getSection('LOCATION_PDP');
  const latitude = locationSec?.lat ?? null;
  const longitude = locationSec?.lng ?? null;
  const address = locationSec?.address || null;

  // --- POLICIES_DEFAULT ---
  const policiesSec = getSection('POLICIES_DEFAULT');
  const houseRulesRaw = policiesSec?.houseRules || [];
  const houseRules = houseRulesRaw.map(r => r.title).filter(Boolean);

  // Parse check-in/check-out times from house rules
  let checkinTime = null, checkoutTime = null;
  for (const rule of houseRules) {
    const ciMatch = rule.match(/Check-?in after\s+([\d:]+\s*[AP]M)/i);
    if (ciMatch) checkinTime = ciMatch[1];
    const coMatch = rule.match(/Check-?out before\s+([\d:]+\s*[AP]M)/i);
    if (coMatch) checkoutTime = coMatch[1];
  }

  // Check pets allowed
  const petsAllowed = houseRules.some(r => /pets allowed/i.test(r))
    ? true
    : houseRules.some(r => /no pets/i.test(r))
    ? false
    : null;

  // --- Property type & location from metadata ---
  const propertyType = sharingConfig.propertyType || null;
  const locationStr = sharingConfig.location || locationSec?.addressTitle || null;

  // --- Extra description from bnbProperty ---
  const bnbDescription = node?.bnbProperty?.description?.byline?.localizedStringWithTranslationPreference;
  const fullDescription = description || bnbDescription || null;

  return {
    listingId,
    url,
    title,
    propertyType,
    location: locationStr,
    address,
    description: fullDescription,
    highlights,
    amenities,
    photos: allPhotos,
    rating,
    reviewCount,
    categoryRatings,
    latitude,
    longitude,
    capacity,
    roomDetails,
    houseRules,
    checkinTime,
    checkoutTime,
    petsAllowed,
  };
}

/**
 * Fallback: parse JSON-LD schema.org data from the page.
 */
function parseJsonLd(jsonLdData) {
  for (const data of jsonLdData) {
    if (data['@type'] === 'VacationRental' || data['@type'] === 'LodgingBusiness') {
      return {
        name: data.name || null,
        description: data.description || null,
        photos: Array.isArray(data.image) ? data.image : data.image ? [data.image] : [],
        rating: data.aggregateRating?.ratingValue ? parseFloat(data.aggregateRating.ratingValue) : null,
        reviewCount: data.aggregateRating?.ratingCount ? parseInt(data.aggregateRating.ratingCount, 10) : null,
        latitude: data.latitude ? parseFloat(data.latitude) : null,
        longitude: data.longitude ? parseFloat(data.longitude) : null,
        capacity: data.containsPlace?.occupancy?.value ?? null,
      };
    }
  }
  return null;
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
    listingId,
    checkin,
    checkout,
    adults = 1,
  } = input;

  if (!listingId) {
    emitError('MISSING_PARAM', 'listingId is required');
  }

  const url = buildListingUrl({ listingId, checkin, checkout, adults });
  log(`[airbnb-listing] Loading: ${url}`);

  const browser = await createAirbnbBrowser(Camoufox);
  const context = await createAirbnbContext(browser);

  try {
    const page = await context.newPage();

    // Block unnecessary assets
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/tracking**', route => route.abort());
    await page.route('**/marketing_event_tracking**', route => route.abort());

    let retries = 0;
    let niobeData = null;
    let jsonLdData = [];

    while (retries < 3) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for SSR data (script tags are hidden, use state: 'attached')
        await page.waitForSelector('script[data-deferred-state-0="true"], #data-deferred-state-0', {
          timeout: 15000,
          state: 'attached',
        });

        niobeData = await extractNiobeData(page);

        // Also grab JSON-LD
        jsonLdData = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          return scripts.map(s => {
            try { return JSON.parse(s.textContent); } catch { return null; }
          }).filter(Boolean);
        });

        break;
      } catch (e) {
        retries++;
        log(`[airbnb-listing] Attempt ${retries} failed: ${e.message}`);
        if (retries < 3) {
          await delay(3000 * retries);
        }
      }
    }

    if (!niobeData && jsonLdData.length === 0) {
      const title = await page.title().catch(() => '');
      if (title.includes('Access denied') || title.includes('403')) {
        emitError('BOT_DETECTED', `Bot detection: page title is "${title}"`);
      }
      emitError('NO_DATA', 'Could not extract listing data from Airbnb page');
    }

    // Try primary extraction from niobeData
    let listing = parsePdpData(niobeData, listingId, url);

    // Merge or fallback from JSON-LD
    const jsonLd = parseJsonLd(jsonLdData);

    if (!listing && jsonLd) {
      log('[airbnb-listing] Using JSON-LD fallback');
      listing = {
        listingId,
        url,
        title: jsonLd.name,
        propertyType: null,
        location: null,
        address: null,
        description: jsonLd.description,
        highlights: [],
        amenities: [],
        photos: jsonLd.photos,
        rating: jsonLd.rating,
        reviewCount: jsonLd.reviewCount,
        categoryRatings: [],
        latitude: jsonLd.latitude,
        longitude: jsonLd.longitude,
        capacity: jsonLd.capacity,
        roomDetails: [],
        houseRules: [],
        checkinTime: null,
        checkoutTime: null,
        petsAllowed: null,
      };
    } else if (listing && jsonLd) {
      // Fill in any missing fields from JSON-LD
      if (!listing.photos.length && jsonLd.photos.length) listing.photos = jsonLd.photos;
      if (!listing.rating && jsonLd.rating) listing.rating = jsonLd.rating;
      if (!listing.reviewCount && jsonLd.reviewCount) listing.reviewCount = jsonLd.reviewCount;
      if (!listing.latitude && jsonLd.latitude) listing.latitude = jsonLd.latitude;
      if (!listing.longitude && jsonLd.longitude) listing.longitude = jsonLd.longitude;
      if (!listing.description && jsonLd.description) listing.description = jsonLd.description;
      if (!listing.capacity && jsonLd.capacity) listing.capacity = jsonLd.capacity;
    }

    if (!listing) {
      emitError('NO_DATA', `Could not extract listing ${listingId} from any source`);
    }

    log(`[airbnb-listing] Extracted: ${listing.title || '(no title)'}`);
    log(`  rating: ${listing.rating}, reviews: ${listing.reviewCount}, photos: ${listing.photos.length}`);

    emitResult(listing);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  log(`[airbnb-listing] Fatal error: ${e.message}`);
  log(e.stack);
  emitError('UNEXPECTED_ERROR', e.message);
});
