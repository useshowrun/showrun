/**
 * Shared utilities for Quora scrapers.
 *
 * Anti-bot Research (2026-03-23):
 * =================================
 * Quora is protected by Cloudflare **managed challenge** (cType: 'managed').
 * This is the most aggressive Cloudflare tier — it requires full JS execution
 * including TLS fingerprint matching and browser challenge solving.
 *
 * Confirmed BLOCKED via the following tests:
 *
 *   1. Direct HTTPS curl — 403 with cf-mitigated: challenge
 *   2. Node.js https.get with Firefox/Chrome UA — 403
 *   3. Node.js https.get with Googlebot UA — 403
 *   4. camoufox headless: true, humanize: 0.3 — 403
 *   5. camoufox headless: true, humanize: true (full) — 403
 *   6. camoufox headless: false, DISPLAY=:99, networkidle — 403 (still "Just a moment...")
 *   7. camoufox headless: false, DISPLAY=:99, 20s wait — 403
 *   8. Playwright chromium headless, anti-detection flags — 403
 *
 * The managed challenge requires TLS/browser fingerprint that passes Cloudflare's
 * bot score assessment. From a datacenter/VPS IP or Turkish residential IP,
 * all requests are challenged and no browser passes headless challenge resolution.
 *
 * RSS feeds (https://www.quora.com/topic/<Topic>/rss) are also blocked by CF.
 *
 * BYPASS OPTIONS:
 *   - SOCKS5_PROXY with a US/EU residential IP (NOT datacenter) may bypass CF
 *     managed challenge. Set: SOCKS5_PROXY=host:port
 *   - Verified residential proxy services: Bright Data, Oxylabs, Smartproxy
 *   - Anti-detect browsers with residential proxy: best combination
 *
 * DATA SOURCES (when unblocked):
 * =================================
 *   1. RSS Feed (topic questions) — FASTEST:
 *      URL: https://www.quora.com/topic/<Topic>/rss
 *      Returns: RSS XML with recent questions, titles, URLs, timestamps
 *      No auth required (but blocked by CF)
 *
 *   2. Topic page HTML — https://www.quora.com/topic/<Topic>
 *      Next.js SSR — React state embedded in <script> tags
 *      Contains: question list, answer counts, follower counts, view counts
 *      Look for: window.__INITIAL_STATE__ or JSON embedded in script tags
 *
 *   3. Question page HTML — https://www.quora.com/<question-slug>
 *      Next.js SSR — React state embedded in <script> tags
 *      Contains: question text, answers with author/upvotes/text/date
 *      Look for: window.__INITIAL_STATE__ or Apollo state
 *
 *   4. Internal API (when session cookies available):
 *      POST /graphql/gql_para_public — GraphQL endpoint
 *      Requires: quora-canary-revision, quora-revision headers
 *      Also requires valid CF clearance cookies
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (host:port), e.g. "residential.proxy.io:1080"
 */

import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[quora] ' + args.join(' ') + '\n');
}

export function emitResult(data) {
  process.stdout.write('RESULT:' + JSON.stringify(data) + '\n');
}

export function emitError(code, message, extra = {}) {
  process.stdout.write('RESULT:' + JSON.stringify({ error: true, code, message, ...extra }) + '\n');
  process.exit(1);
}

export function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTTP fetch helper — direct HTTPS (no browser)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return the response body as text.
 * Follows up to 5 redirects, spoofs a realistic Firefox user-agent.
 * NOTE: This will return 403 from Quora due to Cloudflare managed challenge.
 *       Included for completeness and proxy-enabled scenarios.
 */
