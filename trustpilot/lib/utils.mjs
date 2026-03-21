/**
 * Shared utilities for Trustpilot scrapers.
 *
 * Anti-bot Strategy (Updated 2026-03-21):
 *   Trustpilot uses PerimeterX (px-captcha) for some direct curl requests,
 *   but camoufox-js with fingerprinted Firefox browser bypasses it fully.
 *   All data is embedded in Next.js __NEXT_DATA__ script tags.
 *
 *   Key findings:
 *   1. Residential proxy is recommended (SOCKS5_PROXY env). Works from Turkish
 *      residential IP (188.3.180.188). Not blocked.
 *
 *   2. No warmup required — business and search pages load independently.
 *
 *   3. Primary data source: __NEXT_DATA__ (Next.js SSR JSON) embedded in
 *      <script id="__NEXT_DATA__" type="application/json"> tag.
 *
 *   4. SEARCH PAGE DATA:
 *      URL: /search?query=<query>
 *      __NEXT_DATA__.props.pageProps.businessUnits (array)
 *      Each entry: businessUnitId, displayName, identifyingName, numberOfReviews,
 *                  trustScore, stars, location, contact, categories
 *      Pagination: pageProps.pagination (totalPages, totalHits)
 *      Also intercepted API: /api/consumersitesearch-api/businessunits/search?query=...
 *
 *   5. BUSINESS PAGE DATA:
 *      URL: /review/<domain>?page=N&languages=en&sort=recency
 *      __NEXT_DATA__.props.pageProps.businessUnit — full business profile
 *      __NEXT_DATA__.props.pageProps.reviews — 20 reviews per page
 *      __NEXT_DATA__.props.pageProps.filters — pagination + filter state
 *      __NEXT_DATA__.props.pageProps.sidebarData — contact info (email, phone, address)
 *
 *   6. Review structure:
 *      id, text, rating, title, likes, source, language, location
 *      dates.publishedDate, dates.experiencedDate
 *      consumer.displayName, consumer.countryCode, consumer.numberOfReviews, consumer.isVerified
 *      reply (company reply): text, publishedDate
 *      labels.verification.isVerified, verificationLevel, verificationSource
 *
 *   7. Selectors used (all stable):
 *      script#__NEXT_DATA__[type="application/json"] — Next.js SSR data
 *      script[type="application/ld+json"] — Schema.org structured data (fallback)
 *
 *   PROXY NOTE: Residential proxy strongly recommended. SOCKS5_PROXY=host:port.
 *   Without proxy, PerimeterX may block curl/basic requests; camoufox usually
 *   works even without proxy but proxy adds reliability.
 */

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[trustpilot] ' + args.join(' ') + '\n');
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
 * Create a camoufox browser for Trustpilot scraping.
 * Uses residential proxy if SOCKS5_PROXY env is set.
 */
export async function createTrustpilotBrowser(Camoufox) {
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
    log('No proxy configured (SOCKS5_PROXY not set) — may encounter PerimeterX blocks');
  }

  return Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1366, minHeight: 768 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createTrustpilotContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract __NEXT_DATA__ from Trustpilot page.
 * Returns the pageProps object or null if not found.
 */
export async function extractNextData(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  });
}

/**
 * Parse a single review from Trustpilot __NEXT_DATA__.
 */
export function parseReview(r) {
  return {
    id: r.id || null,
    title: r.title || null,
    text: r.text || null,
    rating: r.rating || null,
    likes: r.likes || 0,
    source: r.source || null,
    language: r.language || null,
    isVerified: r.labels?.verification?.isVerified || false,
    verificationLevel: r.labels?.verification?.verificationLevel || null,
    publishedDate: r.dates?.publishedDate || null,
    updatedDate: r.dates?.updatedDate || null,
    experiencedDate: r.dates?.experiencedDate || null,
    consumer: r.consumer ? {
      id: r.consumer.id || null,
      displayName: r.consumer.displayName || null,
      countryCode: r.consumer.countryCode || null,
      numberOfReviews: r.consumer.numberOfReviews || null,
      isVerified: r.consumer.isVerified || false,
      imageUrl: (r.consumer.hasImage && r.consumer.imageUrl) ? r.consumer.imageUrl : null,
    } : null,
    reply: r.reply ? {
      text: r.reply.text || null,
      publishedDate: r.reply.publishedDate || null,
    } : null,
    location: r.location || null,
  };
}

/**
 * Parse a business unit from Trustpilot search results.
 */
export function parseSearchResult(bu) {
  return {
    businessUnitId: bu.businessUnitId || bu.id || null,
    domain: bu.identifyingName || null,
    name: bu.displayName || null,
    numberOfReviews: bu.numberOfReviews || null,
    trustScore: bu.trustScore || null,
    stars: bu.stars || null,
    location: bu.location || null,
    contact: bu.contact || null,
    categories: (bu.categories || []).map(c => ({
      id: c.id || c.categoryId || null,
      name: c.name || c.displayName || null,
      isPrimary: c.isPrimary || false,
    })),
    profileImageUrl: bu.profileImageUrl || null,
    url: bu.identifyingName ? `https://www.trustpilot.com/review/${bu.identifyingName}` : null,
  };
}

/**
 * Parse the full business unit from a business page.
 */
export function parseBusinessUnit(bu, sidebarData, filters) {
  const sidebar = sidebarData?.infoBusinessUnitBox || {};
  const contact = sidebar.contact || bu.contact || {};

  return {
    businessUnitId: bu.id || null,
    domain: bu.identifyingName || null,
    name: bu.displayName || null,
    websiteUrl: bu.websiteUrl || null,
    trustScore: bu.trustScore || null,
    stars: bu.stars || null,
    numberOfReviews: bu.numberOfReviews || null,
    totalReviewsInFilter: filters?.totalNumberOfReviews || null,
    profileImageUrl: bu.profileImageUrl ? `https:${bu.profileImageUrl}` : null,
    categories: (bu.categories || []).map(c => ({
      id: c.id || null,
      name: c.name || null,
      isPrimary: c.isPrimary || false,
    })),
    contact: {
      email: contact.email || null,
      phone: contact.phone || null,
      address: contact.address || null,
      city: contact.city || null,
      zipCode: contact.zipCode || null,
      country: contact.country || bu.location?.country || null,
    },
    url: bu.identifyingName ? `https://www.trustpilot.com/review/${bu.identifyingName}` : null,
  };
}
