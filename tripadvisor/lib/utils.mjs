/**
 * Shared utilities for Tripadvisor scrapers.
 *
 * Anti-bot Strategy:
 *   Tripadvisor uses Cloudflare bot detection. Key insights:
 *
 *   1. RESIDENTIAL PROXY REQUIRED — server/datacenter IPs return empty body (1.2KB).
 *      Set SOCKS5_PROXY env var (default: 127.0.0.1:11091)
 *      Verified: Vodafone Turkish residential IP (188.3.180.188) works.
 *
 *   2. camoufox (fingerprinted Firefox) is required to pass JS challenges.
 *      Plain curl/fetch returns empty body; camoufox passes Cloudflare.
 *
 *   3. Homepage MUST be loaded first to establish session cookies.
 *      After homepage warmup, hotel and search pages load correctly.
 *
 *   4. SEARCH STRATEGY:
 *      a. Use homepage search box to trigger Typeahead_autocomplete GQL calls
 *         — returns locationId (geoId) for cities, hotels, restaurants, etc.
 *      b. Navigate to /Hotels-g{geoId}-{City}-Hotels.html (hotel listing URL)
 *      c. Extract hotel cards using stable patterns:
 *         - a[href*="Hotel_Review"] with non-numeric text = hotel name
 *         - SVG title "N of 5 bubbles" = rating
 *         - "(N reviews)" text pattern = review count
 *         - URL pattern extracts geoId + locationId (stable unique IDs)
 *
 *   5. HOTEL DETAIL STRATEGY:
 *      a. Load hotel page /Hotel_Review-g{geoId}-d{locationId}-Reviews-...
 *      b. JSON-LD <script type="application/ld+json"> with @type=LodgingBusiness
 *         — contains: name, url, priceRange, aggregateRating, address, geo, amenityFeatures, image
 *      c. DOM reviews via [data-test-target="HR_CC_CARD"] (stable data-test-target)
 *         — innerText pattern: "{author} wrote a review {date}\n{contributions}\n{title}\n{text}"
 *         — rating: SVG title "N of 5 bubbles" (first SVG in card with "bubbles" title)
 *      d. Photos: img[src*="dynamic-media-cdn.tripadvisor.com"] — TA uses CDN for all hotel photos
 *
 *   Stable selectors (never obfuscated CSS class names):
 *   - script[type="application/ld+json"]  — JSON-LD hotel data
 *   - [data-test-target="HR_CC_CARD"]     — review cards
 *   - a[href*="Hotel_Review"]             — hotel links (search + detail pages)
 *   - a[href*="/Profile/"]               — reviewer profile links (to get author name)
 *   - svg title                          — "N of 5 bubbles" rating text (stable, accessible)
 *   - img[src*="dynamic-media-cdn.tripadvisor.com"] — hotel/review photos
 *   - data/graphql/ids                   — GQL endpoint (typeahead + other APIs)
 *
 *   Known limitations:
 *   - DataDome/Cloudflare may rate-limit IPs after many requests
 *   - Hotel listing shows ~10-30 hotels per page (use pagination for more)
 *   - Review cards show ~10 reviews per page (DOM extraction only)
 *   - Restaurant pages use [data-test-target="restaurant-list-item"] (similar pattern)
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
 * Create a camoufox browser for Tripadvisor scraping.
 * Residential proxy required (set SOCKS5_PROXY env var).
 */
export async function createTripadvisorBrowser(Camoufox) {
  const socks5 = process.env.SOCKS5_PROXY || '127.0.0.1:11091';
  const [host, port] = socks5.split(':');

  log(`[browser] Using SOCKS5 proxy: ${socks5}`);

  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 900 },
    firefoxUserPrefs: {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': parseInt(port, 10),
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    },
  });
}

/**
 * Create a browser context for Tripadvisor.
 * English locale + US timezone for consistent data.
 */
