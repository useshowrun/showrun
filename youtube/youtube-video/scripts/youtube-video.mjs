#!/usr/bin/env node

/**
 * YouTube Video Scraper
 *
 * Gets full metadata for a specific YouTube video.
 * No API key or login required — extracts from embedded page data.
 *
 * Usage:
 *   node youtube-video.mjs <videoId|url>
 *
 * Examples:
 *   node youtube-video.mjs dQw4w9WgXcQ
 *   node youtube-video.mjs "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   { videoId, url, title, description, channelId, channelName, channelUrl,
 *     viewCount, likeCount, duration, durationSeconds, publishedDate,
 *     uploadDate, category, keywords, thumbnailUrl, thumbnails,
 *     isFamilySafe, isUnlisted, isLiveBroadcast }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  extractPageJson, addConsentCookies, bestThumbnail, runsText,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const input = process.argv[2];

if (!input) {
  emitError("MISSING_ARG", "Usage: node youtube-video.mjs <videoId|url>");
}

// Resolve video ID
function resolveVideoId(input) {
  // Full URL
  if (input.startsWith("http")) {
    try {
      const url = new URL(input);
      return url.searchParams.get("v") || url.pathname.split("/").pop();
    } catch {
      return input;
    }
  }
  // Short URL youtu.be/ID
  if (input.includes("youtu.be/")) {
    return input.split("youtu.be/").pop().split("?")[0];
  }
  // 11-char video ID
  return input.trim();
}

const videoId = resolveVideoId(input);
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

// ---------------------------------------------------------------------------
// Parse like count from engagement panel (likeButtonViewModel)
// ---------------------------------------------------------------------------

function extractLikeCount(data) {
  try {
    // Look in videoDetails.likeCount (sometimes available)
    // Or in the structured like button data
    const tabs = data.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const tab of tabs) {
      const primaryInfo = tab.videoPrimaryInfoRenderer;
      if (!primaryInfo) continue;

      // Walk through all buttons looking for like data
      const buttons = primaryInfo.videoActions?.menuRenderer?.topLevelButtons || [];
      for (const btn of buttons) {
        // segmentedLikeDislikeButtonViewModel
        const segmented = btn.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel?.likeButtonViewModel;
        if (segmented) {
          const title = segmented.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.title;
          if (title) {
            // "18M" or "18,862,742"
            const clean = title.replace(/,/g, "");
            const mSuffix = clean.match(/([\d.]+)\s*([KMBkm]?)/);
            if (mSuffix) {
              const n = parseFloat(mSuffix[1]);
              const suffix = mSuffix[2].toUpperCase();
              const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix] || 1;
              return Math.round(n * mult);
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Parse channel info from primary info or secondaryInfo
// ---------------------------------------------------------------------------

function extractChannelInfo(data, playerMicroformat) {
  const result = {
    channelId: null,
    channelName: null,
    channelUrl: null,
    channelThumbnailUrl: null,
  };

  try {
    const tabs = data.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const tab of tabs) {
      const secInfo = tab.videoSecondaryInfoRenderer;
      if (!secInfo) continue;

      const owner = secInfo.owner?.videoOwnerRenderer;
      if (owner) {
        result.channelName = runsText(owner.title);
        const endpoint = owner.navigationEndpoint?.browseEndpoint;
        if (endpoint) {
          result.channelId = endpoint.browseId;
          result.channelUrl = `https://www.youtube.com${endpoint.canonicalBaseUrl || "/channel/" + endpoint.browseId}`;
        }
        result.channelThumbnailUrl = bestThumbnail(owner.thumbnail?.thumbnails) || null;
        break;
      }
    }
  } catch {}

  // Fallback from microformat
  if (!result.channelId && playerMicroformat) {
    result.channelId = playerMicroformat.externalChannelId || null;
    result.channelName = playerMicroformat.ownerChannelName || null;
    result.channelUrl = playerMicroformat.ownerProfileUrl || null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching YouTube video: ${videoId}`);
  log(`URL: ${watchUrl}`);

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

    log("Navigating to video page...");
    const response = await page.goto(watchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (response && response.status() === 404) {
      emitError("VIDEO_NOT_FOUND", `Video ${videoId} not found`);
    }

    await delay(3000);

    const title = await page.title();
    log(`Page title: ${title}`);

    if (title.includes("404")) {
      emitError("VIDEO_NOT_FOUND", `Video ${videoId} not found (404)`);
    }

    // Extract ytInitialPlayerResponse (primary video data)
    const playerRaw = await extractPageJson(page, "ytInitialPlayerResponse");
    if (!playerRaw) {
      emitError("DATA_NOT_FOUND", "ytInitialPlayerResponse not found in page");
    }

    const playerData = JSON.parse(playerRaw);

    // Check playability
    const playStatus = playerData.playabilityStatus;
    if (playStatus?.status === "ERROR") {
      emitError("VIDEO_UNAVAILABLE", playStatus.reason || "Video unavailable");
    }

    // Extract ytInitialData (for likes, channel thumbnail)
    const dataRaw = await extractPageJson(page, "ytInitialData");
    const data = dataRaw ? JSON.parse(dataRaw) : null;

    // Video details from player response
    const v = playerData.videoDetails || {};
    const mf = playerData.microformat?.playerMicroformatRenderer || {};

    // Channel info
    const channelInfo = extractChannelInfo(data || {}, mf);

    // Like count (from UI or microformat)
    const likeCount = (data ? extractLikeCount(data) : null) ||
                      (mf.likeCount ? parseInt(mf.likeCount, 10) : null);

    // All thumbnails
    const thumbnails = v.thumbnail?.thumbnails || mf.thumbnail?.thumbnails || [];
    const thumbnailUrl = bestThumbnail(thumbnails) ||
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

    const result = {
      videoId: v.videoId || videoId,
      url: watchUrl,
      title: v.title || null,
      description: v.shortDescription || mf.description?.simpleText || null,
      channelId: v.channelId || channelInfo.channelId,
      channelName: v.author || channelInfo.channelName,
      channelUrl: channelInfo.channelUrl || (v.channelId ? `https://www.youtube.com/channel/${v.channelId}` : null),
      channelThumbnailUrl: channelInfo.channelThumbnailUrl,
      viewCount: v.viewCount ? parseInt(v.viewCount, 10) : null,
      likeCount,
      duration: mf.lengthSeconds ? formatDuration(parseInt(mf.lengthSeconds, 10)) : null,
      durationSeconds: v.lengthSeconds ? parseInt(v.lengthSeconds, 10) : null,
      publishedDate: mf.publishDate || null,
      uploadDate: mf.uploadDate || null,
      category: mf.category || null,
      keywords: v.keywords || [],
      thumbnailUrl,
      thumbnails,
      isFamilySafe: mf.isFamilySafe ?? null,
      isUnlisted: mf.isUnlisted ?? null,
      isLiveBroadcast: v.isLiveContent ?? null,
      isLive: v.isLive ?? null,
    };

    log(`\nExtracted: "${result.title}"`);
    log(`  Channel: ${result.channelName}`);
    log(`  Views: ${result.viewCount?.toLocaleString()}`);
    log(`  Likes: ${result.likeCount?.toLocaleString()}`);
    log(`  Duration: ${result.duration}`);
    log(`  Published: ${result.publishedDate}`);

    emitResult(result);
  } finally {
    await browser.close();
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
