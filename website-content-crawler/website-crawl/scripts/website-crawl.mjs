#!/usr/bin/env node

/**
 * Website Content Crawler
 *
 * Crawls a website and extracts text content, markdown, metadata, and links.
 * Supports single-page scraping or multi-page crawling with depth control.
 * Uses camoufox-js (Firefox anti-detect browser) for JavaScript-rendered pages.
 *
 * Usage:
 *   node website-crawl.mjs <url> [maxPages] [maxDepth] [sameDomainOnly]
 *
 * Examples:
 *   node website-crawl.mjs https://example.com
 *   node website-crawl.mjs https://docs.example.com 20 2 true
 *   node website-crawl.mjs https://blog.example.com 10 3 true
 *
 * Arguments:
 *   url            - Starting URL (required)
 *   maxPages       - Maximum number of pages to crawl (default: 1)
 *   maxDepth       - Maximum link-follow depth (default: 1, 0 = single page only)
 *   sameDomainOnly - Only follow links on the same domain (default: true)
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs to stderr
 *
 * Result format:
 *   {
 *     startUrl: string,
 *     crawledCount: number,
 *     pages: [
 *       {
 *         url: string,
 *         title: string,
 *         markdown: string,         // cleaned Markdown content
 *         text: string,             // plain text (capped at 10k chars)
 *         metadata: {               // meta tags
 *           description, author, publishedDate, keywords, image, canonical, language
 *         },
 *         links: [{ href, text }],  // extracted links (up to 200)
 *         depth: number,            // crawl depth (0 = start page)
 *         status: "ok" | "error",
 *         error: string | null,
 *         crawledAt: ISO8601,
 *       }
 *     ]
 *   }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  normalizeUrl,
  isSameDomain,
  isWebPage,
  extractPageContent,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const startUrl = process.argv[2];
const maxPages = parseInt(process.argv[3] || "1", 10);
const maxDepth = parseInt(process.argv[4] || "1", 10);
const sameDomainOnly = (process.argv[5] || "true").toLowerCase() !== "false";

if (!startUrl) {
  emitError(
    "MISSING_ARG",
    "Usage: node website-crawl.mjs <url> [maxPages] [maxDepth] [sameDomainOnly]"
  );
}

// Validate URL
try {
  new URL(startUrl);
} catch {
  emitError("INVALID_URL", `Invalid URL: ${startUrl}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_TIMEOUT_MS = 30000;    // 30s timeout per page
const NAVIGATION_WAIT = 2000;     // 2s wait after navigation
const BETWEEN_PAGES_DELAY = 1500; // 1.5s between pages (polite crawling)

// ---------------------------------------------------------------------------
// Crawl a single page
// ---------------------------------------------------------------------------

async function crawlPage(page, url, depth) {
  log(`[depth=${depth}] Crawling: ${url}`);

  const result = {
    url,
    title: "",
    markdown: "",
    text: "",
    metadata: {},
    links: [],
    depth,
    status: "ok",
    error: null,
    crawledAt: new Date().toISOString(),
  };

  try {
    // Navigate
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Check HTTP status
    if (response) {
      const status = response.status();
      if (status >= 400) {
        result.status = "error";
        result.error = `HTTP ${status}`;
        log(`  → HTTP error ${status}`);
        return result;
      }
    }

    // Wait for content to settle
    await delay(NAVIGATION_WAIT);

    // Try to wait for network idle (JS-heavy pages)
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // OK — page might be constantly loading resources
    }

    // Handle cookie consent dialogs
    await dismissCookieBanners(page);

    // Extract content
    const extracted = await page.evaluate(extractPageContent);

    result.title = extracted.title || "";
    result.markdown = extracted.markdown || "";
    result.text = extracted.text || "";
    result.metadata = extracted.metadata || {};
    result.links = extracted.links || [];
    result.url = extracted.url || url; // actual URL after redirects

    log(`  → OK: "${result.title.substring(0, 60)}" — ${result.markdown.length} chars markdown, ${result.links.length} links`);

  } catch (err) {
    result.status = "error";
    result.error = err.message;
    log(`  → Error: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dismiss common cookie/consent banners
// ---------------------------------------------------------------------------

async function dismissCookieBanners(page) {
  const bannerSelectors = [
    // Exact text matches
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept Cookies")',
    'button:has-text("I Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button[aria-label*="Accept"]',
    'button[aria-label*="accept"]',
    '[class*="cookie"] button',
    '[id*="cookie"] button',
    '[class*="consent"] button[class*="accept"]',
    '[id*="consent"] button[class*="accept"]',
    // Common frameworks
    '#onetrust-accept-btn-handler',
    '.cc-accept',
    '#accept-recommended-btn-handler',
  ];

  for (const sel of bannerSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click({ timeout: 2000 });
        await delay(500);
        log(`  → Dismissed cookie banner: ${sel}`);
        return;
      }
    } catch {
      // Not found or not clickable, try next
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve and filter links from a crawled page
// ---------------------------------------------------------------------------

function extractCrawlableLinks(pageResult, baseUrl, sameDomainOnly) {
  const urls = [];
  for (const link of pageResult.links) {
    const normalized = normalizeUrl(link.href, pageResult.url);
    if (!normalized) continue;
    if (!isWebPage(normalized)) continue;
    if (sameDomainOnly && !isSameDomain(normalized, baseUrl)) continue;
    urls.push(normalized);
  }
  return [...new Set(urls)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Main crawl loop
// ---------------------------------------------------------------------------

async function crawl() {
  log(`Starting crawl: ${startUrl}`);
  log(`Settings: maxPages=${maxPages}, maxDepth=${maxDepth}, sameDomainOnly=${sameDomainOnly}`);

  const browser = await Camoufox({
    headless: true,
    humanize: 0.5,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  const pages = [];
  const visited = new Set();
  const queue = [{ url: normalizeUrl(startUrl, startUrl), depth: 0 }];

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await context.newPage();

    // Block unnecessary resources to speed up crawling
    await page.route("**/*", async (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        // Allow stylesheets for JS-dependent rendering; block heavy media
        if (resourceType === "media" || resourceType === "font") {
          await route.abort();
          return;
        }
      }
      await route.continue();
    });

    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth } = queue.shift();

      if (visited.has(url)) continue;
      visited.add(url);

      const result = await crawlPage(page, url, depth);
      pages.push(result);

      // Enqueue child links if we haven't hit depth limit and we have budget
      if (result.status === "ok" && depth < maxDepth && pages.length < maxPages) {
        const childLinks = extractCrawlableLinks(result, startUrl, sameDomainOnly);
        log(`  → Found ${childLinks.length} crawlable links at depth ${depth}`);

        for (const childUrl of childLinks) {
          if (!visited.has(childUrl) && pages.length + queue.length < maxPages * 2) {
            queue.push({ url: childUrl, depth: depth + 1 });
          }
        }
      }

      // Polite delay between pages
      if (queue.length > 0 && pages.length < maxPages) {
        await delay(BETWEEN_PAGES_DELAY);
      }
    }

  } finally {
    await browser.close();
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pages = await crawl();

  const successPages = pages.filter(p => p.status === "ok");
  const errorPages = pages.filter(p => p.status === "error");

  log(`\nCrawl complete: ${pages.length} pages (${successPages.length} OK, ${errorPages.length} errors)`);

  emitResult({
    startUrl,
    crawledCount: pages.length,
    successCount: successPages.length,
    errorCount: errorPages.length,
    pages,
  });
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
