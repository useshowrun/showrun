/**
 * Shared utilities for E-commerce Scraper skills.
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
// Price parsing
// ---------------------------------------------------------------------------

/**
 * Parse a price string like "$12.99", "£9.99", "€14,99", "EUR79.52" to a number.
 * Returns { amount, currency, raw }
 */
export function parsePrice(str) {
  if (!str) return null;
  const raw = str.trim();
  
  // Currency code patterns (e.g. "EUR79.52", "USD 14.99")
  const codeMap = {
    "USD": "USD", "EUR": "EUR", "GBP": "GBP", "JPY": "JPY",
    "INR": "INR", "CAD": "CAD", "AUD": "AUD", "MXN": "MXN",
    "BRL": "BRL", "KRW": "KRW", "CNY": "CNY",
  };
  
  // Symbol patterns
  const symMap = {
    "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR", "₩": "KRW",
    "CA$": "CAD", "AU$": "AUD", "C$": "CAD", "A$": "AUD",
  };
  
  let currency = "USD";
  
  // Check for 3-letter currency code prefix
  const codeMatch = raw.match(/^([A-Z]{3})\s*([\d.,]+)/);
  if (codeMatch && codeMap[codeMatch[1]]) {
    currency = codeMap[codeMatch[1]];
    const numStr = codeMatch[2];
    let num;
    if (numStr.includes(",") && !numStr.includes(".")) {
      num = parseFloat(numStr.replace(",", "."));
    } else {
      num = parseFloat(numStr.replace(/,/g, ""));
    }
    if (!isNaN(num)) return { amount: num, currency, raw };
  }
  
  // Check symbol prefix (multi-char first)
  for (const [sym, code] of Object.entries(symMap).sort((a, b) => b[0].length - a[0].length)) {
    if (raw.startsWith(sym)) {
      currency = code;
      break;
    }
  }
  
  // Extract numeric part
  const numStr = raw.replace(/[^0-9.,]/g, "");
  let num;
  if (numStr.includes(",") && !numStr.includes(".")) {
    num = parseFloat(numStr.replace(",", "."));
  } else {
    num = parseFloat(numStr.replace(/,/g, ""));
  }
  if (isNaN(num)) return { amount: null, currency, raw };
  return { amount: num, currency, raw };
}

/**
 * Parse a number text like "4,521" or "1.2K" into a number.
 */