export async function fetchHtml(urlStr, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  let redirectCount = 0;
  let currentUrl = urlStr;

  const socks5 = process.env.SOCKS5_PROXY;
  if (socks5) {
    log(`Using SOCKS5 proxy: ${socks5}`);
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    ...options.headers,
  };

  while (redirectCount <= maxRedirects) {
    const parsedUrl = new URL(currentUrl);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const body = await new Promise((resolve, reject) => {
      const req = lib.get(currentUrl, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (!res.headers.location) {
            reject(new Error(`Redirect with no Location header (${res.statusCode})`));
            return;
          }
          const next = new URL(res.headers.location, currentUrl).toString();
          resolve({ redirect: next, status: res.statusCode });
          res.resume();
          return;
        }

        if (res.statusCode === 404) {
          reject(Object.assign(new Error(`HTTP 404: ${currentUrl}`), { code: 'NOT_FOUND', status: 404 }));
          res.resume();
          return;
        }

        if (res.statusCode >= 400) {
          // Check for Cloudflare challenge
          const isCf = res.headers['cf-mitigated'] === 'challenge' ||
            res.headers['server'] === 'cloudflare';
          const err = Object.assign(
            new Error(`HTTP ${res.statusCode}: ${currentUrl}`),
            { code: isCf ? 'CF_BLOCKED' : 'HTTP_ERROR', status: res.statusCode }
          );
          // Still read body for logging
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            err.body = body;
            reject(err);
          });
          return;
        }

        // Decompress
        const chunks = [];
        const contentEncoding = res.headers['content-encoding'] || '';
        let stream = res;
        try {
          if (contentEncoding.includes('br')) {
            stream = res.pipe(zlib.createBrotliDecompress());
          } else if (contentEncoding.includes('gzip') || contentEncoding.includes('deflate')) {
            stream = res.pipe(zlib.createGunzip());
          }
        } catch (_) {
          stream = res;
        }

        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
        stream.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(options.timeout || 30000, () => {
        req.destroy(new Error('Request timed out'));
      });
    });

    if (body.redirect) {
      currentUrl = body.redirect;
      redirectCount++;
      continue;
    }

    return body;
  }

  throw new Error(`Too many redirects for ${urlStr}`);
}

// ---------------------------------------------------------------------------
// RSS parser (for topic feeds)
// ---------------------------------------------------------------------------

/**
 * Parse an RSS 2.0 XML body and return an array of items.
 * Each item has: title, link, guid, pubDate, description, author.
 */
export function parseRssFeed(xml) {
  const items = [];
  const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];

    const title = extractXmlTag(itemXml, 'title');
    const link = extractXmlTag(itemXml, 'link');
    const guid = extractXmlTag(itemXml, 'guid');
    const pubDate = extractXmlTag(itemXml, 'pubDate');
    const description = extractXmlTag(itemXml, 'description');
    const creator = extractXmlTag(itemXml, 'dc:creator') || extractXmlTag(itemXml, 'author');
    const category = extractAllXmlTags(itemXml, 'category');

    items.push({
      title: title ? decodeXmlEntities(title) : null,
      link: link ? link.trim() : (guid ? guid.trim() : null),
      guid: guid ? guid.trim() : null,
      pubDate: pubDate ? pubDate.trim() : null,
      description: description ? stripHtml(decodeXmlEntities(description)) : null,
      author: creator ? decodeXmlEntities(creator) : null,
      categories: category.map(c => decodeXmlEntities(c)),
    });
  }

  return items;
}

/**
 * Parse RSS channel metadata.
 */
export function parseRssChannel(xml) {
  // Get the channel block (before first <item>)
  const channelMatch = xml.match(/<channel[^>]*>([\s\S]*?)(?:<item|$)/i);
  if (!channelMatch) return {};
  const channelXml = channelMatch[1];

  return {
    title: decodeXmlEntities(extractXmlTag(channelXml, 'title') || ''),
    link: extractXmlTag(channelXml, 'link') || '',
    description: decodeXmlEntities(extractXmlTag(channelXml, 'description') || ''),
    lastBuildDate: extractXmlTag(channelXml, 'lastBuildDate') || null,
  };
}

