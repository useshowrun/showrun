#!/usr/bin/env node

/**
 * Google Search Scraper
 *
 * Scrapes Google search results including:
 * - Organic results (title, URL, description, sitelinks)
 * - Featured snippet (answer box)
 * - People Also Ask (PAA) questions
 * - Local Pack (business listings)
 * - Knowledge Panel (sidebar entity card)
 * - Related searches
 * - Ads (top/bottom sponsored results)
 * - Total results count
 * - Search metadata (time, location)
 *
 * Uses camoufox-js (fingerprinted Firefox) to avoid detection.
 * All selectors are stable: aria roles, data attributes, semantic HTML, text patterns.
 * NEVER uses obfuscated CSS class names (they change on every Google deploy).
 *
 * Usage:
 *   node google-search-scraper.mjs <query> [options]
 *
 * Options:
 *   --max <n>       Max organic results to return (default: 10)
 *   --page <n>      Page number (default: 1, i.e., start=0)
 *   --lang <code>   Language code (default: en)
 *   --country <cc>  Country code for Google domain (default: com)
 *   --safe          Enable SafeSearch (default: off)
 *   --news          Fetch News tab results instead of Web
 *   --images        Fetch Images tab results instead of Web
 *   --verbatim      Force exact query match (turn off Google's synonyms)
 *   --paa           Include People Also Ask questions (default: true)
 *   --related       Include related searches (default: true)
 *
 * Examples:
 *   node google-search-scraper.mjs "camoufox browser fingerprinting" --max 10
 *   node google-search-scraper.mjs "best pizza in new york" --max 5
 *   node google-search-scraper.mjs "OpenAI" --max 10 --country com
 *   node google-search-scraper.mjs "news today" --news --max 5
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * Data returned:
 *   {
 *     query: string,
 *     totalResults: number|null,
 *     timeTaken: string|null,
 *     page: number,
 *     organic: [ { position, title, url, displayUrl, description, sitelinks[], isAd } ],
 *     featuredSnippet: { title, url, description, type } | null,
 *     paa: [ { question, answer } ],
 *     localPack: [ { name, address, rating, reviewCount, category, phone, hours } ],
 *     knowledgePanel: { title, description, type, attributes:{} } | null,
 *     relatedSearches: [ string ],
 *     ads: [ { position, title, url, displayUrl, description } ],
 *   }
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult, emitError, log, delay,
  parseResultCount, isCaptchaPage,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
  emitError("MISSING_ARG", "Usage: node google-search-scraper.mjs <query> [--max N] [--page N] [--lang xx] [--country xx] [--safe] [--news] [--images] [--verbatim] [--no-paa] [--no-related]");
}

const query = args[0];
let maxResults = 10;
let page = 1;
let lang = "en";
let country = "com";
let safe = false;
let newsTab = false;
let imagesTab = false;
let verbatim = false;
let includePaa = true;
let includeRelated = true;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case "--max":       maxResults = parseInt(args[++i], 10); break;
    case "--page":      page = parseInt(args[++i], 10); break;
    case "--lang":      lang = args[++i]; break;
    case "--country":   country = args[++i]; break;
    case "--safe":      safe = true; break;
    case "--news":      newsTab = true; break;
    case "--images":    imagesTab = true; break;
    case "--verbatim":  verbatim = true; break;
    case "--no-paa":    includePaa = false; break;
    case "--no-related":includeRelated = false; break;
    default:
      log(`Warning: unknown flag ${args[i]}`);
  }
}

// Google domain
const googleDomain = `https://www.google.${country}`;

// Build start offset (Google shows 10 per page)
const start = (page - 1) * 10;

// Map TLD to country code for gl= parameter
// gl= expects a 2-letter ISO country code, NOT the TLD
// e.g. google.com → gl=US, google.co.uk → gl=GB, google.com.tr → gl=TR
const TLD_TO_GL = {
  "com": "US",
  "co.uk": "GB",
  "co.in": "IN",
  "com.au": "AU",
  "com.br": "BR",
  "com.tr": "TR",
  "com.mx": "MX",
  "com.ar": "AR",
  "co.jp": "JP",
  "co.kr": "KR",
  "com.ng": "NG",
  "com.eg": "EG",
  "com.sa": "SA",
  "com.pk": "PK",
  "co.za": "ZA",
  "co.nz": "NZ",
  "co.id": "ID",
};
const glParam = TLD_TO_GL[country] || (country.length === 2 ? country.toUpperCase() : "US");

// Build search URL
function buildSearchUrl() {
  const params = new URLSearchParams({ q: query });

  // Only add hl= if explicitly set by user (not default "en")
  // Avoid geo-mismatch signals: if the proxy IP is non-US, forcing hl=en&gl=US
  // can trigger anti-bot. Let Google auto-detect from IP instead.
  if (lang !== "en") params.set("hl", lang);

  // Only add gl= if the country TLD matches a known non-US market
  // (e.g., google.co.uk → gl=GB) or if user explicitly set --country
  // For google.com (default), don't add gl= and let Google use IP-based detection
  if (country !== "com") {
    params.set("gl", glParam);
  }

  // Add num= only if requesting more than 10 results
  const numResults = Math.min(maxResults + 5, 20);
  if (numResults !== 10) {
    params.set("num", String(numResults));
  }

  if (start > 0) params.set("start", String(start));
  if (safe) params.set("safe", "active");
  if (verbatim) params.set("nfpr", "1");

  if (newsTab) params.set("tbm", "nws");
  else if (imagesTab) params.set("tbm", "isch");

  return `${googleDomain}/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// DOM extraction (runs inside page.evaluate())
// ---------------------------------------------------------------------------

const EXTRACT_RESULTS_FN = `
(function extractGoogleResults(maxResults, isNews, isImages) {
  const result = {
    totalResults: null,
    timeTaken: null,
    organic: [],
    featuredSnippet: null,
    paa: [],
    localPack: [],
    knowledgePanel: null,
    relatedSearches: [],
    ads: [],
  };

  // -------------------------------------------------------------------------
  // Helper: innerText of first matching element (safe)
  // -------------------------------------------------------------------------
  function getText(root, selector) {
    const el = root.querySelector(selector);
    return el ? el.innerText.trim() : null;
  }

  function getAttr(root, selector, attr) {
    const el = root.querySelector(selector);
    return el ? (el.getAttribute(attr) || "").trim() : null;
  }

  // -------------------------------------------------------------------------
  // Helper: get the "real" URL from a Google redirect link
  // Google wraps links in /url?q=... or /search?... or /imgres?...
  // We want the actual destination URL.
  // -------------------------------------------------------------------------
  function resolveGoogleUrl(href) {
    if (!href) return null;
    // /url?q=https://...&... → extract q param
    if (href.includes("/url?") || href.includes("google.com/url")) {
      try {
        const u = new URL(href, window.location.origin);
        const dest = u.searchParams.get("q") || u.searchParams.get("url");
        if (dest) return dest;
      } catch {}
    }
    // Relative /search → skip (it's an internal nav link)
    if (href.startsWith("/search") || href.startsWith("/imgres")) return null;
    // Starts with http — real URL
    if (href.startsWith("http")) return href;
    return null;
  }

  // -------------------------------------------------------------------------
  // Total results count
  // Google shows "About X results (Y seconds)" in a div with id="result-stats"
  // -------------------------------------------------------------------------
  const statsEl = document.querySelector("#result-stats");
  if (statsEl) {
    const text = statsEl.innerText;
    // "About 1,230,000,000 results (0.52 seconds)"
    const countMatch = text.match(/([\\d,]+)\\s+results?/i);
    if (countMatch) result.totalResults = parseInt(countMatch[1].replace(/,/g, ""), 10);
    const timeMatch = text.match(/\\(([\\d.]+\\s+seconds?)\\)/i);
    if (timeMatch) result.timeTaken = timeMatch[1];
  }

  // -------------------------------------------------------------------------
  // Featured Snippet
  // Google places featured snippets in a block with role="heading" h3 + description
  // They're typically inside a container that appears before organic results.
  // Strategy: look for a block that contains an extraction/answer text above regular results.
  // Stable signals:
  //   - data-attrid="wa:/description" (Knowledge Graph answer)
  //   - [data-tts-speakable="true"] — Google marks TTS-speakable answer content
  //   - The featured snippet container has a "Source" link pointing to the origin
  // -------------------------------------------------------------------------
  (function extractFeaturedSnippet() {
    // Look for TTS-speakable answer block (featured snippet)
    const speakable = document.querySelector('[data-tts-speakable="true"]');
    if (speakable) {
      // Find the nearest ancestor that is a standalone card
      let container = speakable;
      for (let i = 0; i < 8; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;
        // Stop when we hit a known result container or the main results block
        if (
          container.tagName === "SECTION" ||
          container.getAttribute("data-hveid") ||
          container.getAttribute("data-ved")
        ) break;
      }

      // Find source link inside container
      let sourceUrl = null;
      let sourceTitle = null;
      const links = container.querySelectorAll("a[href]");
      for (const a of links) {
        const url = resolveGoogleUrl(a.href);
        if (url && !url.includes("google.") && !url.startsWith("/")) {
          sourceUrl = url;
          sourceTitle = a.innerText.trim() || null;
          break;
        }
      }

      result.featuredSnippet = {
        title: sourceTitle,
        url: sourceUrl,
        description: speakable.innerText.trim(),
        type: "answer_box",
      };
      return;
    }

    // Alternative: answer in "wa:/description" Knowledge card (short definition)
    const descEl = document.querySelector('[data-attrid="wa:/description"] [data-tts-speakable], [data-attrid="wa:/description"] span');
    if (descEl) {
      result.featuredSnippet = {
        title: null,
        url: null,
        description: descEl.innerText.trim(),
        type: "knowledge_description",
      };
    }
  })();

  // -------------------------------------------------------------------------
  // Knowledge Panel (right sidebar entity card)
  // Stable: [id="kp-wp-tab-overview"], or div with role="complementary"
  // Contains title (entity name), description, type (e.g. "Company · Founded 2015"), attributes
  // -------------------------------------------------------------------------
  (function extractKnowledgePanel() {
    // The knowledge panel sits in a complementary region or a known block
    const kpContainer = document.querySelector('[id^="kp-wp"]') ||
                        document.querySelector('[role="complementary"]');
    if (!kpContainer) return;

    const title = getText(kpContainer, "h2") || getText(kpContainer, "[data-attrid='title'] span") || null;
    if (!title) return; // Not a real KP if no title

    // Description
    const descEl = kpContainer.querySelector('[data-attrid="wa:/description"] span, [data-attrid^="description"] span');
    const description = descEl ? descEl.innerText.trim() : null;

    // Type (entity category)
    const typeEl = kpContainer.querySelector('[data-attrid="kc:/collection/tabbed_topic:type"] span, [data-attrid^="kc:"] span');
    const type = typeEl ? typeEl.innerText.trim() : null;

    // Attributes (key: value pairs in dt/dd or labeled data rows)
    const attributes = {};
    const attrRows = kpContainer.querySelectorAll('[data-attrid]');
    for (const row of attrRows) {
      const attrid = row.getAttribute('data-attrid') || '';
      if (attrid === 'title' || attrid.startsWith('wa:/description') || attrid.startsWith('kc:/collection')) continue;
      const label = attrid.split('/').pop() || attrid;
      const val = row.innerText.trim();
      if (label && val && !attributes[label]) {
        attributes[label] = val;
      }
    }

    result.knowledgePanel = { title, description, type, attributes };
  })();

  // -------------------------------------------------------------------------
  // People Also Ask (PAA)
  // Google uses a div with role="list" or individual divs with aria-expanded
  // for PAA accordions. Each item has a question text and expandable answer.
  // Stable: questions are in <span role="heading"> or direct text in the PAA container.
  // -------------------------------------------------------------------------
  (function extractPAA() {
    // PAA items have an expandable structure — each has a question that is clickable
    // They appear in a block container; questions are often in role="heading" spans
    // or just direct anchor/button elements with the question text.
    // Stable: [data-sgrd="true"] marks PAA blocks, or jsname="Cpkphb" / jsname="yEVEwb"
    // Fallback: look for details/summary pattern or divs with aria-expanded

    // Strategy 1: divs with aria-expanded="false" inside a PAA container
    const paaContainer = document.querySelector('[data-sgrd="true"]') ||
                         document.querySelector('[jscontroller][data-q]') || null;

    if (paaContainer) {
      const items = paaContainer.querySelectorAll('[jsname="Cpkphb"], [data-q]');
      for (const item of items) {
        const questionEl = item.querySelector('[role="heading"], h3, span[jsname]');
        const question = questionEl ? questionEl.innerText.trim() : item.getAttribute('data-q');
        if (!question) continue;

        // Answer is hidden in an expandable div — extract if pre-rendered
        const answerEl = item.querySelector('[jsname="dk1pb"] span, [data-tts-speakable] span, [jsname="yEVEwb"] span');
        const answer = answerEl ? answerEl.innerText.trim() : null;

        result.paa.push({ question, answer });
      }
    }

    // Strategy 2: elements with [aria-expanded] that look like PAA accordions
    if (result.paa.length === 0) {
      const expandables = document.querySelectorAll('[aria-expanded]');
      for (const el of expandables) {
        const parentText = el.innerText.trim();
        if (!parentText || parentText.length > 200) continue; // questions are short
        // Only add if it looks like a question (ends with ?)
        if (parentText.endsWith("?")) {
          result.paa.push({ question: parentText, answer: null });
        }
      }
    }
  })();

  // -------------------------------------------------------------------------
  // Local Pack
  // Google shows a map + business listings for local searches ("best pizza near me").
  // Each business has: name, address, rating, review count, category, hours, phone.
  // Stable: [data-cid] attribute on business result containers (very stable Google data attr).
  // Also: [data-local-attribute-universality-column] on listing rows.
  // -------------------------------------------------------------------------
  (function extractLocalPack() {
    // Local pack containers often have data-cid on the root element
    const businessCards = document.querySelectorAll('[data-cid]');
    for (const card of businessCards) {
      const name = getText(card, 'h3, [role="heading"], [aria-label]') ||
                   card.getAttribute('aria-label') || null;
      if (!name) continue;

      // Rating
      let rating = null;
      const ratingEl = card.querySelector('[aria-label*="stars"], [aria-label*="star"], [aria-label*="rated"]');
      if (ratingEl) {
        const ratingMatch = (ratingEl.getAttribute('aria-label') || '').match(/([\\d.]+)\\s*(?:stars?|out of)/i);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);
      }

      // Review count
      let reviewCount = null;
      const reviewEl = card.querySelector('[aria-label*="review"]');
      if (reviewEl) {
        const m = (reviewEl.getAttribute('aria-label') || reviewEl.innerText || '').match(/([\\d,]+)\\s+review/i);
        if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
      }

      // Address, category, phone, hours — look at all span/div text nodes
      const spans = Array.from(card.querySelectorAll('span, div')).filter(el =>
        el.children.length === 0 && el.innerText.trim().length > 0
      );
      const texts = spans.map(s => s.innerText.trim()).filter(Boolean);

      result.localPack.push({
        name,
        rating,
        reviewCount,
        attributes: texts.slice(0, 6), // first few text snippets (category, address, hours, phone)
      });
    }
  })();

  // -------------------------------------------------------------------------
  // Related Searches
  // Shown at the bottom: "People also search for" or "Related searches"
  // Stable: [role="list"] with link items, or elements with [data-q] attribute inside
  // the related-searches container, or "searches related to" heading followed by links.
  // -------------------------------------------------------------------------
  (function extractRelatedSearches() {
    // Strategy: find all links whose href goes to /search?q=... (related search links)
    // and are NOT part of organic results or PAA
    const seen = new Set();
    const relatedLinks = document.querySelectorAll('a[href^="/search?q="], a[href*="google.com/search?q="]');
    for (const a of relatedLinks) {
      const href = a.href;
      try {
        const u = new URL(href, window.location.origin);
        const q = u.searchParams.get('q');
        if (q && !seen.has(q) && q !== window.__searchQuery) {
          seen.add(q);
          result.relatedSearches.push(q);
        }
      } catch {}
    }
  })();

  // -------------------------------------------------------------------------
  // Ads (Sponsored results)
  // Google marks ads with aria-label="Ads" on a container, or with a "Sponsored" text label.
  // The ad cards have the same link structure as organic results.
  // Stable: look for text "Sponsored" inside a result block.
  // -------------------------------------------------------------------------
  (function extractAds() {
    // Find all elements that contain "Sponsored" text at leaf level
    const allLeafText = document.querySelectorAll('[aria-label="Ads"] a[href], [data-text-ad] a[href]');
    const seen = new Set();

    for (const a of allLeafText) {
      const url = resolveGoogleUrl(a.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      // Walk up to find the card container
      let card = a;
      for (let i = 0; i < 5; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        if (card.querySelectorAll('a[href]').length >= 2) break;
      }

      const titleEl = card.querySelector('[role="heading"], h3');
      const title = titleEl ? titleEl.innerText.trim() : a.innerText.trim();
      const descEl = Array.from(card.querySelectorAll('span, div')).find(el =>
        el.children.length === 0 && el.innerText.length > 50
      );
      const description = descEl ? descEl.innerText.trim() : null;

      result.ads.push({
        position: result.ads.length + 1,
        title,
        url,
        displayUrl: null,
        description,
      });
    }
  })();

  // -------------------------------------------------------------------------
  // News Tab results (tbm=nws)
  // -------------------------------------------------------------------------
  if (isNews) {
    const newsCards = document.querySelectorAll('[role="article"] a[href], article a[href][data-ved]');
    const seen = new Set();
    for (const a of newsCards) {
      const url = resolveGoogleUrl(a.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      // Find card container
      let card = a;
      for (let i = 0; i < 6; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        if (card.getAttribute('role') === 'article' || card.tagName === 'ARTICLE') break;
      }

      const titleEl = card.querySelector('[role="heading"], h3, h4');
      const title = titleEl ? titleEl.innerText.trim() : a.innerText.trim();
      const sourceEl = card.querySelector('time, [datetime]');
      const publishedAt = sourceEl ? (sourceEl.getAttribute('datetime') || sourceEl.innerText.trim()) : null;

      if (!title || result.organic.length >= maxResults) continue;

      result.organic.push({
        position: result.organic.length + 1,
        title,
        url,
        displayUrl: null,
        description: null,
        publishedAt,
        isAd: false,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Organic Results
  // Google's search result structure (as of 2024-2026):
  // Each result is in a <div> block that contains:
  //   - An <h3> with the page title (inside an <a> link to the actual URL)
  //   - A display URL span (breadcrumb-style: "example.com › page › subpage")
  //   - A description/snippet div
  //   - Optional sitelinks table/list
  //
  // Stable strategy:
  //   1. Find all <h3> elements that are inside an <a href> link pointing to an external URL
  //   2. For each h3-inside-a, walk up to find the result container
  //   3. Extract description from the container (longest non-title text block)
  //   4. Extract display URL from the citation/breadcrumb element
  //
  // This approach is robust because:
  //   - <h3> inside <a> is semantically meaningful and stable
  //   - The URL is always on the <a> wrapping the <h3>
  //   - We don't depend on any CSS class names at all
  // -------------------------------------------------------------------------
  const seen = new Set();
  const resultContainers = new Set();

  // Find all h3 elements inside anchor tags
  const h3Elements = document.querySelectorAll('h3');

  for (const h3 of h3Elements) {
    if (result.organic.length >= maxResults) break;

    const title = h3.innerText.trim();
    if (!title || title.length < 3) continue;

    // Find the nearest ancestor <a> with an href
    let anchor = h3.closest('a[href]');
    if (!anchor) {
      // h3 might be a sibling's child — look for the link
      const parent = h3.parentElement;
      if (parent) anchor = parent.querySelector('a[href]') || parent.closest('a[href]');
    }
    if (!anchor) continue;

    const rawHref = anchor.getAttribute('href') || '';
    const url = resolveGoogleUrl(rawHref.startsWith('http') ? rawHref : anchor.href);
    if (!url) continue;
    if (seen.has(url)) continue;

    // Skip Google-internal links and known non-result links
    if (
      url.includes('google.com/search') ||
      url.includes('google.com/maps') ||
      url.includes('google.com/preferences') ||
      url.includes('google.com/intl') ||
      url.includes('accounts.google') ||
      url.includes('support.google') ||
      url.includes('policies.google') ||
      url.includes('webcache.google')
    ) continue;

    seen.add(url);

    // Find the result container: walk up from h3 until we get a block that
    // has some structural complexity (multiple children, some text).
    // We stop when the container starts overlapping with other results.
    let container = h3;
    let containerDepth = 0;
    for (let i = 0; i < 12; i++) {
      if (!container.parentElement) break;
      const parent = container.parentElement;
      // Good containers have multiple direct children and span text
      if (parent.children.length >= 2 && parent.innerText.length > title.length + 20) {
        container = parent;
        containerDepth++;
        // Once we found a good container, don't go too much higher to avoid bleeding into neighbors
        if (containerDepth >= 3) break;
      } else {
        container = parent;
      }
    }

    // Skip if this container was already used by a previous result
    if (resultContainers.has(container)) continue;
    resultContainers.add(container);

    // --- Description ---
    // Find the longest text node that is not the title and not a URL-like string
    let description = null;
    const textNodes = container.querySelectorAll('span, div, p');
    let bestLen = 0;
    for (const node of textNodes) {
      if (node.children.length > 0) continue; // Only leaf nodes
      const text = node.innerText.trim();
      if (!text || text === title) continue;
      if (text.length < 20) continue; // Too short for a description
      // Skip URL-like text (display URL)
      if (text.match(/^[a-z0-9.-]+\\.\\w+/i) && !text.includes(' ')) continue;
      // Skip date-only text
      if (text.match(/^\\w+ \\d+, \\d{4}$/) || text.match(/^\\d+ \\w+ ago$/)) continue;
      if (text.length > bestLen && text.length <= 500) {
        bestLen = text.length;
        description = text;
      }
    }

    // --- Display URL ---
    // Google shows a breadcrumb-style citation URL like "example.com › page › subpage"
    // It's usually in a <cite> element or a span with › characters.
    let displayUrl = null;
    const citeEl = container.querySelector('cite');
    if (citeEl) {
      displayUrl = citeEl.innerText.trim();
    } else {
      // Look for a span with › (breadcrumb separator)
      const allSpans = container.querySelectorAll('span');
      for (const span of allSpans) {
        if (span.children.length === 0 && span.innerText.includes('›')) {
          displayUrl = span.innerText.trim();
          break;
        }
      }
    }

    // --- Sitelinks ---
    // Google sometimes shows sitelinks (sub-links to sections of the same site)
    // These are additional <a href> elements that point to subpages of the same domain
    const sitelinks = [];
    try {
      const domain = new URL(url).hostname;
      const subLinks = container.querySelectorAll('a[href]');
      for (const subA of subLinks) {
        if (subA === anchor) continue;
        const subUrl = resolveGoogleUrl(subA.href.startsWith('http') ? subA.href : null);
        if (!subUrl) continue;
        try {
          const subDomain = new URL(subUrl).hostname;
          if (subDomain === domain) {
            const subTitle = subA.innerText.trim();
            if (subTitle && subTitle.length > 1 && subTitle !== title) {
              sitelinks.push({ title: subTitle, url: subUrl });
            }
          }
        } catch {}
      }
    } catch {}

    // --- Check if it's an ad ---
    // Ads have a "Sponsored" label somewhere in their container
    const containerText = container.innerText || '';
    const isAd = containerText.includes('Sponsored') || containerText.includes('Ad ·');

    result.organic.push({
      position: result.organic.length + 1,
      title,
      url,
      displayUrl: displayUrl || null,
      description: description || null,
      sitelinks: sitelinks.length > 0 ? sitelinks : [],
      isAd,
    });
  }

  return result;
})
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const searchUrl = buildSearchUrl();
  log(`Query: "${query}"`);
  log(`URL: ${searchUrl}`);
  log(`Page: ${page}, Max results: ${maxResults}`);
  log(`Mode: ${newsTab ? "News" : imagesTab ? "Images" : "Web"}`);

  // Support SOCKS5 proxy via environment variable SOCKS5_PROXY=host:port or socks5://host:port
  // This is useful for routing traffic through a residential IP to bypass Google's bot detection.
  // On a VPN-routed machine, set up a local SOCKS5 proxy bound to the residential interface,
  // then set SOCKS5_PROXY=127.0.0.1:11080 (or whatever port the proxy listens on).
  const proxyEnv = process.env.SOCKS5_PROXY || null;
  const camoufoxOptions = {
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  };

  if (proxyEnv) {
    // Parse: accept "host:port" or "socks5://host:port"
    const proxyMatch = proxyEnv.match(/^(?:socks5?:\/\/)?([^:]+):(\d+)$/);
    if (proxyMatch) {
      const proxyHost = proxyMatch[1];
      const proxyPort = parseInt(proxyMatch[2], 10);
      log(`Using SOCKS5 proxy: ${proxyHost}:${proxyPort}`);
      // Use Firefox user prefs to configure SOCKS5 (more reliable than Playwright's proxy option)
      camoufoxOptions.firefox_user_prefs = {
        "network.proxy.type": 1,         // 1 = manual proxy
        "network.proxy.socks": proxyHost,
        "network.proxy.socks_port": proxyPort,
        "network.proxy.socks_version": 5,
        "network.proxy.socks_remote_dns": true,  // DNS via proxy too
        "network.proxy.no_proxies_on": "",
      };
    } else {
      log(`Warning: SOCKS5_PROXY format not recognized: ${proxyEnv} (expected host:port)`);
    }
  }

  const browser = await Camoufox(camoufoxOptions);

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Add Google consent cookies to skip consent page
    await context.addCookies([
      {
        name: "SOCS",
        value: "CAESEwgDEgk2NjM4NTQ5NDYaAmVuIAEaBgiAoJ-1Bg",
        domain: ".google.com",
        path: "/",
      },
      {
        name: "SOCS",
        value: "CAESEwgDEgk2NjM4NTQ5NDYaAmVuIAEaBgiAoJ-1Bg",
        domain: `.google.${country}`,
        path: "/",
      },
      // NID cookie helps Google identify returning "users" and reduces CAPTCHAs
      {
        name: "NID",
        value: "511=PzY5rF0k8v2R3M6Ty9X1QwLn4sUjP8dHgNa7e2BmCqW",
        domain: ".google.com",
        path: "/",
        httpOnly: true,
      },
    ]);

    const page_obj = await context.newPage();

    // Set extra headers to mimic a real browser
    await page_obj.setExtraHTTPHeaders({
      "Accept-Language": `${lang};q=0.9,en;q=0.8`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Warm up: visit Google homepage first to establish a session.
    // Going directly to /search from a cold browser is more suspicious.
    log("Warming up browser session (visiting Google homepage)...");
    try {
      await page_obj.goto(`${googleDomain}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await delay(2000 + Math.random() * 1000);
    } catch (warmupErr) {
      log(`Warmup visit failed (non-fatal): ${warmupErr.message}`);
    }

    log("Navigating to Google Search...");
    const response = await page_obj.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const status = response?.status();
    log(`HTTP Status: ${status}`);

    await delay(3000);

    const title = await page_obj.title();
    const currentUrl = page_obj.url();
    log(`Page title: ${title}`);
    log(`Current URL: ${currentUrl}`);

    // Check for CAPTCHA / unusual traffic page
    if (isCaptchaPage(title, currentUrl)) {
      log("CAPTCHA or unusual traffic page detected!");
      log("Google is blocking requests from this IP. Try:");
      log("  1. Use a residential proxy (set HTTP_PROXY env var)");
      log("  2. Wait and retry after a few minutes");
      log("  3. Use the Google Custom Search JSON API for automated requests");
      emitError("CAPTCHA_DETECTED", "Google blocked the request with CAPTCHA. Use a residential proxy or Google's official API.");
    }

    // Handle consent page (if SOCS cookie didn't work)
    if (title.toLowerCase().includes("consent") || currentUrl.includes("/consent") || currentUrl.includes("consent.google")) {
      log("Consent page detected, trying to accept...");
      try {
        // Try clicking "Accept all" button
        const acceptBtn = page_obj.locator('button:has-text("Accept all"), button:has-text("I agree"), [aria-label="Accept all"]');
        if (await acceptBtn.count() > 0) {
          await acceptBtn.first().click();
          await delay(2000);
          log("Clicked consent button");
        }
      } catch (err) {
        log("Could not click consent button:", err.message);
      }
      // Retry navigation after consent
      await page_obj.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(3000);
    }

    // Verify we have actual results
    const currentTitle = await page_obj.title();
    if (isCaptchaPage(currentTitle, page_obj.url())) {
      emitError("CAPTCHA_DETECTED", "Google blocked the request with CAPTCHA after consent handling.");
    }

    log("Extracting results from DOM...");

    // Store query in window for related search deduplication
    await page_obj.evaluate((q) => { window.__searchQuery = q; }, query);

    // Run extraction — playwright requires max 1 argument, so wrap in object
    // Build the evaluation function with EXTRACT_RESULTS_FN embedded as a string literal
    const extractFn = new Function(
      "args",
      `const { maxResults, isNews, isImages } = args; return (${EXTRACT_RESULTS_FN})(maxResults, isNews, isImages);`
    );
    const extracted = await page_obj.evaluate(
      extractFn,
      { maxResults, isNews: newsTab, isImages: imagesTab }
    );

    log(`\nExtraction results:`);
    log(`  Total results: ${extracted.totalResults}`);
    log(`  Organic: ${extracted.organic.length}`);
    log(`  Featured snippet: ${extracted.featuredSnippet ? "yes" : "no"}`);
    log(`  PAA questions: ${extracted.paa.length}`);
    log(`  Local pack: ${extracted.localPack.length}`);
    log(`  Knowledge panel: ${extracted.knowledgePanel ? "yes" : "no"}`);
    log(`  Related searches: ${extracted.relatedSearches.length}`);
    log(`  Ads: ${extracted.ads.length}`);

    // Filter PAA/related if disabled
    if (!includePaa) extracted.paa = [];
    if (!includeRelated) extracted.relatedSearches = [];

    // Post-process: deduplicate related searches, remove query itself
    const queryLower = query.toLowerCase();
    extracted.relatedSearches = [...new Set(extracted.relatedSearches)].filter(
      s => s.toLowerCase() !== queryLower
    );

    // Move ad results out of organic if incorrectly classified
    const organicOnly = extracted.organic.filter(r => !r.isAd);
    const adsFromOrganic = extracted.organic.filter(r => r.isAd);
    extracted.organic = organicOnly;
    extracted.ads = [...adsFromOrganic, ...extracted.ads].slice(0, 10);

    emitResult({
      query,
      totalResults: extracted.totalResults,
      timeTaken: extracted.timeTaken,
      page,
      resultCount: extracted.organic.length,
      organic: extracted.organic,
      featuredSnippet: extracted.featuredSnippet,
      paa: extracted.paa,
      localPack: extracted.localPack,
      knowledgePanel: extracted.knowledgePanel,
      relatedSearches: extracted.relatedSearches,
      ads: extracted.ads,
    });

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message + "\n" + err.stack);
});
