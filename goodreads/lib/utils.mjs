/**
 * Shared utilities for Goodreads scrapers.
 *
 * Anti-bot Strategy (Research: 2026-03-22):
 *   Goodreads is Amazon-owned and served via CloudFront CDN.
 *   Unlike Fiverr/PerimeterX sites, Goodreads does NOT aggressively bot-block:
 *
 *   - Book pages (goodreads.com/book/show/<id>) respond with 200 to curl with
 *     a standard Firefox User-Agent, no JS execution needed.
 *   - Search pages (goodreads.com/search?q=<query>&search_type=books) also
 *     respond with 200 and include full microdata in the HTML.
 *   - Both page types work via direct HTTPS fetch — no browser required.
 *
 *   DATA SOURCES:
 *   1. BOOK PAGES — Next.js with Apollo GraphQL SSR
 *      Primary: <script id="__NEXT_DATA__"> → props.pageProps.apolloState
 *        - Book: legacyId, title, titleComplete, description, imageUrl,
 *                bookGenres, bookSeries, details (isbn, isbn13, asin, format,
 *                numPages, publicationTime, publisher, language)
 *                primaryContributorEdge, secondaryContributorEdges
 *        - Work: originalTitle, stats (averageRating, ratingsCount,
 *                ratingsCountDist, textReviewsCount), choiceAwards, details
 *                (awardsWon, places, characters, publicationTime)
 *        - Contributor: id, legacyId, name, webUrl, profileImageUrl
 *        - Series: id, title, webUrl (per BookSeries entry)
 *        - Review (30 embedded): id, text, rating, createdAt, updatedAt,
 *                 likeCount, spoilerStatus, shelving
 *        - User (reviewer): name, webUrl, imageUrlSquare
 *
 *      Fallback: <script type="application/ld+json"> → Book schema
 *        - name, image, bookFormat, numberOfPages, inLanguage, isbn, awards, author,
 *          aggregateRating (ratingValue, ratingCount, reviewCount)
 *
 *   2. SEARCH PAGES — Legacy Rails/HTML with microdata
 *      URL: goodreads.com/search?q=<query>&search_type=books&page=N
 *      Microdata: <tr itemscope itemtype="http://schema.org/Book">
 *        Per result: div[id] (bookId), itemprop=name (title), itemprop=url (bookUrl),
 *        itemprop=author (authorName), img.bookCover (coverUrl),
 *        .minirating (ratingText → rating + ratingsCount)
 *        published YYYY (year)
 *
 *   3. REVIEWS (beyond 30) — camoufox + XHR intercept
 *      Goodreads uses Apollo GraphQL for lazy-loaded reviews.
 *      The browser posts to /graphql (internal Apollo endpoint on goodreads.com).
 *      We intercept XHR by capturing page responses and identifying review payloads.
 *      Alternatively, scroll and wait for more reviews to load.
 *
 *   PROXY NOTE: Not needed for basic scraping. SOCKS5_PROXY env supported if needed.
 *
 *   IMPORTANT: URL formats accepted for book pages:
 *     - Full URL: https://www.goodreads.com/book/show/44767458-dune
 *     - Numeric ID: 44767458
 *     - ID-slug: 44767458-dune
 *     - Legacy dotted: 3.Harry_Potter_and_the_Sorcerer_s_Stone
 */