function extractXmlTag(xml, tag) {
  // Handle CDATA
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1];

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (m) return m[1];

  // Self-closing or text node for link
  if (tag === 'link') {
    const linkRe = /<link[^>]*href="([^"]+)"/i;
    const lm = linkRe.exec(xml);
    if (lm) return lm[1];
  }

  return null;
}

function extractAllXmlTags(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  if (results.length > 0) return results;

  const re2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  while ((m = re2.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function decodeXmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function stripHtml(str) {
  if (!str) return str;
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Quora URL helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a topic slug.
 * Accepts: "Artificial Intelligence", "artificial-intelligence", "Artificial-Intelligence"
 * Returns: "Artificial-Intelligence" (Quora-style slug)
 */
export function normalizeTopicSlug(topic) {
  return topic
    .trim()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-');
  // Keep original case — Quora slugs are case-sensitive in practice
  // but the redirect handles casing
}

/**
 * Build a topic RSS URL.
 */
export function topicRssUrl(topicSlug) {
  return `https://www.quora.com/topic/${encodeURIComponent(topicSlug)}/rss`;
}

/**
 * Build a topic page URL.
 */
export function topicPageUrl(topicSlug) {
  return `https://www.quora.com/topic/${encodeURIComponent(topicSlug)}`;
}

/**
 * Normalize a question URL or slug into a full URL.
 * Accepts:
 *   - Full URL: https://www.quora.com/What-is-the-best-programming-language
 *   - Slug: What-is-the-best-programming-language
 */
export function normalizeQuestionUrl(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  const slug = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
  return `https://www.quora.com${slug}`;
}

/**
 * Extract question slug from URL.
 */
export function questionSlug(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, '').split('?')[0];
  } catch (_) {
    return url;
  }
}

// ---------------------------------------------------------------------------
// HTML parsers for Quora pages (used when CF is bypassed via proxy)
// ---------------------------------------------------------------------------

/**
 * Extract embedded React/Next.js state from Quora page HTML.
 * Quora embeds state in various script tags — try multiple patterns.
 *
 * Patterns to look for:
 *   1. window.__PRELOADED_STATE__ = {...}
 *   2. window.__APOLLO_STATE__ = {...}
 *   3. <script id="__NEXT_DATA__">{...}</script>
 *   4. Quora-specific: window.quora = {...} or similar
 */
export function extractQuoraState(html) {
  // Pattern 1: __PRELOADED_STATE__
  const preloadMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/);
  if (preloadMatch) {
    try { return { source: 'PRELOADED_STATE', state: JSON.parse(preloadMatch[1]) }; } catch (_) {}
  }

  // Pattern 2: __APOLLO_STATE__
  const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/);
  if (apolloMatch) {
    try { return { source: 'APOLLO_STATE', state: JSON.parse(apolloMatch[1]) }; } catch (_) {}
  }

  // Pattern 3: __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(\{[\s\S]*?\})<\/script>/);
  if (nextMatch) {
    try { return { source: 'NEXT_DATA', state: JSON.parse(nextMatch[1]) }; } catch (_) {}
  }

  // Pattern 4: JSON-LD structured data
  const jsonLdMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  const jsonLdData = [];
  for (const m of jsonLdMatches) {
    try { jsonLdData.push(JSON.parse(m[1])); } catch (_) {}
  }
  if (jsonLdData.length > 0) {
    return { source: 'JSON_LD', state: jsonLdData };
  }

  // Pattern 5: Embedded JSON data (look for large JSON objects in scripts)
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scriptMatches) {
    const content = m[1].trim();
    if (content.length > 500 && content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        return { source: 'SCRIPT_JSON', state: parsed };
      } catch (_) {}
    }
  }

  return null;
}

/**
 * Parse Quora topic page state to extract questions.
 * Handles multiple possible state shapes.
 */
