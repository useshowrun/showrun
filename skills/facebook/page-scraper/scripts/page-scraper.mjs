#!/usr/bin/env node
/**
 * Facebook Page Scraper
 *
 * Scrapes public Facebook Pages: metadata, follower counts, category, contact info,
 * recent post stubs, and photo grid — no login required for basic page data.
 * Full post feed pagination requires a valid Facebook session (cookies from logged-in Chrome).
 *
 * Strategy:
 *   - Launch/connect to Chrome via Playwright
 *   - Navigate to facebook.com/{page_slug}
 *   - Wait for networkidle (React app fully hydrated)
 *   - Extract page metadata from OG tags + DOM
 *   - Extract posts from DOM (limited without session)
 *   - With session: scroll to load more posts
 *
 * Usage:
 *   node page-scraper.mjs scrape <page_slug_or_id> [options]
 *   node page-scraper.mjs auth [--cdp-url=<url>]
 *   node page-scraper.mjs check-session
 *
 * Options:
 *   --output=<file>       Save results to JSON file (default: stdout)
 *   --cdp-url=<url>       Connect to existing Chrome (default: http://localhost:9333)
 *   --no-headless         Show browser window
 *   --scroll=<n>          Number of scroll attempts (default: 3)
 *   --cache               Cache results to ~/.local/share/showrun/data/facebook/
 *   --verbose             Enable detailed logging
 *
 * Exit codes:
 *   0  Success
 *   1  General error
 *   2  Login required (private page or login wall)
 *   3  Page not found
 *   4  WAF/rate-limit block
 *   5  Session expired (re-run auth)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/facebook');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_EXECUTABLES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const CDP_PORTS = [9333, 9222, 9224];

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

let verboseMode = false;

function log(...args) {
  if (verboseMode || process.env.VERBOSE) console.error('[facebook]', ...args);
}

function info(...args) {
  console.error('[facebook]', ...args);
}

function bail(msg, code = 1) {
  console.error(`[facebook:error] ${msg}`);
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

function cacheKey(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
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

  // Try CDP connection first (existing Chrome)
  if (cdpUrl) {
    log(`Connecting to existing Chrome via CDP: ${cdpUrl}`);
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      log('Connected to existing Chrome');
      return { browser, connected: true };
    } catch (e) {
      log(`CDP connect failed (${e.message}), launching fresh browser`);
    }
  } else {
    // Try auto-detect CDP on common ports
    for (const port of CDP_PORTS) {
      try {
        const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
        log(`Auto-connected to Chrome on port ${port}`);
        return { browser, connected: true };
      } catch {}
    }
  }

  // Launch fresh Chrome
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
  info(`Session saved to ${SESSION_FILE}`);
}

async function captureSession(browser) {
  info('Looking for Facebook session in browser...');

  const contexts = browser.contexts();
  const allCookies = [];

  for (const ctx of contexts) {
    try {
      const cookies = await ctx.cookies(['https://www.facebook.com', 'https://facebook.com']);
      allCookies.push(...cookies);
    } catch {}
  }

  const cUser = allCookies.find(c => c.name === 'c_user');
  const xs = allCookies.find(c => c.name === 'xs');

  if (!cUser || !xs) {
    info('No Facebook session cookies found.');
    info('Make sure you are logged in to Facebook in Chrome.');
    info('Open Chrome, go to https://www.facebook.com, log in, then re-run auth.');
    bail('Facebook session cookies (c_user, xs) not found in browser', 5);
  }

  const relevant = allCookies.filter(c =>
    ['c_user', 'xs', 'datr', 'sb', 'fr', 'wd', 'locale', 'dpr', 'noscript', 'usida'].includes(c.name)
  );

  const session = {
    cookies: relevant,
    cookieStr: relevant.map(c => `${c.name}=${c.value}`).join('; '),
    userId: cUser.value,
  };

  saveSession(session);
  info(`✅ Session captured! User ID: ${session.userId}`);
  return session;
}

// ---------------------------------------------------------------------------
// Facebook-specific detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the page is a login wall (not a public page).
 * Must NOT trigger on normal public pages which also have a login form in the sidebar.
 */
