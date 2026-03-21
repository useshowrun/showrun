#!/usr/bin/env node
/**
 * Hacker News Stories Scraper
 *
 * Fetches stories, comments, and job listings from Hacker News.
 *
 * Data Sources:
 *   1. Official HN Firebase API: https://hacker-news.firebaseio.com/v0/
 *      - topstories, newstories, beststories, askstories, showstories, jobstories
 *      - Full item details with comments
 *   2. Algolia HN Search API: https://hn.algolia.com/api/v1/
 *      - Keyword search with full-text search support
 *      - Search by relevance or date
 *      - Supports pagination, date filters
 *
 * Usage:
 *   node hn-stories.mjs [options]
 *
 * Options:
 *   --type top|new|best|ask|show|job
 *                          Story type (default: top)
 *   --max <N>              Max stories to return (default: 30)
 *   --query <text>         Search by keyword (uses Algolia API)
 *   --sort relevance|date  Sort order for search (default: relevance)
 *   --tags story|comment|ask_hn|show_hn|job
 *                          Filter by type in search (default: story)
 *   --comments             Include top-level comments for each story
 *   --max-comments <N>     Max comments per story (default: 10)
 *   --min-score <N>        Minimum points/score filter
 *   --since <date>         Filter stories created after date (YYYY-MM-DD)
 *   --until <date>         Filter stories created before date (YYYY-MM-DD)
 *
 * Examples:
 *   node hn-stories.mjs --max 20
 *   node hn-stories.mjs --type new --max 10
 *   node hn-stories.mjs --type ask --max 15 --comments
 *   node hn-stories.mjs --query "rust programming" --max 20
 *   node hn-stories.mjs --query "openai" --sort date --max 30
 *   node hn-stories.mjs --type top --max 30 --min-score 100
 *   node hn-stories.mjs --type job --max 20
 *
 * Output:
 *   RESULT:{json} on stdout
 *   Logs on stderr
 */

import https from "https";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

function emitError(code, message) {
  process.stdout.write(
    "RESULT:" + JSON.stringify({ error: true, code, message }) + "\n"
  );
  process.exit(1);
}

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let storyType = "top";
let maxStories = 30;
let searchQuery = null;
let sortOrder = "relevance";
let searchTags = "story";
let includeComments = false;
let maxComments = 10;
let minScore = null;
let since = null;
let until = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--type" && args[i + 1]) storyType = args[++i];
  else if (a === "--max" && args[i + 1]) maxStories = parseInt(args[++i], 10);
  else if (a === "--query" && args[i + 1]) searchQuery = args[++i];
  else if (a === "--sort" && args[i + 1]) sortOrder = args[++i];
  else if (a === "--tags" && args[i + 1]) searchTags = args[++i];
  else if (a === "--comments") includeComments = true;
  else if (a === "--max-comments" && args[i + 1]) maxComments = parseInt(args[++i], 10);
  else if (a === "--min-score" && args[i + 1]) minScore = parseInt(args[++i], 10);
  else if (a === "--since" && args[i + 1]) since = args[++i];
  else if (a === "--until" && args[i + 1]) until = args[++i];
}

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