export function parseCount(str) {
  if (!str) return null;
  const clean = str.replace(/,/g, "").trim();
  const m = clean.match(/([\d.]+)\s*([KMBkm]?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
  return Math.round(n * mult);
}

// ---------------------------------------------------------------------------
// Browser creation
// ---------------------------------------------------------------------------

import { Camoufox } from "camoufox-js";

/**
 * Create a camoufox browser configured for Amazon scraping.
 */
export async function createBrowser() {
  return Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1366, minHeight: 768 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/**
 * Create a browser context with Amazon-friendly headers.
 */
export async function createContext(browser, countryCode = "US") {
  const localeMap = {
    US: { locale: "en-US", timezoneId: "America/New_York" },
    UK: { locale: "en-GB", timezoneId: "Europe/London" },
    DE: { locale: "de-DE", timezoneId: "Europe/Berlin" },
    FR: { locale: "fr-FR", timezoneId: "Europe/Paris" },
    JP: { locale: "ja-JP", timezoneId: "Asia/Tokyo" },
    IN: { locale: "en-IN", timezoneId: "Asia/Kolkata" },
  };
  const loc = localeMap[countryCode] || localeMap.US;
  return browser.newContext({
    locale: loc.locale,
    timezoneId: loc.timezoneId,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
    extraHTTPHeaders: {
      "Accept-Language": `${loc.locale},en;q=0.9`,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });
}

// ---------------------------------------------------------------------------
// Amazon domain helpers
// ---------------------------------------------------------------------------

const AMAZON_DOMAINS = {
  US: "amazon.com",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  FR: "amazon.fr",
  JP: "amazon.co.jp",
  IN: "amazon.in",
  CA: "amazon.ca",
  AU: "amazon.com.au",
  MX: "amazon.com.mx",
  BR: "amazon.com.br",
  IT: "amazon.it",
  ES: "amazon.es",
};

export function getAmazonDomain(countryCode = "US") {
  return AMAZON_DOMAINS[countryCode.toUpperCase()] || "amazon.com";
}

/**
 * Detect Amazon country code from a URL.
 */
export function detectCountryFromUrl(url) {
  for (const [code, domain] of Object.entries(AMAZON_DOMAINS)) {
    if (url.includes(domain)) return code;
  }
  return "US";
}

/**
 * Extract ASIN from an Amazon URL or bare ASIN string.
 * ASINs are 10-char alphanumeric IDs.
 */
export function extractAsin(input) {
  if (!input) return null;
  // Already an ASIN (10 chars, alphanumeric)
  if (/^[A-Z0-9]{10}$/.test(input.trim())) return input.trim();
  // URL patterns:
  // /dp/ASIN, /gp/product/ASIN, /product/ASIN
  const m = input.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  return null;
}

// ---------------------------------------------------------------------------
// Amazon product page data extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured product data from an Amazon product page.
 * Runs in Node.js context (not browser). Takes the page HTML as text.
 * 
 * Strategy:
 *  1. Check for embedded JSON data (window.ue_furl, dataLayer, etc.)
 *  2. Fall back to DOM-based extraction
 */

/**
 * Extract the product data from the page using DOM evaluation.
 * This runs as a browser-side script (via page.evaluate).
 */
export const extractAmazonProduct = `
(function() {
  const result = {};

  // ---- Helpers ----
  function text(el) {
    if (!el) return null;
    return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() || null;
  }
  function attr(el, a) {
    if (!el) return null;
    return el.getAttribute(a) || null;
  }
  function q(selector) {
    return document.querySelector(selector);
  }
  function qa(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  // ---- ASIN ----
  // data-asin on add-to-cart form or body
  result.asin = attr(q('[data-asin]'), 'data-asin')
    || attr(q('#addToCart_feature_div'), 'data-asin')
    || attr(q('#ASIN'), 'value')
    || null;
  if (!result.asin) {
    // From URL
    const m = window.location.href.match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i);
    if (m) result.asin = m[1].toUpperCase();
  }

  // ---- Title ----
  result.title = text(q('#productTitle'))
    || text(q('[data-feature-name="title"] h1'))
    || text(q('h1#title'))
    || null;

  // ---- Brand ----
  result.brand = text(q('#bylineInfo'))
    || text(q('[data-feature-name="bylineInfo"] a'))
    || text(q('.po-brand .po-break-word'))
    || null;
  // Strip "Visit the X Store" or "Brand: X" prefix
  if (result.brand) {
    result.brand = result.brand
      .replace(/^(Brand|Visit the|by)\\s*:?\\s*/i, "")
      .replace(/\\s+Store$/, "")
      .trim();
  }

  // ---- Price ----
  // Try multiple selectors for price — Amazon uses different layouts
  const priceSelectors = [
    '.priceToPay .a-offscreen',       // main price (offscreen = accessible)
    '.a-price[data-a-size="xl"] .a-offscreen',
    '.a-price[data-a-size="l"] .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '.a-price .a-offscreen',
    '#corePrice_feature_div .a-offscreen',
    '.apexPriceToPay .a-offscreen',
    '#sns-base-price',
  ];
  for (const sel of priceSelectors) {
    const el = q(sel);
    if (el && text(el)) {
      result.priceRaw = text(el);
      break;
    }
  }

  // Original/list price (crossed out)
  const origPriceSels = [
    '.a-price[data-a-strike="true"] .a-offscreen',
    '#listPrice .a-offscreen',
    '.priceBlockStrikePriceString',
    '.a-text-price .a-offscreen',
    '[data-feature-name="apex_desktop_qualifiedBuybox"] .a-price[data-a-strike="true"] .a-offscreen',
  ];
  for (const sel of origPriceSels) {
    const el = q(sel);
    if (el && text(el)) {
      result.originalPriceRaw = text(el);
      break;
    }
  }

  // Discount percentage
  const savingsEl = q('.savingsPercentage') || q('.a-color-price.a-text-bold');
  if (savingsEl) {
    const sText = text(savingsEl);
    const m = sText && sText.match(/-?(\\d+)\\s*%/);
    if (m) result.discountPercent = parseInt(m[1], 10);
  }

  // ---- Rating ----
  // Amazon puts rating in aria-label on the stars span: "4.7 out of 5 stars"
  // Check multiple selectors in priority order
  const ratingCandidates = [
    '#averageCustomerReviews_feature_div span[aria-label*="out of 5"]',
    '#averageCustomerReviews span[aria-label*="out of 5"]',
    '[data-feature-name="averageCustomerReviews"] span[aria-label*="out of 5"]',
    'span[data-hook="rating-out-of-text"]',
    'a[href*="customerReviews"] i[class*="a-star"] span.a-icon-alt',
    'i[class*="a-star"][aria-label*="out of 5"]',
    '.a-icon-star span.a-icon-alt',
  ];
  let ratingText = null;
  for (const sel of ratingCandidates) {
    const el = q(sel);
    if (el) {
      const candidate = attr(el, 'aria-label') || text(el) || '';
      if (candidate.match(/[\\d.]+\\s*(?:out of|von|sur)/i)) {
        ratingText = candidate;
        break;
      }
    }
  }
  if (ratingText) {
    const rMatch = ratingText.match(/([\\d.]+)\\s*(?:out of|von|sur|de|di)?\\s*5/i);
    if (rMatch) result.rating = parseFloat(rMatch[1]);
  }

  // ---- Review count ----
  // Selectors for review count: "45,671 ratings" or "45,671 global ratings"
  const reviewCountEl = q('#acrCustomerReviewText')
    || q('[data-feature-name="averageCustomerReviews"] #acrCustomerReviewText')
    || q('[data-hook="total-review-count"]')
    || q('#averageCustomerReviews_feature_div #acrCustomerReviewText')
    || q('span[data-hook="total-review-count"]')
    || q('a[href*="#customerReviews"] #acrCustomerReviewText');
  if (reviewCountEl) {
    const rcText = text(reviewCountEl) || "";
    const rcMatch = rcText.match(/([\\d,]+)/);
    if (rcMatch) result.reviewCount = parseInt(rcMatch[1].replace(/,/g, ""), 10);
  }

  // ---- Availability ----
  const availEl = q('#availability')
    || q('[data-feature-name="availability"]')
    || q('#outOfStock');
  if (availEl) {
    result.availability = text(availEl);
    result.inStock = !/out of stock|unavailable|not available/i.test(result.availability || "");
  }

  // ---- Images ----
  // Amazon stores all images in a JS variable 'ImageBlockATF' or in data-a-dynamic-image
  result.images = [];
  
  // Method 1: data-a-dynamic-image attribute (JSON map of url -> [w, h])
  const dynImgEl = q('#landingImage[data-a-dynamic-image]')
    || q('#imgBlkFront[data-a-dynamic-image]')
    || q('[data-a-dynamic-image]');
  if (dynImgEl) {
    try {
      const dynMap = JSON.parse(attr(dynImgEl, 'data-a-dynamic-image'));
      // Sort by resolution (w*h), take largest
      const sorted = Object.entries(dynMap)
        .sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
      for (const [url, dims] of sorted) {
        if (!result.images.find(i => i.url === url)) {
          result.images.push({ url, width: dims[0], height: dims[1] });
        }
      }
    } catch {}
  }

  // Method 2: thumbnail images in the alt-image area
  qa('#altImages li.item img, #imageBlock_feature_div img').forEach(img => {
    // Skip tiny thumbnails (< 50px)
    const src = attr(img, 'src') || attr(img, 'data-old-hires') || '';
    if (!src || src.includes('pixel') || src.includes('transparent')) return;
    // Get high-res version by removing size constraints
    const hiRes = src.replace(/\\._(AC_)?[A-Z_]+\\d+_./, '._SL1500_.');
    if (!result.images.find(i => i.url === src)) {
      result.images.push({ url: src, hiRes });
    }
  });

  // Primary image as fallback
  const mainImg = q('#landingImage') || q('#imgBlkFront') || q('#main-image');
  if (mainImg) {
    const src = attr(mainImg, 'src') || attr(mainImg, 'data-old-hires') || '';
    if (src && !result.images.find(i => i.url === src)) {
      result.images.unshift({ url: src, width: null, height: null });
    }
  }

  // ---- Features / Bullet points ----
  result.features = [];
  const featureItems = qa('#feature-bullets li span.a-list-item, #productFactsDesktop li span.a-list-item, ul.a-unordered-list.a-vertical.a-spacing-mini li span');
  featureItems.forEach(el => {
    const t = text(el);
    if (t && t.length > 5 && !t.includes("Make sure this fits")) {
      result.features.push(t);
    }
  });

  // ---- Product description ----
  const descEl = q('#productDescription p')
    || q('#productDescription')
    || q('[data-feature-name="productDescription"]');
  if (descEl) {
    result.description = text(descEl);
  }

  // ---- Technical specifications (product details table) ----
  result.specifications = {};
  
  // Helper: skip spec entries that contain scripts or are too long (scraped noise)
  function isCleanSpec(val) {
    if (!val) return false;
    if (val.includes('P.when(') || val.includes('function(') || val.includes('var ')) return false;
    if (val.length > 500) return false; // probably scraped scripts
    return true;
  }
  
  // Table format: <table id="productDetails_techSpec_section_1">
  qa('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, .a-keyvalue.prodDetTable tr').forEach(row => {
    const cells = row.querySelectorAll('th, td');
    if (cells.length >= 2) {
      const key = text(cells[0]);
      const val = text(cells[1]);
      if (key && val && isCleanSpec(val)) result.specifications[key] = val;
    }
  });
  // List format: <div id="detailBullets_feature_div"> <li> <span>key</span><span>value</span>
  qa('#detailBullets_feature_div li').forEach(li => {
    const spans = li.querySelectorAll('span.a-text-bold, span:not(.a-text-bold)');
    if (spans.length >= 2) {
      const key = text(spans[0])?.replace(/\\s*:\\s*$/, '');
      const val = text(spans[1]);
      if (key && val && isCleanSpec(val) && !result.specifications[key]) {
        result.specifications[key] = val;
      }
    }
  });

  // ---- Categories / Breadcrumb ----
  result.categories = [];
  qa('#wayfinding-breadcrumbs_feature_div li a, .a-breadcrumb li a').forEach(a => {
    const t = text(a);
    if (t) result.categories.push(t);
  });

  // ---- Seller ----
  const sellerEl = q('#sellerProfileTriggerId')
    || q('[data-feature-name="merchant-info"] a')
    || q('#merchant-info a');
  if (sellerEl) result.soldBy = text(sellerEl);

  // ---- Sold by Amazon ----
  result.soldByAmazon = !!(q('#tabular-buybox-container #tabular-buybox-truncate-1') || 
    /amazon/i.test(result.soldBy || ""));

  // ---- URL ----
  result.url = window.location.href;

  // ---- Best Sellers Rank ----
  result.bestSellersRank = [];
  qa('#productDetails_db_sections .a-list-item, #SalesRank .value').forEach(el => {
    const t = text(el);
    if (t && t.match(/#\\d/)) {
      result.bestSellersRank.push(t.replace(/\\s+/g, " ").trim());
    }
  });
  // From detail bullets
  qa('#detailBulletsWrapper_feature_div li').forEach(li => {
    const t = text(li);
    if (t && t.toLowerCase().includes('best seller')) {
      result.bestSellersRank.push(t.replace(/\\s+/g, " ").trim());
    }
  });

  // ---- Variants / Variations ----
  result.variants = [];
  // Color swatches, size selects
  qa('[id^="variation_color_name"] li, [id^="variation_size_name"] li, [id^="variation_style_name"] li').forEach(li => {
    const varName = attr(li, 'data-defaultasin') || attr(li, 'data-dp-url');
    const title = attr(li.querySelector('img'), 'alt') || text(li) || '';
    if (title) {
      result.variants.push({ title, asin: varName });
    }
  });

  // ---- Number of items in package ----
  // Sometimes useful for unit pricing
  const qtyEl = q('[data-feature-name="packageQuantity"] span')
    || q('.package-quantity');
  if (qtyEl) result.packageQuantity = text(qtyEl);

  return result;
})()
`;

// ---------------------------------------------------------------------------
// Amazon search results extraction
// ---------------------------------------------------------------------------

/**
 * Extract search result items from Amazon search page.
 * Runs in browser context via page.evaluate.
 */
export const extractAmazonSearch = `
(function() {
  const results = [];

  function text(el) {
    if (!el) return null;
    return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() || null;
  }
  function attr(el, a) {
    if (!el) return null;
    return el.getAttribute(a) || null;
  }

  // Amazon search result cards
  // Primary selector: div[data-component-type="s-search-result"]
  const cards = document.querySelectorAll('[data-component-type="s-search-result"]');

  cards.forEach(card => {
    try {
      const item = {};

      // ASIN
      item.asin = attr(card, 'data-asin') || null;
      if (!item.asin || item.asin.length !== 10) return; // skip non-product cards

      // Title — Amazon wraps the product title in an <h2> with a <span> inside.
      // Also check aria-label on the main product link — it often contains full title.
      const titleEl = card.querySelector('h2');
      const titleLink = card.querySelector('h2 a[href]') || card.querySelector('a[href*="/dp/"][aria-label]');
      // Prefer aria-label (most complete) > h2 text > link text
      const ariaLabel = titleLink ? attr(titleLink, 'aria-label') : null;
      const h2Text = text(titleEl);
      item.title = (ariaLabel && ariaLabel.length > (h2Text || '').length ? ariaLabel : h2Text) || null;
      
      // URL — prefer link on/inside h2, fallback to any /dp/ link in card
      const linkEl = titleLink || card.querySelector('a[href*="/dp/"]');
      if (linkEl) {
        const href = attr(linkEl, 'href') || '';
        item.url = href.startsWith('http') ? href : 'https://www.amazon.com' + href;
      }
      
      // Fallback: extract title from the URL slug (e.g. /Sony-WH-CH720N-Noise-Canceling/dp/...)
      if ((!item.title || item.title.length < 15) && item.url) {
        const slugMatch = item.url.match(/amazon\\.com\\/([^/]+)\\/dp\\//);
        if (slugMatch) {
          item.titleFromUrl = decodeURIComponent(slugMatch[1]).replace(/-/g, ' ');
          if (!item.title || item.title.length < item.titleFromUrl.length) {
            item.title = item.titleFromUrl;
          }
        }
        delete item.titleFromUrl;
      }

      // Price
      const priceEl = card.querySelector('.a-price .a-offscreen');
      item.priceRaw = text(priceEl) || null;
      
      // Original price (crossed out)
      const origPriceEl = card.querySelector('.a-price[data-a-strike="true"] .a-offscreen');
      item.originalPriceRaw = text(origPriceEl) || null;

      // Rating — aria-label on the star icon span is the most stable selector
      // Example: aria-label="4.6 out of 5 stars"
      const ratingEl = card.querySelector('span[aria-label*="out of 5"]')
        || card.querySelector('span[aria-label*="von 5"]')   // DE
        || card.querySelector('span[aria-label*="sur 5"]')   // FR
        || card.querySelector('span[aria-label*="su 5"]')    // IT
        || card.querySelector('.a-icon-star-small span.a-icon-alt')
        || card.querySelector('i[class*="a-star"] span.a-icon-alt');
      if (ratingEl) {
        const rText = attr(ratingEl, 'aria-label') || text(ratingEl) || '';
        const m = rText.match(/([\\d.]+)\\s*(?:out of|von|sur|su|de)\\s*5/i);
        if (m) item.rating = parseFloat(m[1]);
      }

      // Review count — aria-label like "4,521 ratings" or just the text
      const reviewEl = card.querySelector('span[aria-label*="ratings"]')
        || card.querySelector('span[aria-label*="Bewertungen"]')  // DE
        || card.querySelector('[data-cy="reviews-ratings-slot"] span[aria-label]')
        || card.querySelector('a[href*="customerReviews"] span');
      if (reviewEl) {
        const rText = attr(reviewEl, 'aria-label') || text(reviewEl) || '';
        const m = rText.match(/([\\d,]+)/);
        if (m) item.reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
      }

      // Thumbnail
      const imgEl = card.querySelector('img.s-image, img[data-image-latency="s-product-image"]');
      item.thumbnailUrl = attr(imgEl, 'src') || null;
      // High-res version
      if (item.thumbnailUrl) {
        item.imageUrl = item.thumbnailUrl.replace(/\\._(AC_)?[A-Z_]+\\d+_./, '._SL500_.');
      }

      // Prime badge
      item.isPrime = !!card.querySelector('[aria-label="Amazon Prime"], .s-prime, i[aria-label*="Prime"]');

      // Sponsored badge
      item.isSponsored = !!card.querySelector('.puis-sponsored-label-info-icon, [aria-label="Sponsored"]');

      // Delivery info
      const deliveryEl = card.querySelector('[data-cy="delivery-recipe"] span, .s-delivery-time');
      item.deliveryInfo = text(deliveryEl) || null;

      // Brand (sometimes in the subtitle below title)
      const brandEl = card.querySelector('.a-row.a-size-base.a-color-secondary span:first-child, [data-cy="title-recipe-unit-count"]');
      // We'll try to extract brand from data
      item.brand = null; // Will be extracted from title or product page if needed

      if (item.asin && (item.title || item.priceRaw)) {
        results.push(item);
      }
    } catch (e) {
      // Skip malformed cards
    }
  });

  // Pagination info
  const totalEl = document.querySelector('[data-component-type="s-result-info-bar"] span:first-child, .a-section.a-spacing-small span:first-child');
  const totalText = totalEl ? (totalEl.innerText || totalEl.textContent || '').trim() : null;

  return {
    results,
    totalText,
    currentPage: null, // will be filled in Node context
  };
})()
`;
