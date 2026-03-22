#!/usr/bin/env node
/**
 * goodreads-search — Search for books on Goodreads.
 *
 * USAGE:
 *   node goodreads-search.mjs <query> [options]
 *   node goodreads-search.mjs '{"query":"dune","max":20}'
 *
 * ARGS:
 *   <query>         Book title, author name, or ISBN
 *   --max N         Maximum results to return (default: 10, max: 100)
 *   --type books|author  Search type (default: books)
 *
 * OUTPUT (stdout):
 *   RESULT:{
 *     "query": string,
 *     "searchType": string,
 *     "totalResults": number|null,
 *     "books": [
 *       {
 *         "bookId": string,
 *         "title": string,
 *         "author": { "name": string, "url": string },
 *         "rating": number|null,
 *         "ratingsCount": number|null,
 *         "url": string,
 *         "coverUrl": string|null,
 *         "year": number|null,
 *         "isbn": string|null
 *       }
 *     ]
 *   }
 *
 * LOGS: stderr
 * ERRORS: RESULT:{"error": true, "code": "...", "message": "..."}
 *
 * STRATEGY:
 *   - Fetch search page HTML via direct HTTPS (no browser needed)
 *   - Parse schema.org/Book microdata from legacy Rails HTML
 *   - Goodreads search pages work with curl — no bot protection
 *   - Paginate if maxResults > 10 (10 results per page)
 */

import {
  log,
  emitResult,
  emitError,
  fetchHtml,
  parseSearchHtml,
  parseSearchPagination,
  delay,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  if (!args[0]) {
    emitError('MISSING_ARG', 'Usage: node goodreads-search.mjs <query> [--max N] [--type books|author]');
  }

  // Try JSON arg first
  try {
    const json = JSON.parse(args[0]);
    return {
      query: json.query || json.q,
      max: json.max || json.maxResults || 10,
      searchType: json.type || json.searchType || 'books',
    };
  } catch (_) {
    // Not JSON — parse as positional + flags
  }

  const query = args[0];
  let max = 10;
  let searchType = 'books';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--max' && args[i + 1]) {
      max = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--type' && args[i + 1]) {
      searchType = args[i + 1];
      i++;
    }
  }

  return { query, max, searchType };
}

// ---------------------------------------------------------------------------
// Build search URL
// ---------------------------------------------------------------------------

function buildSearchUrl(query, searchType, page) {
  const params = new URLSearchParams({
    q: query,
    search_type: searchType,
    page: String(page),
  });
  return `https://www.goodreads.com/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { query, max, searchType } = parseArgs();

  if (!query || !query.trim()) {
    emitError('MISSING_ARG', 'Query cannot be empty');
  }

  const maxResults = Math.min(Math.max(1, parseInt(max, 10) || 10), 100);
  log(`Searching Goodreads for: "${query}" (type=${searchType}, max=${maxResults})`);

  const resultsPerPage = 10;
  const maxPages = Math.ceil(maxResults / resultsPerPage);

  let allBooks = [];
  let totalResults = null;

  for (let page = 1; page <= maxPages && allBooks.length < maxResults; page++) {
    const url = buildSearchUrl(query, searchType, page);
    log(`Fetching page ${page}: ${url}`);

    let html, finalUrl;
    try {
      const result = await fetchHtml(url);
      html = result.html;
      finalUrl = result.url;
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        // No results
        break;
      }
      if (page === 1) {
        emitError('FETCH_ERROR', `Failed to fetch search results: ${err.message}`);
      }
      log(`Warning: Page ${page} fetch failed: ${err.message} — stopping`);
      break;
    }

    // Check for bot block
    if (html.includes('Robot Check') || html.includes('captcha')) {
      emitError('BOT_DETECTED', 'Goodreads returned a bot-check page — try SOCKS5_PROXY');
    }

    // Extract pagination info on first page
    if (page === 1) {
      const pagination = parseSearchPagination(html);
      totalResults = pagination.total;
      log(`Total results: ${totalResults ?? 'unknown'}`);
    }

    const books = parseSearchHtml(html);
    log(`Page ${page}: extracted ${books.length} books`);

    if (books.length === 0) {
      log('No books on this page — stopping pagination');
      break;
    }

    for (const b of books) {
      if (allBooks.length >= maxResults) break;
      allBooks.push(b);
    }

    // Delay between pages to be polite
    if (page < maxPages && allBooks.length < maxResults) {
      await delay(800);
    }
  }

  log(`Total extracted: ${allBooks.length} books`);

  emitResult({
    query,
    searchType,
    totalResults,
    books: allBooks,
  });
}

main().catch(err => {
  process.stderr.write('[goodreads-search] Fatal: ' + err.message + '\n');
  process.exit(1);
});
