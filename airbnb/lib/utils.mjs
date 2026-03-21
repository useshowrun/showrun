/**
 * Shared utilities for Airbnb scrapers.
 *
 * Anti-bot Strategy (Updated 2026-03-21):
 *   Airbnb does NOT use a third-party bot-detection service like DataDome or
 *   Cloudflare. It serves full SSR pages without JS challenges, as long as the
 *   request comes from a real browser (camoufox handles this).
 *
 *   Key findings:
 *   1. Residential proxy is recommended but not strictly required. Airbnb
 *      does IP-based geo-detection (currency, locale). Use SOCKS5_PROXY env.
 *
 *   2. Homepage warmup is NOT required. The search and listing detail pages
 *      load independently without a prior session.
 *
 *   3. All listing data is server-side rendered (SSR) into an embedded
 *      <script type="application/json" data-deferred-state-0="true">
 *      tag containing niobeClientData with full GraphQL response.
 *
 *   4. SEARCH PAGE DATA:
 *      URL: /s/{location}/homes?checkin=…&checkout=…&adults=N&items_offset=0
 *      niobeClientData key: StaysSearch:{…}
 *      Contains: data.presentation.staysSearch.results.searchResults (array)
 *      Each item has: title, subtitle, avgRating, photos, propertyId,
 *                     demandStayListing.id (base64 → room ID), coordinates,
 *                     structuredDisplayPrice.primaryLine.accessibilityLabel
 *      Pagination: results.paginationInfo.nextPageCursor (base64 JSON with
 *                  items_offset). Pass &items_offset=N to next page.
 *
 *   5. LISTING DETAIL DATA:
 *      URL: /rooms/{id}?check_in=…&check_out=…&adults=N
 *      niobeClientData key: StaysPdpSections:{…}
 *      Contains: data.presentation.stayProductDetailPage.sections.sections
 *      Key sections: TITLE_DEFAULT, DESCRIPTION_DEFAULT, AMENITIES_DEFAULT,
 *                    REVIEWS_DEFAULT, LOCATION_PDP, POLICIES_DEFAULT,
 *                    HERO_DEFAULT, HIGHLIGHTS_DEFAULT, AVAILABILITY_CALENDAR_DEFAULT
 *      Also: data.node.bnbProperty.description.byline (text)
 *      Also: data.node.pdpPresentation.mediaTour (gallery images)
 *      Also: JSON-LD script (name, description, images, rating, coords)
 *
 *   6. URL structure for search:
 *      Location format: "New York, NY, United States" → "New-York--NY--United-States"
 *      place_id param (Google Place ID) is optional but helps accuracy
 *      Supported params: checkin, checkout, adults, children, infants, pets
 *                        items_offset (pagination), place_id, ne_lat, ne_lng,
 *                        sw_lat, sw_lng (bounding box)
 *
 *   Selectors used (all stable):
 *   - script[data-deferred-state-0="true"]  — SSR data embed (search + listing)
 *   - script[type="application/ld+json"]    — structured data fallback
 *   - a[href^="/rooms/"]                    — listing links (fallback)
 *   - [data-testid="listing-card-title"]    — card title (fallback)
 *   - [data-testid="listing-card-name"]     — card name (fallback)
 *
 *   Known limitations:
 *   - Listing price on /rooms/ page only shows if dates are specified
 *   - Reviews are not paginated (only summary ratings shown)
 *   - Host details require login to view contact info
 *   - Some hotel listings show property-level data, not room-level
 *   - items_offset pagination shows max ~90 results (5 pages × 18)
 */

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write('RESULT:' + JSON.stringify(obj) + '\n');
}

