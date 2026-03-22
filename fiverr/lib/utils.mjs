/**
 * Shared utilities for Fiverr scrapers.
 *
 * Anti-bot Strategy:
 *   Fiverr uses Cloudflare protection and is a Next.js React SPA.
 *   Key findings:
 *   1. Fiverr uses Next.js — pages have <script id="__NEXT_DATA__"> with
 *      full server-side rendered page data embedded as JSON.
 *   2. Cloudflare Managed Challenge may trigger from datacenter/Turkish IPs.
 *      Use SOCKS5_PROXY env var if blocked.
 *   3. Search page: __NEXT_DATA__ under props.pageProps.componentProps.listings
 *   4. Gig page: __NEXT_DATA__ under props.pageProps — contains full gig data,
 *      seller info, packages, reviews.
 *   5. XHR intercept strategy: intercept /search/gigs/json or internal API calls
 *      as fallback if __NEXT_DATA__ is missing/stripped.
 *
 *   Selectors (all stable):
 *   - script#__NEXT_DATA__                    — primary data source
 *   - script[type="application/ld+json"]      — JSON-LD fallback
 *   - [data-impressionable-id]               — gig card identifiers
 *
 *   SOCKS5_PROXY env: "host:port" — Firefox SOCKS5 config applied when set
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
 * Create a camoufox browser instance for Fiverr scraping.
 * Supports SOCKS5_PROXY env var for residential proxy.
 */
export async function createFiverrBrowser(Camoufox) {
  const socks5 = process.env.SOCKS5_PROXY;
  const firefoxUserPrefs = {};

  if (socks5) {
    const [host, port] = socks5.split(':');
    log(`[fiverr] Using SOCKS5 proxy: ${socks5}`);
    Object.assign(firefoxUserPrefs, {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': parseInt(port, 10),
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    });
  } else {
    log('[fiverr] No proxy configured (SOCKS5_PROXY not set)');
  }

  return Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1280, minHeight: 900 },
    firefoxUserPrefs,
  });
}

/**
 * Create browser context with US English locale.
 */
export async function createFiverrContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

// ---------------------------------------------------------------------------
// Bot protection detection
// ---------------------------------------------------------------------------

/**
 * Check if the current page is showing a Cloudflare or PerimeterX bot challenge.
 * Fiverr uses PerimeterX (pxAppId: PXK3bezZfO) which shows "It needs a human touch".
 * Returns an object: { blocked: boolean, type: string }
 */
export async function checkCloudflareBlock(page) {
  return page.evaluate(() => {
    const title = document.title || '';
    const body = document.body?.innerText || '';
    const html = document.documentElement?.innerHTML || '';

    // PerimeterX detection (Fiverr uses this)
    if (
      title.includes('It needs a human touch') ||
      html.includes('pxAppId') ||
      html.includes('perimeterx') ||
      html.includes('px-captcha') ||
      document.querySelector('[data-identifier="title"]')?.textContent?.includes('human touch')
    ) {
      return true;
    }

    // Cloudflare detection
    if (
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      body.includes('Enable JavaScript and cookies') ||
      body.includes('cf_clearance') ||
      document.querySelector('#cf-challenge-running') !== null ||
      document.querySelector('.cf-error-details') !== null
    ) {
      return true;
    }

    return false;
  });
}

// ---------------------------------------------------------------------------
// __NEXT_DATA__ extraction
// ---------------------------------------------------------------------------

/**
 * Extract the __NEXT_DATA__ JSON from the page.
 * Returns the parsed object or null if not found.
 */
export async function extractNextData(page) {
  return page.evaluate(() => {
    const el = document.querySelector('script#__NEXT_DATA__');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  });
}

/**
 * Extract window.__fiverr_state__ or similar globals from the page.
 * Some Fiverr pages inject data into window globals as a secondary source.
 */
