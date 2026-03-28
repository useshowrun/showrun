#!/usr/bin/env node
/**
 * YouTube Video Scraper
 *
 * Scrapes YouTube public content without requiring a login account:
 *   - Search results (videos, channels, playlists) with pagination
 *   - Channel videos, shorts, playlists (paginated)
 *   - Channel metadata (subscriber count, description)
 *   - Video metadata (title, views, duration, description)
 *   - Comments (paginated, including replies)
 *
 * Strategy:
 *   YouTube's internal API (youtubei/v1) is accessible without auth for public data.
 *   All requests are made via page.evaluate(fetch(...)) from within Chrome's browser
 *   context (Playwright/CDP). This avoids bot detection and CORS restrictions.
 *   No X-Bogus, no signature computation needed — unlike TikTok.
 *
 * Usage:
 *   node video-scraper.mjs search <query> [--limit=20] [--pages=3] [--filter=videos|channels|playlists]
 *   node video-scraper.mjs channel <channelId|@handle> [--tab=videos|shorts|playlists] [--pages=3]
 *   node video-scraper.mjs video <videoId>
 *   node video-scraper.mjs comments <videoId> [--pages=3]
 *
 * Options:
 *   --output=<file>       Save results to JSON file
 *   --cdp-url=<url>       Connect to existing Chrome (default: http://localhost:9333)
 *   --no-headless         Show browser window (useful for debugging)
 *   --delay=<ms>          Delay between requests (default: 1500ms)
 *   --pages=<n>           Max pages to fetch (default: 3)
 *   --limit=<n>           Max items to return
 *
 * Requires:
 *   - Node.js 22+
 *   - playwright npm package (global: sudo npm install -g playwright)
 *   - Google Chrome or Chromium
 *
 * Exit codes:
 *   0  Success
 *   1  General error
 *   2  Video/channel not found or unavailable
 *   3  Login required (private content)
 *   4  WAF/bot block detected
 *   5  Rate limited — wait and retry
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YOUTUBE_BASE_URL = 'https://www.youtube.com';
const INNERTUBE_BASE = `${YOUTUBE_BASE_URL}/youtubei/v1`;
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DEFAULT_CLIENT_VERSION = '2.20260325.08.00';

// Tab params (URL-encoded base64) — extracted from YouTube's own tab endpoint data
const TAB_PARAMS = {
  home:      'EghmZWF0dXJlZPIGBAoCMgA%3D',
  videos:    'EgZ2aWRlb3PyBgQKAjoA',
  shorts:    'EgZzaG9ydHPyBgUKA5oBAA%3D%3D',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
  posts:     'EgVwb3N0c_IGBAoCSgA%3D',
};

// Search filter params (base64)
const SEARCH_FILTERS = {
  all:       '',
  videos:    'EgIQAQ==',
  channels:  'EgIQAg==',
  playlists: 'EgIQAw==',
  date:      'CAISAhAB', // videos by upload date
};

const CHROME_EXECUTABLES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const DEFAULT_CDP_URLS = [
  'http://localhost:9333',
  'http://localhost:9222',
];

const DEFAULT_DELAY_MS = 1500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function log(...args) {
  if (!process.env.QUIET) console.error('[youtube]', ...args);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs(argv) {
  const args = { flags: {}, positional: [] };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args.flags[key] = rest.length ? rest.join('=') : true;
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function getText(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs) return obj.runs.map(r => r.text || '').join('');
  return null;
}

function extractThumb(thumbnail) {
  if (!thumbnail?.thumbnails) return null;
  const thumbs = thumbnail.thumbnails;
  return thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null;
}

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

async function connectBrowser(cdpUrl, headless) {
  const { chromium } = await import('/usr/lib/node_modules/playwright/index.mjs');

  // Try CDP first
  const cdpUrls = cdpUrl ? [cdpUrl] : DEFAULT_CDP_URLS;
  for (const url of cdpUrls) {
    try {
      log(`Trying CDP at ${url}...`);
      const browser = await chromium.connectOverCDP(url, { timeout: 5000 });
      const contexts = browser.contexts();
      const ctx = contexts[0] || await browser.newContext();
      log('Connected via CDP');
      return { browser, ctx, ownsBrowser: false };
    } catch {}
  }

  // Fall back to launching fresh browser
  log('Launching fresh Chrome instance...');
  let executablePath = null;
  for (const path of CHROME_EXECUTABLES) {
    if (existsSync(path)) { executablePath = path; break; }
  }

  const { chromium: chromium2 } = await import('/usr/lib/node_modules/playwright/index.mjs');
  const browser = await chromium2.launch({
    headless: headless !== false,
    executablePath: executablePath || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  return { browser, ctx, ownsBrowser: true };
}

async function setupPage(ctx) {
  const page = await ctx.newPage();

  // Navigate to YouTube and extract client config
  log('Navigating to YouTube...');
  await page.goto(YOUTUBE_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1000);

  const clientConfig = await page.evaluate(() => {
    const ytcfg = window.ytcfg?.data_ || {};
    return {
      apiKey: ytcfg.INNERTUBE_API_KEY,
      clientVersion: ytcfg.INNERTUBE_CLIENT_VERSION,
      visitorData: ytcfg.VISITOR_DATA,
      hl: ytcfg.HL || 'en',
      gl: ytcfg.GL || 'US',
    };
  });

  const apiKey = clientConfig.apiKey || INNERTUBE_API_KEY;
  const clientVersion = clientConfig.clientVersion || DEFAULT_CLIENT_VERSION;
  const hl = clientConfig.hl || 'en';
  const gl = clientConfig.gl || 'US';

  log(`Client version: ${clientVersion}, region: ${gl}/${hl}`);

  // Helper to make YouTube API calls within browser context
  async function callApi(endpoint, body) {
    const url = `${INNERTUBE_BASE}/${endpoint}?prettyPrint=false&key=${apiKey}`;
    const context = {
      client: {
        clientName: 'WEB',
        clientVersion,
        hl,
        gl,
      },
    };

    const result = await page.evaluate(async ({ url, body, context, clientVersion }) => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': clientVersion,
          },
          body: JSON.stringify({ ...body, context }),
        });
        const text = await resp.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        return { status: resp.status, ok: resp.ok, parsed, error: null };
      } catch (e) {
        return { status: 0, ok: false, parsed: null, error: e.message };
      }
    }, { url, body, context, clientVersion });

    return result;
  }

  return { page, callApi, apiKey, clientVersion, hl, gl };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function parseVideoRenderer(vr) {
  if (!vr) return null;
  const channelRuns = vr.ownerText?.runs || vr.shortBylineText?.runs || [];
  const channelEndpoint = channelRuns[0]?.navigationEndpoint?.browseEndpoint;
  const descriptionSnippet = vr.detailedMetadataSnippets?.[0]?.snippetText;

  return {
    type: 'video',
    videoId: vr.videoId,
    url: `https://www.youtube.com/watch?v=${vr.videoId}`,
    title: getText(vr.title),
    channel: {
      name: getText(vr.ownerText) || getText(vr.shortBylineText),
      id: channelEndpoint?.browseId || null,
      url: channelEndpoint ? `${YOUTUBE_BASE_URL}${channelEndpoint.canonicalBaseUrl || '/channel/' + channelEndpoint.browseId}` : null,
    },
    duration: getText(vr.lengthText),
    viewCount: getText(vr.viewCountText),
    publishedTime: getText(vr.publishedTimeText),
    thumbnailUrl: extractThumb(vr.thumbnail),
    description: getText(descriptionSnippet),
    badges: (vr.badges || []).map(b => getText(b.metadataBadgeRenderer?.label) || b.metadataBadgeRenderer?.style).filter(Boolean),
  };
}

function parseChannelRenderer(cr) {
  if (!cr) return null;
  return {
    type: 'channel',
    channelId: cr.channelId,
    url: `${YOUTUBE_BASE_URL}/channel/${cr.channelId}`,
    handle: cr.channelHandleText ? getText(cr.channelHandleText) : null,
    name: getText(cr.title),
    subscriberCount: getText(cr.videoCountText) || getText(cr.subscriberCountText),
    description: getText(cr.descriptionSnippet),
    thumbnailUrl: extractThumb(cr.thumbnail),
    videoCount: getText(cr.videoCountText),
  };
}

function parseSearchItem(item) {
  if (item.videoRenderer) return parseVideoRenderer(item.videoRenderer);
  if (item.channelRenderer) return parseChannelRenderer(item.channelRenderer);
  if (item.playlistRenderer) {
    const pr = item.playlistRenderer;
    return {
      type: 'playlist',
      playlistId: pr.playlistId,
      url: `${YOUTUBE_BASE_URL}/playlist?list=${pr.playlistId}`,
      title: getText(pr.title),
      videoCount: getText(pr.videoCount),
      channel: getText(pr.shortBylineText),
      thumbnailUrl: extractThumb(pr.thumbnail),
    };
  }
  return null;
}

async function scrapeSearch(callApi, query, options = {}) {
  const { filter = 'all', pages = 3, limit = Infinity, delay = DEFAULT_DELAY_MS } = options;

  const results = [];
  let continuation = null;
  let pageNum = 0;
  let estimatedResults = null;

  log(`Searching YouTube for: "${query}" (filter: ${filter}, pages: ${pages})`);

  while (pageNum < pages && results.length < limit) {
    const body = {};

    if (continuation) {
      body.continuation = continuation;
    } else {
      body.query = query;
      const filterParam = SEARCH_FILTERS[filter];
      if (filterParam) body.params = filterParam;
    }

    const resp = await callApi('search', body);

    if (!resp.ok) {
      if (resp.status === 403) throw Object.assign(new Error('WAF/bot block on search'), { code: 4 });
      throw new Error(`Search API error: status ${resp.status}`);
    }

    const data = resp.parsed;
    if (!data) throw new Error('Empty response from search API');

    if (!estimatedResults && data.estimatedResults) {
      estimatedResults = data.estimatedResults;
    }

    // Extract results
    let sectionContents = null;

    if (continuation) {
      // Continuation response — items are in onResponseReceivedCommands
      const actions = data.onResponseReceivedCommands || data.onResponseReceivedActions || [];
      for (const action of actions) {
        const ci = action.appendContinuationItemsAction?.continuationItems;
        if (ci) {
          // Check if items are wrapped in itemSectionRenderer
          const sectionItem = ci.find(i => i.itemSectionRenderer);
          if (sectionItem) {
            // Unwrap: use the section's contents + pass along continuation token
            const sectionItems = sectionItem.itemSectionRenderer.contents || [];
            const contItem = ci.find(i => i.continuationItemRenderer);
            sectionContents = contItem ? [...sectionItems, contItem] : sectionItems;
          } else {
            // Items are direct (videoRenderer etc.)
            sectionContents = ci;
          }
          break;
        }
      }
    } else {
      // First page
      const primaryContents = data.contents?.twoColumnSearchResultsRenderer
        ?.primaryContents?.sectionListRenderer?.contents;

      if (primaryContents) {
        const section = primaryContents.find(c => c.itemSectionRenderer);
        sectionContents = section?.itemSectionRenderer?.contents;

        // Extract continuation token
        const contSection = primaryContents.find(c => c.continuationItemRenderer);
        continuation = contSection?.continuationItemRenderer
          ?.continuationEndpoint?.continuationCommand?.token || null;
      }
    }

    if (sectionContents) {
      // Always extract continuation token from sectionContents
      const contItem = sectionContents.find(c => c.continuationItemRenderer);
      const sectionContinuation = contItem?.continuationItemRenderer
        ?.continuationEndpoint?.continuationCommand?.token || null;
      // Update continuation if not already set from first page parsing
      if (!continuation || body.continuation) {
        continuation = sectionContinuation;
      }

      for (const item of sectionContents) {
        if (item.continuationItemRenderer) continue;
        const parsed = parseSearchItem(item);
        if (parsed) results.push(parsed);
        if (results.length >= limit) break;
      }
    }

    pageNum++;
    log(`Page ${pageNum}: ${results.length} results so far`);

    if (!continuation || results.length >= limit) break;
    if (pageNum < pages) await sleep(delay);
  }

  return {
    query,
    filter,
    estimatedResults: estimatedResults ? parseInt(estimatedResults.replace(/,/g, ''), 10) : null,
    results: results.slice(0, limit),
    meta: {
      scraped_at: new Date().toISOString(),
      query,
      filter,
      total_fetched: results.length,
      pages_fetched: pageNum,
      has_more: !!continuation,
    },
  };
}

// ---------------------------------------------------------------------------
// Channel scraping
// ---------------------------------------------------------------------------

function parseChannelVideoRenderer(vr) {
  if (!vr) return null;
  return {
    videoId: vr.videoId,
    url: `${YOUTUBE_BASE_URL}/watch?v=${vr.videoId}`,
    title: getText(vr.title),
    publishedTime: getText(vr.publishedTimeText),
    viewCount: getText(vr.viewCountText),
    duration: getText(vr.lengthText),
    thumbnailUrl: extractThumb(vr.thumbnail),
    shortDescription: getText(vr.descriptionSnippet),
    isLive: !!(vr.badges || []).find(b => b.metadataBadgeRenderer?.style?.includes('LIVE')),
  };
}

function extractSubscriberCount(header) {
  try {
    const rows = header?.pageHeaderRenderer?.content?.pageHeaderViewModel
      ?.metadata?.contentMetadataViewModel?.metadataRows;
    if (!rows) return null;
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        const text = part.text?.content || '';
        if (text.includes('subscriber')) return text;
      }
    }
  } catch {}
  return null;
}

async function scrapeChannel(callApi, channelId, options = {}) {
  const { tab = 'videos', pages = 3, delay = DEFAULT_DELAY_MS, limit = Infinity } = options;

  log(`Scraping channel: ${channelId}, tab: ${tab}`);

  // If it's a handle (@...) or URL, resolve to channel ID first
  let resolvedChannelId = channelId;
  if (channelId.startsWith('@') || channelId.startsWith('http')) {
    const url = channelId.startsWith('http')
      ? channelId
      : `${YOUTUBE_BASE_URL}/${channelId}`;
    const resolveResp = await callApi('navigation/resolve_url', { url });
    if (resolveResp.ok && resolveResp.parsed?.endpoint?.browseEndpoint?.browseId) {
      resolvedChannelId = resolveResp.parsed.endpoint.browseEndpoint.browseId;
      log(`Resolved ${channelId} → ${resolvedChannelId}`);
    } else {
      // Try browsing directly with the handle
      log(`Could not resolve handle, using as-is: ${channelId}`);
    }
  }

  // Get channel home page first for metadata
  const homeResp = await callApi('browse', { browseId: resolvedChannelId });

  let channelMeta = null;
  let tabParams = TAB_PARAMS[tab] || TAB_PARAMS.videos;

  if (homeResp.ok && homeResp.parsed) {
    const data = homeResp.parsed;

    // Extract metadata
    const cmr = data.metadata?.channelMetadataRenderer;
    const subscriberCount = extractSubscriberCount(data.header);
    const microformat = data.microformat?.microformatDataRenderer;

    channelMeta = {
      channelId: cmr?.externalId || resolvedChannelId,
      name: cmr?.title || null,
      handle: microformat?.vanityUrl || null,
      url: cmr?.channelUrl || `${YOUTUBE_BASE_URL}/channel/${resolvedChannelId}`,
      description: cmr?.description || null,
      keywords: cmr?.keywords || null,
      subscriberCount,
      thumbnailUrl: extractThumb(cmr?.avatar || microformat?.thumbnail),
      isFamilySafe: microformat?.familySafe,
    };

    // Get dynamic tab params if available
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (tabs) {
      for (const t of tabs) {
        const tabTitle = t.tabRenderer?.title?.toLowerCase();
        if (tabTitle === tab.toLowerCase()) {
          const ep = t.tabRenderer?.endpoint?.browseEndpoint?.params;
          if (ep) tabParams = ep;
          break;
        }
      }
    }
  }

  // Now scrape the specific tab
  const videos = [];
  let continuation = null;
  let pageNum = 0;

  while (pageNum < pages && videos.length < limit) {
    let resp;

    if (continuation) {
      resp = await callApi('browse', { continuation });
    } else {
      resp = await callApi('browse', {
        browseId: resolvedChannelId,
        params: tabParams,
      });
    }

    if (!resp.ok) {
      if (resp.status === 403) throw Object.assign(new Error('Bot block'), { code: 4 });
      if (resp.status === 404) throw Object.assign(new Error(`Channel not found: ${channelId}`), { code: 2 });
      throw new Error(`Browse API error: status ${resp.status}`);
    }

    const data = resp.parsed;
    if (!data) break;

    let items = null;

    if (continuation) {
      // Pagination response
      const actions = data.onResponseReceivedActions || [];
      for (const action of actions) {
        const ci = action.appendContinuationItemsAction?.continuationItems;
        if (ci) { items = ci; break; }
      }
    } else {
      // First page
      const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
      if (tabs) {
        for (const t of tabs) {
          if (t.tabRenderer?.selected) {
            const content = t.tabRenderer?.content;
            items = content?.richGridRenderer?.contents
              || content?.sectionListRenderer?.contents;
            break;
          }
        }
      }
    }

    if (!items) break;

    // Extract continuation token first (always scan full items array)
    let newContinuation = null;
    for (const item of items) {
      if (item.continuationItemRenderer) {
        newContinuation = item.continuationItemRenderer
          ?.continuationEndpoint?.continuationCommand?.token;
      }
    }

    // Now extract videos
    for (const item of items) {
      if (item.continuationItemRenderer) continue;

      // richItemRenderer (channel videos grid)
      const vr = item.richItemRenderer?.content?.videoRenderer
        || item.richItemRenderer?.content?.reelItemRenderer // shorts
        || item.richItemRenderer?.content?.shortsLockupViewModel; // newer shorts format

      if (vr && vr.videoId) {
        const parsed = parseChannelVideoRenderer(vr);
        if (parsed) videos.push(parsed);
      }

      // gridVideoRenderer (playlists tab, older format)
      if (item.gridVideoRenderer) {
        const vr2 = item.gridVideoRenderer;
        videos.push({
          videoId: vr2.videoId,
          url: `${YOUTUBE_BASE_URL}/watch?v=${vr2.videoId}`,
          title: getText(vr2.title),
          publishedTime: getText(vr2.publishedTimeText),
          viewCount: getText(vr2.viewCountText),
          duration: getText(vr2.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text),
          thumbnailUrl: extractThumb(vr2.thumbnail),
        });
      }

      if (videos.length >= limit) break;
    }

    continuation = newContinuation;
    pageNum++;
    log(`Channel tab page ${pageNum}: ${videos.length} items`);

    if (!continuation || videos.length >= limit) break;
    if (pageNum < pages) await sleep(delay);
  }

  return {
    channel: channelMeta,
    tab,
    videos: videos.slice(0, limit),
    meta: {
      scraped_at: new Date().toISOString(),
      channel_id: resolvedChannelId,
      tab,
      total_fetched: videos.length,
      pages_fetched: pageNum,
      has_more: !!continuation,
    },
  };
}

// ---------------------------------------------------------------------------
// Video metadata
// ---------------------------------------------------------------------------

async function scrapeVideo(callApi, videoId) {
  log(`Fetching video metadata: ${videoId}`);

  // Use 'next' endpoint for video info — works without auth
  const nextResp = await callApi('next', { videoId });

  if (!nextResp.ok) {
    if (nextResp.status === 403) throw Object.assign(new Error('Bot block'), { code: 4 });
    throw new Error(`Next API error: ${nextResp.status}`);
  }

  const data = nextResp.parsed;
  if (!data) throw Object.assign(new Error(`Video not found: ${videoId}`), { code: 2 });

  // Also call player for additional metadata (works without auth for videoDetails)
  const playerResp = await callApi('player', { videoId, racyCheckOk: false, contentCheckOk: false });

  let videoDetails = null;
  let playabilityStatus = null;

  if (playerResp.ok && playerResp.parsed) {
    videoDetails = playerResp.parsed.videoDetails;
    playabilityStatus = playerResp.parsed.playabilityStatus?.status;

    if (playabilityStatus === 'LOGIN_REQUIRED' &&
        playerResp.parsed.playabilityStatus?.errorScreen?.playerErrorMessageRenderer) {
      // Video itself is unavailable/private
      throw Object.assign(new Error('Video requires login or is private'), { code: 3 });
    }
  }

  // Parse from next endpoint
  const twoCol = data.contents?.twoColumnWatchNextResults;
  const results = twoCol?.results?.results?.contents || [];

  const primaryInfo = results.find(r => r.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
  const secondaryInfo = results.find(r => r.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;

  // Video title and views
  const title = getText(primaryInfo?.title) || videoDetails?.title;
  const viewCount = getText(primaryInfo?.viewCount?.videoViewCountRenderer?.viewCount)
    || videoDetails?.viewCount;
  const publishDate = getText(primaryInfo?.dateText) || getText(primaryInfo?.relativeDateText);

  // Like count (from button labels)
  let likeCount = null;
  try {
    const buttons = primaryInfo?.videoActions?.menuRenderer?.topLevelButtons || [];
    for (const btn of buttons) {
      const like = btn?.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel
        ?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel
        ?.defaultButtonViewModel?.buttonViewModel?.title;
      if (like) { likeCount = like; break; }
      // Alternative path
      const like2 = btn?.segmentedLikeDislikeButtonRenderer?.likeButton
        ?.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label;
      if (like2) { likeCount = like2; break; }
    }
  } catch {}

  // Channel info
  const ownerRenderer = secondaryInfo?.owner?.videoOwnerRenderer;
  const channelName = getText(ownerRenderer?.title) || videoDetails?.author;
  const channelId = ownerRenderer?.navigationEndpoint?.browseEndpoint?.browseId
    || videoDetails?.channelId;
  const subscriberCount = getText(ownerRenderer?.subscriberCountText);

  // Description
  const description = getText(secondaryInfo?.description)
    || videoDetails?.shortDescription;

  // Related videos
  const relatedItems = twoCol?.secondaryResults?.secondaryResults?.results || [];
  const relatedVideos = [];
  for (const item of relatedItems.slice(0, 10)) {
    // lockupViewModel (newer format)
    const lockup = item.lockupViewModel;
    if (lockup) {
      const metaText = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows;
      relatedVideos.push({
        type: 'video',
        title: getText(lockup.title?.content) || lockup.title,
        thumbnailUrl: lockup.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || null,
      });
      continue;
    }

    // compactVideoRenderer (older format)
    const cvr = item.compactVideoRenderer;
    if (cvr) {
      relatedVideos.push({
        type: 'video',
        videoId: cvr.videoId,
        url: `${YOUTUBE_BASE_URL}/watch?v=${cvr.videoId}`,
        title: getText(cvr.title),
        channel: getText(cvr.shortBylineText),
        viewCount: getText(cvr.viewCountText),
        duration: getText(cvr.lengthText),
        thumbnailUrl: extractThumb(cvr.thumbnail),
      });
    }
  }

  return {
    videoId,
    url: `${YOUTUBE_BASE_URL}/watch?v=${videoId}`,
    title,
    description,
    publishDate,
    viewCount,
    likeCount,
    duration: videoDetails?.lengthSeconds ? formatSeconds(parseInt(videoDetails.lengthSeconds)) : null,
    durationSeconds: videoDetails?.lengthSeconds ? parseInt(videoDetails.lengthSeconds) : null,
    channel: {
      id: channelId,
      name: channelName,
      subscriberCount,
      url: channelId ? `${YOUTUBE_BASE_URL}/channel/${channelId}` : null,
    },
    keywords: videoDetails?.keywords || [],
    thumbnailUrl: videoDetails?.thumbnail?.thumbnails
      ? videoDetails.thumbnail.thumbnails.slice(-1)[0]?.url
      : null,
    isLive: videoDetails?.isLiveContent || false,
    isPrivate: videoDetails?.isPrivate || false,
    relatedVideos,
    meta: {
      scraped_at: new Date().toISOString(),
      videoId,
      playabilityStatus,
    },
  };
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function parseCommentRenderer(cr) {
  if (!cr) return null;
  return {
    commentId: cr.commentId,
    author: getText(cr.authorText),
    authorChannelId: cr.authorEndpoint?.browseEndpoint?.browseId || null,
    text: getText(cr.contentText),
    likeCount: cr.likeCount || 0,
    publishedTime: getText(cr.publishedTimeText),
    isChannelOwner: cr.authorIsChannelOwner || false,
    isPinned: !!(cr.pinnedCommentBadge),
    replyCount: cr.replyCount || 0,
    voteStatus: cr.voteStatus || null,
  };
}

// Parse new-format commentEntityPayload (from frameworkUpdates mutations)
function parseCommentEntityPayload(payload, commentKey) {
  if (!payload) return null;
  const props = payload.properties || {};
  const author = payload.author || {};
  const toolbar = payload.toolbar || {};

  // Parse like count (may be "205K" format)
  const likeCountStr = toolbar.likeCountNotliked || toolbar.likeCountLiked || '0';
  const likeCount = likeCountStr; // keep as string since it's formatted

  return {
    commentId: props.commentId || commentKey,
    author: author.displayName || null,
    authorChannelId: author.channelId || null,
    text: props.content?.content || null,
    likeCount,
    publishedTime: props.publishedTime || null,
    isChannelOwner: author.isCreator || false,
    isPinned: !!(payload.pinnedText || props.pinnedText),
    replyCount: parseInt(toolbar.replyCount || '0', 10) || 0,
    voteStatus: null,
  };
}

async function scrapeComments(callApi, videoId, options = {}) {
  const { pages = 3, delay = DEFAULT_DELAY_MS, limit = Infinity } = options;

  log(`Fetching comments for video: ${videoId}`);

  // Step 1: Get comment section continuation token from next endpoint
  const nextResp = await callApi('next', { videoId });

  if (!nextResp.ok) {
    throw new Error(`Next API error: ${nextResp.status}`);
  }

  const data = nextResp.parsed;
  if (!data) throw Object.assign(new Error(`Video not found: ${videoId}`), { code: 2 });

  // Find comment section token in engagementPanels
  let commentToken = null;
  const panels = data.engagementPanels || [];
  for (const panel of panels) {
    const renderer = panel?.engagementPanelSectionListRenderer;
    if (!renderer) continue;
    // Panel identifier may be 'engagement-panel-comments-section' or 'comment-item-section'
    const id = renderer?.panelIdentifier || '';
    if (id.includes('comment')) {
      commentToken = renderer?.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
        ?.continuationEndpoint?.continuationCommand?.token;
      if (commentToken) break;
    }
  }
  
  // Fallback: check content directly at top level (older format)
  if (!commentToken) {
    for (const panel of panels) {
      const renderer = panel?.engagementPanelSectionListRenderer;
      if (!renderer?.content) continue;
      const ct = renderer.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
        ?.continuationEndpoint?.continuationCommand?.token;
      if (ct) { commentToken = ct; break; }
    }
  }

  if (!commentToken) {
    // Comments may be disabled
    return {
      videoId,
      comments: [],
      meta: {
        scraped_at: new Date().toISOString(),
        videoId,
        note: 'No comment section found — comments may be disabled',
        total_fetched: 0,
        pages_fetched: 0,
        has_more: false,
      },
    };
  }

  const comments = [];
  let continuation = commentToken;
  let pageNum = 0;
  let isFirstPage = true;

  while (pageNum < pages && comments.length < limit) {
    const resp = await callApi('next', { continuation });

    if (!resp.ok) {
      throw new Error(`Comments API error: ${resp.status}`);
    }

    const cdata = resp.parsed;
    if (!cdata) break;

    const endpoints = cdata.onResponseReceivedEndpoints || [];
    let items = null;
    let newContinuation = null;

    // There may be multiple endpoints: one for header, one for comments
    // We need the one with commentThreadRenderer items (not commentsHeaderRenderer)
    for (const ep of endpoints) {
      // First page uses reloadContinuationItemsCommand
      // Subsequent pages use appendContinuationItemsAction
      const ci = ep?.reloadContinuationItemsCommand?.continuationItems
        || ep?.appendContinuationItemsAction?.continuationItems;
      if (ci && ci.some(i => i.commentThreadRenderer || i.continuationItemRenderer)) {
        items = ci;
        break;
      }
    }
    
    // Fallback: use the last endpoint with continuationItems
    if (!items) {
      for (const ep of endpoints) {
        const ci = ep?.reloadContinuationItemsCommand?.continuationItems
          || ep?.appendContinuationItemsAction?.continuationItems;
        if (ci && ci.length > 0) { items = ci; }
      }
    }

    if (!items) break;

    // Build entity mutation map (new YouTube Entity framework)
    // frameworkUpdates.entityBatchUpdate.mutations[] → commentEntityPayload
    const mutations = cdata?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
    const entityMap = new Map();
    for (const mutation of mutations) {
      const payload = mutation?.payload?.commentEntityPayload;
      if (payload?.properties?.commentId) {
        entityMap.set(payload.properties.commentId, payload);
      }
    }

    for (const item of items) {
      if (item.continuationItemRenderer) {
        newContinuation = item.continuationItemRenderer
          ?.continuationEndpoint?.continuationCommand?.token;
        continue;
      }
      if (item.commentsHeaderRenderer) continue; // skip header

      const thread = item.commentThreadRenderer;
      if (thread) {
        let comment = null;

        // New format: commentViewModel (data in frameworkUpdates mutations)
        const cvm = thread.commentViewModel?.commentViewModel;
        if (cvm?.commentId) {
          const entityPayload = entityMap.get(cvm.commentId);
          if (entityPayload) {
            comment = parseCommentEntityPayload(entityPayload, cvm.commentId);
          } else {
            // Build partial comment from commentViewModel
            comment = {
              commentId: cvm.commentId,
              author: null,
              authorChannelId: null,
              text: null,
              likeCount: 0,
              publishedTime: null,
              isChannelOwner: false,
              isPinned: !!(cvm.pinnedText),
              replyCount: 0,
              voteStatus: null,
            };
          }
        }

        // Old format: comment.commentRenderer
        if (!comment) {
          const cr = thread.comment?.commentRenderer;
          comment = parseCommentRenderer(cr);
        }

        if (comment) {
          comment.replies = [];
          comments.push(comment);
        }
      }

      if (comments.length >= limit) break;
    }

    continuation = newContinuation;
    pageNum++;
    isFirstPage = false;
    log(`Comments page ${pageNum}: ${comments.length} comments`);

    if (!continuation || comments.length >= limit) break;
    if (pageNum < pages) await sleep(delay);
  }

  return {
    videoId,
    comments: comments.slice(0, limit),
    meta: {
      scraped_at: new Date().toISOString(),
      videoId,
      total_fetched: comments.length,
      pages_fetched: pageNum,
      has_more: !!continuation,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...positional] = args.positional;

  if (!command || command === 'help') {
    console.log(`YouTube Video Scraper

Commands:
  search <query>               Search videos, channels, playlists
  channel <channelId|@handle>  Scrape channel videos/shorts/playlists
  video <videoId>              Get video metadata
  comments <videoId>           Scrape comments

Options:
  --output=<file>              Save results to JSON file
  --cdp-url=<url>              Chrome CDP URL (default: http://localhost:9333)
  --no-headless                Show browser (for debugging)
  --delay=<ms>                 Delay between requests (default: 1500)
  --pages=<n>                  Max pages to fetch (default: 3)
  --limit=<n>                  Max items to return
  --filter=<type>              Search filter: all|videos|channels|playlists (default: all)
  --tab=<tab>                  Channel tab: videos|shorts|playlists|posts (default: videos)

Examples:
  node video-scraper.mjs search "javascript tutorial" --filter=videos --pages=2
  node video-scraper.mjs channel @MrBeast --tab=videos --pages=2
  node video-scraper.mjs channel UCX6OQ3DkcsbYNE6H8uQQuVA --tab=shorts
  node video-scraper.mjs video dQw4w9WgXcQ
  node video-scraper.mjs comments dQw4w9WgXcQ --pages=2
`);
    process.exit(0);
  }

  const cdpUrl = args.flags['cdp-url'];
  const headless = args.flags['no-headless'] ? false : undefined;
  const delay = parseInt(args.flags.delay || DEFAULT_DELAY_MS, 10);
  const pages = parseInt(args.flags.pages || 3, 10);
  const limit = args.flags.limit ? parseInt(args.flags.limit, 10) : Infinity;
  const outputFile = args.flags.output;
  const filter = args.flags.filter || 'all';
  const tab = args.flags.tab || 'videos';

  let browser, ctx, ownsBrowser;
  let page;

  try {
    ({ browser, ctx, ownsBrowser } = await connectBrowser(cdpUrl, headless));
    const setup = await setupPage(ctx);
    page = setup.page;
    const { callApi } = setup;

    let result;

    switch (command) {
      case 'search': {
        const query = positional.join(' ');
        if (!query) {
          console.error('Usage: video-scraper.mjs search <query>');
          process.exit(1);
        }
        result = await scrapeSearch(callApi, query, { filter, pages, delay, limit });
        break;
      }

      case 'channel': {
        const channelId = positional[0];
        if (!channelId) {
          console.error('Usage: video-scraper.mjs channel <channelId|@handle>');
          process.exit(1);
        }
        result = await scrapeChannel(callApi, channelId, { tab, pages, delay, limit });
        break;
      }

      case 'video': {
        const videoId = positional[0];
        if (!videoId) {
          console.error('Usage: video-scraper.mjs video <videoId>');
          process.exit(1);
        }
        result = await scrapeVideo(callApi, videoId);
        break;
      }

      case 'comments': {
        const videoId = positional[0];
        if (!videoId) {
          console.error('Usage: video-scraper.mjs comments <videoId>');
          process.exit(1);
        }
        result = await scrapeComments(callApi, videoId, { pages, delay, limit });
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }

    // Output result
    const output = JSON.stringify(result, null, 2);

    if (outputFile) {
      ensureDir(dirname(resolve(outputFile)));
      writeFileSync(outputFile, output);
      log(`Results saved to ${outputFile}`);
    }

    // Always print to stdout
    console.log(output);

    // Print summary to stderr
    const meta = result.meta || {};
    if (result.results) {
      console.error(`\nSummary: ${result.results.length} results (estimated: ${result.estimatedResults?.toLocaleString() || 'N/A'})`);
    } else if (result.videos) {
      console.error(`\nSummary: ${result.videos.length} videos from ${result.channel?.name || result.meta?.channel_id}`);
    } else if (result.comments) {
      console.error(`\nSummary: ${result.comments.length} comments`);
    } else if (result.videoId) {
      console.error(`\nSummary: ${result.title} (${result.viewCount})`);
    }

  } catch (err) {
    const code = err.code || 1;

    if (code === 2) {
      console.error(`[youtube] Not found: ${err.message}`);
    } else if (code === 3) {
      console.error(`[youtube] Login required: ${err.message}`);
    } else if (code === 4) {
      console.error(`[youtube] Bot detection / WAF block: ${err.message}`);
      console.error('[youtube] Try: --cdp-url=http://localhost:9333 to use real Chrome session');
    } else if (code === 5) {
      console.error(`[youtube] Rate limited: ${err.message}`);
      console.error('[youtube] Wait 30-60 seconds and retry');
    } else {
      console.error(`[youtube] Error: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }

    process.exit(code);
  } finally {
    if (page) await page.close().catch(() => {});
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }
}

main();
