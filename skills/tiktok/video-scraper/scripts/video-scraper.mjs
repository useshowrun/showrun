#!/usr/bin/env node
/**
 * TikTok Video Scraper
 *
 * Scrapes TikTok public content without requiring a login account:
 *   - Public user profiles (bio, stats, metadata)
 *   - Hashtag/challenge videos (paginated)
 *   - Search results (paginated)
 *   - Trending feed
 *
 * User videos (post/item_list) require TikTok authentication (sessionid cookie)
 * because TikTok uses X-Bogus + X-Gnarly request signing for that endpoint.
 *
 * Strategy (CRITICAL):
 *   TikTok's APIs use X-Bogus/X-Gnarly request signatures. These are computed by
 *   TikTok's own JS running in the page. We CANNOT call the APIs directly via fetch
 *   (page.evaluate) because those calls lack the signatures → empty response body.
 *
 *   Instead we use CDP response interception:
 *   - page.on('response', async resp => { const text = await resp.text(); })
 *   - This captures the REAL signed requests made by TikTok's JS
 *   - We intercept the responses as TikTok's JS makes them during page navigation
 *
 * For pagination:
 *   - Scroll the page to trigger TikTok's JS to make the next page request
 *   - CDP captures each response as it arrives
 *
 * Usage:
 *   node video-scraper.mjs profile <username>
 *   node video-scraper.mjs hashtag <hashtag> [--count=30] [--pages=3]
 *   node video-scraper.mjs search <keyword> [--count=20] [--pages=3]
 *   node video-scraper.mjs trending [--count=20]
 *   node video-scraper.mjs user-videos <username> [--pages=3]
 *   node video-scraper.mjs auth                    # capture sessionid from Chrome
 *   node video-scraper.mjs check-session           # verify stored session
 *
 * Options:
 *   --output=<file>       Save results to JSON file
 *   --cdp-url=<url>       Connect to existing Chrome (default: http://localhost:9333)
 *   --no-headless         Show browser window (useful for debugging)
 *   --delay=<ms>          Delay between scroll triggers (default: 2000ms)
 *   --pages=<n>           Max pages/batches to fetch
 *
 * Requires:
 *   - Node.js 22+
 *   - playwright npm package (global install: sudo npm install -g playwright)
 *   - Google Chrome or Chromium
 *
 * Exit codes:
 *   0  Success
 *   1  General error
 *   2  Login required (for user-videos)
 *   3  Profile/hashtag not found
 *   4  WAF/rate-limit block or bot detection
 *   5  Session expired (re-run auth)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/tiktok');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');

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

const DEFAULT_DELAY_MS = 2000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function log(...args) {
  if (!process.env.QUIET) console.error('[tiktok]', ...args);
}

function bail(msg, code = 1) {
  console.error(`[tiktok:error] ${msg}`);
  process.exit(code);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function findChrome() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  for (const p of CHROME_EXECUTABLES) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Playwright launcher
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  const candidates = [
    '/usr/lib/node_modules/playwright/index.mjs',
    'playwright',
  ];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {}
  }
  bail(
    'playwright not found. Install it:\n' +
    '  sudo npm install -g playwright\n' +
    '  OR: npm install playwright\n' +
    '  Then: npx playwright install chromium'
  );
}

async function launchBrowser(opts = {}) {
  const { chromium } = await loadPlaywright();

  const cdpUrls = opts.cdpUrl
    ? [opts.cdpUrl]
    : (process.env.CHROME_CDP_URL ? [process.env.CHROME_CDP_URL] : DEFAULT_CDP_URLS);

  for (const cdpUrl of cdpUrls) {
    try {
      log(`Connecting to Chrome via CDP: ${cdpUrl}`);
      const browser = await chromium.connectOverCDP(cdpUrl);
      log('Connected to existing Chrome');
      return { browser, connected: true, cdpUrl };
    } catch (e) {
      log(`CDP connect failed (${cdpUrl}): ${e.message}`);
    }
  }

  // Launch fresh browser
  const chrome = findChrome();
  if (!chrome) {
    bail(
      'Chrome/Chromium not found. Install it or set CHROME_EXECUTABLE env var.\n' +
      '  Linux: sudo pacman -S google-chrome  OR  sudo apt install google-chrome-stable\n' +
      '  macOS: brew install --cask google-chrome'
    );
  }

  log(`Launching Chrome: ${chrome}`);
  const { browser } = await chromium.launch({
    executablePath: chrome,
    headless: opts.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });

  return { browser, connected: false };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function loadSession() {
  return loadJson(SESSION_FILE);
}

function saveSession(data) {
  ensureDir(DATA_DIR);
  saveJson(SESSION_FILE, { ...data, savedAt: new Date().toISOString() });
  log(`Session saved to ${SESSION_FILE}`);
}

async function captureSession(browser) {
  log('Looking for TikTok session in browser...');

  const contexts = browser.contexts();
  const allCookies = [];

  for (const ctx of contexts) {
    try {
      const cookies = await ctx.cookies(['https://www.tiktok.com']);
      allCookies.push(...cookies);
    } catch {}
  }

  const sessionid = allCookies.find(c => c.name === 'sessionid');
  if (!sessionid) {
    log('No sessionid cookie found. Make sure you are logged in to TikTok in Chrome.');
    log('Open Chrome, go to https://www.tiktok.com, log in, then re-run auth.');
    bail('sessionid cookie not found in browser. Log in to TikTok first.', 2);
  }

  const relevant = allCookies.filter(c =>
    ['sessionid', 'msToken', 'ttwid', 'tt_chain_token', 'tt_csrf_token'].includes(c.name)
  );

  const session = {
    cookies: relevant,
    sessionid: sessionid.value,
    msToken: allCookies.find(c => c.name === 'msToken')?.value || '',
    ttwid: allCookies.find(c => c.name === 'ttwid')?.value || '',
  };

  saveSession(session);
  log(`✅ Session captured!`);
  return session;
}

// ---------------------------------------------------------------------------
// Core: Browser context setup
// ---------------------------------------------------------------------------

async function createPage(browser, session) {
  // Always use a new context to get a fresh browser state
  // (important: using existing context causes empty API responses due to cookie conflicts)
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
  });

  // Inject session cookies if available
  if (session?.cookies?.length) {
    try {
      await context.addCookies(session.cookies.map(c => ({
        ...c,
        domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'tiktok.com'}`,
      })));
      log('Injected session cookies');
    } catch (e) {
      log(`Cookie injection warning: ${e.message}`);
    }
  }

  const page = await context.newPage();
  return { page, context };
}

async function checkForWAF(page) {
  const title = await page.title().catch(() => '');
  const content = await page.content().catch(() => '');

  if (content.includes('verifyPage') || content.includes('captcha_verify') ||
      title.includes('Verify') || title.includes('Error 403')) {
    return 'captcha';
  }
  if (content.includes('Access Denied') || content.includes('403 Forbidden')) {
    return 'waf_block';
  }
  return null;
}

// ---------------------------------------------------------------------------
// CDP Response Interceptor
// ---------------------------------------------------------------------------

/**
 * Sets up CDP response interception on a page.
 * TikTok's JS auto-generates X-Bogus/X-Gnarly signatures.
 * We intercept responses from TikTok's own API calls during page navigation.
 *
 * @param {Page} page - Playwright page
 * @param {string[]} pathPatterns - URL path substrings to intercept
 * @returns {{ getData: () => Object[], cleanup: () => void }}
 */
