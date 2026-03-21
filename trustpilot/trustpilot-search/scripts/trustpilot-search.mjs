#!/usr/bin/env node
/**
 * trustpilot-search — Search for businesses on Trustpilot.
 *
 * INPUT (JSON arg or env vars):
 *   {
 *     "query":      "amazon",  // Required — business name or domain
 *     "maxResults": 10,        // Optional — max results (default: 10, max: 100)
 *     "page":       1,         // Optional — page number (default: 1)
 *     "country":    "US",      // Optional — country filter (default: "US")
 *   }
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "query": string,
 *     "country": string,
 *     "totalHits": number|null,
 *     "totalPages": number|null,
 *     "currentPage": number,
 *     "businesses": [
 *       {
 *         "businessUnitId": string,
 *         "domain": string,          // e.g. "www.amazon.com"
 *         "name": string,
 *         "numberOfReviews": number,
 *         "trustScore": number,      // e.g. 1.7 (1-5 scale)
 *         "stars": number,           // e.g. 1.5 (1-5 scale)
 *         "location": object|null,
 *         "contact": object|null,
 *         "categories": array,
 *         "url": string,             // full Trustpilot URL
 *       }
 *     ]
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * ENV:
 *   SOCKS5_PROXY — optional SOCKS5 proxy (e.g. "127.0.0.1:11090")
 */

import { Camoufox } from 'camoufox-js';
import {
  emitResult,
  emitError,
  log,
  delay,
  createTrustpilotBrowser,
  createTrustpilotContext,
  extractNextData,
  parseSearchResult,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse input
// ---------------------------------------------------------------------------

function parseInput() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    try {
      return JSON.parse(args[0]);
    } catch (e) {
      // Not JSON — treat as bare query string
      return { query: args[0] };
    }
  }
  // Env var fallback
  const query = process.env.QUERY;
  if (!query) {
    emitError('MISSING_INPUT', 'Provide a JSON argument or QUERY env var');
  }
  return {
    query,
    maxResults: process.env.MAX_RESULTS ? parseInt(process.env.MAX_RESULTS, 10) : undefined,
    page: process.env.PAGE ? parseInt(process.env.PAGE, 10) : undefined,
    country: process.env.COUNTRY,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = parseInput();
  const {
    query,
    maxResults = 10,
    page = 1,
    country = 'US',
  } = input;

  if (!query || query.trim() === '') {
    emitError('MISSING_INPUT', '"query" is required');
  }

  log(`Searching Trustpilot for: "${query}" (page ${page}, country ${country}, maxResults ${maxResults})`);

  const pageSize = Math.min(maxResults, 20); // Each page is 20 results max
  const browser = await createTrustpilotBrowser(Camoufox);
  const context = await createTrustpilotContext(browser);
  const page_ = await context.newPage();

  // Intercept the search API for richer data
  let apiResults = null;
  page_.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/consumersitesearch-api/businessunits/search') && res.status() === 200) {
      try {
        const body = await res.json();
        apiResults = body;
      } catch (e) {
        // ignore
      }
    }
  });

  try {
    const encodedQuery = encodeURIComponent(query.trim());
    const searchUrl = `https://www.trustpilot.com/search?query=${encodedQuery}&country=${country}&page=${page}`;
    log(`Navigating to: ${searchUrl}`);

    await page_.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(4000);

    const title = await page_.title();
    const finalUrl = page_.url();
    log(`Page title: "${title}"`);
    log(`Final URL: ${finalUrl}`);

    // Check for bot detection
    if (title.includes('Access to this page') || title.includes('denied') || title.includes('captcha')) {
      emitError('BOT_DETECTED', 'PerimeterX captcha triggered — use a residential proxy (SOCKS5_PROXY)');
    }

    // Extract __NEXT_DATA__
    const nextDataRaw = await extractNextData(page_);
    const pageProps = nextDataRaw?.props?.pageProps;

    if (!pageProps) {
      log('No __NEXT_DATA__ found, checking body...');
      const bodyText = await page_.evaluate(() => document.body.innerText.substring(0, 300));
      log('Body preview:', bodyText);
      emitError('PARSE_ERROR', 'Could not extract page data from __NEXT_DATA__');
    }

    // Extract businesses from Next.js data
    let businesses = (pageProps.businessUnits || []).map(parseSearchResult);

    // If the API interceptor caught richer data, prefer that
    if (apiResults && apiResults.businessUnits && apiResults.businessUnits.length > 0) {
      log(`API intercepted ${apiResults.businessUnits.length} additional results`);
      // Merge by domain to deduplicate
      const domainMap = new Map(businesses.map(b => [b.domain, b]));
      for (const bu of apiResults.businessUnits) {
        const parsed = parseSearchResult(bu);
        if (!domainMap.has(parsed.domain)) {
          domainMap.set(parsed.domain, parsed);
        }
      }
      businesses = Array.from(domainMap.values());
    }

    // Apply maxResults cap
    const cappedBusinesses = businesses.slice(0, maxResults);

    const totalHits = pageProps.pagination?.totalHits || apiResults?.totalHits || null;
    const totalPages = pageProps.pagination?.totalPages || apiResults?.totalPages || null;

    log(`Found ${cappedBusinesses.length} businesses (total hits: ${totalHits})`);

    emitResult({
      query: query.trim(),
      country,
      page,
      totalHits,
      totalPages,
      businesses: cappedBusinesses,
    });

  } catch (err) {
    log('Error:', err.message);
    emitError('SCRAPE_ERROR', err.message);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write('[trustpilot] Fatal: ' + err.message + '\n');
  process.exit(1);
});
