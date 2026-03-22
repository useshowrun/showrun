/**
 * Shared utilities for G2 scrapers.
 *
 * Anti-bot Strategy:
 *   G2 uses Cloudflare. camoufox-js fingerprinted Firefox bypasses it.
 *
 *   Data sources (in priority order):
 *   1. window.gon — G2's server-side data object injected in <script> tags
 *      Contains: product info, review data, category info, pricing, etc.
 *   2. JSON-LD SoftwareApplication schema — embedded in <script type="application/ld+json">
 *      Contains: name, description, aggregateRating, url, image
 *   3. XHR interception — G2 loads review pages via AJAX on pagination
 *      Endpoint: /products/<slug>/reviews.json or /ajax/reviews/...
 *   4. DOM fallback — aria labels, data-* attributes for structured data
 *
 *   Search URL: https://www.g2.com/search?query=<keyword>
 *   Product URL: https://www.g2.com/products/<slug>/reviews
 *
 *   PROXY NOTE: Set SOCKS5_PROXY=host:port for residential IP if Cloudflare blocks.
 */

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[g2] ' + args.join(' ') + '\n');
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
 * Create a camoufox browser for G2 scraping.
 * Uses residential proxy if SOCKS5_PROXY env is set.
 */
export async function createG2Browser(Camoufox) {
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
    screen: { minWidth: 1366, minHeight: 768 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createG2Context(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract window.gon from the page.
 * G2 injects gon (global objects notation) as:
 *   <script>window.gon={...};</script>
 * or via gon.js patterns.
 */
export async function extractGon(page) {
  return page.evaluate(() => {
    try {
      // Try direct window.gon access
      if (typeof window.gon !== 'undefined') {
        return JSON.parse(JSON.stringify(window.gon));
      }
    } catch (e) {}

    // Try extracting from <script> tags
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const script of scripts) {
      const text = script.textContent || '';
      // Match window.gon = {...} or var gon = {...}
      const m = text.match(/(?:window\.gon|var gon)\s*=\s*(\{[\s\S]*?\});?\s*(?:window|$|<)/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch (e) {}
      }
      // Alternative: gon.someKey = value pattern
      if (text.includes('gon.product') || text.includes('gon.current_user')) {
        try {
          // Try to build gon from individual assignments
          const gonObj = {};
          const assignments = text.matchAll(/gon\.(\w+)\s*=\s*([^;]+);/g);
          for (const [, key, val] of assignments) {
            try {
              gonObj[key] = JSON.parse(val);
            } catch (e) {}
          }
          if (Object.keys(gonObj).length > 0) return gonObj;
        } catch (e) {}
      }
    }
    return null;
  });
}

/**
 * Extract JSON-LD data from page (SoftwareApplication schema).
 */
export async function extractJsonLd(page) {
  return page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    const results = [];
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        results.push(data);
      } catch (e) {}
    }
    return results;
  });
}

/**
 * Parse a product slug from a G2 URL or slug string.
 * Handles:
 *   - "salesforce-sales-cloud"
 *   - "https://www.g2.com/products/salesforce-sales-cloud/reviews"
 *   - "https://www.g2.com/products/salesforce-sales-cloud"
 */
export function parseProductSlug(input) {
  if (!input) return null;
  const str = input.trim();
  // If it's a URL
  const urlMatch = str.match(/g2\.com\/products\/([^/?#]+)/);
  if (urlMatch) return urlMatch[1];
  // Already a slug (no slashes, no protocol)
  if (!str.includes('/') && !str.includes(':')) return str;
  return null;
}

/**
 * Build the G2 product reviews URL from a slug.
 */
export function buildProductUrl(slug, page = 1) {
  const base = `https://www.g2.com/products/${slug}/reviews`;
  if (page > 1) return `${base}?page=${page}`;
  return base;
}

/**
 * Parse pricing info from various G2 data structures.
 */
export function parsePricingInfo(product) {
  if (!product) return null;

  // Check gon.product pricing fields
  const pricing = product.pricing_plan || product.pricingPlan || product.pricing;
  if (pricing) {
    if (typeof pricing === 'string') return pricing;
    if (pricing.plan_type) {
      const type = pricing.plan_type.toLowerCase();
      if (type.includes('free')) return 'free';
      if (type.includes('freemium')) return 'freemium';
      if (type.includes('paid')) return 'paid';
    }
    if (pricing.starting_price || pricing.startingPrice) {
      const price = pricing.starting_price || pricing.startingPrice;
      return `starts at $${price}/mo`;
    }
  }

  // Check pricing_text
  if (product.pricing_text || product.pricingText) {
    return product.pricing_text || product.pricingText;
  }

  // Check editions
  const editions = product.editions || [];
  if (editions.length > 0) {
    const hasFree = editions.some(e => 
      (e.edition_type || '').toLowerCase().includes('free') ||
      (e.name || '').toLowerCase().includes('free')
    );
    const hasPaid = editions.some(e => 
      e.price && parseFloat(e.price) > 0
    );
    if (hasFree && hasPaid) return 'freemium';
    if (hasFree) return 'free';
    const minPrice = editions
      .filter(e => e.price && parseFloat(e.price) > 0)
      .map(e => parseFloat(e.price))
      .sort((a, b) => a - b)[0];
    if (minPrice) return `starts at $${minPrice}/mo`;
    if (hasPaid) return 'paid';
  }

  return null;
}

/**
 * Parse a single review from G2 data.
 */
export function parseReview(r) {
  return {
    id: r.id || r.review_id || null,
    title: r.title || r.comment_answers?.love?.comment || null,
    rating: r.star_rating || r.rating || null,
    pros: r.comment_answers?.love?.comment || r.pros || null,
    cons: r.comment_answers?.hate?.comment || r.cons || null,
    body: r.love || r.comment || null,
    date: r.submitted_at || r.created_at || r.date || null,
    helpfulCount: r.helpful_count || r.votes_count || 0,
    verified: r.is_verified || r.verified || false,
    reviewer: {
      name: r.reviewer?.name || r.user?.name || null,
      title: r.reviewer?.title || r.user?.title || null,
      companySize: r.reviewer?.company_size || r.user?.company_size || null,
      industry: r.reviewer?.industry || r.user?.industry || null,
      company: r.reviewer?.company || r.user?.company_name || null,
    },
  };
}

/**
 * Parse a product from G2 search results.
 */
export function parseSearchProduct(p) {
  const slug = p.slug || p.product_slug || null;
  return {
    name: p.name || p.product_name || null,
    slug,
    url: slug ? `https://www.g2.com/products/${slug}/reviews` : null,
    logoUrl: p.logo_url || p.image_url || p.logo || null,
    rating: p.rating || p.star_rating || null,
    reviewCount: p.reviews_count || p.review_count || null,
    category: p.category_name || p.primary_category || null,
    categories: p.categories || [],
    shortDescription: p.short_description || p.description || null,
    pricingInfo: parsePricingInfo(p),
  };
}
