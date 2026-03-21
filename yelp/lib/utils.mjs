/**
 * Shared utilities for Yelp scrapers.
 *
 * Anti-bot Strategy (Updated 2026-03-21):
 *   Yelp is protected by DataDome bot detection. Key insights:
 *
 *   1. Residential proxy required — server IPs are blocked at the network level.
 *      Set SOCKS5_PROXY env var (default: 127.0.0.1:11091)
 *
 *   2. camoufox (fingerprinted Firefox) is required for DataDome JS challenge.
 *      DataDome serves an iframe challenge at captcha-delivery.com which the
 *      browser must execute. Plain curl/fetch fails; camoufox passes.
 *
 *   3. DataDome challenges:
 *      - Homepage: JS-only challenge (auto-solved via api-js.datadome.co/js/)
 *      - /search page: Harder captcha (geo.captcha-delivery.com) — BLOCKED
 *      - /biz/* pages: JS-only challenge after homepage warmup — WORKS
 *
 *   4. Homepage MUST be loaded first to establish a valid DataDome session.
 *      After homepage, biz pages work. /search remains blocked by DataDome.
 *
 *   5. SEARCH STRATEGY (avoids /search page entirely):
 *      Instead of navigating to /search which is blocked, we:
 *      a. Load homepage (establishes DataDome session)
 *      b. Type query into the search box character by character
 *      c. Each keystroke triggers GQL 'searchSuggestFrontend' calls
 *      d. These calls return business slugs (type:"business") with /biz/ URLs
 *      e. Collect unique business slugs from typeahead suggestions
 *      f. For each slug, optionally load /biz/ page for detailed GQL data
 *      This approach returns the most relevant businesses for a query+location.
 *
 *   6. For business pages, Yelp's GQL batch API returns rich structured data.
 *      Intercept POST to /gql/batch — contains business, reviews, hours, photos.
 *
 *   Selectors used (all stable, never obfuscated CSS classes):
 *   - input#search_description         — search query input (homepage)
 *   - input[name="find_loc"]           — location input (homepage, hidden)
 *   - [aria-label*="star"]             — star ratings
 *   - script[type="application/ld+json"] — structured data
 *   - address                          — business address (DOM fallback)
 *   - a[href^="tel:"]                  — phone link (DOM fallback)
 *   - table tr                         — hours table (DOM fallback)
 *
 *   Known limitations:
 *   - Search returns typeahead results (~5-10 businesses), not paginated search
 *   - Website URL extraction is unreliable from DOM (Yelp masks it); GQL has it
 *   - Reviews limited to first page (10) from GQL
 *   - DataDome may block if same IP sends too many requests in a short window
 *     (recommend 30s+ cooldown between search attempts)
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
 * Create a camoufox browser for Yelp scraping with residential proxy.
 */
