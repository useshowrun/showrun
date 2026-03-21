#!/usr/bin/env node
/**
 * Amazon Bestsellers Scraper
 *
 * Scrapes the Top 100 (or more with pagination) bestselling products from any Amazon category.
 *
 * Strategy:
 *   1. Navigate to https://www.amazon.com/Best-Sellers/zgbs/<category>/
 *   2. Extract product cards using stable selectors:
 *      - Rank: .zg-bdg-text
 *      - Title: img[alt] (from product image alt attribute) ← stable, never obfuscated
 *      - Rating/Reviews: a[aria-label*="stars"] ← stable aria-label
 *      - Price: .a-size-base.a-color-price ← stable class combo
 *      - Author/Brand: a[href*="/e/"] (author profile link)
 *      - Image: img[data-a-dynamic-image]
 *   3. Paginate for more than 30 items
 *   4. Optionally include subcategory list for navigation
 *
 * URL formats:
 *   /Best-Sellers/zgbs                               - All departments
 *   /Best-Sellers-Books-<slug>/zgbs/books             - Books
 *   /Best-Sellers-Electronics/zgbs/electronics        - Electronics
 *   /Best-Sellers-Toys-Games/zgbs/toys-and-games      - Toys & Games
 *   etc.
 *
 * Usage:
 *   node amazon-bestsellers.mjs [category-url | category-slug] [options]
 *
 * Options:
 *   --category <url|slug>   Category URL or known slug (books, electronics, etc.)
 *   --max <N>               Max products to return (default: 30, max available: 100)
 *   --country US|UK|DE|...  Amazon country (default: US)
 *   --movers                Use "Movers & Shakers" list instead of bestsellers
 *   --new-releases          Use "New Releases" list instead of bestsellers
 *   --subcategories         List available subcategories
 *
 * Known category slugs:
 *   books, electronics, toys-and-games, clothing, shoes, kitchen,
 *   sports-and-outdoors, baby, beauty, health, automotive, pet-supplies,
 *   video-games, movies-and-tv, music, tools, grocery, office-products,
 *   garden, software, industrial, digital-music, amazon-devices
 *
 * Examples:
 *   node amazon-bestsellers.mjs --max 50
 *   node amazon-bestsellers.mjs --category electronics --max 50
 *   node amazon-bestsellers.mjs --category books --max 100
 *   node amazon-bestsellers.mjs --category https://www.amazon.com/Best-Sellers-Books-Mystery/zgbs/books/18 --max 30
 *   node amazon-bestsellers.mjs --category electronics --movers --max 50
 *   node amazon-bestsellers.mjs --category books --subcategories
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createBrowser,
  createContext,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let categoryInput = null;
let maxItems = 30;
let countryCode = "US";
let listType = "bestsellers"; // bestsellers | movers | new-releases
let showSubcategories = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((a === "--category" || a === "-c") && args[i + 1]) categoryInput = args[++i];
  else if (a === "--max" && args[i + 1]) maxItems = parseInt(args[++i], 10);
  else if (a === "--country" && args[i + 1]) countryCode = args[++i].toUpperCase();
  else if (a === "--movers") listType = "movers";
  else if (a === "--new-releases") listType = "new-releases";
  else if (a === "--subcategories") showSubcategories = true;
  else if (!categoryInput && !a.startsWith("--")) categoryInput = a;
}

// ---------------------------------------------------------------------------
// Known category slugs → URL slugs
// ---------------------------------------------------------------------------

const AMAZON_DOMAINS = {
  US: "amazon.com",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  FR: "amazon.fr",
  CA: "amazon.ca",
  JP: "amazon.co.jp",
  ES: "amazon.es",
  IT: "amazon.it",
  AU: "amazon.com.au",
  IN: "amazon.in",
  MX: "amazon.com.mx",
  BR: "amazon.com.br",
};

const domain = AMAZON_DOMAINS[countryCode] || "amazon.com";

// Map common category names to Amazon URL slugs
const CATEGORY_MAP = {
  books: { name: "Books", slug: "books" },
  electronics: { name: "Electronics", slug: "electronics" },
  "toys-and-games": { name: "Toys & Games", slug: "toys-and-games" },
  toys: { name: "Toys & Games", slug: "toys-and-games" },
  clothing: { name: "Clothing, Shoes & Jewelry", slug: "fashion" },
  fashion: { name: "Clothing, Shoes & Jewelry", slug: "fashion" },
  kitchen: { name: "Kitchen & Dining", slug: "kitchen" },
  sports: { name: "Sports & Outdoors", slug: "sporting-goods" },
  "sports-and-outdoors": { name: "Sports & Outdoors", slug: "sporting-goods" },
  baby: { name: "Baby", slug: "baby-products" },
  beauty: { name: "Beauty & Personal Care", slug: "beauty" },
  health: { name: "Health & Household", slug: "hpc" },
  automotive: { name: "Automotive", slug: "automotive" },
  "pet-supplies": { name: "Pet Supplies", slug: "pet-supplies" },
  pets: { name: "Pet Supplies", slug: "pet-supplies" },
  "video-games": { name: "Video Games", slug: "videogames" },
  games: { name: "Video Games", slug: "videogames" },
  "movies-and-tv": { name: "Movies & TV", slug: "dvd" },
  music: { name: "Music", slug: "music" },
  tools: { name: "Tools & Home Improvement", slug: "tools" },
  grocery: { name: "Grocery & Gourmet Food", slug: "grocery" },
  office: { name: "Office Products", slug: "office-products" },
  garden: { name: "Garden & Outdoor", slug: "lawn-and-garden" },
  software: { name: "Software", slug: "software" },
  "amazon-devices": { name: "Amazon Devices", slug: "amazon-devices" },
  "digital-music": { name: "Digital Music", slug: "digital-music" },
  industrial: { name: "Industrial & Scientific", slug: "industrial" },
  handmade: { name: "Handmade Products", slug: "handmade" },
};

const LIST_TYPE_PATHS = {
  bestsellers: "zgbs",
  movers: "gp/movers-and-shakers",
  "new-releases": "gp/new-releases",
};

function buildBestsellerUrl(categoryInput, listType) {
  const base = `https://www.${domain}`;

  // Full URL provided
  if (categoryInput && categoryInput.startsWith("http")) {
    return categoryInput;
  }

  // Resolve category slug
  const catSlug = categoryInput
    ? (CATEGORY_MAP[categoryInput.toLowerCase()]?.slug || categoryInput)
    : null;

  if (listType === "bestsellers") {
    if (!catSlug) return `${base}/Best-Sellers/zgbs`;
    return `${base}/Best-Sellers/zgbs/${catSlug}`;
  } else if (listType === "movers") {
    if (!catSlug) return `${base}/gp/movers-and-shakers`;
    return `${base}/gp/movers-and-shakers/${catSlug}`;
  } else if (listType === "new-releases") {
    if (!catSlug) return `${base}/gp/new-releases`;
    return `${base}/gp/new-releases/${catSlug}`;
  }

  // Fallback
  if (!catSlug) return `${base}/Best-Sellers/zgbs`;
  return `${base}/Best-Sellers/zgbs/${catSlug}`;
}

// ---------------------------------------------------------------------------
// Item extraction
// ---------------------------------------------------------------------------

function extractBestsellerItems(items) {
  return items
    .filter((item) => item.asin && item.title)
    .map((item) => ({
      asin: item.asin,
      rank: item.rank,
      title: item.title,
      url: item.productUrl,
      price: item.price,
      priceAmount: item.price
        ? parseFloat(item.price.replace(/[^0-9.]/g, "")) || null
        : null,
      rating: item.rating,
      reviewCount: item.reviewCount,
      author: item.author || null,
      format: item.format || null,
      imageUrl: item.imageUrl,
    }));
}

// ---------------------------------------------------------------------------
// Page extraction function (run in browser context)
// ---------------------------------------------------------------------------

const EXTRACT_PAGE_FN = () => {
  const asinDivs = Array.from(document.querySelectorAll("[data-asin]"));
  const results = [];

  for (const div of asinDivs) {
    const asin = div.getAttribute("data-asin");
    if (!asin || asin.length < 5) continue;

    // Rank
    const rankEl = div.querySelector(".zg-bdg-text");
    const rank = rankEl
      ? parseInt(rankEl.textContent.replace("#", ""), 10)
      : null;

    // Title from image alt attribute (stable across Amazon deploys)
    // Skip small arrow/badge images (they have no data-a-dynamic-image and are very small)
    // Product images always have data-a-dynamic-image attribute
    let imgEl = div.querySelector("img[data-a-dynamic-image]") || div.querySelector("img[alt]");
    // If the first img alt is an arrow indicator, skip to the next one with actual title
    if (imgEl && imgEl.getAttribute("alt") && imgEl.getAttribute("alt").toLowerCase().includes("arrow")) {
      const allImgs = div.querySelectorAll("img[alt]");
      for (const img of allImgs) {
        if (!img.getAttribute("alt").toLowerCase().includes("arrow") && img.getAttribute("alt").trim().length > 3) {
          imgEl = img;
          break;
        }
      }
    }
    const title = imgEl?.getAttribute("alt") || null;
    const rawImageUrl = imgEl?.src || imgEl?.getAttribute("data-src") || null;
    // Get highest quality image URL from data-a-dynamic-image JSON
    let imageUrl = rawImageUrl;
    const dynamicData = imgEl?.getAttribute("data-a-dynamic-image");
    if (dynamicData) {
      try {
        const images = JSON.parse(dynamicData.replace(/&quot;/g, '"'));
        const urls = Object.keys(images);
        if (urls.length > 0) {
          // Pick the largest image
          let maxArea = 0;
          for (const url of urls) {
            const [w, h] = images[url];
            if (w * h > maxArea) {
              maxArea = w * h;
              imageUrl = url;
            }
          }
        }
      } catch (e) {}
    }

    // Product URL (first /dp/ link)
    const dpLinks = div.querySelectorAll("a[href*='/dp/']");
    let productUrl = null;
    for (const link of dpLinks) {
      const href = link.getAttribute("href");
      if (href && href.includes("/dp/")) {
        // Use absolute URL from href or construct one
        if (href.startsWith("http")) {
          productUrl = href.split("?")[0];
        } else {
          productUrl = "https://" + location.hostname + href.split("?")[0];
        }
        break;
      }
    }

    // Rating and review count from stable aria-label
    const ratingLink = div.querySelector(
      'a[aria-label*="stars"], a[aria-label*="rating"]'
    );
    const ratingLabel = ratingLink?.getAttribute("aria-label") || "";
    const ratingMatch = ratingLabel.match(/([\d.]+)\s+out\s+of\s+5/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
    const reviewMatch = ratingLabel.match(/([\d,]+)\s+rating/);
    const reviewCount = reviewMatch
      ? parseInt(reviewMatch[1].replace(/,/g, ""), 10)
      : null;

    // Price - using stable class combo .a-size-base.a-color-price
    // Use textContent (works even when innerText is not available in serialized fn context)
    let price = null;
    // Target leaf elements that contain just price text (not containers)
    const priceEls = div.querySelectorAll(".a-size-base.a-color-price, [class*='p13n-sc-price']");
    for (const el of priceEls) {
      // Skip elements with many child elements (they're containers, not leaf price els)
      if (el.children.length > 2) continue;
      const text = (el.textContent || el.innerText || "").trim();
      // Accept price-like strings: short, contains a digit
      if (text && text.length > 0 && text.length < 25) {
        // Check for digit presence (mandatory for price)
        let hasDigit = false;
        for (let ci = 0; ci < text.length; ci++) {
          const code = text.charCodeAt(ci);
          if (code >= 48 && code <= 57) { hasDigit = true; break; }
        }
        if (hasDigit) {
          price = text;
          break;
        }
      }
    }

    // Author/Brand from author profile link (href contains /e/)
    const authorLink = div.querySelector("a[href*='/e/']");
    const author = authorLink?.innerText?.trim() || null;

    // Format (Hardcover, Paperback, Kindle, etc.)
    const formatEl = div.querySelector(
      ".a-size-small.a-color-secondary.a-text-normal"
    );
    const format = formatEl?.innerText?.trim() || null;

    results.push({
      asin,
      rank,
      title,
      productUrl,
      price,
      rating,
      reviewCount,
      author,
      format,
      imageUrl,
    });
  }

  return results;
};

// ---------------------------------------------------------------------------
// Subcategories extraction
// ---------------------------------------------------------------------------

const EXTRACT_SUBCATEGORIES_FN = () => {
  const links = document.querySelectorAll(
    "#zg-left-col a, .ul-zg-browse a, [class*='zg-browse'] a, [id*='zg_browseRoot'] a"
  );
  return Array.from(links)
    .map((a) => ({
      title: a.innerText?.trim(),
      url: a.href,
    }))
    .filter((c) => c.title && c.url);
};

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------

async function main() {
  const targetUrl = buildBestsellerUrl(categoryInput, listType);
  log(`[INFO] Amazon Bestsellers Scraper`);
  log(`[INFO] URL: ${targetUrl}`);
  log(`[INFO] List type: ${listType}, Max items: ${maxItems}`);

  const browser = await createBrowser(Camoufox);
  const ctx = await createContext(browser);

  try {
    const page = await ctx.newPage();

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await delay(4000);

    // Check for CAPTCHA
    const title = await page.title();
    log(`[INFO] Page title: ${title}`);
    if (
      title.toLowerCase().includes("captcha") ||
      title.toLowerCase().includes("robot")
    ) {
      emitError("CAPTCHA", "Amazon CAPTCHA detected. Try again later.");
    }

    // Get page info
    const pageUrl = page.url();
    const categoryName = await page
      .evaluate(
        () =>
          document.querySelector("h1.a-size-base-plus, h1")?.innerText?.trim()
      )
      .catch(() => null);
    log(`[INFO] Category: ${categoryName || "Unknown"}`);

    // Get subcategories if requested
    let subcategories = [];
    if (showSubcategories) {
      subcategories = await page.evaluate(EXTRACT_SUBCATEGORIES_FN).catch(() => []);
      log(`[INFO] Found ${subcategories.length} subcategories`);
    }

    // Extract items from first page
    let allItems = [];
    const firstPageItems = await page.evaluate(EXTRACT_PAGE_FN).catch(() => []);
    allItems.push(...firstPageItems);
    log(`[INFO] Page 1: ${firstPageItems.length} items`);

    // Paginate for more items (Amazon bestsellers have up to 100 per list)
    let pageNum = 2;
    while (allItems.length < maxItems) {
      // Find next page URL
      const nextUrl = await page.evaluate(() => {
        const nextEl = document.querySelector(
          ".a-pagination .a-last a, [class*='pagination'] .a-last a, a[aria-label='Next page']"
        );
        return nextEl?.href || null;
      });

      if (!nextUrl) {
        log(`[INFO] No more pages`);
        break;
      }

      log(`[INFO] Navigating to page ${pageNum}...`);
      await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(3000);

      const pageItems = await page.evaluate(EXTRACT_PAGE_FN).catch(() => []);
      log(`[INFO] Page ${pageNum}: ${pageItems.length} items`);

      if (pageItems.length === 0) break;

      allItems.push(...pageItems);
      pageNum++;
    }

    // Parse and limit
    const parsedItems = extractBestsellerItems(allItems).slice(0, maxItems);
    log(`[INFO] Total items extracted: ${parsedItems.length}`);

    const result = {
      categoryUrl: targetUrl,
      categoryName: categoryName || null,
      listType,
      country: countryCode,
      totalLoaded: parsedItems.length,
      items: parsedItems,
      ...(showSubcategories ? { subcategories } : {}),
      scrapedAt: new Date().toISOString(),
    };

    emitResult(result);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("SCRAPER_ERROR", String(err.message || err));
});
