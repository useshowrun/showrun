// Flagship (www.linkedin.com) search via the server-rendered results page.
//
// LinkedIn moved /search/results/* to server-driven UI (flagship-web RSC). The
// results are rendered into the initial HTML document and the page no longer
// calls voyager for them: `voyagerSearchDashClusters` still answers HTTP 200
// but with metadata only — zero EntityResultViewModel entities for every
// query. So we fetch the same results page the browser would load (in-page,
// through chromeFetch — one request per page of 10, no tab navigation) and
// parse the result cards out of the HTML in Node.
//
// The HTML is parsed here rather than in-page because LinkedIn's Trusted Types
// default policy strips markup from DOMParser/innerHTML input.

import { chromeFetch } from './linkedin-fetch.mjs';

export const PAGE_SIZE = 10; // flagship search always renders 10 results/page

const TYPE_PATHS = {
  PEOPLE: 'people',
  COMPANIES: 'companies',
  GROUPS: 'groups',
  SCHOOLS: 'schools',
  EVENTS: 'events',
  PRODUCTS: 'products',
  SERVICES: 'services',
  POSTS: 'content',
};

export function searchResultsUrl(type, keywords, page = 1) {
  const path = TYPE_PATHS[type];
  if (!path) throw new Error(`Unsupported search type: ${type}`);
  const pageParam = page > 1 ? `&page=${page}` : '';
  return `https://www.linkedin.com/search/results/${path}/?keywords=${encodeURIComponent(keywords)}${pageParam}`;
}

// ---------------------------------------------------------------------------
// HTML helpers (zero-dependency; the markup is React SSR output, so tags are
// well-formed and attribute values are always double-quoted)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function textOf(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[​‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

// Index just past the `</a>` that closes the <a> opened at `start`. Result
// cards are an <a> wrapping the whole card with a nested title <a>, so count.
function matchingAnchorEnd(html, start) {
  const re = /<a\b|<\/a>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</a>' ? -1 : 1;
    if (depth === 0) return m.index + 4;
  }
  return html.length;
}

// Card anchors are `<a tabindex="0" href=… componentkey=…>`. Promo cards
// (Sales Navigator / Premium upsells) share that shape but open in a new tab.
function isResultCard(tag) {
  if (!/\stabindex="0"/.test(tag) || !/\scomponentkey="/.test(tag)) return false;
  if (/\starget="_blank"/.test(tag)) return false;
  const href = attr(tag, 'href') || '';
  if (!/^https:\/\/www\.linkedin\.com\//.test(href)) return false;
  return !/linkedin\.com\/(search|premium|sales|help|mypreferences)\//.test(href);
}

// Drop separator-only lines and leading "· " so joined lines read cleanly.
const cleanLines = lines => lines.map(s => s.replace(/^[\s·•|]+/, '')).filter(Boolean);

function parseCard(cardHtml, href) {
  // First <p> is the title line: <a>Name</a> plus an optional " • 2nd" badge.
  const titleMatch = cardHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
  if (!titleMatch) return null;
  const titleHtml = titleMatch[1];
  const titleAnchor = titleHtml.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
  const titleText = textOf(titleHtml);
  const name = titleAnchor ? textOf(titleAnchor[1]) : titleText.replace(/\s*•.*$/, '');
  const distanceMatch = titleText.match(/•\s*(1st|2nd|3rd\+?)/);

  // Subtitle lines (headline / industry, location) are the <div><p>…</p></div>
  // siblings right after the title; anything later in the card (snippet,
  // mutual connections, follower count) goes to `summary`.
  const header = [];
  let rest = cardHtml.slice(titleMatch.index + titleMatch[0].length);
  const lineRe = /^\s*<div\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<\/div>/;
  let lm;
  while ((lm = rest.match(lineRe))) {
    header.push(textOf(lm[1]));
    rest = rest.slice(lm[0].length);
  }
  const extra = [...rest.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m => textOf(m[1]));
  const memberId = cardHtml.match(/\bid="SearchResults(ACoA[A-Za-z0-9_-]+)"/);

  return {
    name: name || '(unknown)',
    subtitle: header[0] || '',
    secondary: cleanLines(header.slice(1)).join(' · '),
    summary: cleanLines(extra).join(' · '),
    distance: distanceMatch ? distanceMatch[1] : '',
    url: href.split('?')[0],
    profileUrn: memberId ? `urn:li:fsd_profile:${memberId[1]}` : null,
  };
}

// Parse a /search/results/<vertical>/ HTML document.
// Returns { results, total, lastPage }. `total` is only rendered for some
// verticals (e.g. "2 results" on companies); null when LinkedIn omits it.
export function parseSearchResultsHtml(html) {
  const results = [];
  const seen = new Set();
  const tagRe = /<a\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (!isResultCard(m[0])) continue;
    const end = matchingAnchorEnd(html, m.index);
    const href = attr(m[0], 'href');
    const card = parseCard(html.slice(m.index, end), href);
    tagRe.lastIndex = end;
    if (!card || seen.has(card.url)) continue;
    seen.add(card.url);
    results.push(card);
  }

  const totalMatch = html.match(/>\s*(?:About\s+)?([\d][\d,.]*)\s+results?\s*</);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/[,.]/g, ''), 10) : null;

  let lastPage = null;
  for (const pm of html.matchAll(/aria-label="Page (\d+)"/g)) {
    lastPage = Math.max(lastPage || 0, parseInt(pm[1], 10));
  }

  return { results, total, lastPage };
}