export function parseTopicState(stateObj) {
  if (!stateObj) return [];

  const { source, state } = stateObj;
  const questions = [];

  // Try to find question arrays in the state tree
  const found = deepSearch(state, (key, val) => {
    return Array.isArray(val) &&
      val.length > 0 &&
      typeof val[0] === 'object' &&
      val[0] !== null &&
      (val[0].qid != null || val[0].question != null || val[0].questionId != null);
  });

  for (const arr of found) {
    for (const item of arr) {
      const q = normalizeQuestionItem(item);
      if (q) questions.push(q);
    }
  }

  return questions;
}

/**
 * Normalize a raw question object from any state shape.
 */
export function normalizeQuestionItem(item) {
  if (!item || typeof item !== 'object') return null;

  // Support multiple field naming conventions
  const id = item.qid ?? item.questionId ?? item.id ?? null;
  const title = item.questionText ?? item.title ?? item.text ?? null;
  const url = item.url ?? item.link ?? item.questionUrl ?? null;
  const viewCount = item.viewCount ?? item.views ?? item.numViews ?? null;
  const answerCount = item.numAnswers ?? item.answerCount ?? item.numAnswersVisible ?? null;
  const followCount = item.numFollowers ?? item.followCount ?? item.followerCount ?? null;
  const askedAt = item.createdAt ?? item.createdTime ?? item.askedAt ?? null;
  const topics = item.topics ?? item.relatedTopics ?? [];

  if (!title && !url) return null;

  return {
    questionId: id ? String(id) : null,
    title: title ? String(title).trim() : null,
    url: url ? String(url) : null,
    viewCount: parseCount(viewCount),
    answerCount: parseCount(answerCount),
    followCount: parseCount(followCount),
    askedAt: parseTimestamp(askedAt),
    topics: Array.isArray(topics) ? topics.map(t => (typeof t === 'string' ? t : t?.name ?? null)).filter(Boolean) : [],
  };
}

/**
 * Parse Quora question page state to extract answers.
 */
export function parseQuestionState(stateObj) {
  if (!stateObj) return { question: null, answers: [] };

  const { source, state } = stateObj;

  // Find answer arrays
  const answers = [];
  const found = deepSearch(state, (key, val) => {
    return Array.isArray(val) &&
      val.length > 0 &&
      typeof val[0] === 'object' &&
      val[0] !== null &&
      (val[0].aid != null || val[0].answerId != null || val[0].upvoteCount != null || val[0].numUpvotes != null);
  });

  for (const arr of found) {
    for (const item of arr) {
      const a = normalizeAnswerItem(item);
      if (a) answers.push(a);
    }
  }

  // Try to find question metadata
  const question = extractQuestionMeta(state);

  return { question, answers };
}

function normalizeAnswerItem(item) {
  if (!item || typeof item !== 'object') return null;

  const authorName = item.author?.name ?? item.authorName ?? null;
  const authorUrl = item.author?.url ?? item.authorUrl ?? null;
  const authorCredential = item.author?.credential ?? item.credential ?? null;
  const upvotes = item.numUpvotes ?? item.upvoteCount ?? item.voteCount ?? null;
  const text = item.content?.text ?? item.text ?? item.answerText ?? null;
  const createdAt = item.createdAt ?? item.createdTime ?? null;
  const isTopAnswer = item.isTopAnswer ?? item.isFeaturedAnswer ?? false;

  if (!text && !authorName) return null;

  return {
    authorName: authorName ? String(authorName).trim() : null,
    authorUrl: authorUrl ? String(authorUrl) : null,
    authorCredential: authorCredential ? String(authorCredential).trim() : null,
    upvotes: parseCount(upvotes),
    text: text ? stripHtml(String(text)).substring(0, 5000) : null,
    createdAt: parseTimestamp(createdAt),
    isTopAnswer: Boolean(isTopAnswer),
  };
}

function extractQuestionMeta(state) {
  const found = deepSearch(state, (key, val) => {
    return val && typeof val === 'object' &&
      (val.questionText != null || val.title != null) &&
      !Array.isArray(val);
  });

  if (found.length === 0) return null;
  const q = found[0];

  return {
    text: q.questionText ?? q.title ?? null,
    url: q.url ?? null,
    viewCount: parseCount(q.viewCount ?? q.numViews ?? null),
    answerCount: parseCount(q.numAnswers ?? q.answerCount ?? null),
    askedAt: parseTimestamp(q.createdAt ?? q.createdTime ?? null),
  };
}