export async function createTripadvisorContext(browser) {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Load cookies if provided
  const cookiesJson = process.env.TA_COOKIES;
  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(cookies);
      log('[auth] Loaded Tripadvisor cookies from TA_COOKIES env var');
    } catch (e) {
      log('[auth] Warning: TA_COOKIES is invalid JSON:', e.message);
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// Session init (homepage warmup)
// ---------------------------------------------------------------------------

/**
 * Navigate to Tripadvisor homepage to establish session cookies.
 * REQUIRED before hotel search or detail pages.
 * Returns the page for further use.
 */
export async function initTripadvisorSession(context) {
  const page = await context.newPage();

  log('[session] Loading Tripadvisor homepage for warmup...');
  await page.goto('https://www.tripadvisor.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await delay(2000);

  const bodyLen = await page.evaluate(() => document.body.innerHTML.length);
  if (bodyLen < 5000) {
    throw new Error(
      `Homepage body too small (${bodyLen} bytes) — bot detection active. Residential proxy required.`
    );
  }

  log(`[session] Homepage loaded OK (${bodyLen} bytes)`);
  return page;
}

// ---------------------------------------------------------------------------
// Location lookup via Typeahead GQL
// ---------------------------------------------------------------------------

/**
 * Resolve a city/location name to a Tripadvisor geoId (locationId).
 * Uses the homepage search box to trigger the Typeahead_autocomplete GQL API.
 *
 * Returns: { locationId, localizedName, placeType, hotelsUrl, attractionsUrl }
 */
export async function lookupLocation(page, query) {
  log(`[lookup] Resolving location: "${query}"`);

  // Collect typeahead GQL responses
  const typeaheadResults = [];
  const responseHandler = async (response) => {
    const url = response.url();
    if (url.includes('graphql')) {
      try {
        const text = await response.text();
        if (text.includes('Typeahead_autocomplete') && text.includes('locationId')) {
          const data = JSON.parse(text);
          typeaheadResults.push(...(data || []));
        }
      } catch {}
    }
  };
  page.on('response', responseHandler);

  // Find and use the search input
  const searchInput = await page.$(
    'input[id*="search"], input[placeholder*="Where"], input[name="q"], input[type="search"]'
  );

  if (!searchInput) {
    throw new Error('Search input not found on homepage');
  }

  await searchInput.click();
  await delay(500);
  await page.keyboard.type(query, { delay: 80 });
  await delay(3000); // Wait for typeahead GQL calls

  page.off('response', responseHandler);

  // Parse results
  for (const batch of typeaheadResults) {
    const results = batch?.data?.Typeahead_autocomplete?.results;
    if (!results) continue;

    for (const item of results) {
      if (item.__typename === 'Typeahead_LocationItem' && item.locationId) {
        const details = item.details;
        const v2 = details?.locationV2;
        log(
          `[lookup] Found: ${details?.localizedName} (id=${item.locationId}, type=${v2?.placeType})`
        );
        return {
          locationId: item.locationId,
          localizedName: details?.localizedName,
          placeType: v2?.placeType,
          hierarchy: details?.localizedAdditionalNames?.longOnlyHierarchy,
        };
      }
    }
  }

  throw new Error(`Location not found for query: "${query}"`);
}

// ---------------------------------------------------------------------------
// Hotel listing URL builder
// ---------------------------------------------------------------------------

/**
 * Build the hotel listing URL for a given geoId and optional city name.
 * Format: /Hotels-g{geoId}-{CityName}-Hotels.html
 *
 * If citySlug is not provided, we use the simple format which redirects correctly.
 */
export function buildHotelListingUrl(geoId, citySlug) {
  const base = 'https://www.tripadvisor.com';
  if (citySlug) {
    return `${base}/Hotels-g${geoId}-${citySlug}-Hotels.html`;
  }
  return `${base}/Hotels-g${geoId}-Hotels.html`;
}

// ---------------------------------------------------------------------------
// Hotel listing extraction
// ---------------------------------------------------------------------------

/**
 * Extract hotel cards from a Tripadvisor hotel listing page.
 * Uses stable patterns: URL-based IDs, SVG title ratings, text-pattern reviews.
 *
 * Returns array of hotel objects: { name, url, locationId, geoId, rating, reviewCount, price }
 */
export async function extractHotelListing(page, maxResults = 30) {
  log('[listing] Extracting hotel cards...');

  const hotels = await page.evaluate((max) => {
    const results = [];
    const seen = new Set(); // dedup by locationId

    // Find all hotel links with visible text (the name links, not review-count links)
    const links = [...document.querySelectorAll('a[href*="Hotel_Review"]')].filter(a => {
      const text = a.innerText?.trim() || '';
      // Skip review count links like "(5,449 reviews)" and empty links
      return text.length > 2 && !text.match(/^\([\d,]+ reviews\)$/i) && !text.match(/^\d+$/);
    });

    for (const a of links) {
      if (results.length >= max) break;

      const href = a.href || '';
      const urlMatch = href.match(/Hotel_Review-g(\d+)-d(\d+)-Reviews/);
      if (!urlMatch) continue;

      const geoId = urlMatch[1];
      const locationId = urlMatch[2];

      if (seen.has(locationId)) continue;
      seen.add(locationId);

      // Walk up to find the container with rating + review info + price
      // We need to go far enough to include the price element (at least 1 level up from rating)
      let container = a.parentElement;
      let containerText = '';
      let foundRatingReview = false;
      for (let i = 0; i < 15; i++) {
        if (!container) break;
        containerText = container.innerText || '';
        const hasReviews = containerText.includes('reviews');
        const hasRating = !!containerText.match(/\d\.\d/);
        const hasPrice = containerText.includes('from') && containerText.includes('$');

        if (hasReviews && hasRating) {
          foundRatingReview = true;
          // If this container also has price info, stop here
          if (hasPrice) break;
          // Otherwise walk up one more level to try to include price
        } else if (foundRatingReview) {
          // Went past the right level — use previous
          break;
        }
        container = container.parentElement;
      }

      // Extract rating from SVG title "N.N of 5 bubbles"
      let rating = null;
      if (container) {
        const svgTitles = [...container.querySelectorAll('svg title')];
        for (const title of svgTitles) {
          const m = title.textContent?.match(/^([\d.]+) of 5 bubbles/);
          if (m) {
            rating = parseFloat(m[1]);
            break;
          }
        }
      }

      // Extract review count from text pattern
      const reviewMatch = containerText.match(/\(?([\d,]+)\s*reviews?\)?/i);
      const reviewCount = reviewMatch
        ? parseInt(reviewMatch[1].replace(/,/g, ''), 10)
        : null;

      // Extract price (from text) - handle "from\n$357" pattern with \s+
      const priceMatch = containerText.match(/from\s+\$(\d+)/i);
      const price = priceMatch ? parseInt(priceMatch[1], 10) : null;

      results.push({
        name: a.innerText.trim(),
        url: href.replace(/^https:\/\/www\.tripadvisor\.com/, ''),
        locationId,
        geoId,
        rating,
        reviewCount,
        priceFrom: price,
      });
    }

    return results;
  }, maxResults);

  log(`[listing] Extracted ${hotels.length} hotels`);
  return hotels;
}

// ---------------------------------------------------------------------------
// Hotel detail extraction
// ---------------------------------------------------------------------------

/**
 * Extract full hotel detail from a Tripadvisor hotel review page.
 * Uses JSON-LD (primary) + DOM review cards (secondary).
 *
 * Returns comprehensive hotel object.
 */
export async function extractHotelDetail(page) {
  log('[detail] Extracting hotel detail...');

  // Wait for content
  await page.waitForSelector('[data-test-target="HR_CC_CARD"], script[type="application/ld+json"]', {
    timeout: 15000,
  }).catch(() => log('[detail] Warning: selector timeout, proceeding anyway'));

  const detail = await page.evaluate(() => {
    // 1. Extract JSON-LD (primary source)
    let hotelJsonLd = null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        if (data['@type'] === 'LodgingBusiness') {
          hotelJsonLd = data;
          break;
        }
      } catch {}
    }

    // 2. Extract breadcrumb for location hierarchy
    let breadcrumb = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        if (data['@type'] === 'BreadcrumbList') {
          breadcrumb = (data.itemListElement || []).map(item => item.name).filter(Boolean);
          break;
        }
      } catch {}
    }

    // 3. Extract photos from CDN
    const photos = [...new Set(
      [...document.querySelectorAll('img[src*="dynamic-media-cdn.tripadvisor.com"]')]
        .map(img => {
          // Upgrade thumbnail to larger size
          const src = img.src?.replace(/\?w=\d+.*/, '?w=900&h=600&s=1');
          return src;
        })
        .filter(src => src && !src.includes('avatar') && !src.includes('default'))
    )].slice(0, 20);

    // 4. Extract review cards
    const reviewCards = [...document.querySelectorAll('[data-test-target="HR_CC_CARD"]')];
    const reviews = reviewCards.map(card => {
      // Author + date from first line of innerText
      const text = card.innerText?.trim() || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // Line format: "{author} wrote a review {month} {year}"
      const metaLine = lines[0] || '';
      const authorMatch = metaLine.match(/^(.+?)\s+wrote a review\s+(.+)$/i);
      const author = authorMatch?.[1]?.trim() || null;
      const reviewDate = authorMatch?.[2]?.trim() || null;

      // Rating from SVG title
      let rating = null;
      for (const title of card.querySelectorAll('svg title')) {
        const m = title.textContent?.match(/^([\d.]+) of 5 bubbles?/i);
        if (m) {
          rating = parseFloat(m[1]);
          break;
        }
      }

      // Title is usually lines[2] (after metadata/contributions line)
      // Lines structure: [authorLine, contributionsLine, title, ...text]
      const hasContribs = lines[1]?.includes('contribution');
      let titleIdx = hasContribs ? 2 : 1;
      // Skip "See all N photos" link if it appears before the actual title
      if (lines[titleIdx]?.match(/^See all \d+ photos?$/i)) {
        titleIdx++;
      }
      const title = lines[titleIdx] || null;

      // Review text: everything after title, but stop at common trailing junk
      // Remove trailing lines: "Value", "Rooms", "Location", "Date of stay:", "Trip type:",
      // "Insider tip:", "Read more", "Response from", disclaimer text
      const trailingPatterns = [
        /^(Value|Rooms|Location|Cleanliness|Service|Sleep Quality|Food|Atmosphere)$/i,
        /^Date of stay:/i,
        /^Trip type:/i,
        /^Insider tip:/i,
        /^Read more$/i,
        /^Response from /i,
        /^This review is the subjective opinion/i,
        /^This response is the subjective opinion/i,
        /^Review collected in partnership/i,
        /^\d+$/, // standalone numbers (helpful vote counts)
      ];

      const rawTextLines = lines.slice(titleIdx + 1);
      const cleanTextLines = [];
      for (const line of rawTextLines) {
        if (trailingPatterns.some(p => p.test(line))) break;
        cleanTextLines.push(line);
      }
      const reviewText = cleanTextLines.join('\n').trim() || null;

      // Reviewer profile URL
      const profileLink = card.querySelector('a[href*="/Profile/"]');
      const profileUrl = profileLink?.href || null;

      return {
        author,
        profileUrl,
        rating,
        title,
        text: reviewText?.substring(0, 2000) || null,
        date: reviewDate,
      };
    });

    // 5. Build result object
    const jsonLd = hotelJsonLd || {};
    const address = jsonLd.address || {};
    const agg = jsonLd.aggregateRating || {};
    const geo = jsonLd.geo || {};
    const amenities = (jsonLd.amenityFeatures || []).filter(f => f.value).map(f => f.name);

    // Extract geoId and locationId from current URL
    const urlMatch = window.location.href.match(/Hotel_Review-g(\d+)-d(\d+)-Reviews/);

    return {
      name: jsonLd.name || document.querySelector('h1')?.innerText?.trim() || null,
      url: jsonLd.url || window.location.href,
      geoId: urlMatch?.[1] || null,
      locationId: urlMatch?.[2] || null,
      priceRange: jsonLd.priceRange || null,
      rating: agg.ratingValue ? parseFloat(agg.ratingValue) : null,
      reviewCount: agg.reviewCount ? parseInt(agg.reviewCount, 10) : null,
      address: {
        street: address.streetAddress || null,
        city: address.addressLocality || null,
        region: address.addressRegion || null,
        postalCode: address.postalCode || null,
        country: address.addressCountry?.name || null,
      },
      coordinates: geo.latitude ? { lat: geo.latitude, lng: geo.longitude } : null,
      amenities,
      photos,
      reviews,
      breadcrumb,
      imageUrl: jsonLd.image || null,
    };
  });

  log(`[detail] Extracted: ${detail.name}, ${detail.rating}★, ${detail.reviewCount} reviews, ${detail.reviews.length} review cards, ${detail.photos.length} photos`);
  return detail;
}