async function isLoginWall(page) {
  const result = await page.evaluate(() => {
    const body = document.body;
    if (!body) return { loginWall: true, reason: 'no body' };

    const title = document.title;
    const url = window.location.href;

    // If page was redirected to login URL
    if (url.includes('/login') || url.includes('/checkpoint')) {
      return { loginWall: true, reason: 'redirected to login' };
    }

    // Check for OG title presence (public pages always have og:title)
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    if (!ogTitle || ogTitle === 'Facebook') {
      // Only a login wall if the page also doesn't have profile content
      const hasH1 = !!document.querySelector('h1');
      if (!hasH1) {
        return { loginWall: true, reason: 'no og:title and no h1 - pure login wall' };
      }
    }

    // WAF/error page detection
    const headTitle = document.querySelector('head > title')?.textContent || '';
    if (headTitle === 'Error' || headTitle.includes('something went wrong')) {
      return { loginWall: false, waf: true, reason: 'error page' };
    }

    // Content length check - a real page is large
    const contentLen = body.innerHTML.length;
    if (contentLen < 10000) {
      return { loginWall: true, reason: `page too small (${contentLen} bytes)` };
    }

    return { loginWall: false, reason: 'page appears to be a real public page' };
  });

  return result;
}

/**
 * Check if page is a WAF/error page
 */