export function emitError(code, message) {
  process.stdout.write(
    'RESULT:' + JSON.stringify({ error: true, code, message }) + '\n'
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser for Airbnb scraping.
 * Uses residential proxy if SOCKS5_PROXY env is set.
 */
export async function createAirbnbBrowser(Camoufox) {
  const socks5 = process.env.SOCKS5_PROXY;
  const firefoxUserPrefs = {};

  if (socks5) {
    const [host, port] = socks5.split(':');
    log(`Using SOCKS5 proxy: ${socks5}`);
    Object.assign(firefoxUserPrefs, {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': parseInt(port, 10),
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    });
  } else {
    log('No proxy configured (SOCKS5_PROXY not set)');
  }

  return Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1280, minHeight: 900 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createAirbnbContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the niobeClientData from the embedded SSR script tag.
 * Returns the parsed value object, or null if not found.
 */
export async function extractNiobeData(page) {
  return page.evaluate(() => {
    // The script tag has data-deferred-state-0="true" attribute
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    for (const script of scripts) {
      if (script.getAttribute('data-deferred-state-0') === 'true' ||
          script.id === 'data-deferred-state-0') {
        try {
          const data = JSON.parse(script.textContent);
          return data;
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  });
}

/**
 * Decode a base64 Airbnb ID (e.g. DemandStayListing:12345 → 12345)
 */
export function decodeAirbnbId(b64Id) {
  if (!b64Id) return null;
  try {
    const decoded = Buffer.from(b64Id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    return parts[parts.length - 1];
  } catch (e) {
    return null;
  }
}

/**
 * Find a section by sectionComponentType in the sections array.
 */
export function findSection(sections, type) {
  if (!Array.isArray(sections)) return null;
  return sections.find(s => s.sectionComponentType === type) || null;
}

/**
 * Get section data from a section container.
 * Airbnb uses `section` field (not `sectionData`) for the actual data.
 */
export function getSectionData(section) {
  if (!section) return null;
  return section.section || section.sectionData || null;
}

/**
 * Extract price string from a structuredDisplayPrice object.
 */
export function extractPriceLabel(structuredDisplayPrice) {
  if (!structuredDisplayPrice) return null;
  const primary = structuredDisplayPrice.primaryLine;
  if (primary) {
    return primary.accessibilityLabel || null;
  }
  return null;
}

/**
 * Extract a clean rating + review count from search result.
 */
export function extractRating(result) {
  const raw = result.avgRatingA11yLabel;
  if (!raw) return { rating: null, reviewCount: null };

  // Format: "4.86 out of 5 average rating, 79 reviews"
  const ratingMatch = raw.match(/([\d.]+)\s+out of/);
  const countMatch = raw.match(/([\d,]+)\s+reviews?/);

  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
    reviewCount: countMatch ? parseInt(countMatch[1].replace(',', ''), 10) : null,
  };
}

/**
 * Convert Airbnb search location string to URL slug.
 * "New York, NY, United States" → "New-York--NY--United-States"
 */
export function locationToSlug(location) {
  return location
    .split(',')
    .map(p => p.trim().replace(/\s+/g, '-'))
    .join('--');
}

/**
 * Build Airbnb search URL.
 */
export function buildSearchUrl({
  location,        // e.g. "New York, NY, United States"
  checkin,         // e.g. "2026-04-10"
  checkout,        // e.g. "2026-04-11"
  adults = 1,
  children = 0,
  infants = 0,
  pets = 0,
  placeId,         // Google Place ID (optional)
  itemsOffset = 0, // pagination offset (18 per page)
  refinementPath = '/homes',
}) {
  const slug = locationToSlug(location);
  const params = new URLSearchParams();

  if (checkin) params.set('checkin', checkin);
  if (checkout) params.set('checkout', checkout);
  if (adults > 0) params.set('adults', String(adults));
  if (children > 0) params.set('children', String(children));
  if (infants > 0) params.set('infants', String(infants));
  if (pets > 0) params.set('pets', String(pets));
  if (placeId) params.set('place_id', placeId);
  if (itemsOffset > 0) params.set('items_offset', String(itemsOffset));
  params.set('currency', 'USD');

  return `https://www.airbnb.com/s/${slug}${refinementPath}?${params.toString()}`;
}

/**
 * Build Airbnb listing detail URL.
 */
export function buildListingUrl({
  listingId,
  checkin,
  checkout,
  adults = 1,
}) {
  const params = new URLSearchParams();
  if (checkin) params.set('check_in', checkin);
  if (checkout) params.set('check_out', checkout);
  if (adults > 0) params.set('adults', String(adults));
  params.set('currency', 'USD');

  return `https://www.airbnb.com/rooms/${listingId}?${params.toString()}`;
}