// ---------------------------------------------------------------------------
// Restaurant listing extraction
// ---------------------------------------------------------------------------

/**
 * Extract restaurant cards from a Tripadvisor restaurant listing page.
 * URL format: /Restaurants-g{geoId}-{City}-Restaurants.html
 *
 * Returns array: { name, url, locationId, geoId, rating, reviewCount, cuisine, priceLevel }
 */
export async function extractRestaurantListing(page, maxResults = 30) {
  log('[listing] Extracting restaurant cards...');

  const restaurants = await page.evaluate((max) => {
    const results = [];
    const seen = new Set();

    // Restaurant links follow pattern: /Restaurant_Review-g{geoId}-d{locationId}-Reviews-...
    const links = [...document.querySelectorAll('a[href*="Restaurant_Review"]')].filter(a => {
      const text = a.innerText?.trim() || '';
      return text.length > 2 && !text.match(/^\([\d,]+ reviews\)$/i);
    });

    for (const a of links) {
      if (results.length >= max) break;

      const href = a.href || '';
      const urlMatch = href.match(/Restaurant_Review-g(\d+)-d(\d+)-Reviews/);
      if (!urlMatch) continue;

      const geoId = urlMatch[1];
      const locationId = urlMatch[2];

      if (seen.has(locationId)) continue;
      seen.add(locationId);

      // Walk up to find container with rating + review info
      let container = a.parentElement;
      let containerText = '';
      for (let i = 0; i < 15; i++) {
        if (!container) break;
        containerText = container.innerText || '';
        if (containerText.includes('review') && containerText.match(/\d\.\d/)) break;
        container = container.parentElement;
      }

      // Rating from SVG title
      let rating = null;
      if (container) {
        for (const title of container.querySelectorAll('svg title')) {
          const m = title.textContent?.match(/^([\d.]+) of 5 bubbles?/i);
          if (m) { rating = parseFloat(m[1]); break; }
        }
      }

      // Review count
      const reviewMatch = containerText.match(/\(?([\d,]+)\s*reviews?\)?/i);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null;

      // Cuisine/category (text before reviews count)
      const cuisineMatch = containerText.match(/(?:CUISINES?|$\s*)([A-Z][^$\n]+?)(?:\n|$)/m);

      results.push({
        name: a.innerText.trim(),
        url: href.replace(/^https:\/\/www\.tripadvisor\.com/, ''),
        locationId,
        geoId,
        rating,
        reviewCount,
      });
    }

    return results;
  }, maxResults);

  log(`[listing] Extracted ${restaurants.length} restaurants`);
  return restaurants;
}
