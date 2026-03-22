/**
 * Shared utilities for Capterra scrapers.
 *
 * Anti-bot Strategy:
 *   Capterra (owned by Gartner) uses Cloudflare Managed Challenge on all pages.
 *   The managed challenge requires JavaScript execution + browser fingerprint validation.
 *   camoufox-js (fingerprinted Firefox) is needed to bypass Cloudflare.
 *
 *   From datacenter/non-residential IPs, Cloudflare returns HTTP 403 "Just a moment..."
 *   even with camoufox. A residential proxy is required to pass the managed challenge.
 *
 *   Data sources (in priority order):
 *   1. __NEXT_DATA__ — Capterra uses Next.js SSR; props.pageProps contains all data
 *      Contains: product info, rating breakdown, pricing, features, reviews, etc.
 *   2. JSON-LD SoftwareApplication schema — embedded in <script type="application/ld+json">
 *      Contains: name, description, aggregateRating, url, image
 *   3. XHR interception — Capterra loads reviews via paginated API
 *      Endpoints: /api/reviews/... or XHR to internal Gartner data APIs
 *   4. window.__STATE__ — alternative SSR data blob (Gartner pattern)
 *
 *   Search URL:  https://www.capterra.com/search/?query=<keyword>
 *   Product URL: https://www.capterra.com/p/<id>/<slug>/
 *   Category:    https://www.capterra.com/<category>-software/
 *
 *   PROXY NOTE: Set SOCKS5_PROXY=host:port for residential IP to bypass Cloudflare.
 *   Cloudflare Managed Challenge is verified via JS proof-of-work — residential IP
 *   with a real browser fingerprint (camoufox) is required.
 */

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[capterra] ' + args.join(' ') + '\n');
}

export function emitResult(data) {
  process.stdout.write('RESULT:' + JSON.stringify(data) + '\n');
}

export function emitError(code, message, extra = {}) {
  process.stdout.write('RESULT:' + JSON.stringify({ error: true, code, message, ...extra }) + '\n');
  process.exit(1);
}

export function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Browser creation
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser for Capterra scraping.
 *
 * Capterra uses Cloudflare Managed Challenge — needs:
 * 1. A fingerprinted Firefox browser (camoufox) to pass the JS challenge
 * 2. A residential IP (SOCKS5_PROXY) to avoid the 403 block
 *
 * Without a residential proxy, Cloudflare returns HTTP 403 from datacenter/Turkish IPs.
 */
