#!/usr/bin/env node

/**
 * YouTube Channel Scraper
 *
 * Fetches a YouTube channel's metadata plus its most recent videos.
 * No API key or login required — extracts from embedded page data (ytInitialData).
 *
 * Usage:
 *   node youtube-channel.mjs <channelId|@handle|username> [maxVideos]
 *
 * Examples:
 *   node youtube-channel.mjs UCpVm7bg6pXKo1Pr6k5kxG9A 30
 *   node youtube-channel.mjs NationalGeographic 20
 *   node youtube-channel.mjs @NatGeo 10
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   - channel: { title, handle, channelId, description, subscriberCount,
 *                videoCount, thumbnailUrl, bannerUrl, canonicalUrl }
 *   - videos[]: up to maxVideos most recent videos
 *     Each video: { videoId, url, title, viewCount, duration, publishedText,
 *                   thumbnailUrl, description }
 *   - meta: { videosReturned, hasContinuation }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  extractPageJson, addConsentCookies, resolveChannelUrls,
  parseSubCount, parseCount, bestThumbnail, runsText,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const input = process.argv[2];
const maxVideos = parseInt(process.argv[3] || "30", 10);

if (!input) {
  emitError("MISSING_ARG", "Usage: node youtube-channel.mjs <channelId|@handle|username> [maxVideos]");
}

// ---------------------------------------------------------------------------
// Parse channel metadata from ytInitialData
// ---------------------------------------------------------------------------

function parseChannelMeta(data) {
  const channel = {};

  // Microformat: title, description, canonical URL, thumbnail
  const mf = data.microformat?.microformatDataRenderer ||
              data.microformat?.channelMicroformatRenderer;
  if (mf) {
    channel.title = mf.title || null;
    channel.description = mf.description || null;
    channel.canonicalUrl = mf.urlCanonical || null;
    channel.thumbnailUrl = bestThumbnail(mf.thumbnail?.thumbnails) || null;
  }

  // Header: handle, subscriber count, video count, avatar, banner
  const headerContent = data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
  if (headerContent) {
    if (!channel.title) {
      channel.title = runsText(headerContent.title);
    }

    // Description from header
    if (!channel.description && headerContent.description) {
      channel.description = runsText(headerContent.description);
    }

    // Metadata rows: ["@NatGeo"], ["25.9M subscribers", "11K videos"]
    const metaRows = headerContent.metadata?.contentMetadataViewModel?.metadataRows || [];
    for (const row of metaRows) {
      const parts = (row.metadataParts || []).map(p => p.text?.content).filter(Boolean);
      for (const part of parts) {
        if (part.startsWith("@")) {
          channel.handle = part;
        } else if (/subscriber/i.test(part)) {
          channel.subscriberCount = parseSubCount(part);
          channel.subscriberCountText = part;
        } else if (/video/i.test(part)) {
          channel.videoCountText = part;
          const m = part.match(/^([\d,.KMB]+)/i);
          if (m) channel.videoCount = parseCount(m[1]);
        }
      }
    }

    // Avatar
    if (!channel.thumbnailUrl) {
      const avatar = headerContent.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel;
      if (avatar) {
        channel.thumbnailUrl = bestThumbnail(avatar.image?.sources) || null;
      }
    }

    // Banner
    const banner = headerContent.banner?.imageBannerViewModel;
    if (banner) {
      channel.bannerUrl = bestThumbnail(banner.image?.sources) || null;
    }
  }

  // Channel ID from canonical URL
  if (channel.canonicalUrl) {
    const m = channel.canonicalUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
    if (m) channel.channelId = m[1];
  }

  return channel;
}

// ---------------------------------------------------------------------------
// Parse video item from richItemRenderer.content.videoRenderer
// ---------------------------------------------------------------------------

function parseVideoItem(v) {
  if (!v) return null;
  const videoId = v.videoId;
  if (!videoId) return null;

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: runsText(v.title) || null,
    viewCount: parseCount(runsText(v.viewCountText)) || null,
    viewCountText: runsText(v.viewCountText) || null,
    duration: runsText(v.lengthText) || null,
    durationSeconds: parseDurationToSeconds(runsText(v.lengthText)),
    publishedText: runsText(v.publishedTimeText) || null,
    thumbnailUrl: bestThumbnail(v.thumbnail?.thumbnails) || null,
    description: runsText(v.descriptionSnippet) || null,
    isLive: !!(v.badges?.find(b => b.metadataBadgeRenderer?.label === "LIVE")),
  };
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return null;
  const parts = durationStr.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ---------------------------------------------------------------------------
// Extract videos from the Videos tab richGridRenderer
// ---------------------------------------------------------------------------

function extractVideosFromData(data, max) {
  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];

  // Try the Videos tab (may or may not be selected)
  for (const tab of tabs) {
    const tabRenderer = tab.tabRenderer;
    if (!tabRenderer) continue;
    if (tabRenderer.title !== "Videos" && !tabRenderer.selected) continue;

    const content = tabRenderer.content;
    const grid = content?.richGridRenderer;
    if (!grid) continue;

    const items = grid.contents || [];
    const videos = [];
    let hasContinuation = false;

    for (const item of items) {
      if (item.continuationItemRenderer) {
        hasContinuation = true;
        continue;
      }
      const vRenderer = item.richItemRenderer?.content?.videoRenderer;
      if (!vRenderer) continue;
      const parsed = parseVideoItem(vRenderer);
      if (parsed) {
        videos.push(parsed);
        if (videos.length >= max) break;
      }
    }

    return { videos, hasContinuation };
  }

  return { videos: [], hasContinuation: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Fetching YouTube channel: ${input}`);
  log(`Max videos: ${maxVideos}`);

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

    // Try candidate URLs — different formats may work for different channels
    const candidateUrls = resolveChannelUrls(input);
    log(`Trying ${candidateUrls.length} candidate URLs...`);

    let ytData = null;
    let loadedUrl = null;

    for (const url of candidateUrls) {
      log(`Trying: ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(2000);

        const title = await page.title();
        if (title.includes("404") || title === "YouTube") {
          log(`  → ${title} (skipping)`);
          continue;
        }

        const rawJson = await extractPageJson(page, "ytInitialData");
        if (!rawJson) {
          log("  → No ytInitialData found (skipping)");
          continue;
        }

        ytData = JSON.parse(rawJson);
        loadedUrl = url;
        log(`  → Loaded! Title: ${title}`);
        break;
      } catch (err) {
        log(`  → Error: ${err.message}`);
      }
    }

    if (!ytData) {
      emitError("CHANNEL_NOT_FOUND", `Could not load channel data for: ${input}`);
    }

    // Parse channel metadata
    const channel = parseChannelMeta(ytData);
    log(`Channel: ${channel.title || "unknown"}`);
    log(`Subscribers: ${channel.subscriberCountText || "unknown"}`);

    // Parse videos
    let { videos, hasContinuation } = extractVideosFromData(ytData, maxVideos);
    log(`Found ${videos.length} videos in initial load`);

    // If we're on the channel home page (not /videos), navigate to /videos tab
    if (videos.length === 0 && loadedUrl && !loadedUrl.includes("/videos")) {
      const videosUrl = loadedUrl.replace(/\/(about|home|shorts|community|playlists)?$/, "/videos");
      log(`Navigating to videos tab: ${videosUrl}`);
      try {
        await page.goto(videosUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(2000);
        const rawJson2 = await extractPageJson(page, "ytInitialData");
        if (rawJson2) {
          const data2 = JSON.parse(rawJson2);
          const result2 = extractVideosFromData(data2, maxVideos);
          videos = result2.videos;
          hasContinuation = result2.hasContinuation;
          log(`Found ${videos.length} videos after navigating to /videos`);
        }
      } catch (err) {
        log(`Error navigating to /videos: ${err.message}`);
      }
    }

    emitResult({
      channel,
      videos,
      meta: {
        videosReturned: videos.length,
        hasContinuation,
        source: loadedUrl,
      },
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