export async function extractWindowState(page) {
  return page.evaluate(() => {
    // Try various known Fiverr window globals
    const candidates = [
      window.__fiverr_state__,
      window.initialData,
      window.__INITIAL_STATE__,
      window.__APP_STATE__,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object') return c;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Search data parsers
// ---------------------------------------------------------------------------

/**
 * Parse gig listings from Fiverr __NEXT_DATA__ search results.
 * Handles both the old and new Fiverr page structures.
 */
export function parseSearchNextData(nextData) {
  if (!nextData) return [];

  const pageProps = nextData?.props?.pageProps;
  if (!pageProps) return [];

  // Try various known paths for search results
  const candidates = [
    pageProps?.componentProps?.listings,
    pageProps?.listings,
    pageProps?.initialData?.listings,
    pageProps?.serverState?.listings,
    pageProps?.dehydratedState?.queries?.[0]?.state?.data?.listings,
    pageProps?.componentProps?.gigResults,
    pageProps?.gigResults,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map(normalizeSearchGig).filter(Boolean);
    }
  }

  // Try deep search for listings array
  const found = deepFindArray(nextData, 'listings', 50);
  if (found && found.length > 0) {
    return found.map(normalizeSearchGig).filter(Boolean);
  }

  return [];
}

/**
 * Normalize a single gig from search results into a consistent shape.
 */
export function normalizeSearchGig(gig) {
  if (!gig || typeof gig !== 'object') return null;

  // Handle nested gig object (e.g. gig.gig or gig.gigData)
  const g = gig.gig || gig.gigData || gig;

  const gigId = String(g.gig_id || g.gigId || g.id || '');
  const title = g.title || g.name || '';

  if (!gigId && !title) return null;

  const username = g.username || g.seller?.username || g.seller_username || '';
  const gigSlug = g.slug || g.gig_slug || g.gigSlug || '';
  const gigUrl = gigSlug && username
    ? `https://www.fiverr.com/${username}/${gigSlug}`
    : g.url || '';

  const seller = {
    username,
    displayName: g.seller?.name || g.seller_name || g.seller?.display_name || username,
    level: g.seller?.seller_level || g.seller_level || g.seller?.level || null,
    rating: parseFloat(g.seller?.rating || g.rating || 0) || null,
    reviewCount: parseInt(g.seller?.reviews_count || g.reviews_count || 0, 10) || 0,
    avatarUrl: g.seller?.avatar_url || g.seller?.profile_image || g.seller_avatar || null,
    country: g.seller?.country || g.country || null,
  };

  // Price — Fiverr stores in cents sometimes
  let startingPrice = g.price?.min || g.min_price || g.starting_price || g.price || null;
  if (typeof startingPrice === 'number' && startingPrice > 1000) {
    // Likely in cents
    startingPrice = startingPrice / 100;
  }
  const currency = g.price?.currency || g.currency || 'USD';

  const deliveryDays = parseInt(g.delivery_time || g.delivery_days || g.deliveryTime || 0, 10) || null;
  const rating = parseFloat(g.rating || g.avg_rating || seller.rating || 0) || null;
  const reviewCount = parseInt(g.reviews_count || g.review_count || g.votes_count || seller.reviewCount || 0, 10) || 0;

  // Thumbnail
  const thumbnailUrl = g.thumbnails?.large
    || g.thumbnails?.medium
    || g.image_url
    || g.thumbnail_url
    || g.cover_image
    || null;

  const isProSeller = !!(g.seller?.is_pro || g.is_pro_seller || g.is_pro);
  const isPro = !!(g.is_pro || g.pro);

  return {
    gigId,
    title,
    gigUrl,
    thumbnailUrl,
    seller,
    startingPrice,
    currency,
    deliveryDays,
    rating,
    reviewCount,
    isProSeller,
    isPro,
  };
}

// ---------------------------------------------------------------------------
// Gig detail parsers
// ---------------------------------------------------------------------------

/**
 * Parse a Fiverr gig detail page from __NEXT_DATA__.
 */
export function parseGigNextData(nextData, gigUrl) {
  if (!nextData) return null;

  const pageProps = nextData?.props?.pageProps;
  if (!pageProps) return null;

  // Various known paths for gig detail data
  const gigData =
    pageProps?.componentProps?.gigData ||
    pageProps?.gigData ||
    pageProps?.data?.gigData ||
    pageProps?.initialData?.gigData ||
    pageProps?.componentProps?.gig ||
    pageProps?.gig ||
    null;

  const overviewData =
    pageProps?.componentProps?.overviewData ||
    pageProps?.overviewData ||
    pageProps?.componentProps?.gigOverviewData ||
    null;

  const reviewsData =
    pageProps?.componentProps?.reviewsData ||
    pageProps?.reviewsData ||
    pageProps?.componentProps?.reviews ||
    pageProps?.reviews ||
    null;

  const sellerData =
    pageProps?.componentProps?.sellerData ||
    pageProps?.sellerData ||
    pageProps?.componentProps?.seller ||
    pageProps?.seller ||
    null;

  // If we got a top-level gig, parse it
  if (gigData) {
    return buildGigDetail(gigData, overviewData, reviewsData, sellerData, gigUrl, pageProps);
  }

  // Try extracting from nested structure
  const deepGig = deepFind(nextData, 'gigData', 10)
    || deepFind(nextData, 'gig_details', 10)
    || deepFind(nextData, 'gig', 10);

  if (deepGig && typeof deepGig === 'object' && (deepGig.title || deepGig.gig_id)) {
    return buildGigDetail(deepGig, null, null, null, gigUrl, pageProps);
  }

  return null;
}

/**
 * Build a structured gig detail object from raw Fiverr data.
 */
export function buildGigDetail(gig, overviewData, reviewsData, sellerData, gigUrl, pageProps) {
  if (!gig) return null;

  const g = gig.gig || gig;

  const gigId = String(g.gig_id || g.gigId || g.id || '');
  const title = g.title || g.name || '';
  const username = g.username || g.seller?.username || '';
  const gigSlug = g.slug || g.gig_slug || '';

  const resolvedUrl = gigUrl || (username && gigSlug
    ? `https://www.fiverr.com/${username}/${gigSlug}`
    : '');

  // Description
  const description = g.description
    || overviewData?.description
    || g.overview
    || null;

  // Tags and categories
  const tags = (g.tags || g.metadata || []).filter(t => typeof t === 'string');
  const categories = [
    g.category?.name,
    g.subcategory?.name,
    g.nested_sub_category?.name,
  ].filter(Boolean);

  // FAQs
  const faqs = (g.faqs || g.faq || []).map(f => ({
    question: f.question || f.q || '',
    answer: f.answer || f.a || '',
  })).filter(f => f.question);

  // Packages
  const packages = parsePackages(g, overviewData);

  // Seller
  const seller = parseSellerDetail(
    sellerData || g.seller || g,
    g
  );

  // Reviews
  const reviews = parseReviews(reviewsData || g.reviews || pageProps?.reviews);

  // Stats
  const rating = parseFloat(g.rating || g.avg_rating || 0) || null;
  const reviewCount = parseInt(g.reviews_count || g.votes_count || reviews.length || 0, 10) || 0;
  const isProSeller = !!(g.is_pro_seller || g.seller?.is_pro);
  const isPro = !!(g.is_pro);

  // Starting price from packages
  let startingPrice = null;
  if (packages.length > 0) {
    const prices = packages.map(p => p.price).filter(p => typeof p === 'number' && p > 0);
    if (prices.length > 0) startingPrice = Math.min(...prices);
  }
  if (!startingPrice) {
    startingPrice = g.price?.min || g.min_price || g.starting_price || null;
    if (typeof startingPrice === 'number' && startingPrice > 1000) {
      startingPrice = startingPrice / 100;
    }
  }

  const currency = g.currency || g.price?.currency || 'USD';
  const deliveryDays = parseInt(g.delivery_time || g.delivery_days || 0, 10) || null;

  const thumbnailUrl = g.thumbnails?.large
    || g.thumbnails?.medium
    || g.image_url
    || g.thumbnail_url
    || g.cover_image
    || null;

  return {
    gigId,
    title,
    gigUrl: resolvedUrl,
    thumbnailUrl,
    description,
    packages,
    tags,
    categories,
    faqs,
    seller,
    startingPrice,
    currency,
    deliveryDays,
    rating,
    reviewCount,
    isProSeller,
    isPro,
    reviews,
  };
}

/**
 * Parse gig packages from raw data.
 */
function parsePackages(gig, overviewData) {
  // Try packages array first
  const rawPackages = gig.packages
    || overviewData?.packages
    || gig.gig_packages
    || [];

  if (Array.isArray(rawPackages) && rawPackages.length > 0) {
    return rawPackages.map((pkg, idx) => {
      let price = pkg.price || pkg.amount || 0;
      if (typeof price === 'number' && price > 1000) price = price / 100;

      return {
        name: pkg.name || pkg.title || ['Basic', 'Standard', 'Premium'][idx] || `Package ${idx + 1}`,
        price,
        deliveryDays: parseInt(pkg.delivery_time || pkg.delivery_days || 0, 10) || null,
        description: pkg.description || '',
        revisions: pkg.revisions ?? pkg.revision_count ?? null,
        features: (pkg.includes || pkg.features || []).map(f =>
          typeof f === 'string' ? f : (f.title || f.feature || f.description || '')
        ).filter(Boolean),
      };
    });
  }

  // Try extracting from basic/standard/premium keys
  const pkgMap = {
    basic: gig.basic_package || gig.package_basic,
    standard: gig.standard_package || gig.package_standard,
    premium: gig.premium_package || gig.package_premium,
  };

  const result = [];
  for (const [name, pkg] of Object.entries(pkgMap)) {
    if (!pkg) continue;
    let price = pkg.price || pkg.amount || 0;
    if (typeof price === 'number' && price > 1000) price = price / 100;

    result.push({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      price,
      deliveryDays: parseInt(pkg.delivery_time || pkg.delivery_days || 0, 10) || null,
      description: pkg.description || '',
      revisions: pkg.revisions ?? null,
      features: (pkg.includes || pkg.features || []).map(f =>
        typeof f === 'string' ? f : (f.title || '')
      ).filter(Boolean),
    });
  }

  return result;
}

/**
 * Parse seller detail from raw data.
 */
function parseSellerDetail(sellerRaw, gig) {
  if (!sellerRaw) sellerRaw = {};

  const seller = sellerRaw.seller || sellerRaw;

  return {
    username: seller.username || gig?.username || '',
    displayName: seller.name || seller.display_name || seller.username || '',
    level: seller.seller_level || seller.level || null,
    rating: parseFloat(seller.rating || seller.avg_rating || 0) || null,
    reviewCount: parseInt(seller.reviews_count || seller.votes_count || 0, 10) || 0,
    avatarUrl: seller.avatar_url || seller.profile_image || seller.avatar || null,
    country: seller.country || seller.origin_country || null,
    bio: seller.description || seller.bio || seller.tagline || null,
    memberSince: seller.member_since || seller.joined || seller.registration_date || null,
    responseTime: seller.response_time || seller.avg_response_time || null,
    ordersInQueue: parseInt(seller.ongoing_orders || seller.orders_in_queue || 0, 10) || 0,
    languages: (seller.languages || []).map(l =>
      typeof l === 'string' ? l : (l.language || l.name || '')
    ).filter(Boolean),
    skills: (seller.skills || []).map(s =>
      typeof s === 'string' ? s : (s.skill || s.name || '')
    ).filter(Boolean),
  };
}

/**
 * Parse reviews from raw data.
 */
function parseReviews(reviewsData) {
  if (!reviewsData) return [];

  const list = reviewsData.reviews
    || reviewsData.data
    || reviewsData.items
    || (Array.isArray(reviewsData) ? reviewsData : []);

  if (!Array.isArray(list)) return [];

  return list.map(r => ({
    id: String(r.id || r.review_id || ''),
    reviewer: r.reviewer?.username || r.buyer?.username || r.username || '',
    rating: parseFloat(r.rating || r.stars || 0) || null,
    text: r.review || r.text || r.content || r.comment || '',
    date: r.published_at || r.created_at || r.date || r.timestamp || null,
    sellerResponse: r.reply?.text || r.seller_response?.text || r.response || null,
  })).filter(r => r.reviewer || r.text);
}

// ---------------------------------------------------------------------------
// XHR intercept helpers
// ---------------------------------------------------------------------------

/**
 * Set up XHR/fetch intercept for Fiverr search API responses.
 * Returns a promise that resolves with intercepted data, or null on timeout.
 */
export function setupSearchIntercept(page) {
  return new Promise((resolve) => {
    const intercepted = [];
    let resolved = false;

    const handler = async (response) => {
      const url = response.url();
      if (
        url.includes('/api/v2/search/gigs') ||
        url.includes('/search/gigs/json') ||
        url.includes('/api/search') ||
        url.includes('fiverr.com/api/')
      ) {
        try {
          const json = await response.json().catch(() => null);
          if (json) {
            intercepted.push(json);
            if (!resolved) {
              resolved = true;
              resolve(json);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    };

    page.on('response', handler);

    // Timeout after 15s
    setTimeout(() => {
      if (!resolved) {
        page.off('response', handler);
        resolve(intercepted[0] || null);
      }
    }, 15000);
  });
}

/**
 * Set up XHR/fetch intercept for Fiverr gig detail API responses.
 */
export function setupGigIntercept(page) {
  return new Promise((resolve) => {
    let resolved = false;

    const handler = async (response) => {
      const url = response.url();
      if (
        url.includes('/api/v2/gigs/') ||
        url.includes('/api/v1/gigs/') ||
        (url.includes('fiverr.com/api/') && url.includes('gig'))
      ) {
        try {
          const json = await response.json().catch(() => null);
          if (json && !resolved) {
            resolved = true;
            page.off('response', handler);
            resolve(json);
          }
        } catch (e) {
          // ignore
        }
      }
    };

    page.on('response', handler);

    setTimeout(() => {
      if (!resolved) {
        page.off('response', handler);
        resolve(null);
      }
    }, 15000);
  });
}

// ---------------------------------------------------------------------------
// Deep search utilities
// ---------------------------------------------------------------------------

/**
 * Recursively search an object for a key, up to maxDepth levels deep.
 * Returns the first found value.
 */
export function deepFind(obj, key, maxDepth = 10, depth = 0) {
  if (depth > maxDepth || !obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFind(v, key, maxDepth, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Deep-find an array value by key.
 */
export function deepFindArray(obj, key, maxDepth = 10, depth = 0) {
  if (depth > maxDepth || !obj || typeof obj !== 'object') return null;
  if (key in obj && Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFindArray(v, key, maxDepth, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Fiverr gig URL or path into { username, slug }.
 * Accepts:
 *   - Full URL: https://www.fiverr.com/username/gig-slug
 *   - Path: username/gig-slug
 */
export function parseGigPath(input) {
  if (!input) return null;

  // Remove protocol + domain if present
  let path = input.replace(/^https?:\/\/(www\.)?fiverr\.com\//, '');

  // Remove leading slash
  path = path.replace(/^\//, '');

  // Remove query string and hash
  path = path.split('?')[0].split('#')[0];

  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  return {
    username: parts[0],
    slug: parts[1],
    gigUrl: `https://www.fiverr.com/${parts[0]}/${parts[1]}`,
  };
}