function setupCDPInterceptor(page, pathPatterns) {
  const batches = [];

  const handler = async (resp) => {
    const url = resp.url();
    if (!pathPatterns.some(p => url.includes(p))) return;
    if (!url.includes('tiktok.com')) return;

    try {
      const text = await resp.text();
      if (!text || text.length === 0) return;

      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }

      const path = new URL(url).pathname;
      batches.push({ url, path, status: resp.status(), parsed, bodyLen: text.length });
      log(`CDP captured: ${path} (${text.length} bytes, ${parsed.itemList?.length ?? parsed.data?.length ?? '?'} items)`);
    } catch {}
  };

  page.on('response', handler);

  return {
    getBatches: () => batches,
    cleanup: () => page.removeListener('response', handler),
  };
}

// ---------------------------------------------------------------------------
// Profile extraction from SSR HTML
// ---------------------------------------------------------------------------

async function extractProfileFromPage(page) {
  return await page.evaluate(() => {
    // Find script containing __DEFAULT_SCOPE__ with user detail
    const scripts = Array.from(document.querySelectorAll('script'));

    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('"webapp.user-detail"')) continue;

      // Extract the JSON object (find matching braces)
      const jsonStart = text.indexOf('{"__DEFAULT_SCOPE__"');
      if (jsonStart < 0) continue;

      let depth = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) { jsonEnd = i; break; }
        }
      }

      try {
        const parsed = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
        const scope = parsed['__DEFAULT_SCOPE__'] || parsed;
        const userDetail = scope['webapp.user-detail'];
        if (userDetail?.userInfo) {
          return { found: true, data: userDetail };
        }
      } catch {}
    }

    // Fallback: DOM extraction via data-e2e attributes
    const domData = {};
    for (const el of document.querySelectorAll('[data-e2e]')) {
      const key = el.getAttribute('data-e2e');
      if (key) domData[key] = el.textContent?.trim();
    }

    if (domData['user-title'] || domData['followers-count']) {
      return { found: false, domFallback: true, domData };
    }

    return { found: false };
  });
}

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