import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function log(...args) {
  process.stderr.write('[goodreads] ' + args.join(' ') + '\n');
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
// HTTP fetch helper (no browser, pure Node.js)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return the response body as text.
 * Follows up to 5 redirects, spoofs a Firefox user-agent.
 */
export async function fetchHtml(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  let redirectCount = 0;
  let currentUrl = url;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    ...options.headers,
  };

  while (redirectCount <= maxRedirects) {
    const parsedUrl = new URL(currentUrl);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const body = await new Promise((resolve, reject) => {
      const req = lib.get(currentUrl, { headers }, (res) => {
        // Handle redirects
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
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${currentUrl}`), {
            code: 'HTTP_ERROR', status: res.statusCode,
          }));
          res.resume();
          return;
        }

        // Decompress if needed
        const chunks = [];
        const contentEncoding = res.headers['content-encoding'] || '';

        let stream = res;
        if (contentEncoding.includes('gzip') || contentEncoding.includes('deflate') || contentEncoding.includes('br')) {
          try {
            if (contentEncoding.includes('br')) {
              stream = res.pipe(zlib.createBrotliDecompress());
            } else {
              stream = res.pipe(zlib.createGunzip());
            }
          } catch (e) {
            // fallback: read raw
          }
        }

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });

    if (body.redirect) {
      currentUrl = body.redirect;
      redirectCount++;
      log(`Redirect → ${currentUrl}`);
      continue;
    }

    return { html: body.body, url: currentUrl, status: body.status };
  }

  throw new Error(`Too many redirects (${maxRedirects})`);
}

// ---------------------------------------------------------------------------
// URL / ID normalization
// ---------------------------------------------------------------------------

/**
 * Parse a user-provided book input and return the Goodreads URL.
 * Accepts:
 *   - Full URL: https://www.goodreads.com/book/show/44767458-dune
 *   - Numeric ID: 44767458
 *   - ID-slug: 44767458-dune
 *   - Dotted legacy: 3.Harry_Potter_and_the_Sorcerer_s_Stone
 *   - Bare slug: dune (ambiguous — best-effort)
 */
export function resolveBookUrl(input) {
  if (!input) return null;

  const trimmed = input.trim();

  // Already a full URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const parsed = new URL(trimmed);
    // Normalize to www.goodreads.com
    parsed.hostname = 'www.goodreads.com';
    // Strip query params
    parsed.search = '';
    return parsed.toString();
  }

  // Numeric-only ID
  if (/^\d+$/.test(trimmed)) {
    return `https://www.goodreads.com/book/show/${trimmed}`;
  }

  // ID-slug format: 44767458-dune or 3.Harry_Potter
  if (/^\d+[.\-]/.test(trimmed)) {
    return `https://www.goodreads.com/book/show/${trimmed}`;
  }

  // Fallback: treat as slug / search term path
  return `https://www.goodreads.com/book/show/${trimmed}`;
}

/**
 * Extract legacy book ID from URL or any string.
 */
export function extractBookId(urlOrId) {
  if (!urlOrId) return null;

  const trimmed = urlOrId.toString().trim();

  // Try to extract from full URL path: /book/show/44767458...
  const urlMatch = trimmed.match(/\/book\/show\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  // Pure number
  if (/^\d+$/.test(trimmed)) return trimmed;

  // ID-slug: 44767458-dune
  const slugMatch = trimmed.match(/^(\d+)[.\-]/);
  if (slugMatch) return slugMatch[1];

  return null;
}

// ---------------------------------------------------------------------------
// HTML data extraction
// ---------------------------------------------------------------------------

/**
 * Extract __NEXT_DATA__ from page HTML.
 * Returns the parsed JSON object or null.
 */
export function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    log('Warning: Failed to parse __NEXT_DATA__:', e.message);
    return null;
  }
}

/**
 * Extract JSON-LD Book schema from page HTML.
 * Returns the first Book-type JSON-LD object or null.
 */
export function extractJsonLd(html) {
  const matches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      if (data['@type'] === 'Book') return data;
    } catch (e) {
      // skip malformed
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apollo state parsing
// ---------------------------------------------------------------------------

/**
 * Resolve a __ref pointer within an Apollo cache.
 */
export function resolveRef(apolloState, refObj) {
  if (!refObj || !refObj.__ref) return null;
  return apolloState[refObj.__ref] || null;
}

/**
 * Extract full book data from apolloState.
 * Returns { book, work, authors, series, reviews, reviewerMap } or null.
 */
export function parseApolloState(apolloState) {
  if (!apolloState) return null;

  // Locate Book entry — prefer the one with the most data (title, description, etc.)
  // Goodreads may include multiple Book entries (e.g. redirect editions).
  const bookKeys = Object.keys(apolloState).filter(k => k.startsWith('Book:'));
  if (!bookKeys.length) return null;
  // Score each book entry by number of meaningful keys; prefer entries with title/description
  const bookKey = bookKeys.reduce((best, k) => {
    const b = apolloState[k];
    const score = (b.title ? 10 : 0) + (b.description ? 5 : 0) + Object.keys(b).length;
    const bestScore = (() => {
      const bb = apolloState[best];
      return (bb.title ? 10 : 0) + (bb.description ? 5 : 0) + Object.keys(bb).length;
    })();
    return score > bestScore ? k : best;
  }, bookKeys[0]);
  const book = apolloState[bookKey];

  // Locate Work entry
  const workRef = book.work;
  const work = workRef ? resolveRef(apolloState, workRef) : null;

  // Locate primary author (Contributor)
  const primaryEdge = book.primaryContributorEdge;
  const primaryContrib = primaryEdge?.node
    ? resolveRef(apolloState, primaryEdge.node)
    : null;

  // Secondary contributors
  const secondaryEdges = book.secondaryContributorEdges || [];
  const secondaryContribs = secondaryEdges.map(edge => {
    const contrib = resolveRef(apolloState, edge.node);
    return contrib ? { ...contrib, role: edge.role } : null;
  }).filter(Boolean);

  // Series
  const bookSeries = (book.bookSeries || []).map(bs => {
    const seriesRef = bs.series;
    const series = resolveRef(apolloState, seriesRef);
    return series ? {
      id: series.id || null,
      title: series.title || null,
      webUrl: series.webUrl || null,
      userPosition: bs.userPosition || null,
    } : null;
  }).filter(Boolean);

  // Reviews
  const reviewKeys = Object.keys(apolloState).filter(k => k.startsWith('Review:'));
  const reviews = reviewKeys.map(rk => {
    const r = apolloState[rk];
    const creatorRef = r.creator;
    const creator = creatorRef ? resolveRef(apolloState, creatorRef) : null;
    return {
      id: r.id || null,
      rating: r.rating ?? null,
      text: r.text ? stripHtml(r.text) : null,
      textHtml: r.text || null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      spoilerStatus: r.spoilerStatus || false,
      likeCount: r.likeCount ?? 0,
      commentCount: r.commentCount ?? 0,
      shelving: r.shelving || null,
      reviewer: creator ? {
        id: creator.legacyId || creator.id || null,
        name: creator.name || null,
        webUrl: creator.webUrl || null,
        imageUrl: creator.imageUrlSquare || null,
        isAuthor: creator.isAuthor || false,
        followersCount: creator.followersCount || null,
        textReviewsCount: creator.textReviewsCount || null,
      } : null,
    };
  });

  // Sort reviews by createdAt desc (most recent first)
  reviews.sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0;
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return { book, work, primaryContrib, secondaryContribs, bookSeries, reviews };
}

// ---------------------------------------------------------------------------
// Book data normalizer
// ---------------------------------------------------------------------------

/**
 * Build a clean book object from apolloState data + JSON-LD fallback.
 */
export function normalizeBook(apolloParsed, jsonLd, bookUrl) {
  const { book, work, primaryContrib, secondaryContribs, bookSeries, reviews } = apolloParsed || {};

  // ---- Basic IDs ----
  const bookId = book?.legacyId
    ? String(book.legacyId)
    : extractBookId(bookUrl);
  const webUrl = book?.webUrl || bookUrl;

  // ---- Title ----
  const rawTitleComplete = book?.titleComplete || jsonLd?.name || null;
  const titleComplete = rawTitleComplete ? decodeHtmlEntities(rawTitleComplete) : null;
  const rawTitle = book?.title || null;
  const title = (rawTitle ? decodeHtmlEntities(rawTitle) : null) ||
    (titleComplete ? titleComplete.replace(/\s*\(.*?\)\s*$/, '').trim() : null);

  // ---- Original title ----
  const originalTitle = work?.details?.originalTitle || null;

  // ---- Authors ----
  const authors = [];
  if (primaryContrib) {
    authors.push({
      id: primaryContrib.legacyId ? String(primaryContrib.legacyId) : null,
      name: primaryContrib.name || null,
      url: primaryContrib.webUrl || null,
      imageUrl: primaryContrib.profileImageUrl || null,
      role: book?.primaryContributorEdge?.role || 'Author',
      followersCount: primaryContrib.followers?.totalCount || null,
      worksCount: primaryContrib.works?.totalCount || null,
    });
  } else if (jsonLd?.author) {
    const jldAuthors = Array.isArray(jsonLd.author) ? jsonLd.author : [jsonLd.author];
    for (const a of jldAuthors) {
      authors.push({
        id: null,
        name: a.name || null,
        url: a.url || null,
        imageUrl: null,
        role: 'Author',
        followersCount: null,
        worksCount: null,
      });
    }
  }
  for (const sc of (secondaryContribs || [])) {
    authors.push({
      id: sc.legacyId ? String(sc.legacyId) : null,
      name: sc.name || null,
      url: sc.webUrl || null,
      imageUrl: sc.profileImageUrl || null,
      role: sc.role || 'Contributor',
      followersCount: sc.followers?.totalCount || null,
      worksCount: sc.works?.totalCount || null,
    });
  }

  // ---- Stats ----
  const stats = work?.stats || {};
  const ratingsDist = stats.ratingsCountDist || null;
  const ratingDistribution = ratingsDist ? {
    1: ratingsDist[0] || 0,
    2: ratingsDist[1] || 0,
    3: ratingsDist[2] || 0,
    4: ratingsDist[3] || 0,
    5: ratingsDist[4] || 0,
  } : null;

  // ---- Details ----
  const details = book?.details || {};
  const publicationTime = details.publicationTime || work?.details?.publicationTime || null;
  const publishedDate = publicationTime ? new Date(publicationTime).toISOString().slice(0, 10) : null;

  // ---- Genres ----
  const genres = (book?.bookGenres || []).map(bg => bg.genre?.name).filter(Boolean);

  // ---- Series ----
  const series = (bookSeries || []).map(s => ({
    id: s.id,
    title: s.title,
    url: s.webUrl,
    position: s.userPosition,
  }));

  // ---- Awards ----
  const awardsWon = work?.details?.awardsWon || [];
  const awards = awardsWon.map(a => ({
    name: a.name || null,
    url: a.webUrl || null,
    year: a.awardedAt ? new Date(a.awardedAt).getFullYear() : null,
    category: a.category || null,
    designation: a.designation || null,
  }));

  // ---- Places ----
  const places = (work?.details?.places || []).map(p => ({
    name: p.name || null,
    country: p.countryName || null,
    url: p.webUrl || null,
  }));

  // ---- Characters ----
  const characters = (work?.details?.characters || []).map(c => ({
    name: c.name || null,
    url: c.webUrl || null,
  }));

  // ---- Cover ----
  const coverUrl = book?.imageUrl || jsonLd?.image || null;
  const coverImageLarge = coverUrl
    ? coverUrl.replace(/\._[A-Z][A-Z0-9]+_\./, '.') // Remove Amazon size suffix
    : null;

  return {
    bookId,
    title: title || null,
    originalTitle,
    titleComplete,
    authors,
    isbn: details.isbn || null,
    isbn13: details.isbn13 || (jsonLd?.isbn?.length === 13 ? jsonLd.isbn.replace(/[^0-9X]/g, '') : null) || null,
    asin: details.asin || null,
    rating: stats.averageRating || jsonLd?.aggregateRating?.ratingValue || null,
    ratingsCount: stats.ratingsCount || jsonLd?.aggregateRating?.ratingCount || null,
    reviewsCount: stats.textReviewsCount || jsonLd?.aggregateRating?.reviewCount || null,
    ratingDistribution,
    description: book?.description ? stripHtml(book['description({"stripped":true})'] || book.description) : null,
    genres,
    series,
    publisher: details.publisher || null,
    publishedDate,
    pages: details.numPages || jsonLd?.numberOfPages || null,
    language: details.language?.name || jsonLd?.inLanguage || null,
    format: details.format || jsonLd?.bookFormat || null,
    coverUrl,
    coverImageLarge,
    awards,
    places,
    characters,
    url: webUrl,
    workId: work?.legacyId ? String(work.legacyId) : null,
    quotesCount: work?.['quotes({"pagination":{"limit":1}})']?.totalCount || null,
    questionsCount: work?.['questions({"pagination":{"limit":1}})']?.totalCount || null,
  };
}

/**
 * Build a search result entry from HTML microdata.
 */
export function normalizeSearchResult({ bookId, title, authorName, authorUrl, rating, ratingsCount, coverUrl, year, bookUrl, isbn }) {
  return {
    bookId: bookId || null,
    title: title ? decodeHtmlEntities(title) : null,
    author: {
      name: authorName ? decodeHtmlEntities(authorName) : null,
      url: authorUrl || null,
    },
    rating: rating ? parseFloat(rating) : null,
    ratingsCount: ratingsCount ? parseInt(ratingsCount.replace(/[,\s]/g, ''), 10) : null,
    url: bookUrl ? (bookUrl.startsWith('http') ? bookUrl : `https://www.goodreads.com${bookUrl.split('?')[0]}`) : null,
    coverUrl: coverUrl || null,
    year: year ? parseInt(year, 10) : null,
    isbn: isbn || null,
  };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a string, replacing common tags with whitespace/newlines.
 */
export function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Decode basic HTML entities in a string.
 */
export function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ---------------------------------------------------------------------------
// camoufox browser helpers (for extended reviews scraping)
// ---------------------------------------------------------------------------

/**
 * Create a camoufox browser for Goodreads scraping.
 * Uses SOCKS5_PROXY env if set.
 */
export async function createGoodreadsBrowser(Camoufox) {
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
  }

  return Camoufox({
    headless: true,
    humanize: 0.3,
    screen: { minWidth: 1280, minHeight: 800 },
    firefoxUserPrefs,
  });
}

/**
 * Create a browser context with US locale.
 */
export async function createGoodreadsContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
}

/**
 * Parse search results from Goodreads search page HTML.
 * Uses microdata / itemprop attributes.
 * Returns array of search result objects.
 */
export function parseSearchHtml(html) {
  const results = [];

  // Find all book rows by schema.org/Book microdata marker
  const rowPattern = /<tr itemscope itemtype="http:\/\/schema\.org\/Book">([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];

    // Book ID from anchor target div
    const idMatch = row.match(/<div id="(\d+)" class="u-anchorTarget">/);
    const bookId = idMatch ? idMatch[1] : null;

    // Title from itemprop=name
    const titleMatch = row.match(/itemprop='name'[^>]*>([^<]+)<\/span>/);
    const title = titleMatch ? titleMatch[1].trim() : null;

    // Book URL
    const urlMatch = row.match(/class="bookTitle"\s+itemprop="url"\s+href="([^"]+)"/);
    const bookUrl = urlMatch ? urlMatch[1].split('?')[0] : null;

    // Cover image
    const imgMatch = row.match(/class="bookCover"\s+itemprop="image"\s+src="([^"]+)"/);
    const coverUrl = imgMatch ? imgMatch[1] : null;

    // Author name and URL
    const authorUrlMatch = row.match(/class="authorName"\s+itemprop="url"\s+href="([^"]+)"/);
    const authorUrl = authorUrlMatch ? authorUrlMatch[1].split('?')[0] : null;
    const authorNameMatch = row.match(/itemprop="name">([^<]+)<\/span>/);
    const authorName = authorNameMatch ? authorNameMatch[1].trim() : null;

    // Rating and count from minirating text
    // Note: HTML may contain &mdash; entity which matches [^0-9] in decoded form
    const ratingMatch = row.match(/([\d.]+)\s+avg rating\s+(?:&mdash;|—|–|-)\s+([\d,]+)\s+rating/);
    const rating = ratingMatch ? ratingMatch[1] : null;
    const ratingsCount = ratingMatch ? ratingMatch[2] : null;

    // Published year
    const yearMatch = row.match(/published\s+(\d{4})/);
    const year = yearMatch ? yearMatch[1] : null;

    if (bookId || title) {
      results.push(normalizeSearchResult({
        bookId,
        title,
        authorName,
        authorUrl,
        rating,
        ratingsCount,
        coverUrl,
        year,
        bookUrl: bookUrl ? `https://www.goodreads.com${bookUrl}` : null,
        isbn: null,
      }));
    }
  }

  return results;
}

/**
 * Extract pagination info from search HTML.
 */
export function parseSearchPagination(html) {
  // "1-10 of 100055 books" or similar
  const totalMatch = html.match(/showing\s+[\d-]+\s+of\s+([\d,]+)\s+(?:books|results)/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;

  return { total };
}