// ---------------------------------------------------------------------------
// Deep search utility
// ---------------------------------------------------------------------------

/**
 * Recursively search an object tree for values matching a predicate.
 * Returns array of matching values.
 * Limits depth to avoid infinite loops.
 */
export function deepSearch(obj, predicate, maxDepth = 8, depth = 0, visited = new Set()) {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return [];
  if (visited.has(obj)) return [];
  visited.add(obj);

  const results = [];

  for (const [key, val] of Object.entries(obj)) {
    if (predicate(key, val)) {
      results.push(val);
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      results.push(...deepSearch(val, predicate, maxDepth, depth + 1, visited));
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object') {
          results.push(...deepSearch(item, predicate, maxDepth, depth + 1, visited));
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCount(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[,\s]/g, '');
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function parseTimestamp(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    // Could be seconds or milliseconds
    const ts = val > 1e10 ? val : val * 1000;
    return new Date(ts).toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Camoufox browser helpers
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser for Quora scraping.
 * Uses SOCKS5_PROXY env if set (strongly recommended for Quora).
 */
export async function createQuoraBrowser(Camoufox) {
  const socks5 = process.env.SOCKS5_PROXY;
  const firefoxUserPrefs = {};

  if (socks5) {
    const [host, port] = socks5.split(':');
    log(`Using SOCKS5 proxy: ${socks5}`);
    Object.assign(firefoxUserPrefs, {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': parseInt(port, 10),
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    });
  } else {
    log('WARNING: No SOCKS5_PROXY set — Quora uses Cloudflare managed challenge. Likely to be blocked.');
  }

  return Camoufox({
    headless: true,
    humanize: true,
    screen: { minWidth: 1280, minHeight: 800 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createQuoraContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

/**
 * Check if the page is blocked by Cloudflare.
 */
export function isCloudflarePage(html) {
  return html.includes('Just a moment') ||
    html.includes('cf-browser-verification') ||
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('_cf_chl_opt');
}

/**
 * Navigate to a Quora page and wait for CF challenge to (hopefully) resolve.
 * Returns { html, blocked } where blocked=true if CF challenge persists.
 */
export async function navigateQuoraPage(page, url, waitMs = 12000) {
  log(`Navigating to ${url}`);
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  log(`Waiting ${waitMs}ms for CF challenge resolution...`);
  await page.waitForTimeout(waitMs);

  const html = await page.content();
  const blocked = isCloudflarePage(html);

  if (blocked) {
    log('Cloudflare managed challenge NOT resolved — still on challenge page');
  } else {
    log('Page loaded successfully');
  }

  return { html, blocked };
}

// ---------------------------------------------------------------------------
// RSS-based topic scraper (Strategy 1 — fastest, works if unblocked)
// ---------------------------------------------------------------------------

/**
 * Fetch and parse topic RSS feed.
 * Returns array of question items from RSS.
 */
export async function fetchTopicRss(topicSlug, options = {}) {
  const url = topicRssUrl(topicSlug);
  log(`Fetching RSS: ${url}`);

  const resp = await fetchHtml(url, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    ...options,
  });

  const items = parseRssFeed(resp.body);
  const channel = parseRssChannel(resp.body);

  return { items, channel, url };
}

/**
 * Normalize an RSS item from Quora topic feed into question format.
 */
export function normalizeRssQuestion(item, index) {
  return {
    questionId: null, // Not available in RSS
    title: item.title,
    url: item.link,
    viewCount: null, // Not available in RSS
    answerCount: null, // Not available in RSS
    followCount: null, // Not available in RSS
    askedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    topics: item.categories || [],
    author: item.author || null,
    description: item.description || null,
    source: 'rss',
  };
}