function parseCount(str) {
  if (!str) return null;
  str = str.trim();
  const num = parseFloat(str.replace(/[,]/g, ''));
  if (isNaN(num)) return null;
  if (str.endsWith('B') || str.endsWith('b')) return Math.round(num * 1e9);
  if (str.endsWith('M') || str.endsWith('m')) return Math.round(num * 1e6);
  if (str.endsWith('K') || str.endsWith('k')) return Math.round(num * 1e3);
  return Math.round(num) || null;
}

function normalizeUser(user, stats) {
  return {
    id: user.id || '',
    uniqueId: user.uniqueId || '',
    nickname: user.nickname || '',
    secUid: user.secUid || '',
    signature: user.signature || '',
    bio_link: user.bioLink?.link || null,
    avatar_thumb: user.avatarThumb || null,
    avatar_medium: user.avatarMedium || null,
    verified: user.verified || false,
    private_account: user.privateAccount || user.secret || false,
    follower_count: stats?.followerCount ?? null,
    following_count: stats?.followingCount ?? null,
    video_count: stats?.videoCount ?? null,
    heart_count: stats?.heart ?? stats?.heartCount ?? null,
  };
}

function normalizeVideo(item) {
  const author = item.author || {};
  const stats = item.stats || {};
  const video = item.video || {};
  const challenges = (item.challenges || []).map(c => c.title).filter(Boolean);

  const videoUrls = video.PlayAddrStruct?.UrlList || [];
  const playUrl = videoUrls[0] || video.downloadAddr || null;

  return {
    id: item.id || '',
    desc: item.desc || '',
    create_time: item.createTime || null,
    create_time_iso: item.createTime
      ? new Date(item.createTime * 1000).toISOString()
      : null,
    author: {
      id: author.id || '',
      unique_id: author.uniqueId || '',
      nickname: author.nickname || '',
      sec_uid: author.secUid || '',
      avatar_thumb: author.avatarThumb || null,
      verified: author.verified || false,
      follower_count: author.followerCount
        ?? item.authorStats?.followerCount
        ?? null,
    },
    stats: {
      play_count: stats.playCount ?? null,
      digg_count: stats.diggCount ?? null,
      comment_count: stats.commentCount ?? null,
      share_count: stats.shareCount ?? null,
      collect_count: stats.collectCount ?? null,
    },
    video: {
      id: video.id || '',
      duration: video.duration || null,
      height: video.height || null,
      width: video.width || null,
      cover: video.cover || video.originCover || null,
      dynamic_cover: video.dynamicCover || null,
      play_url: playUrl,
      format: video.format || 'mp4',
      bitrate: video.bitrate || null,
    },
    hashtags: challenges,
    is_ad: item.isAd || false,
    video_url: `https://www.tiktok.com/@${author.uniqueId}/video/${item.id}`,
  };
}

function normalizeSearchItem(item) {
  return normalizeVideo(item);
}

// ---------------------------------------------------------------------------
// Scroll pagination helper
// ---------------------------------------------------------------------------

