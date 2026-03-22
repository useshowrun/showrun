#!/usr/bin/env node
/**
 * Quora Question Scraper
 *
 * Scrapes answers from a Quora question page.
 *
 * ⚠️  STATUS: BLOCKED by Cloudflare Managed Challenge
 *   Quora uses Cloudflare (cType: 'managed') — all pages are blocked from
 *   datacenter and non-residential IPs. Set SOCKS5_PROXY=host:port to bypass.
 *
 * Strategy (in order of preference):
 *   1. Direct HTTP with realistic headers (fast, no browser overhead)
 *   2. Camoufox headless Firefox (for JS-rendered content after CF bypass)
 *   3. DOM extraction of answers via stable attributes
 *
 * Usage:
 *   node quora-question.mjs <question-url> [--max-answers N]
 *
 * Arguments:
 *   <question-url>       Full Quora question URL or slug
 *                        e.g. "https://www.quora.com/What-is-artificial-intelligence"
 *                             "What-is-artificial-intelligence"
 *   --max-answers <N>    Maximum number of answers to return (default: 10)
 *
 * Environment:
 *   SOCKS5_PROXY=host:port    Route through SOCKS5 proxy (residential IP recommended)
 *
 * Examples:
 *   node quora-question.mjs "https://www.quora.com/What-is-artificial-intelligence"
 *   node quora-question.mjs "What-is-machine-learning" --max-answers 5
 *   SOCKS5_PROXY=127.0.0.1:11090 node quora-question.mjs <url> --max-answers 10
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 *
 * Data schema (when unblocked):
 *   {
 *     questionId: string | null,
 *     title: string,
 *     url: string,
 *     viewCount: number | null,
 *     answerCount: number | null,
 *     askedAt: string | null,           // ISO 8601
 *     answers: [
 *       {
 *         authorName: string,
 *         authorCredential: string | null,
 *         upvotes: string | null,        // "1.2K", "45" etc.
 *         text: string | null,
 *         createdAt: string | null,
 *         isTopAnswer: boolean,
 *       }
 *     ],
 *     total: number,
 *     source: "http" | "browser",
 *     blocked: boolean,
 *   }
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(__dirname, '../../lib/utils.mjs');

const {
  emitResult,
  emitError,
  log,
  fetchUrl,
  checkCloudflareBlock,
  checkCamoufoxCFBlock,
  createQuoraBrowser,
  createQuoraContext,
  extractQuestionId,
  EXTRACT_ANSWERS_FN,
  parseArgs,
  parseUpvoteCount,
} = await import(utilsPath);

// ─── URL Normalization ──────────────────────────────────────────────────────

function normalizeQuestionUrl(input) {
  if (!input) return null;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return input.replace(/^http:\/\//, 'https://');
  }
  // Slug-only input
  const slug = input.replace(/^\//, '');
  return `https://www.quora.com/${slug}`;
}

// ─── HTTP extraction of question metadata ────────────────────────────────────

function extractQuestionMeta(html) {
  const result = {
    title: null,
    viewCount: null,
    answerCount: null,
    askedAt: null,
  };

  // Title: from <title> or og:title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    result.title = titleMatch[1].trim().replace(/\s+on Quora$/, '').replace(/\s+\|\s+Quora$/, '').trim();
  }

  const ogTitleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (ogTitleMatch) {
    result.title = ogTitleMatch[1].trim().replace(/\s+\|\s+Quora$/, '').trim();
  }

  // JSON-LD structured data
  const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      if (data['@type'] === 'QAPage' || data['@type'] === 'Question') {
        if (data.name) result.title = data.name;
        if (data.answerCount) result.answerCount = parseInt(data.answerCount, 10);
        if (data.dateCreated) result.askedAt = new Date(data.dateCreated).toISOString();
        if (data.datePublished) result.askedAt = new Date(data.datePublished).toISOString();
      }
    } catch (_) {}
  }

  // Answer count from meta description or text
  const answerCountMatch = html.match(/([\d,]+)\s+answers?/i);
  if (answerCountMatch && !result.answerCount) {
    result.answerCount = parseInt(answerCountMatch[1].replace(/,/g, ''), 10);
  }

  // View count
  const viewMatch = html.match(/([\d,]+[KkMm]?)\s+views?/i);
  if (viewMatch) result.viewCount = viewMatch[1];

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv);

  if (!positional[0]) {
    process.stderr.write(
      'Usage: node quora-question.mjs <question-url> [--max-answers N]\n' +
      '       SOCKS5_PROXY=host:port node quora-question.mjs <url>\n' +
      '\nExamples:\n' +
      '  node quora-question.mjs "https://www.quora.com/What-is-artificial-intelligence"\n' +
      '  node quora-question.mjs "What-is-machine-learning" --max-answers 5\n' +
      '  SOCKS5_PROXY=127.0.0.1:11090 node quora-question.mjs <url> --max-answers 10\n'
    );
    process.exit(1);
  }

  const rawInput = positional[0];
  const questionUrl = normalizeQuestionUrl(rawInput);
  const maxAnswers = parseInt(flags['max-answers'] || flags['max'] || '10', 10);
  const questionId = extractQuestionId(questionUrl);

  log(`Question URL: ${questionUrl}`);
  log(`Max answers: ${maxAnswers}`);

  // ── Strategy 1: Direct HTTP ──────────────────────────────────────────────
  log('Attempting direct HTTP fetch...');
  try {
    const { statusCode, body } = await fetchUrl(questionUrl);

    log(`HTTP response: ${statusCode}, size=${body.length}`);

    if (!checkCloudflareBlock(body, statusCode)) {
      log('HTTP accessible — extracting data...');
      const meta = extractQuestionMeta(body);

      // Check for JSON-LD answers
      const answers = [];
      const jsonLdMatch = body.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
      if (jsonLdMatch) {
        for (const block of jsonLdMatch) {
          try {
            const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
            const data = JSON.parse(inner);
            const schema = Array.isArray(data) ? data : [data];
            for (const item of schema) {
              if (item['@type'] === 'QAPage' && item.mainEntity) {
                const q = item.mainEntity;
                if (q.acceptedAnswer) {
                  const ans = q.acceptedAnswer;
                  answers.push({
                    authorName: ans.author?.name || 'Unknown',
                    authorCredential: null,
                    upvotes: null,
                    text: (ans.text || '').substring(0, 5000),
                    createdAt: ans.dateCreated ? new Date(ans.dateCreated).toISOString() : null,
                    isTopAnswer: true,
                  });
                }
                if (q.suggestedAnswer) {
                  for (const ans of (Array.isArray(q.suggestedAnswer) ? q.suggestedAnswer : [q.suggestedAnswer])) {
                    if (answers.length >= maxAnswers) break;
                    answers.push({
                      authorName: ans.author?.name || 'Unknown',
                      authorCredential: null,
                      upvotes: null,
                      text: (ans.text || '').substring(0, 5000),
                      createdAt: ans.dateCreated ? new Date(ans.dateCreated).toISOString() : null,
                      isTopAnswer: false,
                    });
                  }
                }
              }
            }
          } catch (_) {}
        }
      }

      emitResult({
        questionId,
        title: meta.title,
        url: questionUrl,
        viewCount: meta.viewCount,
        answerCount: meta.answerCount,
        askedAt: meta.askedAt,
        answers: answers.slice(0, maxAnswers),
        total: answers.length,
        source: 'http',
        blocked: false,
      });
      return;
    }

    log('HTTP blocked by Cloudflare — trying browser...');
  } catch (err) {
    log(`HTTP error: ${err.message} — trying browser...`);
  }

  // ── Strategy 2: Camoufox Browser ─────────────────────────────────────────
  log('Attempting camoufox browser...');
  let browser = null;
  try {
    browser = await createQuoraBrowser();
    const context = await createQuoraContext(browser);
    const page = await context.newPage();

    log(`Navigating to: ${questionUrl}`);
    await page.goto(questionUrl, { timeout: 30000, waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    const isCF = await checkCamoufoxCFBlock(page);
    log(`CF check: blocked=${isCF}`);

    if (!isCF) {
      // Extract title
      const pageTitle = await page.title();
      const cleanTitle = pageTitle.replace(/\s+on Quora$/, '').replace(/\s+\|\s+Quora$/, '').trim();

      // Extract answers from DOM
      log('Extracting answers from DOM...');
      const answers = await page.evaluate(
        new Function('args', `${EXTRACT_ANSWERS_FN}\n return extractAnswers(args.max);`),
        { max: maxAnswers }
      );

      log(`Extracted ${answers.length} answers from DOM`);

      // Get page text for metadata
      const pageText = await page.evaluate(() => document.body.innerText);
      const meta = extractQuestionMeta(await page.content());

      await browser.close();

      emitResult({
        questionId,
        title: meta.title || cleanTitle,
        url: questionUrl,
        viewCount: meta.viewCount,
        answerCount: meta.answerCount,
        askedAt: meta.askedAt,
        answers,
        total: answers.length,
        source: 'browser',
        blocked: false,
      });
      return;
    }

    await browser.close();
    log('Browser also blocked by Cloudflare');
  } catch (err) {
    log(`Browser error: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  // ── All strategies blocked ───────────────────────────────────────────────
  const socks5Proxy = process.env.SOCKS5_PROXY;
  log('All strategies blocked. Returning BLOCKED result.');

  emitResult({
    questionId,
    title: null,
    url: questionUrl,
    viewCount: null,
    answerCount: null,
    askedAt: null,
    answers: [],
    total: 0,
    source: null,
    blocked: true,
    blockReason: 'Cloudflare Managed Challenge (cType: managed)',
    blockDetails: socks5Proxy
      ? 'SOCKS5 proxy was used but Cloudflare still blocked. Try a US/EU residential proxy.'
      : 'Set SOCKS5_PROXY=host:port env var with a residential proxy to bypass Cloudflare.',
    proxyInUse: socks5Proxy || null,
    retryWith: `SOCKS5_PROXY=<residential-proxy-host:port> node quora-question.mjs "${rawInput}" --max-answers ${maxAnswers}`,
  });
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  emitError('FATAL_ERROR', err.message);
  process.exit(1);
});