export async function createCapterraBrowser(Camoufox) {
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
    log('No proxy configured (SOCKS5_PROXY not set) — Cloudflare will likely block');
  }

  return Camoufox({
    headless: true,
    humanize: 1,
    geoip: true,
    screen: { minWidth: 1920, minHeight: 1080 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createCapterraContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

// ---------------------------------------------------------------------------
// Bot detection check
// ---------------------------------------------------------------------------

/**
 * Check if Cloudflare is blocking the current page.
 * Returns true if blocked (challenge page detected).
 */
export async function checkCloudflareBlock(page) {
  const title = await page.title();
  const url = page.url();

  if (
    title.includes('Just a moment') ||
    title.includes('Attention Required') ||
    title.includes('Access denied') ||
    url.includes('__cf_chl') ||
    url.includes('cf-chl-bypass')
  ) {
    return true;
  }

  // Check body for Cloudflare challenge tokens
  const bodySnippet = await page.evaluate(() => {
    return document.body?.innerText?.slice(0, 200) || '';
  });

  return (
    bodySnippet.includes('Enable JavaScript and cookies to continue') ||
    bodySnippet.includes('cf_chl_opt') ||
    bodySnippet.length < 20
  );
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract __NEXT_DATA__ JSON from Capterra pages.
 *
 * Capterra runs on Next.js — all SSR data is in:
 *   <script id="__NEXT_DATA__" type="application/json">{...}</script>
 *
 * The pageProps object contains:
 *   - For search: pageProps.initialData.searchResults[] with product cards
 *   - For product: pageProps.product, pageProps.reviews, pageProps.pricing
 *   - For category: pageProps.productList[], pageProps.categoryData
 */
export async function extractNextData(page) {
  return page.evaluate(() => {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  });
}

/**
 * Extract window.__STATE__ from Capterra pages (Gartner alternative SSR blob).
 */
export async function extractWindowState(page) {
  return page.evaluate(() => {
    try {
      if (window.__STATE__) return window.__STATE__;
      // Some Gartner pages use __INITIAL_STATE__
      if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;
      // Try to find it in script tags
      for (const script of document.querySelectorAll('script:not([src])')) {
        const text = script.textContent || '';
        const m = text.match(/window\.__STATE__\s*=\s*({[\s\S]+?});?\s*(?:window|$)/);
        if (m) {
          try { return JSON.parse(m[1]); } catch (e) {}
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  });
}

/**
 * Extract JSON-LD structured data from the page.
 * Returns an array of all JSON-LD objects found.
 */
export async function extractJsonLd(page) {
  return page.evaluate(() => {
    const results = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (Array.isArray(data)) results.push(...data);
        else results.push(data);
      } catch (e) {}
    }
    return results;
  });
}

/**
 * Set up XHR interceptor to capture review API responses.
 *
 * Capterra loads paginated reviews via XHR/fetch calls to:
 *   /api/reviews/...
 *   /gdm-api/...
 *   Internal Gartner APIs (graph.capterra.com or similar)
 *
 * Returns array that gets populated as responses arrive.
 */
export function setupXhrInterceptor(page) {
  const captured = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';

    if (
      res.status() === 200 &&
      ct.includes('application/json') &&
      (
        url.includes('/reviews') ||
        url.includes('/api/') ||
        url.includes('/gdm-api/') ||
        url.includes('capterra.com') ||
        url.includes('gartner.com')
      ) &&
      !url.includes('.js') &&
      !url.includes('.css')
    ) {
      try {
        const body = await res.json();
        if (body && typeof body === 'object') {
          captured.push({ url, body });
        }
      } catch (e) {}
    }
  });
  return captured;
}

// ---------------------------------------------------------------------------
// URL/slug parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Capterra product URL or slug.
 *
 * Accepts:
 *   - Full URL: https://www.capterra.com/p/26943/Slack/
 *   - Slug: 26943/Slack
 *   - Slug with slug only: Slack (will try to find product)
 *
 * Returns { id, slug, url } or null if invalid.
 */
export function parseProductInput(input) {
  if (!input) return null;

  // Full URL: https://www.capterra.com/p/26943/Slack/
  const urlMatch = input.match(/capterra\.com\/p\/(\d+)\/([^/?#]+)/i);
  if (urlMatch) {
    return {
      id: urlMatch[1],
      slug: urlMatch[2],
      url: `https://www.capterra.com/p/${urlMatch[1]}/${urlMatch[2]}/`,
    };
  }

  // Slug format: 26943/Slack
  const slugMatch = input.match(/^(\d+)\/([^/?#]+)/);
  if (slugMatch) {
    return {
      id: slugMatch[1],
      slug: slugMatch[2],
      url: `https://www.capterra.com/p/${slugMatch[1]}/${slugMatch[2]}/`,
    };
  }

  // Pure name slug (no ID) — build category URL pattern
  // E.g., "Slack" -> try https://www.capterra.com/p/26943/Slack/
  return null;
}

/**
 * Extract product ID and slug from a Capterra URL.
 */
export function extractProductIdSlug(url) {
  const m = url.match(/\/p\/(\d+)\/([^/?#]+)/);
  if (!m) return null;
  return { id: m[1], slug: m[2] };
}

/**
 * Parse search result product data from __NEXT_DATA__.
 *
 * Capterra search results live in various locations depending on page version:
 *   - nextData.props.pageProps.initialData.searchResults[]
 *   - nextData.props.pageProps.productList[]
 *   - nextData.props.pageProps.products[]
 */
export function parseSearchNextData(nextData) {
  if (!nextData) return null;

  const pageProps = nextData?.props?.pageProps || {};

  // Try various locations for product list
  const productList =
    pageProps?.initialData?.searchResults ||
    pageProps?.productList ||
    pageProps?.products ||
    pageProps?.searchResults ||
    pageProps?.data?.products ||
    pageProps?.initialData?.products ||
    null;

  if (!productList || !Array.isArray(productList)) return null;

  return {
    products: productList,
    totalFound:
      pageProps?.initialData?.totalCount ||
      pageProps?.totalCount ||
      pageProps?.total ||
      productList.length,
    page: pageProps?.page || 1,
  };
}

/**
 * Parse a product object from Capterra search results (__NEXT_DATA__).
 *
 * Capterra product card schema (from __NEXT_DATA__):
 * {
 *   id: number,
 *   uniqueName: string,           // slug
 *   productName: string,
 *   overallRating: number,        // 0-5
 *   reviewCount: number,
 *   shortDescription: string,
 *   priceDisplayText: string,     // e.g. "Free version", "Starting from $29.00/mo"
 *   logoUrl: string,
 *   categoryNames: string[],
 *   url: string,                  // relative or absolute URL
 * }
 */
export function parseSearchProduct(raw) {
  if (!raw) return null;

  const id = raw.id || raw.productId || null;
  const slug = raw.uniqueName || raw.slug || raw.productSlug || null;
  const name = raw.productName || raw.name || raw.title || null;

  if (!name) return null;

  const productId = String(id || '');
  const productSlug = slug || name?.toLowerCase()?.replace(/\s+/g, '-') || '';

  let url = raw.url || raw.productUrl || null;
  if (!url && productId && productSlug) {
    url = `https://www.capterra.com/p/${productId}/${productSlug}/`;
  } else if (url && !url.startsWith('http')) {
    url = `https://www.capterra.com${url}`;
  }

  // Rating
  const rating = raw.overallRating != null
    ? parseFloat(raw.overallRating)
    : raw.rating != null
      ? parseFloat(raw.rating)
      : null;

  // Review count
  const reviewCount = raw.reviewCount != null
    ? parseInt(raw.reviewCount, 10)
    : raw.numReviews != null
      ? parseInt(raw.numReviews, 10)
      : null;

  // Pricing
  let pricingInfo = raw.priceDisplayText || raw.pricingInfo || raw.price || null;
  if (!pricingInfo && raw.hasFreeVersion) pricingInfo = 'Free version available';

  // Logo
  let logoUrl = raw.logoUrl || raw.logo || raw.logoImageUrl || null;
  if (logoUrl && !logoUrl.startsWith('http')) {
    logoUrl = `https:${logoUrl}`;
  }

  // Categories
  const categories = raw.categoryNames || raw.categories || [];

  return {
    name,
    id: productId || null,
    slug: productSlug || null,
    url,
    logoUrl: logoUrl || null,
    rating: rating != null && !isNaN(rating) ? rating : null,
    reviewCount: reviewCount != null && !isNaN(reviewCount) ? reviewCount : null,
    shortDescription: raw.shortDescription || raw.description || null,
    pricingInfo,
    categories: Array.isArray(categories) ? categories : [],
  };
}

/**
 * Parse product detail data from __NEXT_DATA__ (product detail page).
 *
 * Capterra product page __NEXT_DATA__ structure:
 * {
 *   props: {
 *     pageProps: {
 *       product: { ... },
 *       reviews: { ... },
 *       pricing: { ... },
 *       features: [...],
 *     }
 *   }
 * }
 */
export function parseProductNextData(nextData) {
  if (!nextData) return null;

  const pageProps = nextData?.props?.pageProps || {};

  // Product may be nested in different ways
  const product =
    pageProps?.product ||
    pageProps?.productDetails ||
    pageProps?.productData ||
    pageProps?.initialData?.product ||
    null;

  // Reviews
  const reviewsData =
    pageProps?.reviews ||
    pageProps?.reviewData ||
    pageProps?.initialData?.reviews ||
    null;

  // Pricing
  const pricingData =
    pageProps?.pricing ||
    pageProps?.pricingDetails ||
    pageProps?.initialData?.pricing ||
    null;

  // Features
  const featuresData =
    pageProps?.features ||
    pageProps?.featureList ||
    pageProps?.initialData?.features ||
    null;

  return { product, reviewsData, pricingData, featuresData, pageProps };
}

/**
 * Parse a single review object from Capterra __NEXT_DATA__ or API.
 *
 * Capterra review schema:
 * {
 *   id: string,
 *   title: string,
 *   overallRating: number,
 *   pros: string,
 *   cons: string,
 *   date: string,                  // ISO date
 *   helpfulVotes: number,
 *   reviewer: {
 *     name: string,
 *     jobTitle: string,
 *     companySize: string,
 *     industry: string,
 *   }
 * }
 */
export function parseReview(raw) {
  if (!raw) return null;

  return {
    id: raw.id || raw.reviewId || null,
    title: raw.title || raw.reviewTitle || null,
    rating: raw.overallRating != null
      ? parseFloat(raw.overallRating)
      : raw.rating != null
        ? parseFloat(raw.rating)
        : null,
    pros: raw.pros || raw.positives || null,
    cons: raw.cons || raw.negatives || null,
    date: raw.date || raw.submittedDate || raw.publishedDate || null,
    helpful: raw.helpfulVotes || raw.helpfulCount || raw.helpful || 0,
    author: raw.reviewer?.name || raw.authorName || raw.name || null,
    role: raw.reviewer?.jobTitle || raw.jobTitle || raw.role || null,
    companySize: raw.reviewer?.companySize || raw.companySize || null,
    industry: raw.reviewer?.industry || raw.industry || null,
    verified: raw.verified || raw.isVerified || false,
  };
}

/**
 * Parse rating breakdown from Capterra product data.
 *
 * Capterra provides sub-ratings:
 * - easeOfUse
 * - customerService / support
 * - valueForMoney
 * - functionality / features
 */
export function parseRatingBreakdown(raw) {
  if (!raw) return null;

  return {
    ease: raw.easeOfUse || raw.ease || raw.easeRating || null,
    value: raw.valueForMoney || raw.value || raw.valueRating || null,
    features: raw.functionality || raw.features || raw.featuresRating || null,
    support: raw.customerService || raw.support || raw.supportRating || null,
  };
}

/**
 * Parse pricing info from Capterra pricing data.
 */
export function parsePricing(raw) {
  if (!raw) return null;

  return {
    hasFreeVersion: raw.hasFreeVersion || raw.free || false,
    hasFreeTriaL: raw.hasFreeTrial || raw.freeTrial || false,
    startingPrice: raw.startingPrice || raw.price || raw.priceDisplayText || null,
    pricingModel: raw.pricingModel || raw.billingType || null,
    currency: raw.currency || 'USD',
  };
}