async function isWafBlock(page) {
  const url = page.url();
  const title = await page.title();
  if (title === 'Error' || url.includes('/checkpoint')) return true;
  const content = await page.content();
  if (content.length < 5000 && content.includes('something went wrong')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Page data extraction (runs in browser context)
// ---------------------------------------------------------------------------

async function extractPageData(page) {
  return await page.evaluate(() => {
    // OG tags
    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => {
      og[m.getAttribute('property')] = m.getAttribute('content') || '';
    });

    // Twitter card tags (sometimes have extra info)
    const tw = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
      tw[m.getAttribute('name')] = m.getAttribute('content') || '';
    });

    // Page ID from app deep link
    const androidUrl = document.querySelector('meta[property="al:android:url"]')?.content || '';
    const iosUrl = document.querySelector('meta[property="al:ios:url"]')?.content || '';
    const pageIdMatch = (androidUrl || iosUrl).match(/(\d{10,})/);
    const pageId = pageIdMatch?.[1] || null;

    // Canonical URL
    const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || '';
    const slugFromCanonical = canonicalUrl.replace('https://www.facebook.com/', '').split('/')[0] || '';

    // Page name from h1
    const h1Text = document.querySelector('h1')?.innerText?.trim() || '';

    // Description from meta
    const metaDesc = document.querySelector('meta[name="description"]')?.content || '';

    // Category from DOM
    let category = null;
    const bodyText = document.body.innerText;

    // "Page · Category" pattern
    const catMatch = bodyText.match(/^Page · (.+)$/m);
    if (catMatch) category = catMatch[1].trim();

    // Follower/following counts
    // Priority: og:description (precise exact number) > DOM text (may be abbreviated)
    let followerCount = null;
    let followingCount = null;

    // 1. Try og:description first (has precise "N,NNN,NNN likes" format)
    const ogDesc = og['og:description'] || '';
    const descLikesMatch = ogDesc.match(/([\d,]+)\s+likes/i);
    if (descLikesMatch) {
      followerCount = parseInt(descLikesMatch[1].replace(/,/g, ''), 10) || null;
    }

    // 2. Fall back to DOM text (may be abbreviated: "26M followers")
    if (!followerCount) {
      const followerMatch = bodyText.match(/([0-9,.]+[KMB]?)\s+followers?\b/i);
      if (followerMatch) {
        const raw = followerMatch[1].replace(',', '');
        if (raw.endsWith('M')) followerCount = Math.round(parseFloat(raw) * 1_000_000);
        else if (raw.endsWith('K')) followerCount = Math.round(parseFloat(raw) * 1_000);
        else if (raw.endsWith('B')) followerCount = Math.round(parseFloat(raw) * 1_000_000_000);
        else followerCount = parseInt(raw, 10) || null;
      }
    }

    const followingMatch = bodyText.match(/(\d+)\s+following\b/i);
    if (followingMatch) followingCount = parseInt(followingMatch[1], 10) || null;

    // Contact info
    const emailMatch = bodyText.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
    const email = emailMatch?.[1] || null;

    // Website from DOM links
    let website = null;
    const externalLinks = Array.from(document.querySelectorAll('a[href^="https://l.facebook.com/l.php"]'));
    for (const link of externalLinks) {
      const href = link.href;
      const uMatch = href.match(/[?&]u=([^&]+)/);
      if (uMatch) {
        const decoded = decodeURIComponent(uMatch[1]);
        if (!decoded.includes('facebook.com') && !decoded.includes('fb.com')) {
          website = decoded;
          break;
        }
      }
    }
    // Also try direct links in about section
    if (!website) {
      const aboutLinks = Array.from(document.querySelectorAll('a[role="link"]'))
        .map(a => a.href)
        .filter(h => h.startsWith('http') && !h.includes('facebook.com') && !h.includes('fb.com'))
        .filter(h => !h.includes('instagram.com') && !h.includes('twitter.com'));
      if (aboutLinks.length > 0) website = aboutLinks[0];
    }

    // Transparency info
    const transparencyMatch = bodyText.match(/([A-Z][A-Z\s&,]+)\s+is responsible for this Page/);
    const transparencyInfo = transparencyMatch?.[0] || null;

    // Verified badge detection
    const verified = !!document.querySelector('[aria-label*="verified"]') ||
                     bodyText.includes('Verified Page') ||
                     !!document.querySelector('[data-visualcompletion="css-img"][alt*="verified"]');

    // Posts extraction
    const posts = [];
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));

    articles.forEach((article, i) => {
      if (i > 20) return;
      const text = article.innerText || '';
      if (!text.trim()) return;

      // Skip comment articles - they are small and don't have post-level reactions
      // Real posts have "Like", "Comment", "Share" buttons at the bottom
      const hasLikeButton = article.querySelector('[aria-label="Like"]') !== null ||
                            text.includes('\nLike\n') || text.includes('\nLike\nComment\n');
      const hasReactionsBar = text.includes('All reactions:') || text.includes('reaction');
      const articleLen = text.length;

      // Comment articles are short (< 200 chars) and don't have Like buttons from page perspective
      // They also don't have "Share" text at top level
      if (articleLen < 100 && !hasLikeButton && !hasReactionsBar) return;

      // Extract post ID from links
      const links = Array.from(article.querySelectorAll('a[href]'));
      let postId = null;
      let postUrl = null;
      let postType = 'post';

      for (const link of links) {
        const href = link.href || '';
        const postMatch = href.match(/\/posts\/(\d+)/) ||
                         href.match(/[?&]post_id=(\d+)/) ||
                         href.match(/permalink\/(\d+)/);
        if (postMatch) { postId = postMatch[1]; postUrl = href.split('?')[0]; postType = 'post'; break; }

        const eventMatch = href.match(/\/events\/(\d+)/);
        if (eventMatch) { postId = eventMatch[1]; postUrl = href.split('?')[0]; postType = 'event'; break; }

        const videoMatch = href.match(/\/videos\/(\d+)/);
        if (videoMatch) { postId = videoMatch[1]; postUrl = href.split('?')[0]; postType = 'video'; break; }
      }

      // Fallback: look for post_id in embedded data
      if (!postId) {
        const postIdMatch = article.innerHTML.match(/"post_id":"(\d+)"/);
        if (postIdMatch) postId = postIdMatch[1];
      }

      // Extract timestamps
      const timeEl = article.querySelector('abbr[data-utime], abbr[title], time[datetime]');
      const timestamp = timeEl?.getAttribute('data-utime') ||
                       timeEl?.getAttribute('datetime') ||
                       timeEl?.getAttribute('title') || null;

      // Relative time (e.g. "4h", "Yesterday")
      const relTimeEl = Array.from(article.querySelectorAll('abbr, span')).find(el =>
        /^\d+[hmd]$/.test(el.innerText.trim()) || /^Yesterday/.test(el.innerText.trim())
      );
      const timestampRelative = relTimeEl?.innerText.trim() || null;

      // Extract reaction count
      let reactionCount = null;
      const reactionEl = Array.from(article.querySelectorAll('[aria-label]')).find(el =>
        /reaction/.test(el.getAttribute('aria-label') || '')
      );
      if (reactionEl) {
        const ariaLabel = reactionEl.getAttribute('aria-label') || '';
        const m = ariaLabel.match(/(\d+)/);
        if (m) reactionCount = parseInt(m[1], 10);
      }
      // Also look for "All reactions: N" in text
      if (!reactionCount) {
        const reactMatch = text.match(/All reactions:\s*([\d,]+)/);
        if (reactMatch) reactionCount = parseInt(reactMatch[1].replace(',', ''), 10) || null;
      }

      // Extract comment count
      let commentCount = null;
      const commentMatch = text.match(/(\d+)\s+comment/i);
      if (commentMatch) commentCount = parseInt(commentMatch[1], 10);

      // Extract text preview (first substantial line)
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const textPreview = lines.slice(0, 5).join(' ').substring(0, 300);

      // Extract media URLs from article
      const mediaUrls = Array.from(article.querySelectorAll('img[src*="scontent"]'))
        .map(img => img.src)
        .filter(s => s.includes('scontent') && !s.includes('profile') && s.length > 50)
        .slice(0, 5);

      if (!postId && !textPreview) return; // Skip empty/invalid

      posts.push({
        post_id: postId,
        type: postType,
        text_preview: textPreview,
        timestamp,
        timestamp_relative: timestampRelative,
        reaction_count: reactionCount,
        comment_count: commentCount,
        post_url: postUrl,
        media_urls: mediaUrls,
      });
    });

    // Also extract post IDs from embedded JSON (even if article extraction missed them)
    const embeddedPostIds = [];
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const text = script.textContent || '';
      const matches = text.match(/"post_id":"(\d+)"/g) || [];
      matches.forEach(m => {
        const id = m.match(/"post_id":"(\d+)"/)?.[1];
        if (id && !embeddedPostIds.includes(id)) embeddedPostIds.push(id);
      });
    }

    // Photos from grid
    const photos = [];
    const photoLinks = Array.from(document.querySelectorAll('a[href*="/photo/"]'));
    photoLinks.forEach(link => {
      const href = link.href;
      const fbidMatch = href.match(/fbid=(\d+)/);
      if (!fbidMatch) return;
      const photoId = fbidMatch[1];
      const img = link.querySelector('img[src*="scontent"]');
      if (!img) return;
      photos.push({
        photo_id: photoId,
        thumbnail_url: img.src,
        photo_url: `https://www.facebook.com/photo/?fbid=${photoId}`,
      });
    });

    return {
      og,
      tw,
      pageId,
      slugFromCanonical,
      h1Text,
      metaDesc,
      category,
      followerCount,
      followingCount,
      email,
      website,
      transparencyInfo,
      verified,
      posts,
      embeddedPostIds,
      photos: photos.slice(0, 20),
    };
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAuth(flags) {
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const { browser } = await launchBrowser({ cdpUrl, headless: false });
  const session = await captureSession(browser);
  console.log(JSON.stringify({ success: true, userId: session.userId }));
}

