#!/usr/bin/env node

/**
 * Facebook Ad Library Scraper
 *
 * Searches the public Facebook Ad Library for ads by keyword or advertiser.
 * No login required — Ad Library is publicly accessible.
 *
 * Strategy:
 *   1. Navigate to https://www.facebook.com/ads/library/ with search params
 *   2. DOM parsing to extract ad cards
 *   3. Each card is identified by unique "Library ID:"
 *   4. Scroll to load more ads (pagination via infinite scroll)
 *
 * Ad card data extracted via DOM:
 *   - Library ID (unique numeric ID)
 *   - Status (active/inactive)
 *   - Date range (start, end)
 *   - Advertiser name + page URL
 *   - Ad text
 *   - Ad images (thumbnail + full size from CDN)
 *   - Video URLs
 *   - External landing page links
 *   - Platforms
 *   - EU transparency flag
 *
 * Usage:
 *   node facebook-ad-library.mjs <keyword> [options]
 *
 * Options:
 *   --type keyword_unordered|keyword_exact_phrase|page  Search type (default: keyword_unordered)
 *   --country US|ALL|DE|...                             Country code (default: US)
 *   --status active|inactive|all                        Ad status (default: all)
 *   --media all|image|video|meme|no_image               Media type filter (default: all)
 *   --max <N>                                           Max ads to return (default: 20)
 *
 * Examples:
 *   node facebook-ad-library.mjs "nike shoes"
 *   node facebook-ad-library.mjs apple --type keyword_exact_phrase --status active --max 50
 *   node facebook-ad-library.mjs --type page "Nike" --country ALL
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  createFbBrowser,
  createFbContext,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let keyword = null;
let searchType = "keyword_unordered";
let country = "US";
let adStatus = "all";
let mediaType = "all";
let maxAds = 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--type" && args[i + 1]) {
    searchType = args[++i];
  } else if (args[i] === "--country" && args[i + 1]) {
    country = args[++i].toUpperCase();
  } else if (args[i] === "--status" && args[i + 1]) {
    adStatus = args[++i];
  } else if (args[i] === "--media" && args[i + 1]) {
    mediaType = args[++i];
  } else if (args[i] === "--max" && args[i + 1]) {
    maxAds = parseInt(args[++i], 10);
  } else if (!keyword) {
    keyword = args[i];
  }
}

if (!keyword) {
  emitError("MISSING_ARG", "Usage: facebook-ad-library.mjs <keyword> [--type keyword_unordered|keyword_exact_phrase|page] [--country US] [--status active|inactive|all] [--media all|image|video|meme|no_image] [--max N]");
}

// ---------------------------------------------------------------------------
// Build Ad Library URL
// ---------------------------------------------------------------------------

function buildAdLibraryUrl() {
  const params = new URLSearchParams({
    active_status: adStatus === "all" ? "all" : adStatus,
    ad_type: "all",
    country,
    is_targeted_country: "false",
    media_type: mediaType,
    q: keyword,
    search_type: searchType,
    "sort_data[mode]": "total_impressions",
    "sort_data[direction]": "desc",
  });

  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Parse ad cards from DOM
// ---------------------------------------------------------------------------

async function parseAdsFromDom(page) {
  return page.evaluate(() => {
    const ads = new Map(); // libraryId -> ad data (dedup)

    // Find ad card containers by walking up from Library ID text nodes
    // Strategy: walk up until libIdCount changes from 1 to 2+, use the "prev" (single card)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const cardElements = [];

    while (node = walker.nextNode()) {
      if (!node.textContent?.trim().startsWith("Library ID:")) continue;

      // Walk up the ancestor chain to find the card boundary
      let el = node.parentElement;
      let prev = el;
      for (let i = 0; i < 30 && el; i++) {
        const text = el.innerText || "";
        const libIdCount = (text.match(/Library ID:/g) || []).length;
        if (libIdCount > 1) {
          // 'prev' is the ad card container
          cardElements.push(prev);
          break;
        }
        prev = el;
        el = el.parentElement;
      }
    }

    for (const cardEl of cardElements) {
      const el = cardEl;

      const text = el.innerText || "";
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      // Library ID
      const libIdMatch = text.match(/Library ID:\s*([\d]+)/);
      const libraryId = libIdMatch?.[1] || null;
      if (!libraryId || ads.has(libraryId)) continue;

      // Status (first meaningful line)
      const status = text.match(/^Inactive/m) ? "inactive" : text.match(/^Active/m) ? "active" : "unknown";

      // Dates
      let startDate = null;
      let endDate = null;
      const dateRangeMatch = text.match(
        /((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4})\s*-\s*((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4})/
      );
      if (dateRangeMatch) {
        startDate = dateRangeMatch[1];
        endDate = dateRangeMatch[3];
      }
      const startedMatch = text.match(/Started running on (.+?)(?:\n|$)/);
      if (startedMatch && !startDate) startDate = startedMatch[1].trim();

      // Advertiser name (line before "Sponsored")
      const sponsoredIdx = lines.indexOf("Sponsored");
      const advertiser = sponsoredIdx > 0 ? lines[sponsoredIdx - 1] : null;

      // Ad text (lines after "Sponsored" until stop patterns)
      let adText = null;
      if (sponsoredIdx >= 0) {
        const stopPattern =
          /^(Like|Comment|Share|See all|Learn more|Open Dropdown|See summary|See ad details|See[\s\w]+details|\d+:\d+\s*\/\s*\d+:\d+)$/i;
        const textLines = [];
        for (
          let i = sponsoredIdx + 1;
          i < lines.length && i < sponsoredIdx + 30;
          i++
        ) {
          const l = lines[i];
          if (stopPattern.test(l)) break;
          // Skip engagement number-only lines
          if (/^\d+[KMBkmb]?$/.test(l) && l.length < 8) continue;
          textLines.push(l);
        }
        adText = textLines.join("\n").trim() || null;
        // Cap at 2000 chars
        if (adText && adText.length > 2000) adText = adText.substring(0, 2000) + "...";
      }

      // Advertiser page URL
      let advertiserUrl = null;
      const cardLinks = Array.from(el.querySelectorAll("a[href]"));
      for (const link of cardLinks) {
        const href = link.href || "";
        const linkText = link.innerText?.trim() || "";
        if (
          href.includes("facebook.com/") &&
          !href.includes("/ads/library") &&
          !href.includes("/about") &&
          !href.includes("l.php") &&
          (linkText === advertiser || link.closest('[aria-label*="ad"]'))
        ) {
          advertiserUrl = href.split("?")[0]; // strip query params
          break;
        }
      }

      // Ad images (from CDN, not ad profile pics which are small)
      const images = Array.from(el.querySelectorAll("img[src]"))
        .map((img) => img.src)
        .filter((src) => src.includes("fbcdn") && !src.includes("s40x40") && !src.includes("s60x60"));

      // Videos
      const videos = [
        ...Array.from(el.querySelectorAll("video source[src]")).map((v) => v.src),
        ...Array.from(el.querySelectorAll("video[src]")).map((v) => v.src),
      ].filter(Boolean);

      // External links (landing pages)
      const externalLinks = cardLinks
        .map((l) => {
          const href = l.href || "";
          if (href.includes("l.facebook.com/l.php") || href.includes("lm.facebook.com")) {
            try {
              const url = new URL(href);
              const u = url.searchParams.get("u") || url.searchParams.get("href");
              return u ? decodeURIComponent(u) : null;
            } catch {
              return null;
            }
          }
          return null;
        })
        .filter((u) => u && !u.includes("facebook.com"));

      // Platforms
      const platforms = [];
      if (text.includes("Facebook")) platforms.push("facebook");
      if (text.includes("Instagram")) platforms.push("instagram");
      if (text.includes("Messenger")) platforms.push("messenger");
      if (text.includes("Audience Network")) platforms.push("audience_network");
      if (text.includes("WhatsApp")) platforms.push("whatsapp");

      ads.set(libraryId, {
        libraryId,
        status,
        startDate,
        endDate,
        advertiser,
        advertiserUrl,
        adText,
        images: images.slice(0, 5),
        videoUrls: videos.slice(0, 3),
        landingPageUrls: [...new Set(externalLinks)].slice(0, 3),
        platforms: [...new Set(platforms)],
        hasMultipleVersions: text.includes("multiple versions"),
        hasEuTransparency: text.includes("EU transparency"),
        adLibraryUrl: `https://www.facebook.com/ads/library/?id=${libraryId}`,
      });
    }

    return Array.from(ads.values());
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const adLibUrl = buildAdLibraryUrl();
  log(`Fetching Facebook Ad Library`);
  log(`Keyword: "${keyword}", Country: ${country}, Status: ${adStatus}, Max: ${maxAds}`);
  log(`URL: ${adLibUrl}`);

  const browser = await createFbBrowser(Camoufox);

  try {
    const context = await createFbContext(browser);
    const page = await context.newPage();

    log("Navigating to Ad Library...");
    await page.goto(adLibUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await delay(8000);

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    const title = await page.title();
    log(`Title: ${title}`);

    if (title === "" || title === "Facebook") {
      emitError("LOAD_FAILED", "Failed to load Ad Library — may be blocked");
    }

    // Get total result count
    const totalCount = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const match = bodyText.match(/(>?\d[\d,]*)\s+results?/i);
      return match ? match[0] : null;
    });
    log(`Results count: ${totalCount}`);

    // Initial parse
    let allAds = await parseAdsFromDom(page);
    log(`Initial parse: ${allAds.length} unique ads`);

    // Scroll to load more if needed
    let scrollAttempts = 0;
    const maxScrolls = 30;
    let noNewAdCount = 0;

    while (allAds.length < maxAds && scrollAttempts < maxScrolls) {
      scrollAttempts++;
      const prevCount = allAds.length;

      const currentScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate((px) => window.scrollTo(0, px), currentScroll + 600);
      await delay(2500);

      const newAds = await parseAdsFromDom(page);
      if (newAds.length > prevCount) {
        allAds = newAds;
        noNewAdCount = 0;
        log(`Scroll ${scrollAttempts}: ${allAds.length} unique ads`);
      } else {
        noNewAdCount++;
        if (noNewAdCount >= 4) {
          log(`${noNewAdCount} consecutive scrolls with no new ads — stopping`);
          break;
        }
      }
    }

    const finalAds = allAds.slice(0, maxAds);

    log(`\nFinal result:`);
    log(`  Total results on page: ${totalCount}`);
    log(`  Ads returned: ${finalAds.length}`);
    log(`  Has more: ${finalAds.length < allAds.length || allAds.length >= maxAds}`);

    emitResult({
      keyword,
      country,
      adStatus,
      searchType,
      totalCountText: totalCount,
      ads: finalAds,
      meta: {
        returned: finalAds.length,
        hasMore: allAds.length >= maxAds,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