export async function createYelpBrowser(Camoufox) {
  const socks5 = process.env.SOCKS5_PROXY || '127.0.0.1:11091';
  const [host, port] = socks5.split(':');

  log(`Using SOCKS5 proxy: ${socks5}`);

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
 * Create a browser context for Yelp.
 */
export async function createYelpContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

// ---------------------------------------------------------------------------
// DataDome bypass - Homepage warmup
// ---------------------------------------------------------------------------

/**
 * Load Yelp homepage and wait for DataDome to validate the session.
 *
 * DataDome flow for homepage:
 *   1. First request → 403 with interstitial challenge iframe (or 200 directly)
 *   2. Browser executes challenge JS (auto-solved by camoufox)
 *   3. POST to api-js.datadome.co/js/ → returns cookie
 *   4. Session established — can now access /biz/* pages
 *
 * @returns {Page} initialized page with valid DataDome session
 */
export async function initYelpSession(context) {
  const page = await context.newPage();

  // Wait for DataDome JS challenge validation
  let datadomeValidated = false;
  const ddValidatedPromise = new Promise((resolve) => {
    context.on('response', (response) => {
      const url = response.url();
      if (url.includes('api-js.datadome.co/js/') && !datadomeValidated) {
        response.text().then((body) => {
          if (body.includes('"status":200') && body.includes('datadome=')) {
            datadomeValidated = true;
            log('DataDome JS challenge passed!');
            resolve();
          }
        }).catch(() => {});
      }
    });
  });

  log('Loading Yelp homepage...');
  await page.goto('https://www.yelp.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  }).catch((e) => log('Nav warning:', e.message.substring(0, 60)));

  // Wait for DataDome validation (or timeout after 25s)
  await Promise.race([ddValidatedPromise, delay(25000)]);

  const title = await page.title();
  log('Homepage:', title.substring(0, 80));

  // "yelp.com" title means DataDome challenge page still showing
  if (title === 'yelp.com' || (title.length < 25 && title.toLowerCase().includes('yelp.com'))) {
    // Wait longer — sometimes the challenge takes more time
    await delay(15000);
    const retryTitle = await page.title();
    log('Homepage retry:', retryTitle.substring(0, 80));
    if (retryTitle === 'yelp.com' || retryTitle.length < 30) {
      throw new Error('Yelp homepage blocked by DataDome — residential proxy may be flagged');
    }
  }

  // Additional wait for page hydration
  await delay(3000);

  return page;
}

// ---------------------------------------------------------------------------
// Search via typeahead (avoids blocked /search page)
// ---------------------------------------------------------------------------

/**
 * Search for businesses on Yelp using the homepage search typeahead.
 *
 * Strategy (avoids DataDome-blocked /search page):
 *   1. Start from homepage (already initialized by initYelpSession)
 *   2. Type location in find_loc input (hidden field via JS)
 *   3. Type query character by character in #search_description
 *   4. Each keystroke triggers GQL searchSuggestFrontend calls
 *   5. Collect type:"business" entries from suggestions (have /biz/ slugs)
 *   6. Return array of { slug, name, address } objects
 *
 * Notes:
 *   - Returns typically 3-10 most-relevant businesses for the query+location
 *   - The longer the query matches, the more business-type suggestions appear
 *   - Add location context to improve relevance (e.g. "coffee San Francisco")
 *   - For broader search, use partial query words to cast wider net
 *
 * @param {Page} page - page initialized with initYelpSession
 * @param {string} query - search term (e.g. "coffee", "pizza", "dentist")
 * @param {string} location - location string (e.g. "San Francisco, CA")
 * @returns {Array<{slug, name, address}>} found businesses
 */
export async function searchViaSuggest(page, query, location) {
  log(`Searching via typeahead: "${query}" in "${location}"`);

  const businessSlugs = new Map(); // slug → { name, address }

  // Set up GQL response listener BEFORE we start typing
  const gqlHandler = async (response) => {
    if (response.url() !== 'https://www.yelp.com/gql/batch') return;
    try {
      const body = await response.text();
      if (!body.includes('searchSuggestFrontend')) return;
      const parsed = JSON.parse(body);
      for (const item of parsed) {
        const suggestions =
          item?.data?.searchSuggestFrontend?.prefetchSuggestions?.suggestions || [];
        for (const sug of suggestions) {
          if (sug.type === 'business' && sug.redirectUrl?.startsWith('/biz/')) {
            const slug = sug.redirectUrl.replace('/biz/', '').split('?')[0];
            if (!businessSlugs.has(slug)) {
              businessSlugs.set(slug, {
                name: sug.title || slug,
                address: sug.subtitle || null,
              });
              log(`  Typeahead found: ${slug}`);
            }
          }
        }
      }
    } catch {
      // Ignore parse errors from non-JSON responses
    }
  };

  page.on('response', gqlHandler);

  try {
    // Set location value in hidden field via JS (invisible to DataDome)
    await page.evaluate((loc) => {
      const locEl = document.querySelector('input[name="find_loc"]');
      if (locEl) {
        // Set value and trigger change events
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(locEl, loc);
        } else {
          locEl.value = loc;
        }
        locEl.dispatchEvent(new Event('input', { bubbles: true }));
        locEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, location);

    // Find and interact with the search description input
    const descInput = await page.$('#search_description');
    if (!descInput) {
      throw new Error('Homepage search input (#search_description) not found');
    }

    await descInput.click();
    await delay(500);

    // Clear any existing value
    await descInput.selectAll?.().catch(() => {});
    await page.keyboard.press('Control+a');
    await delay(200);

    // Type the query: include location in query for better matching
    // e.g. "coffee San Francisco" gives better business suggestions than just "coffee"
    const fullQuery = query.includes(location.split(',')[0])
      ? query
      : `${query} ${location.split(',')[0]}`;

    log(`Typing: "${fullQuery}"`);
    for (const ch of fullQuery) {
      await descInput.type(ch, { delay: 120 });
      await delay(600); // Wait for each keystroke to trigger suggest
    }

    // Final wait for all suggestions to arrive
    await delay(3000);

  } finally {
    page.off('response', gqlHandler);
  }

  const results = Array.from(businessSlugs.entries()).map(([slug, info]) => ({
    slug,
    name: info.name,
    address: info.address,
  }));

  log(`Typeahead search found ${results.length} businesses`);
  return results;
}

// ---------------------------------------------------------------------------
// Search - Full detailed results
// ---------------------------------------------------------------------------

/**
 * Search and return detailed business information.
 *
 * Combines searchViaSuggest (to get slugs) with extractBusinessDetail
 * (to get full GQL data for each business).
 *
 * Note: For efficiency, data from the biz page GQL is used.
 * For a quick search without visiting each biz page, use searchViaSuggest directly.
 *
 * @param {Page} page - initialized page
 * @param {string} query - search term
 * @param {string} location - location string
 * @param {Object} options - { maxResults, includeDetail }
 * @returns {Array} array of business objects
 */
export async function performSearch(page, query, location, options = {}) {
  const { maxResults = 10 } = options;

  const slugResults = await searchViaSuggest(page, query, location);
  if (slugResults.length === 0) {
    throw new Error(`No businesses found via typeahead for "${query}" in "${location}"`);
  }

  // Return lightweight results from typeahead (no extra biz page loads)
  return slugResults.slice(0, maxResults).map((r, i) => ({
    rank: i + 1,
    name: r.name,
    slug: r.slug,
    url: `https://www.yelp.com/biz/${r.slug}`,
    address: r.address,
    // These fields require visiting each biz page - not populated in search
    rating: null,
    reviewCount: null,
    priceRange: null,
    categories: [],
    isSponsored: false,
    thumbnailUrl: null,
  }));
}

// ---------------------------------------------------------------------------
// Search result extraction (kept for reference / future use when /search loads)
// ---------------------------------------------------------------------------

/**
 * Extract business listings from a Yelp search results page.
 * NOTE: /search is currently blocked by DataDome for most IPs.
 * This function is kept as fallback if /search becomes accessible.
 *
 * Uses DOM traversal: walks from business links (a[href*="/biz/"]) up
 * to their parent <li> containers, then extracts text content.
 */
export async function extractSearchResults(page) {
  return page.evaluate(() => {
    const results = [];
    const seenSlugs = new Set();
    const bizLinks = Array.from(document.querySelectorAll('a[href*="/biz/"]'));

    for (const link of bizLinks) {
      const href = link.getAttribute('href') || '';
      const slug = href.split('/biz/')[1]?.split('?')[0];

      if (!slug || seenSlugs.has(slug)) continue;
      // Skip encoded/base64-like slugs (Yelp uses these for ad tracking)
      if (slug.length > 50 && !slug.includes('-')) continue;
      seenSlugs.add(slug);

      // Walk up to the <li> container
      let container = link;
      let depth = 0;
      while (container && depth < 15 && container.tagName !== 'LI') {
        container = container.parentElement;
        depth++;
      }
      if (!container || container.tagName !== 'LI') continue;

      const fullText = (container.textContent || '').replace(/\s+/g, ' ').trim();

      // Parse rank and name: "1. Q Specialty Coffee 4.2 (212 reviews)"
      const rankNameMatch = fullText.match(/^(\d+)\.\s+(.+?)\s+\d+\.\d/);

      // Rating from aria-label
      const ratingEl = container.querySelector('[aria-label*="star"]');
      const ratingText = ratingEl?.getAttribute('aria-label') || '';
      const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Review count: "(2.2k reviews)" or "(212 reviews)"
      const reviewMatch = fullText.match(/\((\d+[\.,]?\d*[km]?)\s*reviews?\)/i);
      let reviewCount = null;
      if (reviewMatch) {
        const raw = reviewMatch[1].replace(',', '').toLowerCase();
        if (raw.endsWith('k')) reviewCount = Math.round(parseFloat(raw) * 1000);
        else if (raw.endsWith('m')) reviewCount = Math.round(parseFloat(raw) * 1000000);
        else reviewCount = parseInt(raw, 10);
      }

      // Price range ($$, $$$, etc.)
      const priceMatch = fullText.match(/\s(\${1,4})(?:\s|$)/);
      const priceRange = priceMatch ? priceMatch[1] : null;

      // Category links
      const categories = Array.from(container.querySelectorAll('a[href^="/c/"]'))
        .map((a) => a.textContent.trim())
        .filter((c) => c && c.length < 40);

      // Review snippet (quoted text)
      const snippetMatch = fullText.match(/"([^"]{20,200})"/);

      // Sponsored check
      const isSponsored = fullText.includes('Sponsored') || fullText.includes('Ad ');

      // Thumbnail
      const imgEl = container.querySelector('img');
      const thumbnailUrl = imgEl?.src || null;

      // Business name
      const name = rankNameMatch
        ? rankNameMatch[2].trim()
        : (link.textContent || '').trim().substring(0, 80);

      if (!name || name.length < 2) continue;

      results.push({
        rank: rankNameMatch ? parseInt(rankNameMatch[1], 10) : results.length + 1,
        name,
        slug,
        url: `https://www.yelp.com/biz/${slug}`,
        rating,
        reviewCount,
        priceRange,
        categories: [...new Set(categories)].slice(0, 5),
        snippet: snippetMatch ? snippetMatch[1].substring(0, 200) : null,
        isSponsored,
        thumbnailUrl,
      });

      if (results.length >= 20) break;
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Business detail - GQL interception
// ---------------------------------------------------------------------------

/**
 * Extract business detail from a Yelp business page.
 *
 * Primary source: Yelp's internal GQL batch API (/gql/batch)
 * - Intercepted as the page loads (GetLocalBusinessJsonLinkedData, GetBusinessHours,
 *   GetBusinessReviewFeed operations)
 * - Contains: name, alias, rating, reviewCount, categories, address,
 *   phone, priceRange, hours, reviews (with text), photos
 *
 * Fallback: JSON-LD structured data and DOM extraction
 *
 * Note on website URL: Yelp obfuscates external URLs through their redirect service.
 * The GQL businessUrl field, if present, contains the real URL. DOM extraction
 * is unreliable (often picks up partner/ad links). We try GQL first.
 *
 * Returns full business detail object.
 */
export async function extractBusinessDetail(page, slug) {
  const url = `https://www.yelp.com/biz/${slug}`;
  log(`Loading: ${url}`);

  // Set up GQL interception BEFORE navigation
  const gqlBodies = [];
  const gqlHandler = async (response) => {
    if (response.url() === 'https://www.yelp.com/gql/batch') {
      try {
        const body = await response.text();
        if (body.length > 500) gqlBodies.push(body);
      } catch {}
    }
  };
  page.on('response', gqlHandler);

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    }).catch((e) => log('Nav warning:', e.message.substring(0, 60)));

    await delay(6000);

    const title = await page.title();
    if (title === 'yelp.com' || (title.length < 25 && title.toLowerCase().includes('yelp.com'))) {
      throw new Error(`Business page blocked: ${url}`);
    }

    log('Business page:', title.substring(0, 80));

    // Parse GQL responses to get structured business data
    // Yelp splits data across multiple GQL batch calls; merge them
    let gqlBizData = null;
    let gqlReviewData = null;
    let gqlHoursData = null;
    let gqlPhotosData = null;

    for (const body of gqlBodies) {
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) continue;

        for (const item of parsed) {
          const biz = item?.data?.business;
          if (!biz) continue;

          // Main business info (GetLocalBusinessJsonLinkedData):
          // has name, rating, reviewCount, categories, location, phoneNumber, priceRange
          if (biz.name && biz.rating !== undefined) {
            gqlBizData = gqlBizData ? { ...biz, ...gqlBizData } : biz;
          }

          // Hours (GetBusinessHours): has operationHours
          if (biz.operationHours !== undefined) {
            gqlHoursData = biz.operationHours;
          }

          // Reviews (GetBusinessReviewFeed): has reviews with text
          const reviewEdges = biz.reviews?.edges || [];
          if (reviewEdges.some((e) => e.node?.text?.full)) {
            gqlReviewData = biz.reviews;
          }

          // Photos (GetMediaItems or media field): has orderedMediaItems
          if (biz.media?.orderedMediaItems) {
            gqlPhotosData = biz.media;
          }
        }
      } catch {}
    }

    // Merge data into gqlBizData
    if (gqlBizData) {
      if (gqlReviewData && !gqlBizData.reviews?.edges?.some((e) => e.node?.text?.full)) {
        gqlBizData.reviews = gqlReviewData;
      }
      if (gqlHoursData && !gqlBizData.operationHours) {
        gqlBizData.operationHours = gqlHoursData;
      }
      if (gqlPhotosData && !gqlBizData.media) {
        gqlBizData.media = gqlPhotosData;
      }
    }

    // Also try JSON-LD as fallback
    const jsonLdData = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => {
          try { return JSON.parse(s.textContent || ''); } catch { return null; }
        })
        .filter(Boolean);
    });

    // DOM extraction as final fallback
    const domData = await page.evaluate(() => {
      const name = document.querySelector('h1')?.textContent?.trim();

      // Rating from aria-label
      const ratingEl = document.querySelector('[aria-label*="star"]');
      const ratingText = ratingEl?.getAttribute('aria-label') || '';
      const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);

      // Review count (from link to reviews section)
      const reviewLink = Array.from(document.querySelectorAll('a')).find(
        (a) => a.href?.includes('#reviews') && /\d/.test(a.textContent)
      );
      const reviewText = reviewLink?.textContent?.trim() || '';
      const reviewCountMatch = reviewText.match(/(\d+(?:[,.]?\d+)?[km]?)/i);
      let reviewCount = null;
      if (reviewCountMatch) {
        const raw = reviewCountMatch[1].replace(',', '').toLowerCase();
        if (raw.endsWith('k')) reviewCount = Math.round(parseFloat(raw) * 1000);
        else reviewCount = parseInt(raw, 10);
      }

      // Address
      const address = document.querySelector('address')?.textContent?.replace(/\s+/g, ' ').trim();

      // Phone
      const phoneLink = document.querySelector('a[href^="tel:"]');
      const phone = phoneLink?.href?.replace('tel:', '') || null;

      // Website: Yelp uses a redirect service for business websites.
      // Best approach: find links that go through yelp's biz_website redirect.
      // These look like: https://www.yelp.com/biz_redir?url=...&src_bizid=...
      // Or look for the "Business website" P/span text
      let website = null;
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      
      // Try Yelp's biz_redir links (most reliable)
      const bizRedirLink = allLinks.find(a => a.href.includes('yelp.com/biz_redir'));
      if (bizRedirLink) {
        try {
          const u = new URL(bizRedirLink.href);
          const realUrl = u.searchParams.get('url') || u.searchParams.get('website');
          if (realUrl) website = realUrl;
        } catch {}
      }

      // Hours table
      const hours = Array.from(document.querySelectorAll('table tr'))
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll('th, td')).map(
            (c) => c.textContent?.replace(/\s+/g, ' ').trim()
          );
          return cells.length >= 2 && cells[0] ? { day: cells[0], hours: cells[1] || 'Closed' } : null;
        })
        .filter(Boolean);

      // Photos from bphoto CDN URLs
      const photos = Array.from(document.querySelectorAll('img'))
        .map((i) => i.src)
        .filter((src) => src.includes('bphoto'))
        .slice(0, 10);

      // Categories
      const categories = [...new Set(
        Array.from(document.querySelectorAll('a[href^="/c/"]'))
          .map((a) => a.textContent.trim())
          .filter((c) => c && c.length < 40)
      )].slice(0, 8);

      return {
        name,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        reviewCount,
        address,
        phone,
        website,
        hours,
        photos,
        categories,
      };
    });

    // Build result from GQL data (most complete), falling back to DOM
    if (gqlBizData) {
      log('Using GQL data for business detail');

      const loc = gqlBizData.location;
      const addr = loc?.address || {};
      const hours = (gqlBizData.operationHours?.regularHoursMergedWithSpecialHoursForCurrentWeek || [])
        .map((day) => ({
          day: day.dayOfWeek || day.dayOfWeekShort,
          hours: Array.isArray(day.regularHours) ? day.regularHours.join(', ') : 'Closed',
        }));

      const cats = (gqlBizData.categories || []).map((c) => ({
        title: c.title,
        alias: c.alias,
      }));

      const reviews = (gqlBizData.reviews?.edges || [])
        .map((e) => e.node)
        .filter((n) => n?.text?.full)
        .map((n) => {
          let date = null;
          if (n.createdAt) {
            date = typeof n.createdAt === 'string'
              ? n.createdAt
              : (n.createdAt.localDateTimeForBusiness || null);
          }
          return {
            rating: n.rating ?? null,
            text: n.text.full,
            author: n.author?.displayName || null,
            authorLocation: n.author?.displayLocation || null,
            date,
            language: n.text.language || 'en',
          };
        });

      // Photos from media (most reliable source)
      const photoUrls = (gqlBizData.media?.orderedMediaItems?.edges || [])
        .map((e) => {
          const photoUrl = e.node?.photoUrl?.url || e.node?.viewerPhotoUrl?.url;
          return photoUrl || null;
        })
        .filter(Boolean);

      // Website: Try GQL businessUrl field first
      let website = gqlBizData.businessUrl?.url || null;
      if (!website) {
        // Fall back to DOM extraction (biz_redir links)
        website = domData.website || null;
      }

      return {
        name: gqlBizData.name,
        slug,
        alias: gqlBizData.alias,
        url,
        rating: gqlBizData.rating ?? null,
        reviewCount: gqlBizData.reviewCount ?? null,
        priceRange: gqlBizData.priceRange?.display || null,
        categories: cats,
        address: {
          street: addr.addressLine1 || null,
          street2: addr.addressLine2 || null,
          city: addr.city || null,
          state: addr.regionCode || null,
          zip: addr.postalCode || null,
          country: loc?.country?.code || null,
        },
        phone: gqlBizData.phoneNumber?.formatted || domData.phone || null,
        website,
        hours,
        isOpenNow: gqlBizData.isOpenNow ?? null,
        amenities: [],
        photos: photoUrls.length > 0 ? photoUrls : domData.photos,
        reviews,
        yelpUrl: url,
      };
    }

    // Fallback to DOM / JSON-LD
    log('GQL not available, using DOM/JSON-LD fallback');
    const bizLd = jsonLdData.find((d) =>
      d?.['@type'] === 'LocalBusiness'
      || d?.['@type'] === 'Restaurant'
      || (Array.isArray(d?.['@type']) && d['@type'].some((t) => t.includes('Business')))
    );

    const addr = bizLd?.address || {};
    return {
      name: domData.name || bizLd?.name || null,
      slug,
      alias: slug,
      url,
      rating: domData.rating ?? (bizLd?.aggregateRating?.ratingValue
        ? parseFloat(bizLd.aggregateRating.ratingValue) : null),
      reviewCount: domData.reviewCount ?? (bizLd?.aggregateRating?.reviewCount
        ? parseInt(bizLd.aggregateRating.reviewCount, 10) : null),
      priceRange: null,
      categories: domData.categories.map((c) => ({ title: c, alias: null })),
      address: {
        street: addr.streetAddress || null,
        city: addr.addressLocality || null,
        state: addr.addressRegion || null,
        zip: addr.postalCode || null,
        country: addr.addressCountry || null,
        raw: domData.address || null,
      },
      phone: domData.phone || bizLd?.telephone || null,
      website: domData.website || bizLd?.url || null,
      hours: domData.hours,
      isOpenNow: null,
      amenities: [],
      photos: domData.photos,
      reviews: [],
      yelpUrl: url,
    };
  } finally {
    page.off('response', gqlHandler);
  }
}