async function cmdCheckSession(flags) {
  const session = loadSession();
  if (!session?.userId) {
    console.log(JSON.stringify({ valid: false, reason: 'No session found. Run: node page-scraper.mjs auth' }));
    process.exit(5);
  }

  // Quick check: try to load a known public page with session cookies
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const { browser } = await launchBrowser({ cdpUrl, headless: flags['headless'] !== 'false' });

  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    await context.addCookies(session.cookies.map(c => ({
      ...c,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
    })));

    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

    const checkResult = await page.evaluate(() => {
      const isLoggedIn = document.cookie.includes('c_user=') &&
                         !document.querySelector('form[data-testid="royal_login_form"]');
      return { isLoggedIn };
    });

    if (checkResult.isLoggedIn) {
      console.log(JSON.stringify({ valid: true, userId: session.userId }));
    } else {
      console.log(JSON.stringify({ valid: false, reason: 'Session expired. Re-run auth.' }));
      process.exit(5);
    }
  } finally {
    await page.close();
  }
}

async function cmdScrape(pageSlug, flags) {
  if (!pageSlug) bail('Usage: page-scraper.mjs scrape <page_slug_or_id> [options]');

  // Normalize slug
  pageSlug = pageSlug.replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/$/, '').trim();
  if (!pageSlug) bail('Invalid page slug or URL');

  verboseMode = flags.verbose === true;

  const outputFile = flags.output || null;
  const useCache = flags.cache === true;
  const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL;
  const headless = flags['no-headless'] !== true;
  const scrollAttempts = parseInt(flags.scroll) || 3;

  // Check cache
  const cacheFile = resolve(CACHE_DIR, `page-${cacheKey(pageSlug)}.json`);
  if (useCache && existsSync(cacheFile)) {
    log(`Loading from cache: ${cacheFile}`);
    const cached = loadJson(cacheFile);
    const output = JSON.stringify(cached, null, 2);
    if (outputFile) { writeFileSync(outputFile, output); info(`Saved to ${outputFile}`); }
    else console.log(output);
    return;
  }

  // Load session (optional)
  const session = loadSession();
  const hasSession = !!(session?.userId && session?.cookies?.length > 0);
  log(`Session available: ${hasSession}`);

  // Launch browser
  const { browser, connected } = await launchBrowser({ cdpUrl, headless });
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
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

    const targetUrl = `https://www.facebook.com/${encodeURIComponent(pageSlug)}`;
    info(`Navigating to: ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(2000);

    // Check for WAF block
    if (await isWafBlock(page)) {
      bail('WAF/error page detected. Facebook may be blocking this IP. Try again later or use a different IP.', 4);
    }

    // Check for redirect to login page
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      if (hasSession) {
        bail(`Session expired or invalid — page redirected to login. Re-run: node page-scraper.mjs auth`, 5);
      }
      bail(
        `Facebook requires login to view this page (redirected to ${currentUrl}).\n` +
        `This can mean:\n` +
        `  1. The page is private or doesn't exist\n` +
        `  2. Facebook is rate-limiting this IP (wait 30–60 minutes)\n` +
        `  3. Login is required for all content\n` +
        `To scrape with auth: node page-scraper.mjs auth --cdp-url=http://localhost:9333`,
        2
      );
    }

    // Check for login wall
    const wallCheck = await isLoginWall(page);
    log('Wall check:', JSON.stringify(wallCheck));

    if (wallCheck.loginWall) {
      if (!hasSession) {
        bail(`Login wall detected: ${wallCheck.reason}. Run 'node page-scraper.mjs auth' to capture a Facebook session.`, 2);
      } else {
        bail(`Login wall despite having session: ${wallCheck.reason}. Session may have expired — re-run auth.`, 5);
      }
    }

    // Check for 404
    const title = await page.title();
    if (title.includes('Page Not Found') || title.includes('not found') || title === 'Facebook') {
      // Could also be homepage redirect (page doesn't exist)
      const url = page.url();
      if (url === 'https://www.facebook.com/' || url.includes('/?') ) {
        bail(`Page not found: ${pageSlug}`, 3);
      }
    }

    info(`Page loaded: ${title}`);

    // Extract initial page data
    log('Extracting page data...');
    let data = await extractPageData(page);

    // Scroll to load more posts
    if (scrollAttempts > 0) {
      log(`Scrolling to load more posts (${scrollAttempts} attempts)...`);
      for (let i = 0; i < scrollAttempts; i++) {
        await page.evaluate(() => window.scrollBy(0, 2000));
        await sleep(2000 + Math.random() * 1000);
        log(`Scroll ${i + 1}/${scrollAttempts} done`);
      }
      // Re-extract after scrolling
      data = await extractPageData(page);
      log(`Posts after scroll: ${data.posts.length}`);
    }

    // Build structured result
    const pageUrl = `https://www.facebook.com/${pageSlug}`;
    const name = data.og['og:title'] || data.h1Text || pageSlug;
    const description = (data.metaDesc || data.og['og:description'] || '').replace(/^.+?\.\s+/, '').trim();

    const result = {
      page: {
        id: data.pageId,
        slug: data.slugFromCanonical || pageSlug,
        name,
        url: data.og['og:url'] || pageUrl,
        description,
        follower_count: data.followerCount,
        following_count: data.followingCount,
        category: data.category,
        cover_photo_url: data.og['og:image'] || null,
        profile_photo_url: data.og['og:image'] || null, // FB uses same image for both in OG
        website: data.website,
        email: data.email,
        phone: null,
        address: null,
        verified: data.verified,
        transparency_info: data.transparencyInfo,
      },
      posts: data.posts,
      photos: data.photos,
      meta: {
        scraped_at: new Date().toISOString(),
        session_used: hasSession,
        scroll_attempts: scrollAttempts,
        posts_note: !hasSession && data.posts.length < 5
          ? 'Only a few posts visible without login. Run auth + scrape with session for more.'
          : undefined,
        embedded_post_ids: data.embeddedPostIds.length > data.posts.length
          ? data.embeddedPostIds
          : undefined,
      },
    };

    // Cache result
    if (useCache) {
      saveJson(cacheFile, result);
      log(`Cached to ${cacheFile}`);
    }

    // Output
    const output = JSON.stringify(result, null, 2);
    if (outputFile) {
      writeFileSync(outputFile, output);
      info(`Saved to ${outputFile}`);
    } else {
      console.log(output);
    }

    info(`✅ Done. Page: ${name} | Followers: ${result.page.follower_count?.toLocaleString() || 'unknown'} | Posts: ${data.posts.length}`);

  } finally {
    try { await page.close(); } catch {}
    // Don't close if we connected to an existing Chrome
    if (!connected) {
      try { await browser.close(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Facebook Page Scraper

USAGE:
  node page-scraper.mjs scrape <page_slug_or_id> [options]
  node page-scraper.mjs auth [--cdp-url=<url>]
  node page-scraper.mjs check-session [--cdp-url=<url>]

COMMANDS:
  scrape <slug>      Scrape a public Facebook page (no login required for metadata)
  auth               Capture session from logged-in Chrome (for post feed access)
  check-session      Verify stored session is still valid

OPTIONS (for scrape):
  --output=<file>       Save results to JSON file
  --cdp-url=<url>       Connect to existing Chrome (e.g. http://localhost:9333)
  --no-headless         Show browser window
  --scroll=<n>          Scroll attempts to load more posts (default: 3)
  --cache               Cache results locally
  --verbose             Enable detailed logging

ENVIRONMENT VARIABLES:
  CHROME_CDP_URL        Default CDP URL for existing Chrome
  CHROME_EXECUTABLE     Path to Chrome/Chromium binary
  VERBOSE               Enable verbose logging

EXAMPLES:
  # Basic page metadata (no auth needed):
  node page-scraper.mjs scrape NASA

  # Scrape with scrolling to load more posts:
  node page-scraper.mjs scrape NASA --scroll=5

  # Connect to existing logged-in Chrome:
  node page-scraper.mjs auth --cdp-url=http://localhost:9333
  node page-scraper.mjs scrape NASA --cdp-url=http://localhost:9333

  # Scrape by numeric ID:
  node page-scraper.mjs scrape 100044561550831

  # Scrape Meta's official page:
  node page-scraper.mjs scrape Meta --output=/tmp/meta.json

  # Full URL also works:
  node page-scraper.mjs scrape https://www.facebook.com/NASA

EXIT CODES:
  0  Success
  1  General error
  2  Login required (private page or login wall)
  3  Page not found
  4  WAF/rate-limit block
  5  Session expired (re-run auth)
`);
    process.exit(0);
  }

  const cmd = args[0];
  const { flags, positional } = parseFlags(args.slice(1));

  if (flags.verbose) verboseMode = true;

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
  console.error('[facebook:fatal]', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
