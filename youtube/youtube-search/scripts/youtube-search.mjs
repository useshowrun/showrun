#!/usr/bin/env node

/**
 * YouTube Search Scraper
 *
 * Searches YouTube and returns video results.
 * No API key or login required — extracts from embedded page data (ytInitialData).
 *
 * Usage:
 *   node youtube-search.mjs <query> [maxResults]
 *
 * Examples:
 *   node youtube-search.mjs "space exploration" 20
 *   node youtube-search.mjs "cooking pasta" 10
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - query: the search query
 *   - count: number of results returned
 *   - results[]: array of video items, each with:
 *     { videoId, url, title, channelName, channelId, viewCountText, viewCount,
 *       duration, publishedText, thumbnailUrl, descriptionSnippet }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  extractPageJson, addConsentCookies,
  parseCount, bestThumbnail, runsText,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const query = process.argv[2];
const maxResults = parseInt(process.argv[3] || "20", 10);

if (!query) {
  emitError("MISSING_ARG", "Usage: node youtube-search.mjs <query> [maxResults]");
}

// ---------------------------------------------------------------------------
// Parse video renderer from search results
// ---------------------------------------------------------------------------

function parseVideoRenderer(v) {
  if (!v || !v.videoId) return null;

  const viewCountText = runsText(v.viewCountText) || runsText(v.shortViewCountText) || null;

  // Channel info
  const channelRuns = v.ownerText?.runs || v.longBylineText?.runs || [];
  const channelName = channelRuns[0]?.text || null;
  const channelId = channelRuns[0]?.navigationEndpoint?.browseEndpoint?.browseId || null;
  const channelHandle = channelRuns[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || null;

  // Description snippet
  const descParts = v.detailedMetadataSnippets?.[0]?.snippetText?.runs || [];
  const description = descParts.map(r => r.text).join("") || null;

  return {
    videoId: v.videoId,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    title: runsText(v.title) || null,
    channelName,
    channelId,
    channelUrl: channelHandle
      ? `https://www.youtube.com${channelHandle}`
      : channelId
        ? `https://www.youtube.com/channel/${channelId}`
        : null,
    viewCountText,
    viewCount: parseCount(viewCountText),
    duration: runsText(v.lengthText) || null,
    publishedText: runsText(v.publishedTimeText) || null,
    thumbnailUrl: bestThumbnail(v.thumbnail?.thumbnails) || null,
    descriptionSnippet: description,
    badges: (v.badges || []).map(b => b.metadataBadgeRenderer?.label).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Extract all video results from ytInitialData
// ---------------------------------------------------------------------------

function extractSearchResults(data, max) {
  const results = [];

  try {
    const sections = data.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of sections) {
      const items = section.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const v = item.videoRenderer;
        if (!v) continue;

        const parsed = parseVideoRenderer(v);
        if (parsed) {
          results.push(parsed);
          if (results.length >= max) break;
        }
      }
      if (results.length >= max) break;
    }
  } catch (err) {
    log(`Error extracting results: ${err.message}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
  log(`Searching YouTube: "${query}"`);
  log(`URL: ${searchUrl}`);
  log(`Target: ${maxResults} results`);

  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await addConsentCookies(context);

    const page = await context.newPage();

    log("Navigating to YouTube search...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    const title = await page.title();
    log(`Page title: ${title}`);

    // Handle consent page if still shown
    if (title.includes("consent") || page.url().includes("consent")) {
      try {
        await page.locator('button:has-text("Accept all")').first().click();
        await delay(2000);
      } catch {
        // No consent dialog
      }
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(3000);
    }

    const rawJson = await extractPageJson(page, "ytInitialData");
    if (!rawJson) {
      const bodyLen = await page.evaluate(() => document.body.innerHTML.length);
      log(`Body length: ${bodyLen}`);
      emitError("DATA_NOT_FOUND", "ytInitialData not found in search results page");
    }

    const data = JSON.parse(rawJson);
    log("Parsing search results...");

    const results = extractSearchResults(data, maxResults);

    if (results.length === 0) {
      log("No video results found. Checking page structure...");
      const structure = await page.evaluate(() => ({
        title: document.title,
        url: window.location.href,
        bodyLen: document.body.innerHTML.length,
      }));
      log("Page:", JSON.stringify(structure));
    }

    log(`\nFound ${results.length} videos`);

    emitResult({
      query,
      count: results.length,
      results,
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
