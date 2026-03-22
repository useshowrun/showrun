#!/usr/bin/env node
/**
 * quora-topic — Get recent questions for a Quora topic.
 *
 * ⚠️  STATUS: BLOCKED — Quora uses Cloudflare managed challenge (cType: 'managed')
 *
 * All bypass strategies confirmed BLOCKED from datacenter/Turkish residential IP:
 *   - RSS feed: https://www.quora.com/topic/<Topic>/rss → CF 403
 *   - Direct HTTP with browser UA (Firefox/Chrome/Googlebot) → CF 403
 *   - camoufox headless (humanize: true) → CF 403
 *   - camoufox headless: false + DISPLAY=:99 + 20s wait → CF 403
 *   - Playwright chromium headless, anti-detection → CF timeout/403
 *
 * TO UNBLOCK:
 *   Set SOCKS5_PROXY=<host:port> to a US/EU residential proxy.
 *   Verified residential proxy services: Bright Data, Oxylabs, Smartproxy.
 *   The skill will automatically use the proxy for all requests.
 *
 * STRATEGY (when proxy is available):
 *   1. Try RSS feed (fastest — pure HTTP)
 *   2. Fallback: camoufox browser to load topic page, extract React state
 *   3. Fallback: parse HTML for embedded JSON data
 *
 * Usage:
 *   node quora-topic.mjs <topic> [options]
 *
 * Arguments:
 *   <topic>     Topic slug or name (e.g. "Artificial-Intelligence", "Python programming language")
 *               Spaces are converted to hyphens automatically.
 *
 * Options:
 *   --max <N>           Max questions to return (default: 20)
 *   --strategy rss|browser|auto   Force a specific strategy (default: auto)
 *   --help              Show this help
 *
 * Examples:
 *   node quora-topic.mjs "Artificial-Intelligence"
 *   node quora-topic.mjs "Python" --max 10
 *   node quora-topic.mjs "Entrepreneurship" --max 5
 *   SOCKS5_PROXY=proxy.host:1080 node quora-topic.mjs "Machine Learning" --max 20
 *
 * Output (stdout):
 *   RESULT:{
 *     "topic": string,
 *     "topicUrl": string,
 *     "rssUrl": string,
 *     "total": number,
 *     "source": "rss" | "browser" | "none",
 *     "questions": [
 *       {
 *         "questionId": string | null,
 *         "title": string,
 *         "url": string,
 *         "viewCount": number | null,
 *         "answerCount": number | null,
 *         "followCount": number | null,
 *         "askedAt": string | null,       (ISO 8601)
 *         "topics": string[],
 *         "author": string | null,
 *         "description": string | null,
 *         "source": "rss" | "browser"
 *       }
 *     ],
 *     "scrapedAt": string
 *   }
 *
 * ERRORS:
 *   RESULT:{"error": true, "code": "CF_BLOCKED", ...}   — Cloudflare blocked (no proxy)
 *   RESULT:{"error": true, "code": "TOPIC_NOT_FOUND", ...} — Invalid topic
 *   RESULT:{"error": true, "code": "MISSING_ARG", ...}  — No topic provided
 *
 * LOGS: stderr
 *
 * ENV:
 *   SOCKS5_PROXY — SOCKS5 proxy host:port (e.g. "residential.proxy.io:1080")
 *                  Required to bypass Cloudflare managed challenge on Quora.
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, '../../lib/utils.mjs');

const {
  emitResult,
  emitError,
  log,
  delay,
  normalizeTopicSlug,
  topicRssUrl,
  topicPageUrl,
  fetchTopicRss,
  normalizeRssQuestion,
  parseRssFeed,
  parseRssChannel,
  extractQuoraState,
  parseTopicState,
  normalizeQuestionItem,
  createQuoraBrowser,
  createQuoraContext,
  navigateQuoraPage,
  isCloudflarePage,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stderr.write(`Usage: node quora-topic.mjs <topic> [options]

Arguments:
  <topic>     Topic slug or name (e.g. "Artificial-Intelligence", "Python programming language")

Options:
  --max <N>                   Max questions to return (default: 20)
  --strategy rss|browser|auto  Force strategy (default: auto)
  --help                      Show this help

Examples:
  node quora-topic.mjs "Artificial-Intelligence"
  node quora-topic.mjs "Python" --max 10
  SOCKS5_PROXY=proxy.host:1080 node quora-topic.mjs "Machine Learning"

Output: RESULT:{json} on stdout, logs on stderr

⚠️  Quora uses Cloudflare managed challenge — set SOCKS5_PROXY= for a residential proxy.
`);
  process.exit(0);
}

const topicRaw = args[0];
if (!topicRaw || topicRaw.startsWith('--')) {
  emitError('MISSING_ARG', 'Usage: node quora-topic.mjs <topic> [--max N]');
}

let maxQuestions = 20;
let strategyOverride = 'auto';

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--max':
      maxQuestions = Math.max(1, parseInt(args[++i], 10) || 20);
      break;
    case '--strategy':
      strategyOverride = args[++i];
      break;
    default:
      log(`Unknown arg: ${args[i]} (ignored)`);
  }
}

// ---------------------------------------------------------------------------
// Normalize topic
// ---------------------------------------------------------------------------

const topicSlug = normalizeTopicSlug(topicRaw);
const topicUrl = topicPageUrl(topicSlug);
const rssUrl = topicRssUrl(topicSlug);
const socks5 = process.env.SOCKS5_PROXY;

log(`Topic: ${topicSlug}`);
log(`Topic URL: ${topicUrl}`);
log(`RSS URL: ${rssUrl}`);
log(`Strategy: ${strategyOverride}`);
log(`SOCKS5_PROXY: ${socks5 || '(not set)'}`);

// ---------------------------------------------------------------------------
// Strategy 1: RSS Feed
// ---------------------------------------------------------------------------

async function tryRss() {
  log('[Strategy 1] Trying RSS feed...');
  try {
    const { items, channel } = await fetchTopicRss(topicSlug);
    log(`[Strategy 1] RSS returned ${items.length} items`);

    if (items.length === 0) {
      log('[Strategy 1] RSS empty — topic may not exist or have no recent questions');
      return null;
    }

    const questions = items
      .slice(0, maxQuestions)
      .map((item, i) => normalizeRssQuestion(item, i));

    return {
      topic: topicSlug,
      topicUrl,
      rssUrl,
      feedTitle: channel.title || null,
      total: questions.length,
      source: 'rss',
      questions,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err.code === 'CF_BLOCKED' || err.status === 403) {
      log(`[Strategy 1] RSS blocked by Cloudflare (${err.status})`);
      return 'CF_BLOCKED';
    }
    if (err.code === 'NOT_FOUND' || err.status === 404) {
      log('[Strategy 1] Topic not found (404)');
      return 'NOT_FOUND';
    }
    log(`[Strategy 1] RSS error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Browser (camoufox) — requires SOCKS5_PROXY
// ---------------------------------------------------------------------------

async function tryBrowser() {
  log('[Strategy 2] Trying camoufox browser...');

  if (!socks5) {
    log('[Strategy 2] No SOCKS5_PROXY set — browser approach likely to fail (CF managed challenge)');
  }

  let Camoufox;
  try {
    const mod = await import('camoufox-js');
    Camoufox = mod.Camoufox;
  } catch (err) {
    log(`[Strategy 2] camoufox-js not installed: ${err.message}`);
    log('[Strategy 2] Run: npm install in quora/ directory');
    return null;
  }

  let browser;
  try {
    browser = await createQuoraBrowser(Camoufox);
    const ctx = await createQuoraContext(browser);
    const page = await ctx.newPage();

    // Try RSS first via browser (same URL, but now with CF cookies from browser)
    const { html: rssHtml, blocked: rssBlocked } = await navigateQuoraPage(page, rssUrl, 12000);

    if (!rssBlocked && rssHtml.includes('<rss') || rssHtml.includes('<item>')) {
      log('[Strategy 2] Browser got RSS content!');
      const items = parseRssFeed(rssHtml);
      const channel = parseRssChannel(rssHtml);

      if (items.length > 0) {
        const questions = items.slice(0, maxQuestions).map((item, i) => normalizeRssQuestion(item, i));
        await browser.close();
        return {
          topic: topicSlug,
          topicUrl,
          rssUrl,
          feedTitle: channel.title || null,
          total: questions.length,
          source: 'browser-rss',
          questions,
          scrapedAt: new Date().toISOString(),
        };
      }
    }

    if (rssBlocked) {
      log('[Strategy 2] RSS via browser still blocked — trying topic page...');
    }

    // Try topic page
    const { html: topicHtml, blocked: topicBlocked } = await navigateQuoraPage(page, topicUrl, 12000);

    if (topicBlocked) {
      log('[Strategy 2] Topic page also blocked by Cloudflare');
      await browser.close();
      return 'CF_BLOCKED';
    }

    log('[Strategy 2] Got topic page HTML, extracting state...');

    // Check for 404 / not found
    if (topicHtml.includes('This page is not found') || topicHtml.includes('Page Not Found')) {
      await browser.close();
      return 'NOT_FOUND';
    }

    const stateObj = extractQuoraState(topicHtml);
    if (!stateObj) {
      log('[Strategy 2] Could not extract state from topic page');
      await browser.close();
      return null;
    }

    log(`[Strategy 2] Extracted state via ${stateObj.source}`);
    const questions = parseTopicState(stateObj).slice(0, maxQuestions);

    if (questions.length === 0) {
      log('[Strategy 2] No questions found in state — DOM parsing needed');
      // Try DOM-based extraction via page.evaluate
      const domQuestions = await page.evaluate(() => {
        const results = [];
        // Look for question link patterns
        const links = document.querySelectorAll('a[href*="/question/"]');
        for (const link of links) {
          const text = link.textContent?.trim();
          const href = link.href;
          if (text && href && text.length > 10) {
            results.push({ title: text, url: href });
          }
        }
        return results.slice(0, 50);
      }).catch(() => []);

      if (domQuestions.length > 0) {
        const normalized = domQuestions.slice(0, maxQuestions).map(q => ({
          questionId: null,
          title: q.title,
          url: q.url,
          viewCount: null,
          answerCount: null,
          followCount: null,
          askedAt: null,
          topics: [topicSlug],
          author: null,
          description: null,
          source: 'browser-dom',
        }));

        await browser.close();
        return {
          topic: topicSlug,
          topicUrl,
          rssUrl,
          feedTitle: null,
          total: normalized.length,
          source: 'browser-dom',
          questions: normalized,
          scrapedAt: new Date().toISOString(),
        };
      }
    }

    await browser.close();

    if (questions.length > 0) {
      return {
        topic: topicSlug,
        topicUrl,
        rssUrl,
        feedTitle: null,
        total: questions.length,
        source: 'browser',
        questions,
        scrapedAt: new Date().toISOString(),
      };
    }

    return null;
  } catch (err) {
    log(`[Strategy 2] Browser error: ${err.message}`);
    try { await browser?.close(); } catch (_) {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

let result = null;
let blockedByCloudflare = false;
let notFound = false;

if (strategyOverride === 'auto' || strategyOverride === 'rss') {
  result = await tryRss();
  if (result === 'CF_BLOCKED') {
    blockedByCloudflare = true;
    result = null;
  } else if (result === 'NOT_FOUND') {
    notFound = true;
    result = null;
  }
}

if (!result && !notFound && (strategyOverride === 'auto' || strategyOverride === 'browser')) {
  result = await tryBrowser();
  if (result === 'CF_BLOCKED') {
    blockedByCloudflare = true;
    result = null;
  } else if (result === 'NOT_FOUND') {
    notFound = true;
    result = null;
  }
}

// ---------------------------------------------------------------------------
// Handle outcomes
// ---------------------------------------------------------------------------

if (notFound) {
  emitResult({
    error: true,
    code: 'TOPIC_NOT_FOUND',
    message: `Quora topic not found: "${topicSlug}" — check the topic slug`,
    topic: topicSlug,
    topicUrl,
    rssUrl,
  });
  process.exit(1);
}

if (!result) {
  // Blocked by Cloudflare
  emitResult({
    error: true,
    code: 'CF_BLOCKED',
    message: [
      'Quora is protected by Cloudflare managed challenge (cType: managed).',
      'All bypass strategies failed from this IP address.',
      'Set SOCKS5_PROXY=host:port to a US/EU residential proxy to unblock.',
      'Verified residential proxy services: Bright Data, Oxylabs, Smartproxy.',
    ].join(' '),
    topic: topicSlug,
    topicUrl,
    rssUrl,
    bypassGuidance: {
      required: 'residential_proxy',
      env: 'SOCKS5_PROXY',
      example: 'SOCKS5_PROXY=proxy.brightdata.com:22225 node quora-topic.mjs "Artificial-Intelligence"',
      notes: 'Cloudflare managed challenge requires TLS fingerprint + JS execution from non-datacenter IP.',
    },
    scrapedAt: new Date().toISOString(),
  });
  process.exit(1);
}

emitResult(result);
