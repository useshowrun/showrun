#!/usr/bin/env node
/**
 * Instagram Profile Scraper
 *
 * Scrapes public Instagram profiles without requiring a login (for basic data).
 * Optionally uses a sessionid cookie for paginated post scraping.
 *
 * Strategy:
 *   - Launch/connect to Chrome via Playwright
 *   - Navigate to instagram.com to get baseline cookies
 *   - Call `web_profile_info` API from within browser context (bypasses CORS/WAF)
 *   - Optionally paginate posts via `feed/user/{id}` API (requires sessionid)
 *
 * Usage:
 *   node profile-scraper.mjs scrape <username> [options]
 *   node profile-scraper.mjs auth                    # capture sessionid from Chrome
 *   node profile-scraper.mjs check-session           # verify stored session is valid
 *
 * Options:
 *   --output=<file>              Save results to JSON file (default: stdout)
 *   --posts=<n>                  Number of posts to fetch (default: 12, max without session: 12)
 *   --cdp-url=<url>             Connect to existing Chrome (default: http://localhost:9222)
 *   --no-headless               Show browser window
 *   --cache                     Cache results to ~/.local/share/showrun/data/instagram/
 *
 * Requires:
 *   - Node.js 22+
 *   - playwright npm package (globally or in node_modules)
 *   - Google Chrome or Chromium
 *
 * Exit codes:
 *   0  Success
 *   1  General error
 *   2  Login required (sessionid needed for requested feature)
 *   3  Profile not found / private
 *   4  WAF/rate-limit block
 *   5  Session expired (re-run auth)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/instagram');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const IG_APP_ID = '936619743392459';
const IG_ASBD_ID = '129477';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_EXECUTABLES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

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

function cacheKey(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
}

function log(...args) {
  if (!process.env.QUIET) console.error('[instagram]', ...args);
}

function bail(msg, code = 1) {
  console.error(`[instagram:error] ${msg}`);
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

async function sleep(ms) {
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
      const mod = await import(candidate);
      return mod;
    } catch {}
  }
  bail(
    'playwright not found. Install it:\n' +
    '  sudo npm install -g playwright\n' +
    '  OR: npm install playwright  (in the skill directory)\n' +
    '  Then: npx playwright install chromium'
  );
}

async function launchBrowser(opts = {}) {
  const { chromium } = await loadPlaywright();

  const cdpUrl = opts.cdpUrl || process.env.CHROME_CDP_URL;

  if (cdpUrl) {
    log(`Connecting to existing Chrome via CDP: ${cdpUrl}`);
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      log('Connected to existing Chrome');
      return { browser, connected: true };
    } catch (e) {
      log(`CDP connect failed (${e.message}), launching fresh browser`);
    }
  }

  const chrome = findChrome();
  if (!chrome) {
    bail(
      'Chrome/Chromium not found. Install it or set CHROME_EXECUTABLE env var.\n' +
      '  Linux: sudo pacman -S google-chrome  OR  sudo apt install google-chrome-stable\n' +
      '  macOS: brew install --cask google-chrome'
    );
  }

  log(`Launching Chrome: ${chrome}`);
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: opts.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
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
  log('Looking for Instagram session in browser...');

  const contexts = browser.contexts();
  const allCookies = [];

  for (const ctx of contexts) {
    try {
      const cookies = await ctx.cookies(['https://www.instagram.com', 'https://i.instagram.com']);
      allCookies.push(...cookies);
    } catch {}
  }

  const sessionid = allCookies.find(c => c.name === 'sessionid');
  if (!sessionid) {
    log('No sessionid cookie found. Make sure you are logged in to Instagram in Chrome.');
    log('Open Chrome, go to https://www.instagram.com, log in, then re-run auth.');
    bail('sessionid cookie not found in browser', 5);
  }

  const relevant = allCookies.filter(c =>
    ['sessionid', 'csrftoken', 'ig_did', 'datr', 'mid', 'ds_user_id', 'rur'].includes(c.name)
  );

  const session = {
    cookies: relevant,
    cookieStr: relevant.map(c => `${c.name}=${c.value}`).join('; '),
    sessionid: sessionid.value,
    csrftoken: allCookies.find(c => c.name === 'csrftoken')?.value || '',
    userId: allCookies.find(c => c.name === 'ds_user_id')?.value || '',
  };

  saveSession(session);
  log(`✅ Session captured! User ID: ${session.userId || 'unknown'}`);
  return session;
}

// ---------------------------------------------------------------------------
// Core API calls (executed from within browser context)
// ---------------------------------------------------------------------------

async function fetchProfileInBrowser(page, username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  const result = await page.evaluate(async ({ url, appId, asbdId }) => {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-IG-App-ID': appId,
          'X-ASBD-ID': asbdId,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
      });

      const body = await resp.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch {}

      return {
        status: resp.status,
        ok: resp.ok,
        body: body.substring(0, 100000),
        parsed,
        rateLimitRemaining: resp.headers.get('x-ratelimit-remaining'),
        rateLimitLimit: resp.headers.get('x-ratelimit-limit'),
      };
    } catch (e) {
      return { error: e.message };
    }
  }, { url, appId: IG_APP_ID, asbdId: IG_ASBD_ID });

  return result;
}

async function fetchUserFeedInBrowser(page, userId, maxId = null, count = 12) {
  let url = `https://i.instagram.com/api/v1/feed/user/${userId}/?count=${count}`;
  if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

  const result = await page.evaluate(async ({ url, appId, asbdId }) => {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-IG-App-ID': appId,
          'X-ASBD-ID': asbdId,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
      });

      const body = await resp.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch {}

      return {
        status: resp.status,
        ok: resp.ok,
        body: body.substring(0, 200000),
        parsed,
      };
    } catch (e) {
      return { error: e.message };
    }
  }, { url, appId: IG_APP_ID, asbdId: IG_ASBD_ID });

  return result;
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

function extractProfileData(user) {
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    biography: user.biography || '',
    bio_links: (user.bio_links || []).map(l => ({
      title: l.title || '',
      url: l.url || l.lynx_url || '',
    })),
    external_url: user.external_url || null,
    profile_pic_url: user.profile_pic_url || null,
    profile_pic_url_hd: user.profile_pic_url_hd || null,
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_business_account: user.is_business_account,
    is_professional_account: user.is_professional_account,
    category_name: user.category_name || user.business_category_name || null,
    follower_count: user.edge_followed_by?.count ?? null,
    following_count: user.edge_follow?.count ?? null,
    post_count: user.edge_owner_to_timeline_media?.count ?? null,
    highlight_reel_count: user.highlight_reel_count ?? 0,
  };
}

function extractPostData(node) {
  // Extract from web_profile_info edge format
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || null;
  const children = node.edge_sidecar_to_children?.edges?.map(e => ({
    id: e.node.id,
    display_url: e.node.display_url,
    is_video: e.node.is_video,
    video_url: e.node.video_url || null,
    dimensions: e.node.dimensions,
  })) || null;

  return {
    id: node.id,
    shortcode: node.shortcode,
    type: node.__typename || (node.is_video ? 'GraphVideo' : 'GraphImage'),
    display_url: node.display_url || node.thumbnail_src || null,
    thumbnail_src: node.thumbnail_src || null,
    is_video: node.is_video || false,
    video_url: node.video_url || null,
    taken_at: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
    like_count: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? null,
    comment_count: node.edge_media_to_comment?.count ?? null,
    caption,
    location: node.location ? { id: node.location.id, name: node.location.name } : null,
    accessibility_caption: node.accessibility_caption || null,
    dimensions: node.dimensions || null,
    children: children,
    post_url: `https://www.instagram.com/p/${node.shortcode}/`,
  };
}

function extractFeedItemData(item) {
  // Extract from feed/user/{id} format
  const caption = item.caption?.text || null;
  const carouselMedia = item.carousel_media?.map(m => ({
    id: m.pk,
    media_type: m.media_type,
    image_url: m.image_versions2?.candidates?.[0]?.url || null,
    video_url: m.video_versions?.[0]?.url || null,
    dimensions: { width: m.original_width, height: m.original_height },
  })) || null;

  return {
    id: item.pk,
    shortcode: item.code,
    type: item.media_type === 1 ? 'GraphImage' : item.media_type === 2 ? 'GraphVideo' : 'GraphSidecar',
    display_url: item.image_versions2?.candidates?.[0]?.url || item.display_uri || null,
    thumbnail_url: item.image_versions2?.candidates?.[1]?.url || null,
    is_video: item.media_type === 2,
    video_url: item.video_versions?.[0]?.url || null,
    taken_at: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
    like_count: item.like_count ?? null,
    comment_count: item.comment_count ?? null,
    caption,
    location: item.locations?.[0] ? { id: item.locations[0].pk, name: item.locations[0].name } : null,
    dimensions: { width: item.original_width, height: item.original_height },
    carousel_media: carouselMedia,
    post_url: `https://www.instagram.com/p/${item.code}/`,
  };
}

// ---------------------------------------------------------------------------
// Main commands
// ---------------------------------------------------------------------------

async function cmdAuth(flags) {
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const { browser } = await launchBrowser({ cdpUrl, headless: false });
  const session = await captureSession(browser);
  console.log(JSON.stringify({ success: true, userId: session.userId, hasSession: true }));
}

async function cmdCheckSession(flags) {
  const session = loadSession();
  if (!session?.sessionid) {
    console.log(JSON.stringify({ valid: false, reason: 'No session found. Run: node profile-scraper.mjs auth' }));
    process.exit(5);
  }

  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const { browser } = await launchBrowser({ cdpUrl, headless: flags['headless'] !== 'false' });
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    // Inject session cookies
    await context.addCookies(session.cookies);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 30000 });

    const cookies = await context.cookies(['https://www.instagram.com']);
    const hasSession = cookies.some(c => c.name === 'sessionid');

    if (!hasSession) {
      console.log(JSON.stringify({ valid: false, reason: 'Session expired. Re-run auth.' }));
      process.exit(5);
    }

    // Test with a known profile
    const result = await fetchProfileInBrowser(page, 'instagram');
    if (result.status === 200) {
      console.log(JSON.stringify({ valid: true, userId: session.userId }));
    } else {
      console.log(JSON.stringify({ valid: false, reason: `API returned ${result.status}`, status: result.status }));
      process.exit(result.status === 401 ? 5 : 4);
    }
  } finally {
    await page.close();
  }
}

async function cmdScrape(username, flags) {
  if (!username) bail('Usage: profile-scraper.mjs scrape <username> [options]');

  username = username.replace(/^@/, '').trim();
  if (!username) bail('Username cannot be empty');

  const postsRequested = parseInt(flags.posts) || 12;
  const outputFile = flags.output || null;
  const useCache = flags.cache === true;
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const headless = flags['no-headless'] !== true;

  // Check cache
  const cacheFile = resolve(CACHE_DIR, `profile-${cacheKey(username)}.json`);
  if (useCache && existsSync(cacheFile)) {
    log(`Loading from cache: ${cacheFile}`);
    const cached = loadJson(cacheFile);
    if (outputFile) {
      writeFileSync(outputFile, JSON.stringify(cached, null, 2));
      log(`Saved to ${outputFile}`);
    } else {
      console.log(JSON.stringify(cached, null, 2));
    }
    return;
  }

  // Load session (optional)
  const session = loadSession();
  const hasSession = !!session?.sessionid;
  const canPaginate = hasSession && postsRequested > 12;

  if (postsRequested > 12 && !hasSession) {
    log(`⚠️  Requesting ${postsRequested} posts but no session found. Only 12 posts available without login.`);
    log(`   Run 'node profile-scraper.mjs auth' to enable post pagination.`);
  }

  // Launch browser
  const { browser } = await launchBrowser({ cdpUrl, headless });
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    // Inject session cookies if available
    if (hasSession) {
      log('Injecting session cookies...');
      try {
        await context.addCookies(session.cookies.map(c => ({
          ...c,
          domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        })));
      } catch (e) {
        log(`Cookie injection warning: ${e.message}`);
      }
    }

    // Navigate to instagram.com to establish base cookies (CSRF, ig_did, etc.)
    log('Establishing Instagram session...');
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(1500);

    // Check for login wall or captcha
    const pageTitle = await page.title();
    const pageContent = await page.content();

    // Check for actual security challenge (not just CSS variable names)
    const isSecurityChallenge =
      pageContent.includes('/challenge/?next=') ||
      pageContent.includes('"challenge_type"') ||
      pageContent.includes('accounts/login/?next') && pageContent.includes('challenge') ||
      pageContent.includes('/challenge/action/');

    if (isSecurityChallenge) {
      bail('Instagram security challenge detected. Please complete it in Chrome and re-run auth.', 4);
    }

    // Fetch profile
    log(`Fetching profile: @${username}`);
    const profileResp = await fetchProfileInBrowser(page, username);

    if (profileResp.error) {
      bail(`Network error: ${profileResp.error}`, 4);
    }

    if (profileResp.status === 404) {
      bail(`Profile not found: @${username}`, 3);
    }

    if (profileResp.status === 401) {
      // Instagram returns 401 for both auth failures and rate limiting
      const body = profileResp.parsed || {};
      const msg = body.message || '';
      if (msg.includes('wait') || msg.includes('minutes')) {
        bail(`Rate limited by Instagram: "${msg}" — Wait a few minutes and try again.`, 4);
      }
      if (hasSession) {
        bail('Session expired. Re-run: node profile-scraper.mjs auth', 5);
      }
      bail('Instagram requires login for this profile. The profile may be private, or you may be rate-limited. Wait a few minutes and try again. For private profiles, run auth.', 2);
    }

    if (profileResp.status === 429) {
      bail('Rate limited by Instagram. Wait a few minutes and try again.', 4);
    }

    // Check for WAF blocks (avoid false positives from "blocked_by_viewer" field in normal responses)
    const isWafBlock = profileResp.status === 403 ||
      (profileResp.body && !profileResp.body.startsWith('{') &&
       (profileResp.body.includes('Access Denied') || profileResp.body.includes('Bot detected')));

    if (isWafBlock) {
      bail('WAF/bot block detected. Try using --cdp-url to attach to your real Chrome session.', 4);
    }

    if (!profileResp.ok || !profileResp.parsed?.data?.user) {
      const bodySnippet = profileResp.body?.substring(0, 200) || 'no body';
      bail(`Unexpected response (HTTP ${profileResp.status}): ${bodySnippet}`, 1);
    }

    const user = profileResp.parsed.data.user;

    // Check if profile is private
    if (user.is_private && !hasSession) {
      log(`⚠️  @${username} is a private account. Only public profile info available.`);
    }

    // Extract profile info
    const profile = extractProfileData(user);
    log(`✅ Got profile: @${profile.username} (${profile.follower_count?.toLocaleString()} followers)`);

    // Extract inline posts from profile response (up to 12)
    const inlineEdges = user.edge_owner_to_timeline_media?.edges || [];
    const inlinePosts = inlineEdges.map(e => extractPostData(e.node));
    const profilePageInfo = user.edge_owner_to_timeline_media?.page_info || {};

    log(`Inline posts: ${inlinePosts.length} of ${profile.post_count || '?'} total`);

    let posts = inlinePosts;
    let hasMorePosts = profilePageInfo.has_next_page || false;

    // If more posts requested and session available, paginate via feed API
    if (canPaginate && postsRequested > inlinePosts.length && hasMorePosts) {
      log(`Fetching additional posts (target: ${postsRequested})...`);
      const userId = profile.id;

      // First page of feed API
      let nextMaxId = null;
      let feedPage = 1;

      while (posts.length < postsRequested) {
        log(`Fetching feed page ${feedPage} (have ${posts.length} posts)...`);

        const feedResp = await fetchUserFeedInBrowser(page, userId, nextMaxId, 12);

        if (feedResp.status === 401) {
          log('⚠️  Session expired during pagination. Stopping at current post count.');
          hasMorePosts = false;
          break;
        }

        if (!feedResp.ok || !feedResp.parsed?.items) {
          log(`Feed request failed (HTTP ${feedResp.status}). Stopping pagination.`);
          hasMorePosts = false;
          break;
        }

        const feedItems = feedResp.parsed.items || [];
        posts.push(...feedItems.map(extractFeedItemData));

        hasMorePosts = feedResp.parsed.more_available;
        nextMaxId = feedResp.parsed.next_max_id;

        if (!hasMorePosts || !nextMaxId) break;

        feedPage++;
        // Rate limit delay
        await sleep(2000 + Math.random() * 1000);
      }

      // Trim to requested count
      posts = posts.slice(0, postsRequested);
    }

    // Build result
    const result = {
      profile,
      posts,
      meta: {
        scraped_at: new Date().toISOString(),
        posts_fetched: posts.length,
        posts_total: profile.post_count,
        has_more_posts: hasMorePosts,
        pagination_note: !hasSession && profile.post_count > 12
          ? 'Only 12 posts available without login. Run auth to enable full pagination.'
          : undefined,
        session_used: hasSession,
      },
    };

    // Cache result
    if (useCache) {
      saveJson(cacheFile, result);
      log(`Cached to ${cacheFile}`);
    }

    // Output
    if (outputFile) {
      writeFileSync(outputFile, JSON.stringify(result, null, 2));
      log(`Saved to ${outputFile}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    log(`✅ Done. Profile: @${profile.username}, Posts: ${posts.length}`);

  } finally {
    try { await page.close(); } catch {}
    // Don't close the browser if we connected to an existing one
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Instagram Profile Scraper

USAGE:
  node profile-scraper.mjs scrape <username> [options]
  node profile-scraper.mjs auth [--cdp-url=<url>]
  node profile-scraper.mjs check-session [--cdp-url=<url>]

COMMANDS:
  scrape <username>       Scrape a public Instagram profile
  auth                    Capture session from Chrome (for pagination)
  check-session           Verify stored session is still valid

OPTIONS (for scrape):
  --posts=<n>            Number of posts to fetch (default: 12)
                         Note: >12 requires auth (sessionid cookie)
  --output=<file>        Save results to JSON file
  --cache                Cache results locally
  --cdp-url=<url>        Connect to existing Chrome (e.g. http://localhost:9222)
  --no-headless          Show browser window

ENVIRONMENT VARIABLES:
  CHROME_CDP_URL         Default CDP URL for existing Chrome
  CHROME_EXECUTABLE      Path to Chrome/Chromium binary
  QUIET                  Suppress log output

EXAMPLES:
  # Scrape public profile (no auth needed):
  node profile-scraper.mjs scrape cristiano

  # Scrape with more posts (requires auth):
  node profile-scraper.mjs auth --cdp-url=http://localhost:9333
  node profile-scraper.mjs scrape cristiano --posts=50

  # Use existing Chrome session:
  node profile-scraper.mjs scrape natgeo --cdp-url=http://localhost:9333

  # Save to file:
  node profile-scraper.mjs scrape instagram --output=/tmp/ig-profile.json

EXIT CODES:
  0  Success
  1  General error
  2  Login required
  3  Profile not found or private
  4  WAF/rate-limit block
  5  Session expired (re-run auth)
`);
    process.exit(0);
  }

  const cmd = args[0];
  const { flags, positional } = parseFlags(args.slice(1));

  switch (cmd) {
    case 'scrape':
      await cmdScrape(positional[0], flags);
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
  console.error('[instagram:fatal]', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