function fetchJson(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HN-Scraper/1.0)",
        Accept: "application/json",
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve({ ok: true, data: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, error: "JSON parse error", raw: data.substring(0, 200) });
          }
        } else {
          resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      if (retries > 0) {
        log(`[WARN] Timeout fetching ${url}, retrying...`);
        fetchJson(url, retries - 1).then(resolve).catch(reject);
      } else {
        resolve({ ok: false, error: "Timeout" });
      }
    });

    req.on("error", (e) => {
      if (retries > 0) {
        delay(1000).then(() => fetchJson(url, retries - 1).then(resolve).catch(reject));
      } else {
        resolve({ ok: false, error: e.message });
      }
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parallel fetch with concurrency limit
// ---------------------------------------------------------------------------

async function fetchParallel(urls, concurrency = 10) {
  const results = new Array(urls.length);
  let index = 0;

  const worker = async () => {
    while (index < urls.length) {
      const i = index++;
      results[i] = await fetchJson(urls[i]);
    }
  };

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// HN Firebase API
// ---------------------------------------------------------------------------

const HN_BASE = "https://hacker-news.firebaseio.com/v0";

const STORY_TYPE_ENDPOINTS = {
  top: `${HN_BASE}/topstories.json`,
  new: `${HN_BASE}/newstories.json`,
  best: `${HN_BASE}/beststories.json`,
  ask: `${HN_BASE}/askstories.json`,
  show: `${HN_BASE}/showstories.json`,
  job: `${HN_BASE}/jobstories.json`,
};

function formatItem(raw) {
  if (!raw || raw.dead || raw.deleted) return null;

  const id = raw.id;
  const type = raw.type || "story";
  const score = raw.score || 0;
  const time = raw.time;
  const createdAt = time ? new Date(time * 1000).toISOString() : null;

  // For stories
  const storyUrl = raw.url || (id ? `https://news.ycombinator.com/item?id=${id}` : null);
  const hnUrl = id ? `https://news.ycombinator.com/item?id=${id}` : null;

  // Strip HTML from text
  const stripHtml = (html) => {
    if (!html) return null;
    return html
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
      .replace(/<p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, "/")
      .replace(/&#x60;/g, "`")
      .replace(/&#x3D;/g, "=")
      .trim();
  };

  return {
    id,
    type,
    title: raw.title || null,
    url: type === "story" ? (raw.url || hnUrl) : hnUrl,
    hnUrl,
    externalUrl: raw.url || null,
    author: raw.by || null,
    score,
    commentCount: raw.descendants || 0,
    commentIds: raw.kids || [],
    text: stripHtml(raw.text),
    createdAt,
    timestamp: time,
    dead: raw.dead || false,
    deleted: raw.deleted || false,
  };
}

function formatComment(raw) {
  if (!raw || raw.dead || raw.deleted) return null;

  const stripHtml = (html) => {
    if (!html) return null;
    return html
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
      .replace(/<p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, "/")
      .replace(/&#x60;/g, "`")
      .replace(/&#x3D;/g, "=")
      .trim();
  };

  return {
    id: raw.id,
    parent: raw.parent,
    author: raw.by || null,
    text: stripHtml(raw.text),
    createdAt: raw.time ? new Date(raw.time * 1000).toISOString() : null,
    timestamp: raw.time,
    replyCount: (raw.kids || []).length,
  };
}

// ---------------------------------------------------------------------------
// Fetch stories from Firebase API
// ---------------------------------------------------------------------------

async function fetchStoriesByType() {
  const endpoint = STORY_TYPE_ENDPOINTS[storyType];
  if (!endpoint) {
    emitError("INVALID_TYPE", `Unknown story type: ${storyType}. Valid: ${Object.keys(STORY_TYPE_ENDPOINTS).join(", ")}`);
  }

  log(`[INFO] Fetching ${storyType} story IDs...`);
  const idResult = await fetchJson(endpoint);
  if (!idResult.ok) {
    emitError("FETCH_ERROR", `Failed to fetch story IDs: ${idResult.error}`);
  }

  let ids = idResult.data || [];
  log(`[INFO] Total ${storyType} stories available: ${ids.length}`);

  // Apply max limit (fetch slightly more to account for filtering)
  const fetchCount = Math.min(ids.length, maxStories + 10);
  ids = ids.slice(0, fetchCount);

  // Fetch all story details in parallel
  log(`[INFO] Fetching ${fetchCount} story details...`);
  const urls = ids.map((id) => `${HN_BASE}/item/${id}.json`);
  const itemResults = await fetchParallel(urls, 15);

  const stories = [];
  for (const result of itemResults) {
    if (!result.ok || !result.data) continue;
    const item = formatItem(result.data);
    if (!item || item.dead || item.deleted) continue;
    if (minScore !== null && item.score < minScore) continue;
    if (since) {
      const sinceTs = new Date(since).getTime() / 1000;
      if (item.timestamp < sinceTs) continue;
    }
    if (until) {
      const untilTs = new Date(until).getTime() / 1000;
      if (item.timestamp > untilTs) continue;
    }
    stories.push(item);
    if (stories.length >= maxStories) break;
  }

  return stories;
}

// ---------------------------------------------------------------------------
// Algolia HN Search API
// ---------------------------------------------------------------------------

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1";

async function fetchStoriesBySearch() {
  const stories = [];
  let page = 0;

  while (stories.length < maxStories) {
    const hitsPerPage = Math.min(20, maxStories - stories.length);
    const endpoint = sortOrder === "date" ? "search_by_date" : "search";
    
    const params = new URLSearchParams({
      query: searchQuery,
      tags: searchTags,
      hitsPerPage: String(hitsPerPage),
      page: String(page),
    });

    // Date filters
    if (since || until) {
      const filters = [];
      if (since) {
        const sinceTs = Math.floor(new Date(since).getTime() / 1000);
        filters.push(`created_at_i>${sinceTs}`);
      }
      if (until) {
        const untilTs = Math.floor(new Date(until).getTime() / 1000);
        filters.push(`created_at_i<${untilTs}`);
      }
      params.set("numericFilters", filters.join(","));
    }

    // Score filter
    if (minScore !== null) {
      const scoreFilter = `points>=${minScore}`;
      const existing = params.get("numericFilters");
      params.set("numericFilters", existing ? `${existing},${scoreFilter}` : scoreFilter);
    }

    const url = `${ALGOLIA_BASE}/${endpoint}?${params.toString()}`;
    log(`[INFO] Searching (page ${page}): ${url}`);
    
    const result = await fetchJson(url);
    if (!result.ok) {
      emitError("SEARCH_ERROR", `Algolia search failed: ${result.error}`);
    }

    const hits = result.data.hits || [];
    log(`[INFO] Got ${hits.length} hits (total: ${result.data.nbHits})`);

    if (hits.length === 0) break;

    for (const hit of hits) {
      const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      stories.push({
        id: parseInt(hit.objectID, 10),
        type: hit._tags?.find((t) => ["story", "comment", "job"].includes(t)) || "story",
        title: hit.title || null,
        url: hit.url || hnUrl,
        hnUrl,
        externalUrl: hit.url || null,
        author: hit.author || null,
        score: hit.points || 0,
        commentCount: hit.num_comments || 0,
        commentIds: hit.children || [],
        text: null, // Algolia doesn't return full text
        createdAt: hit.created_at || null,
        timestamp: hit.created_at_i || null,
        dead: false,
        deleted: false,
      });
    }

    const totalPages = result.data.nbPages || 0;
    if (page >= totalPages - 1 || stories.length >= maxStories) break;
    
    page++;
    await delay(200);
  }

  return stories.slice(0, maxStories);
}

// ---------------------------------------------------------------------------
// Fetch comments for a story
// ---------------------------------------------------------------------------

async function fetchComments(story) {
  if (!story.commentIds || story.commentIds.length === 0) return [];
  
  const topLevelIds = story.commentIds.slice(0, maxComments);
  const urls = topLevelIds.map((id) => `${HN_BASE}/item/${id}.json`);
  const results = await fetchParallel(urls, 10);
  
  const comments = [];
  for (const result of results) {
    if (!result.ok || !result.data) continue;
    const comment = formatComment(result.data);
    if (comment) comments.push(comment);
  }
  
  return comments;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let stories;

  if (searchQuery) {
    log(`[INFO] Searching HN for: "${searchQuery}" (sort: ${sortOrder})`);
    stories = await fetchStoriesBySearch();
  } else {
    log(`[INFO] Fetching ${storyType} stories...`);
    stories = await fetchStoriesByType();
  }

  log(`[INFO] Got ${stories.length} stories`);

  // Optionally fetch comments
  if (includeComments && stories.length > 0) {
    log(`[INFO] Fetching comments (max ${maxComments} per story)...`);
    for (const story of stories) {
      story.comments = await fetchComments(story);
      await delay(100); // Be polite
    }
  }

  const result = {
    type: searchQuery ? "search" : storyType,
    query: searchQuery || null,
    sort: searchQuery ? sortOrder : null,
    filters: {
      minScore: minScore || null,
      since: since || null,
      until: until || null,
    },
    totalLoaded: stories.length,
    stories,
    scrapedAt: new Date().toISOString(),
  };

  emitResult(result);
}

main().catch((err) => {
  emitError("SCRAPER_ERROR", String(err.message || err));
});
