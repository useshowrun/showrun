/**
 * Shared utilities for Booking.com scrapers.
 *
 * Strategy overview:
 *   Booking.com renders search results server-side (SSR HTML).
 *   Hotel detail pages are also SSR. The key challenges:
 *   1. AWS WAF bot protection — camoufox (fingerprinted Firefox) bypasses this automatically
 *   2. dest_id lookup — Booking.com requires a numeric destination ID for searches
 *      We resolve this via their autocomplete GraphQL API from within the browser
 *   3. Cookie session — must visit homepage first to set cookies/session
 *
 *   Stable selectors used:
 *   - data-testid attributes (Booking.com uses these consistently)
 *   - JSON-LD structured data (Schema.org Hotel type)
 *   - aria-label attributes for star ratings
 *   - Standard semantic HTML (h1, img[src*="bstatic.com"])
 *
 *   Never use obfuscated CSS class names (they change on every deploy).
 */

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

export function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

export function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser configured for Booking.com scraping.
 * Uses en-US locale for consistent English results.
 */
export async function createBookingBrowser(Camoufox) {
  return Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 900 },
  });
}

/**
 * Create a browser context configured for Booking.com.
 * Optionally loads cookies from BOOKING_COOKIES env var.
 */
export async function createBookingContext(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Load Booking.com cookies if provided
  const cookiesJson = process.env.BOOKING_COOKIES;
  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(cookies);
      log("[auth] Loaded Booking.com cookies from BOOKING_COOKIES env var");
    } catch (e) {
      log("[auth] Warning: BOOKING_COOKIES is invalid JSON:", e.message);
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// Session init (homepage navigation for cookies/WAF)
// ---------------------------------------------------------------------------

/**
 * Navigate to Booking.com homepage to set session cookies.
 * This is required before any search or hotel page requests.
 */
export async function initBookingSession(page) {
  log("[session] Navigating to Booking.com homepage for session init...");
  await page.goto("https://www.booking.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await delay(2000);
  log("[session] Session initialized");
}

// ---------------------------------------------------------------------------
// Destination ID lookup
// ---------------------------------------------------------------------------

/**
 * Look up the Booking.com dest_id for a given location string.
 * Uses the autoCompleteSuggestions GraphQL API from within the browser context.
 *
 * Returns: { destId, destType, label } or null if not found.
 *
 * Example results:
 *   "Istanbul" → { destId: "-755070", destType: "CITY", label: "Istanbul, Marmara Region, Turkey" }
 *   "New York"  → { destId: "...", destType: "CITY", ... }
 */
export async function lookupDestination(page, query) {
  log(`[autocomplete] Looking up destination: "${query}"`);

  // Trigger autocomplete by typing in the search box, which causes the GQL call
  // Strategy: type in search box and intercept the autoCompleteSuggestions GQL response

  // Set up response interceptor BEFORE navigating to the form
  const resultPromise = new Promise((resolve) => {
    const handler = async (resp) => {
      const url = resp.url();
      if (!url.includes("/dml/graphql")) return;
      try {
        const body = await resp.text();
        const data = JSON.parse(body);
        const suggestions = data?.data?.autoCompleteSuggestions?.results;
        if (!suggestions || suggestions.length === 0) return;

        // Find best match: prefer CITY destType, then REGION
        const cityMatch = suggestions.find(
          (s) => s.destination?.destType === "CITY"
        );
        const regionMatch = suggestions.find(
          (s) => s.destination?.destType === "REGION"
        );
        const best = cityMatch || regionMatch || suggestions[0];

        if (best?.destination?.destId) {
          page.off("response", handler);
          resolve({
            destId: best.destination.destId,
            destType: best.destination.destType,
            label: best.displayInfo?.label || query,
            latitude: best.destination.latitude,
            longitude: best.destination.longitude,
          });
        }
      } catch (_) {}
    };
    page.on("response", handler);

    // Timeout after 15s
    setTimeout(() => {
      page.off("response", handler);
      resolve(null);
    }, 15000);
  });

  // Trigger autocomplete by typing in the search box
  try {
    const input = await page.locator('input[name="ss"]').first();
    await input.click({ force: true, timeout: 10000 });
    await delay(500);
    await input.fill(query);
    log(`[autocomplete] Typed "${query}" in search box`);
  } catch (e) {
    log(`[autocomplete] Could not interact with search box: ${e.message}`);
    return null;
  }

  const result = await resultPromise;

  if (result) {
    log(
      `[autocomplete] Found: destId=${result.destId}, type=${result.destType}, label=${result.label}`
    );
  } else {
    log(`[autocomplete] No destination found for: "${query}"`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Search URL builder
// ---------------------------------------------------------------------------

/**
 * Build a Booking.com search URL with the given parameters.
 */
export function buildSearchUrl({
  location,
  destId,
  destType = "city",
  checkin,
  checkout,
  adults = 2,
  rooms = 1,
  children = 0,
  offset = 0,
  sortBy = "popularity", // popularity, class_ascending, class_descending, price, review_score_and_price
}) {
  const params = new URLSearchParams({
    ss: location,
    lang: "en-gb",
    sb: "1",
    src_elem: "sb",
    src: "index",
    dest_type: destType,
    dest_id: destId,
    efdco: "1",
    from_sf: "1",
    group_adults: String(adults),
    no_rooms: String(rooms),
    group_children: String(children),
    order: sortBy,
  });

  if (checkin) params.set("checkin", checkin);
  if (checkout) params.set("checkout", checkout);
  if (offset > 0) params.set("offset", String(offset));

  return `https://www.booking.com/searchresults.en-gb.html?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Search results extraction
// ---------------------------------------------------------------------------

/**
 * Extract hotel search result cards from the current page.
 * Works on Booking.com search results pages (SSR HTML).
 */
export async function extractSearchResults(page) {
  return page.evaluate(() => {
    function normalizeText(s) {
      return s?.replace(/\s+/g, " ").trim() || null;
    }

    function parsePrice(text) {
      if (!text) return { amount: null, currency: null };
      // Match currency symbol/code and number
      const match = text.match(/([€$£¥₺]|EUR|USD|GBP|TRY|CAD|AUD)\s*([\d,\.]+)/);
      if (!match) return { amount: null, currency: null };
      const currency = match[1];
      const amount = parseFloat(match[2].replace(/,/g, ""));
      return { amount: isNaN(amount) ? null : amount, currency };
    }

    function parseReviewScoreFromEl(el) {
      // The review-score element has a specific structure:
      //   div (aria-hidden=null)  → "Scored X.X"   (screen-reader text with score)
      //   div (aria-hidden=true)  → "X.X"           (visual score number)
      //   div (aria-hidden=false) → "Label N reviews" (label + count)
      //     → child span/div    → "Label"
      //     → child span/div    → "N reviews"
      if (!el) return { score: null, label: null, count: null };

      // Try structured approach first (use aria-hidden=true for score)
      const visualScoreEl = el.querySelector('[aria-hidden="true"]');
      const verboseEl = el.querySelector('[aria-hidden="false"]');

      let score = null;
      let label = null;
      let count = null;

      if (visualScoreEl) {
        const scoreText = visualScoreEl.textContent?.trim();
        const scoreNum = parseFloat(scoreText);
        if (!isNaN(scoreNum)) score = scoreNum;
      }

      if (verboseEl) {
        // Get all child text nodes / elements
        const children = Array.from(verboseEl.children);
        if (children.length >= 2) {
          label = children[0]?.textContent?.trim() || null;
          const countText = children[children.length - 1]?.textContent?.trim() || "";
          const countMatch = countText.match(/([\d,]+)/);
          count = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null;
        } else {
          // Fallback: parse the full text
          const fullText = verboseEl.textContent?.trim() || "";
          const labelMatch = fullText.match(/^([A-Za-z\s]+?)\s+([\d,]+)\s*review/);
          if (labelMatch) {
            label = labelMatch[1].trim();
            count = parseInt(labelMatch[2].replace(/,/g, ""), 10);
          }
        }
      }

      // Fallback: parse from screen-reader text "Scored X.X"
      if (!score) {
        const srText = el.textContent?.trim() || "";
        const scoreMatch = srText.match(/Scored\s+(\d+\.?\d*)/);
        if (scoreMatch) score = parseFloat(scoreMatch[1]);
      }

      return { score, label, count };
    }

    function parseStars(card) {
      // Try rating-stars with aria-label: "4 out of 5 stars"
      const starsEl = card.querySelector('[data-testid="rating-stars"]');
      if (starsEl) {
        const aria = starsEl.getAttribute("aria-label") || "";
        const m = aria.match(/(\d+)\s*out\s*of\s*5/i);
        if (m) return parseInt(m[1], 10);
      }
      // Try rating-squares with aria-label: "3 out of 5"
      const squaresEl = card.querySelector('[data-testid="rating-squares"]');
      if (squaresEl) {
        const aria = squaresEl.getAttribute("aria-label") || "";
        const m = aria.match(/(\d+)\s*out\s*of\s*5/i) || aria.match(/^(\d+)$/);
        if (m) return parseInt(m[1], 10);
      }
      // Try any element with aria-label "X out of 5"
      const anyStars = card.querySelector('[aria-label*="out of 5"]');
      if (anyStars) {
        const m = anyStars.getAttribute("aria-label").match(/(\d+)\s*out\s*of/i);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    }

    const cards = document.querySelectorAll('[data-testid="property-card"]');
    const results = [];

    for (const card of cards) {
      // Name
      const name = normalizeText(card.querySelector('[data-testid="title"]')?.textContent);

      // URL — from title link, stripped of tracking params
      const titleLink = card.querySelector('[data-testid="title-link"]');
      let hotelUrl = null;
      if (titleLink?.href) {
        try {
          const u = new URL(titleLink.href);
          // Extract just the path without tracking params
          // Keep only essential params (checkin, checkout, no_rooms, group_adults)
          const cleanUrl = `https://www.booking.com${u.pathname}`;
          const keepParams = ["checkin", "checkout", "no_rooms", "group_adults", "group_children"];
          const cleanParams = new URLSearchParams();
          for (const p of keepParams) {
            const val = u.searchParams.get(p);
            if (val) cleanParams.set(p, val);
          }
          const paramStr = cleanParams.toString();
          hotelUrl = paramStr ? `${cleanUrl}?${paramStr}` : cleanUrl;
        } catch (_) {
          hotelUrl = titleLink.href;
        }
      }

      // Stars
      const stars = parseStars(card);

      // Review score — use structured DOM parsing (aria-hidden attrs) for accuracy
      const reviewScoreEl = card.querySelector('[data-testid="review-score"]');
      const reviewScoreText = normalizeText(reviewScoreEl?.textContent);
      const { score: reviewScore, label: reviewLabel, count: reviewCount } = parseReviewScoreFromEl(reviewScoreEl);

      // Secondary score (location score)
      const secondaryEl = card.querySelector('[data-testid="secondary-review-score-link"]');
      const secondaryText = normalizeText(secondaryEl?.textContent);
      const locationScoreMatch = secondaryText?.match(/Location\s+([\d.]+)/i);
      const locationScore = locationScoreMatch ? parseFloat(locationScoreMatch[1]) : null;

      // Price
      const priceText = normalizeText(
        card.querySelector('[data-testid="price-and-discounted-price"]')?.textContent
      );
      const { amount: priceAmount, currency: priceCurrency } = parsePrice(priceText);

      // Taxes included
      const taxesText = normalizeText(
        card.querySelector('[data-testid="taxes-and-charges"]')?.textContent
      );

      // Address
      const address = normalizeText(
        card.querySelector('[data-testid="address-link"]')?.textContent
      );

      // Distance
      const distance = normalizeText(
        card.querySelector('[data-testid="distance"]')?.textContent
      );

      // Room type
      const roomType = normalizeText(
        card.querySelector('[data-testid="recommended-units"]')?.textContent
      );

      // Deal badge
      const dealEl = card.querySelector('[data-testid="property-card-deal"]');
      const dealText = normalizeText(dealEl?.textContent);
      const hasDeal = !!dealEl;

      // Thumbnail image
      const imgEl = card.querySelector('[data-testid="image"] img, img[src*="bstatic.com"]');
      const thumbnail = imgEl?.src || null;

      if (name) {
        results.push({
          name,
          hotelUrl,
          stars,
          reviewScore,
          reviewLabel,
          reviewCount,
          locationScore,
          pricePerNight: priceAmount,
          currency: priceCurrency,
          taxesIncluded: taxesText?.toLowerCase()?.includes("include") ?? null,
          address,
          distanceFromCentre: distance,
          roomType,
          hasDeal,
          dealText: hasDeal ? dealText : null,
          thumbnail,
        });
      }
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Hotel detail extraction
// ---------------------------------------------------------------------------

/**
 * Extract full hotel details from a Booking.com hotel page.
 * Works on /hotel/<cc>/<slug>.en-gb.html pages (SSR HTML).
 */
export async function extractHotelDetails(page) {
  return page.evaluate(() => {
    function normalizeText(s) {
      return s?.replace(/\s+/g, " ").trim() || null;
    }

    function dedupeArray(arr) {
      return [...new Set(arr)];
    }

    // ---- JSON-LD (most reliable source) ----
    let jsonLd = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        if (data["@type"] === "Hotel" || data["@type"] === "LodgingBusiness") {
          jsonLd = data;
          break;
        }
      } catch (_) {}
    }

    // ---- Meta tags ----
    const metas = {};
    document.querySelectorAll("meta").forEach((m) => {
      const key = m.getAttribute("property") || m.getAttribute("name");
      if (key) metas[key] = m.getAttribute("content");
    });

    // ---- Basic info from JSON-LD ----
    const name = jsonLd?.name || normalizeText(document.querySelector("h1")?.textContent);
    const description = jsonLd?.description || null;
    const hotelUrl = jsonLd?.url || metas["og:url"] || page.url || window.location.href;

    // ---- Address from JSON-LD ----
    const address = jsonLd?.address
      ? {
          street: jsonLd.address.streetAddress || null,
          city: jsonLd.address.addressLocality || null,
          region: jsonLd.address.addressRegion || null,
          country: jsonLd.address.addressCountry || null,
          postalCode: jsonLd.address.postalCode || null,
        }
      : null;

    // Full address string — prefer JSON-LD streetAddress (most reliable)
    const addressText = jsonLd?.address?.streetAddress || null;

    // ---- Stars ----
    const starsEl = document.querySelector('[data-testid="rating-stars"]');
    const starsAria = starsEl?.getAttribute("aria-label") || "";
    const starsMatch = starsAria.match(/(\d+)\s*out\s*of\s*5/i);
    const stars = starsMatch ? parseInt(starsMatch[1], 10) : null;

    // ---- Review score ----
    const reviewScoreEl = document.querySelector('[data-testid="review-score-component"]');
    const reviewScoreText = normalizeText(reviewScoreEl?.textContent);

    // Parse review score: "Scored 9.3 9.3Rated superb Superb · 1,033 reviews"
    let reviewScore = jsonLd?.aggregateRating?.ratingValue || null;
    let reviewCount = jsonLd?.aggregateRating?.reviewCount || null;
    let reviewLabel = null;

    if (!reviewScore && reviewScoreText) {
      const scoreMatch = reviewScoreText.match(/(\d+\.?\d*)/);
      reviewScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;
    }
    if (!reviewCount && reviewScoreText) {
      const countMatch = reviewScoreText.match(/([\d,]+)\s*review/i);
      reviewCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null;
    }
    if (reviewScoreText) {
      const labelMatch = reviewScoreText.match(
        /\b(Exceptional|Superb|Fabulous|Very Good|Good|Pleasant|Review score)\b/i
      );
      // Capitalize first letter of each word in label
      reviewLabel = labelMatch
        ? labelMatch[1].replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
    }

    // ---- Review category scores ----
    const reviewSubscores = {};
    document.querySelectorAll('[data-testid="review-subscore"]').forEach((el) => {
      const text = normalizeText(el.textContent);
      if (!text) return;
      // Format: "Category Name X.X" (last token is score)
      const parts = text.split(/\s+/);
      const score = parseFloat(parts[parts.length - 1]);
      if (!isNaN(score)) {
        const category = parts.slice(0, -1).join(" ");
        reviewSubscores[category] = score;
      }
    });

    // ---- Photos ----
    // Only include hotel property images (not avatars, flags, or other UI assets)
    // bstatic.com/xdata/images/hotel/ is Booking.com's hotel photo CDN
    const photos = dedupeArray(
      Array.from(
        document.querySelectorAll(
          'img[src*="bstatic.com/xdata/images/hotel/"]'
        )
      )
        .map((img) => {
          // Upgrade image resolution to max1024x768
          return img.src
            .replace(/\/max\d+\//, "/max1024x768/")
            .replace(/\/max\d+x\d+\//, "/max1024x768/")
            .replace(/\/square\d+\//, "/max1024x768/");
        })
        .filter(Boolean)
    ).slice(0, 20);

    // Also try gallery images
    const galleryPhotos = dedupeArray(
      Array.from(document.querySelectorAll('[data-testid="GalleryUnifiedDesktop-wrapper"] img'))
        .map((img) => img.src)
        .filter((s) => s && s.includes("bstatic.com/xdata/images/hotel/"))
    );

    const allPhotos = dedupeArray([...photos, ...galleryPhotos]).slice(0, 20);

    // ---- Facilities / Amenities ----
    const facilityWrapper = document.querySelector(
      '[data-testid="property-most-popular-facilities-wrapper"]'
    );
    const popularFacilities = facilityWrapper
      ? dedupeArray(
          Array.from(facilityWrapper.querySelectorAll("li, span"))
            .map((el) => {
              // Only leaf elements (no child lis/spans with text)
              const children = el.querySelectorAll("li, span");
              if (children.length > 0) return null;
              const text = normalizeText(el.textContent);
              // Filter out UI elements like "See all N facilities"
              if (text && /^see all \d+/i.test(text)) return null;
              return text;
            })
            .filter((t) => t && t.length > 1)
        )
      : [];

    // All facilities (from facility-icon elements)
    const allFacilities = dedupeArray(
      Array.from(document.querySelectorAll('[data-testid="facility-icon"]'))
        .map((el) => {
          // Get the text from the parent container of the icon
          const parent = el.closest("li, div");
          const text = normalizeText(parent?.textContent);
          // Filter out "See all N facilities" buttons
          if (text && /^see all \d+/i.test(text)) return null;
          return text;
        })
        .filter((t) => t && t.length > 1 && t.length < 100)
    );

    // ---- Location info ----
    const locationEl = document.querySelector(
      '[data-testid="property-description-location-score-trans"]'
    );
    const locationDesc = normalizeText(locationEl?.textContent);

    // ---- Nearby POIs ----
    const poiEl = document.querySelector('[data-testid="poi-block-list"]');
    const pois = poiEl
      ? normalizeText(poiEl.textContent)
          ?.split(/\n+/)
          ?.map((s) => s.trim())
          ?.filter((s) => s.length > 2)
      : [];

    // ---- Featured review ----
    const reviewText = normalizeText(
      document.querySelector('[data-testid="featuredreviewcard-text"]')?.textContent
    );
    const reviewAuthor = normalizeText(
      document.querySelector('[data-testid="featuredreviewcard-avatar"]')?.textContent
    );

    // ---- Breadcrumb for location ----
    const breadcrumbs = Array.from(document.querySelectorAll('[data-testid="breadcrumb-link"]'))
      .map((el) => normalizeText(el.textContent))
      .filter(Boolean);

    // ---- Hotel policies ----
    const cancelEl = document.querySelector('[data-testid="cancellation-policy"]');
    const cancellationPolicy = normalizeText(cancelEl?.textContent);

    const prepayEl = document.querySelector('[data-testid="policy-title"]');
    const prepaymentPolicy = normalizeText(prepayEl?.textContent);

    // ---- Walking badge ----
    const walkingBadge = normalizeText(
      document.querySelector('[data-testid="walking-badge"]')?.textContent
    );

    // ---- Q&A ----
    const question = normalizeText(
      document.querySelector('[data-testid="question"]')?.textContent
    );
    const answer = normalizeText(
      document.querySelector('[data-testid="answer"]')?.textContent
    );

    return {
      name,
      stars,
      reviewScore,
      reviewCount,
      reviewLabel,
      reviewSubscores,
      description,
      address,
      addressText,
      locationDesc,
      hotelUrl,
      photos: allPhotos,
      popularFacilities,
      allFacilities,
      pois,
      featuredReview: reviewText
        ? { text: reviewText, author: reviewAuthor }
        : null,
      breadcrumbs,
      cancellationPolicy,
      prepaymentPolicy,
      walkingBadge,
      faq: question ? { question, answer } : null,
      meta: {
        ogTitle: metas["og:title"] || null,
        ogDescription: metas["og:description"] || null,
        ogImage: metas["og:image"] || null,
      },
    };
  });
}
