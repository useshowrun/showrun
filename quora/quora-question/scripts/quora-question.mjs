#!/usr/bin/env node
/**
 * quora-question — Get a Quora question's answers.
 *
 * ⚠️  STATUS: BLOCKED — Quora uses Cloudflare managed challenge (cType: 'managed')
 *
 * All bypass strategies confirmed BLOCKED from datacenter/Turkish residential IP:
 *   - Direct HTTP with browser UA → CF 403
 *   - camoufox headless (humanize: true) → CF 403
 *   - camoufox headless: false + DISPLAY + wait → CF 403
 *
 * TO UNBLOCK:
 *   Set SOCKS5_PROXY=<host:port> to a US/EU residential proxy.
 *   Verified residential proxy services: Bright Data, Oxylabs, Smartproxy.
 *   The skill will automatically use the proxy for all requests.
 *
 * STRATEGY (when proxy is available):
 *   1. Fetch question page HTML via camoufox browser (with proxy)
 *   2. Extract embedded React state (window.__PRELOADED_STATE__ or similar)
 *   3. Parse answers from state object
 *   4. Fallback: DOM-based extraction via page.evaluate
 *
 * DATA (when unblocked):
 *   Question page embeds Next.js/React state with:
 *   - Question text, URL, view count, answer count, creation date
 *   - Answers: author name/URL/credential, upvotes, text, date, isTopAnswer
 *
 * Usage:
 *   node quora-question.mjs <question-url-or-slug> [options]
 *
 * Arguments:
 *   <question-url-or-slug>   Full Quora URL or slug
 *                            e.g. "https://www.quora.com/What-is-the-best-programming-language-to-learn"
 *                            or   "What-is-the-best-programming-language-to-learn"
 *
 * Options:
 *   --max-answers <N>    Max answers to return (default: 10)
 *   --help               Show this help
 *
 * Examples:
 *   node quora-question.mjs "What-is-the-best-programming-language-to-learn"
 *   node quora-question.mjs "https://www.quora.com/What-is-Python" --max-answers 5
 *   SOCKS5_PROXY=proxy.host:1080 node quora-question.mjs "What-is-AI" --max-answers 10
 *
 * Output (stdout):
 *   RESULT:{
 *     "question": {
 *       "text": string | null,
 *       "url": string,
 *       "viewCount": number | null,
 *       "answerCount": number | null,
 *       "askedAt": string | null        (ISO 8601)
 *     },
 *     "total": number,
 *     "source": "browser" | "browser-dom" | "none",
 *     "answers": [
 *       {
 *         "authorName": string | null,
 *         "authorUrl": string | null,
 *         "authorCredential": string | null,
 *         "upvotes": number | null,
 *         "text": string | null,
 *         "createdAt": string | null,   (ISO 8601)
 *         "isTopAnswer": boolean
 *       }
 *     ],
 *     "scrapedAt": string
 *   }
 *
 * ERRORS:
 *   RESULT:{"error": true, "code": "CF_BLOCKED", ...}      — Cloudflare blocked
 *   RESULT:{"error": true, "code": "QUESTION_NOT_FOUND", ...} — Question not found (404)
 *   RESULT:{"error": true, "code": "MISSING_ARG", ...}     — No input provided
 *   RESULT:{"error": true, "code": "INVALID_INPUT", ...}   — Invalid URL/slug
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
  normalizeQuestionUrl,
  questionSlug,
  fetchHtml,
  extractQuoraState,
  parseQuestionState,
  normalizeAnswerItem,
  createQuoraBrowser,
  createQuoraContext,
  navigateQuoraPage,
  isCloudflarePage,
  stripHtml,
} = await import(utilsPath);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stderr.write(`Usage: node quora-question.mjs <question-url-or-slug> [options]

Arguments:
  <question-url-or-slug>   Full Quora URL or slug
                           e.g. "What-is-the-best-programming-language-to-learn"

Options:
  --max-answers <N>    Max answers to return (default: 10)
  --help               Show this help

Examples:
  node quora-question.mjs "What-is-the-best-programming-language-to-learn"
  node quora-question.mjs "https://www.quora.com/What-is-Python" --max-answers 5

Output: RESULT:{json} on stdout, logs on stderr

⚠️  Quora uses Cloudflare managed challenge — set SOCKS5_PROXY= for a residential proxy.
`);
  process.exit(0);
}

const inputRaw = args[0];
if (!inputRaw || inputRaw.startsWith('--')) {
  emitError('MISSING_ARG', 'Usage: node quora-question.mjs <question-url-or-slug> [--max-answers N]');
}

let maxAnswers = 10;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--max-answers':
      maxAnswers = Math.max(1, parseInt(args[++i], 10) || 10);
      break;
    default:
      log(`Unknown arg: ${args[i]} (ignored)`);
  }
}

// ---------------------------------------------------------------------------
// Normalize input
// ---------------------------------------------------------------------------

let questionUrl;
try {
  questionUrl = normalizeQuestionUrl(inputRaw);
} catch (err) {
  emitError('INVALID_INPUT', `Could not normalize question URL: ${inputRaw}`);
}

const socks5 = process.env.SOCKS5_PROXY;
log(`Question URL: ${questionUrl}`);
log(`Max answers: ${maxAnswers}`);
log(`SOCKS5_PROXY: ${socks5 || '(not set)'}`);

// ---------------------------------------------------------------------------
// Strategy 1: Direct HTTP fetch (fast but will hit CF)
// ---------------------------------------------------------------------------

async function tryDirectHttp() {
  log('[Strategy 1] Trying direct HTTP fetch...');
  try {
    const resp = await fetchHtml(questionUrl);
    if (isCloudflarePage(resp.body)) {
      log('[Strategy 1] Response is Cloudflare challenge page');
      return 'CF_BLOCKED';
    }

    log('[Strategy 1] Got HTML response, extracting state...');

    if (resp.body.includes('This page is not found') ||
        resp.body.includes('404') ||
        resp.body.includes('Page Not Found')) {
      return 'NOT_FOUND';
    }

    const stateObj = extractQuoraState(resp.body);
    if (!stateObj) {
      log('[Strategy 1] No state found in HTML');
      return null;
    }

    log(`[Strategy 1] Extracted state via ${stateObj.source}`);
    const { question, answers } = parseQuestionState(stateObj);
    const slicedAnswers = answers.slice(0, maxAnswers);

    return {
      question: question || {
        text: null,
        url: questionUrl,
        viewCount: null,
        answerCount: null,
        askedAt: null,
      },
      total: slicedAnswers.length,
      source: 'http',
      answers: slicedAnswers,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err.code === 'CF_BLOCKED' || err.status === 403) {
      log(`[Strategy 1] Blocked by Cloudflare (${err.status})`);
      return 'CF_BLOCKED';
    }
    if (err.code === 'NOT_FOUND' || err.status === 404) {
      log('[Strategy 1] Question not found (404)');
      return 'NOT_FOUND';
    }
    log(`[Strategy 1] HTTP error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Browser (camoufox) — requires SOCKS5_PROXY
// ---------------------------------------------------------------------------

async function tryBrowser() {
  log('[Strategy 2] Trying camoufox browser...');

  if (!socks5) {
    log('[Strategy 2] No SOCKS5_PROXY set — likely to fail (CF managed challenge)');
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

    const { html, blocked } = await navigateQuoraPage(page, questionUrl, 12000);

    if (blocked) {
      log('[Strategy 2] Still on Cloudflare challenge page');
      await browser.close();
      return 'CF_BLOCKED';
    }

    // Check for 404
    if (html.includes('This page is not found') ||
        html.includes('Page Not Found') ||
        html.includes('404 - Not Found')) {
      await browser.close();
      return 'NOT_FOUND';
    }

    log('[Strategy 2] Got question page HTML, extracting state...');
    const stateObj = extractQuoraState(html);

    if (stateObj) {
      log(`[Strategy 2] Extracted state via ${stateObj.source}`);
      const { question, answers } = parseQuestionState(stateObj);
      const slicedAnswers = answers.slice(0, maxAnswers);

      if (slicedAnswers.length > 0 || question) {
        await browser.close();
        return {
          question: question || { text: null, url: questionUrl, viewCount: null, answerCount: null, askedAt: null },
          total: slicedAnswers.length,
          source: 'browser',
          answers: slicedAnswers,
          scrapedAt: new Date().toISOString(),
        };
      }
    }

    // Fallback: DOM-based extraction
    log('[Strategy 2] State extraction yielded no answers — trying DOM extraction...');
    const domData = await page.evaluate((url) => {
      const result = { question: null, answers: [] };

      // Extract question text
      const questionEls = document.querySelectorAll('[data-rh="true"] h1, .puppeteer_test_question_title, [class*="question"] h1');
      for (const el of questionEls) {
        const text = el.textContent?.trim();
        if (text && text.length > 5) {
          result.question = { text, url, viewCount: null, answerCount: null, askedAt: null };
          break;
        }
      }

      // Extract answers using structural selectors (not brittle class names)
      // Look for answer containers — typically articles or sections with author + upvote info
      const answerContainers = document.querySelectorAll('article, [data-testid*="answer"], [role="article"]');
      for (const container of answerContainers) {
        const authorEl = container.querySelector('[href*="/profile/"]');
        const authorName = authorEl?.textContent?.trim() || null;
        const authorUrl = authorEl?.href || null;

        // Get text content (exclude nav/author/upvote elements)
        const textEls = container.querySelectorAll('p, [class*="content"], [class*="answer-text"]');
        let text = '';
        for (const el of textEls) {
          text += ' ' + (el.textContent?.trim() || '');
        }
        text = text.trim().substring(0, 5000);

        if (authorName || text.length > 20) {
          result.answers.push({
            authorName,
            authorUrl,
            authorCredential: null,
            upvotes: null,
            text: text || null,
            createdAt: null,
            isTopAnswer: false,
          });
        }
      }

      return result;
    }, questionUrl).catch(() => ({ question: null, answers: [] }));

    await browser.close();

    if (domData.answers.length > 0 || domData.question) {
      const slicedAnswers = domData.answers.slice(0, maxAnswers);
      return {
        question: domData.question || { text: null, url: questionUrl, viewCount: null, answerCount: null, askedAt: null },
        total: slicedAnswers.length,
        source: 'browser-dom',
        answers: slicedAnswers,
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

// Strategy 1: Direct HTTP
result = await tryDirectHttp();
if (result === 'CF_BLOCKED') {
  blockedByCloudflare = true;
  result = null;
} else if (result === 'NOT_FOUND') {
  notFound = true;
  result = null;
}

// Strategy 2: Browser
if (!result && !notFound) {
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
    code: 'QUESTION_NOT_FOUND',
    message: `Quora question not found: "${questionUrl}" — check the URL or slug`,
    questionUrl,
  });
  process.exit(1);
}

if (!result) {
  emitResult({
    error: true,
    code: 'CF_BLOCKED',
    message: [
      'Quora is protected by Cloudflare managed challenge (cType: managed).',
      'All bypass strategies failed from this IP address.',
      'Set SOCKS5_PROXY=host:port to a US/EU residential proxy to unblock.',
      'Verified residential proxy services: Bright Data, Oxylabs, Smartproxy.',
    ].join(' '),
    questionUrl,
    bypassGuidance: {
      required: 'residential_proxy',
      env: 'SOCKS5_PROXY',
      example: 'SOCKS5_PROXY=proxy.brightdata.com:22225 node quora-question.mjs "What-is-Python"',
      notes: 'Cloudflare managed challenge requires TLS fingerprint + JS execution from non-datacenter IP.',
    },
    scrapedAt: new Date().toISOString(),
  });
  process.exit(1);
}

emitResult(result);