async function scrollForMoreContent(page, delay) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(delay);
  // Additional nudge
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight + 200));
  await sleep(delay / 2);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdProfile(username, flags) {
  if (!username) bail('Usage: video-scraper.mjs profile <username>');
  username = username.replace(/^@/, '').trim();
  if (!username) bail('Username cannot be empty');

  const session = loadSession();
  const { browser } = await launchBrowser({
    cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
    headless: flags['no-headless'] !== true,
  });

  const { page, context } = await createPage(browser, session);

  try {
    log(`Fetching profile: @${username}`);
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(2000);

    const wafStatus = await checkForWAF(page);
    if (wafStatus) {
      bail(`Bot detection triggered (${wafStatus}). Try --cdp-url with an active Chrome session.`, 4);
    }

    const title = await page.title();
    if (title.includes('TikTok - Make Your Day') && !title.includes(username) && !title.includes('@')) {
      bail(`Profile not found: @${username}`, 3);
    }

    const extracted = await extractProfileFromPage(page);

    let profileData;
    if (extracted.found) {
      const ui = extracted.data.userInfo;
      profileData = normalizeUser(ui.user, ui.stats);
    } else if (extracted.domFallback) {
      const d = extracted.domData;
      profileData = {
        uniqueId: username,
        nickname: d['user-title'] || username,
        signature: d['user-bio'] || '',
        bio_link: d['user-link'] || null,
        verified: false,
        private_account: false,
        follower_count: parseCount(d['followers-count']),
        following_count: parseCount(d['following-count']),
        heart_count: parseCount(d['likes-count']),
        source: 'dom_fallback',
      };
    } else {
      bail(`Could not extract profile data for @${username}. Profile may not exist.`, 3);
    }

    const result = {
      profile: profileData,
      meta: {
        scraped_at: new Date().toISOString(),
        username,
        source: extracted.found ? 'ssr' : 'dom',
        session_used: !!(session?.sessionid),
        note: 'For user videos (post/item_list), use the user-videos command which requires auth.',
      },
    };

    outputResult(result, flags.output);
    log(`✅ Profile: @${profileData.uniqueId} (${profileData.follower_count?.toLocaleString() || 'unknown'} followers)`);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function cmdHashtag(hashtag, flags) {
  if (!hashtag) bail('Usage: video-scraper.mjs hashtag <hashtag> [--pages=3]');
  hashtag = hashtag.replace(/^#/, '').trim().toLowerCase();

  const maxPages = parseInt(flags.pages) || 3;
  const delay = parseInt(flags.delay) || DEFAULT_DELAY_MS;

  const session = loadSession();
  const { browser } = await launchBrowser({
    cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
    headless: flags['no-headless'] !== true,
  });

  const { page, context } = await createPage(browser, session);

  try {
    log(`Navigating to hashtag page: #${hashtag}`);

    // Set up CDP interceptor for challenge/item_list
    const interceptor = setupCDPInterceptor(page, [
      '/api/challenge/item_list/',
      '/api/challenge/detail/',
    ]);

    await page.goto(`https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(delay);

    const wafStatus = await checkForWAF(page);
    if (wafStatus) {
      bail(`Bot detection triggered (${wafStatus}). Try --cdp-url with an active Chrome session.`, 4);
    }

    const title = await page.title();
    if (title.toLowerCase().includes('not found')) {
      bail(`Hashtag not found: #${hashtag}`, 3);
    }

    // TikTok's JS auto-calls challenge/detail and challenge/item_list on page load
    // Wait for initial data to be captured
    await sleep(delay);

    // Scroll to trigger more pages
    for (let pageNum = 1; pageNum < maxPages; pageNum++) {
      log(`Scrolling for page ${pageNum + 1}...`);
      await scrollForMoreContent(page, delay);
    }

    // Collect captured data
    const batches = interceptor.getBatches();
    interceptor.cleanup();

    // Extract hashtag info from detail response
    const detailBatch = batches.find(b => b.path.includes('/api/challenge/detail/'));
    let hashtagMeta = { title: hashtag };

    if (detailBatch?.parsed?.challengeInfo) {
      const ci = detailBatch.parsed.challengeInfo;
      const ch = ci.challenge || {};
      hashtagMeta = {
        id: ch.id || '',
        title: ch.title || hashtag,
        desc: ch.desc || '',
        cover: ch.coverMedium || ch.coverThumb || null,
        profile: ch.profileMedium || null,
        view_count: ci.stats?.viewCount ?? ci.statsV2?.viewCount ?? null,
        video_count: ci.stats?.videoCount ?? null,
      };
      log(`✅ Hashtag: #${hashtagMeta.title} (${hashtagMeta.view_count?.toLocaleString()} views)`);
    }

    // Collect all video items from item_list batches
    const itemListBatches = batches.filter(b => b.path.includes('/api/challenge/item_list/'));
    log(`Captured ${itemListBatches.length} video batch(es)`);

    const seenIds = new Set();
    const allVideos = [];

    for (const batch of itemListBatches) {
      const items = batch.parsed?.itemList || [];
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allVideos.push(normalizeVideo(item));
        }
      }
    }

    const lastBatch = itemListBatches[itemListBatches.length - 1];
    const hasMore = lastBatch?.parsed?.hasMore ?? false;

    if (allVideos.length === 0) {
      log('⚠️  No videos captured. TikTok may be rate-limiting. Wait a few minutes and retry.');
      // Don't bail — return empty result so caller can detect
    }

    const result = {
      hashtag: hashtagMeta,
      videos: allVideos,
      meta: {
        scraped_at: new Date().toISOString(),
        hashtag,
        videos_fetched: allVideos.length,
        batches_captured: itemListBatches.length,
        has_more: hasMore,
        session_used: !!(session?.sessionid),
      },
    };

    outputResult(result, flags.output);
    log(`✅ Done. Videos: ${allVideos.length} from #${hashtag}`);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function cmdSearch(keyword, flags) {
  if (!keyword) bail('Usage: video-scraper.mjs search <keyword> [--pages=3]');

  const maxPages = parseInt(flags.pages) || 3;
  const delay = parseInt(flags.delay) || DEFAULT_DELAY_MS;

  const session = loadSession();
  const { browser } = await launchBrowser({
    cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
    headless: flags['no-headless'] !== true,
  });

  const { page, context } = await createPage(browser, session);

  try {
    log(`Searching: "${keyword}"`);

    const interceptor = setupCDPInterceptor(page, [
      '/api/search/general/full/',
      '/api/search/general/preview/',
    ]);

    await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(delay);

    const wafStatus = await checkForWAF(page);
    if (wafStatus) {
      bail(`Bot detection triggered (${wafStatus}). Try --cdp-url with an active Chrome session.`, 4);
    }

    // Scroll to trigger pagination
    for (let pageNum = 1; pageNum < maxPages; pageNum++) {
      log(`Scrolling for page ${pageNum + 1}...`);
      await scrollForMoreContent(page, delay);
    }

    const batches = interceptor.getBatches();
    interceptor.cleanup();

    const searchBatches = batches.filter(b => b.path.includes('/api/search/general/full/'));
    log(`Captured ${searchBatches.length} search batch(es)`);

    const seenIds = new Set();
    const allVideos = [];

    for (const batch of searchBatches) {
      const items = (batch.parsed?.data || []).filter(d => d.type === 1 && d.item);
      for (const d of items) {
        const item = d.item;
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allVideos.push(normalizeSearchItem(item));
        }
      }
    }

    const lastBatch = searchBatches[searchBatches.length - 1];
    const hasMore = !!(lastBatch?.parsed?.has_more);

    if (allVideos.length === 0) {
      log('⚠️  No search results captured. TikTok may be rate-limiting. Try again in a few minutes.');
    }

    const result = {
      keyword,
      videos: allVideos,
      meta: {
        scraped_at: new Date().toISOString(),
        keyword,
        videos_fetched: allVideos.length,
        batches_captured: searchBatches.length,
        has_more: hasMore,
        session_used: !!(session?.sessionid),
      },
    };

    outputResult(result, flags.output);
    log(`✅ Done. Found ${allVideos.length} videos for "${keyword}"`);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function cmdTrending(flags) {
  const maxPages = parseInt(flags.pages) || 2;
  const delay = parseInt(flags.delay) || DEFAULT_DELAY_MS;

  const session = loadSession();
  const { browser } = await launchBrowser({
    cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
    headless: flags['no-headless'] !== true,
  });

  const { page, context } = await createPage(browser, session);

  try {
    log('Fetching trending videos...');

    const interceptor = setupCDPInterceptor(page, [
      '/api/recommend/item_list/',
    ]);

    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(delay);

    const wafStatus = await checkForWAF(page);
    if (wafStatus) {
      bail(`Bot detection triggered (${wafStatus}). Try --cdp-url with an active Chrome session.`, 4);
    }

    // Scroll to get more
    for (let p = 1; p < maxPages; p++) {
      await scrollForMoreContent(page, delay);
    }

    const batches = interceptor.getBatches();
    interceptor.cleanup();

    const trendingBatches = batches.filter(b => b.path.includes('/api/recommend/item_list/'));
    log(`Captured ${trendingBatches.length} trending batch(es)`);

    const seenIds = new Set();
    const allVideos = [];

    for (const batch of trendingBatches) {
      const items = batch.parsed?.itemList || [];
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allVideos.push(normalizeVideo(item));
        }
      }
    }

    if (allVideos.length === 0) {
      log('⚠️  No trending videos captured.');
    }

    const result = {
      videos: allVideos,
      meta: {
        scraped_at: new Date().toISOString(),
        videos_fetched: allVideos.length,
        batches_captured: trendingBatches.length,
        session_used: !!(session?.sessionid),
      },
    };

    outputResult(result, flags.output);
    log(`✅ Done. Trending videos: ${allVideos.length}`);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function cmdUserVideos(username, flags) {
  if (!username) bail('Usage: video-scraper.mjs user-videos <username> [--pages=3]');
  username = username.replace(/^@/, '').trim();

  const maxPages = parseInt(flags.pages) || 3;
  const delay = parseInt(flags.delay) || DEFAULT_DELAY_MS;

  const session = loadSession();
  if (!session?.sessionid) {
    bail(
      'user-videos requires TikTok authentication (sessionid cookie).\n' +
      '  1. Open Chrome and log in to TikTok\n' +
      '  2. Run: node video-scraper.mjs auth --cdp-url=http://localhost:9333\n' +
      '  3. Retry: node video-scraper.mjs user-videos @' + username,
      2
    );
  }

  const { browser } = await launchBrowser({
    cdpUrl: flags['cdp-url'] || process.env.CHROME_CDP_URL,
    headless: flags['no-headless'] !== true,
  });

  const { page, context } = await createPage(browser, session);

  try {
    log(`Fetching videos for @${username}...`);

    // Set up CDP interceptor for post/item_list AND user/detail
    const interceptor = setupCDPInterceptor(page, [
      '/api/post/item_list/',
      '/api/user/detail/',
    ]);

    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(delay);

    // Check for session expiry signs
    const content = await page.content();
    if (content.includes('"statusCode":10201') || content.includes('"require_login":true')) {
      bail('Session expired. Re-run: node video-scraper.mjs auth', 5);
    }

    const wafStatus = await checkForWAF(page);
    if (wafStatus) {
      bail(`Bot detection triggered (${wafStatus}).`, 4);
    }

    // Extract profile from SSR
    const extracted = await extractProfileFromPage(page);
    let profileData = null;

    if (extracted.found) {
      const ui = extracted.data.userInfo;
      profileData = normalizeUser(ui.user, ui.stats);
      log(`Profile: @${profileData.uniqueId} (${profileData.follower_count?.toLocaleString()} followers)`);
    }

    // Check if private
    if (profileData?.private_account) {
      log('⚠️  This account is private. Video list may not be accessible.');
    }

    // Scroll to trigger post/item_list requests
    log('Scrolling to trigger video list requests...');
    for (let p = 0; p < maxPages + 2; p++) {
      await scrollForMoreContent(page, delay);
    }

    const batches = interceptor.getBatches();
    interceptor.cleanup();

    const postBatches = batches.filter(b => b.path.includes('/api/post/item_list/'));
    log(`Captured ${postBatches.length} video batch(es)`);

    const seenIds = new Set();
    const allVideos = [];

    for (const batch of postBatches) {
      // Check for auth errors
      const sc = batch.parsed?.statusCode ?? batch.parsed?.status_code;
      if (sc === 10201 || sc === 10202) {
        log(`Auth error in response (statusCode=${sc}). Session may be expired.`);
        bail('Session expired or invalid. Re-run: node video-scraper.mjs auth', 5);
      }

      const items = batch.parsed?.itemList || [];
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allVideos.push(normalizeVideo(item));
        }
      }
    }

    if (allVideos.length === 0) {
      log('⚠️  No user videos captured via CDP interception.');
      log('   Possible causes:');
      log('   - TikTok rotated X-Bogus signing: page may not trigger API requests correctly');
      log('   - Rate limiting in effect');
      log('   - Private account or login required');
    }

    const lastBatch = postBatches[postBatches.length - 1];
    const hasMore = lastBatch?.parsed?.hasMore ?? false;

    const result = {
      profile: profileData,
      videos: allVideos,
      meta: {
        scraped_at: new Date().toISOString(),
        username,
        videos_fetched: allVideos.length,
        batches_captured: postBatches.length,
        has_more: hasMore,
        session_used: true,
        method: 'cdp_intercept',
        note: allVideos.length === 0
          ? 'No videos captured. post/item_list uses X-Bogus signing that may have changed.'
          : undefined,
      },
    };

    outputResult(result, flags.output);
    log(`✅ Done. Videos: ${allVideos.length} for @${username}`);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function cmdAuth(flags) {
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9333';
  const { browser } = await launchBrowser({ cdpUrl });
  const session = await captureSession(browser);
  const result = { success: true, hasSession: !!session.sessionid };
  console.log(JSON.stringify(result));
}

async function cmdCheckSession(flags) {
  const session = loadSession();
  if (!session?.sessionid) {
    console.log(JSON.stringify({ valid: false, reason: 'No session found. Run: node video-scraper.mjs auth' }));
    process.exit(5);
  }

  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const { browser } = await launchBrowser({ cdpUrl, headless: flags['no-headless'] !== true });
  const { page, context } = await createPage(browser, session);

  try {
    await page.goto('https://www.tiktok.com/@tiktok', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    const cookies = await context.cookies(['https://www.tiktok.com']);
    const hasSessionId = cookies.some(c => c.name === 'sessionid');

    if (hasSessionId) {
      console.log(JSON.stringify({ valid: true, note: 'Session cookie present' }));
    } else {
      console.log(JSON.stringify({ valid: false, reason: 'Session expired. Re-run auth.' }));
      process.exit(5);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function outputResult(result, outputFile) {
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    log(`Saved to ${outputFile}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
TikTok Video Scraper

USAGE:
  node video-scraper.mjs <command> [args] [options]

COMMANDS:
  profile <username>         Scrape public user profile (no auth needed)
  hashtag <hashtag>          Scrape videos from a hashtag (no auth needed)
  search <keyword>           Search for videos (no auth needed)
  trending                   Fetch trending/For You videos (no auth needed)
  user-videos <username>     Scrape user's own videos (requires auth)
  auth                       Capture TikTok session from Chrome
  check-session              Verify stored session is valid

OPTIONS:
  --pages=<n>          Max pagination pages (default: 3)
  --delay=<ms>         Delay between scrolls in ms (default: 2000)
  --output=<file>      Save results to JSON file
  --cdp-url=<url>      Connect to existing Chrome (e.g. http://localhost:9333)
  --no-headless        Show browser window

ENVIRONMENT VARIABLES:
  CHROME_CDP_URL       Default CDP URL for existing Chrome
  CHROME_EXECUTABLE    Path to Chrome/Chromium binary
  QUIET                Suppress log output
  DEBUG                Show full stack traces on error

EXAMPLES:
  node video-scraper.mjs profile charlidamelio
  node video-scraper.mjs hashtag funny --pages=3
  node video-scraper.mjs search "dance challenge" --pages=2
  node video-scraper.mjs trending --pages=2
  node video-scraper.mjs hashtag cats --output=/tmp/cats-videos.json
  node video-scraper.mjs profile khaby.lame --cdp-url=http://localhost:9333

  # For user videos (requires Chrome open + logged in to TikTok):
  node video-scraper.mjs auth --cdp-url=http://localhost:9333
  node video-scraper.mjs user-videos charlidamelio --pages=5

EXIT CODES:
  0  Success
  1  General error
  2  Login required (for user-videos command)
  3  Profile/hashtag/keyword not found
  4  WAF/rate-limit block or bot detection
  5  Session expired (re-run auth)
`);
    process.exit(0);
  }

  const cmd = args[0];
  const { flags, positional } = parseFlags(args.slice(1));

  switch (cmd) {
    case 'profile':
      await cmdProfile(positional[0], flags);
      break;
    case 'hashtag':
      await cmdHashtag(positional[0], flags);
      break;
    case 'search':
      await cmdSearch(positional.join(' ') || flags.q, flags);
      break;
    case 'trending':
      await cmdTrending(flags);
      break;
    case 'user-videos':
      await cmdUserVideos(positional[0], flags);
      break;
    case 'auth':
      await cmdAuth(flags);
      break;
    case 'check-session':
      await cmdCheckSession(flags);
      break;
    default:
      bail(`Unknown command: ${cmd}. Run with --help for usage.`);
  }
}

main().then(() => {
  process.exit(0);
}).catch(e => {
  console.error('[tiktok:fatal]', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