// Content (POSTS) search renders feed-update cards instead of entity cards,
// and only the first few are server-rendered (the rest stream in on scroll),
// so this returns that first batch only.
export function parsePostsHtml(html) {
  const results = [];
  const stop = html.indexOf('Are these results helpful');
  const body = stop > 0 ? html.slice(0, stop) : html;
  const starts = [...body.matchAll(/<div\b[^>]*role="listitem"[^>]*componentkey="update-card-/g)].map(m => m.index);
  starts.forEach((from, i) => {
    const card = body.slice(from, starts[i + 1] ?? body.length);
    const authorTag = card.match(/<a\b[^>]*\stabindex="0"[^>]*>/);
    const textIdx = card.search(/data-testid="expandable-text-box"/);
    const head = textIdx >= 0 ? card.slice(0, textIdx) : card;
    const headLines = [...head.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(m => textOf(m[1])).filter(Boolean);
    let text = '';
    if (textIdx >= 0) {
      const tail = card.slice(textIdx);
      const close = tail.indexOf('</p>');
      text = textOf(tail.slice(tail.indexOf('>') + 1, close >= 0 ? close : undefined).replace(/<br\s*\/?>/g, ' '));
    }
    const degreeIdx = headLines.findIndex(l => /^•?\s*(1st|2nd|3rd\+?)$/.test(l));
    const distance = degreeIdx >= 0 ? headLines[degreeIdx].replace(/^•\s*/, '') : '';
    const rest = headLines.filter((_, k) => k !== 0 && k !== degreeIdx);
    // Post URN, when the card carries its translation id (share or ugcPost).
    const ugc = card.match(/userGeneratedContentId=(\d+)/);
    const share = card.match(/shareId=(\d+)/);
    const urn = ugc ? `urn:li:ugcPost:${ugc[1]}` : share ? `urn:li:share:${share[1]}` : null;
    results.push({
      name: headLines[0] || '(unknown)',
      subtitle: rest.length > 1 ? rest.slice(0, -1).join(' · ') : '',
      secondary: rest.length ? rest[rest.length - 1] : '', // relative post date, e.g. "Oct 1"
      summary: text,
      distance,
      url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : '',
      authorUrl: authorTag ? (attr(authorTag[0], 'href') || '').split('?')[0] : '',
      profileUrn: null,
    });
  });
  return { results, total: null, lastPage: 1 };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function detectBlocked(resp) {
  if (resp.status === 999) {
    return 'LinkedIn returned HTTP 999 (anti-automation block). Stop and let the account rest before retrying.';
  }
  const finalUrl = resp.url || '';
  if (/\/(login|uas\/login|authwall|checkpoint)\b/.test(finalUrl)) {
    return `LinkedIn redirected the search to ${finalUrl.split('?')[0]} — the session is logged out or challenged. Open LinkedIn in Chrome, clear the prompt / log in, then retry.`;
  }
  if (resp.status === 401 || resp.status === 403) {
    return `LinkedIn returned HTTP ${resp.status} for the search page — log in to LinkedIn in Chrome and retry.`;
  }
  if (!resp.ok) return `LinkedIn search page returned HTTP ${resp.status}.`;
  return null;
}

// Fetch and parse one results page (1-based LinkedIn page number).
export async function fetchSearchResultsPage(type, keywords, page = 1) {
  const url = searchResultsUrl(type, keywords, page);
  const resp = await chromeFetch(url, { headers: { accept: 'text/html' } });
  const problem = detectBlocked(resp);
  if (problem) throw new Error(problem);
  return type === 'POSTS' ? parsePostsHtml(resp.body) : parseSearchResultsHtml(resp.body);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch results [start, start+count) by walking LinkedIn's fixed 10-per-page
// result pages, pausing ~10s between page loads (account-safety pacing).
export async function searchFlagship(type, keywords, { start = 0, count = 10, pauseMs = 10000 } = {}) {
  if (type === 'POSTS') {
    // Only the first server-rendered batch is reachable without scrolling.
    if (start > 0) throw new Error('POSTS search only returns the first server-rendered batch; --page > 1 is not supported.');
    const res = await fetchSearchResultsPage(type, keywords, 1);
    return { ...res, results: res.results.slice(0, count) };
  }
  const firstPage = Math.floor(start / PAGE_SIZE) + 1;
  const lastPageNeeded = Math.floor((start + count - 1) / PAGE_SIZE) + 1;
  let collected = [];
  let total = null;
  let lastPage = null;
  for (let p = firstPage; p <= lastPageNeeded; p++) {
    if (p > firstPage) await sleep(pauseMs + Math.random() * 3000);
    const res = await fetchSearchResultsPage(type, keywords, p);
    total = total ?? res.total;
    lastPage = Math.max(lastPage || 0, res.lastPage || 0) || null;
    collected = collected.concat(res.results);
    if (res.results.length < PAGE_SIZE) break; // ran out of results
  }
  const offset = start - (firstPage - 1) * PAGE_SIZE;
  return { results: collected.slice(offset, offset + count), total, lastPage };
}
