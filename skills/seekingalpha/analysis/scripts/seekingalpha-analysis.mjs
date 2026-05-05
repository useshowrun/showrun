#!/usr/bin/env node
// seekingalpha-analysis.mjs — Expert analysis articles, author metrics, and saved articles from Seeking Alpha
//
// Setup:   node seekingalpha-analysis.mjs auth
// Usage:   node seekingalpha-analysis.mjs latest --count=10
//          node seekingalpha-analysis.mjs latest --category=dividends --count=10
//          node seekingalpha-analysis.mjs categories
//          node seekingalpha-analysis.mjs for-ticker AAPL --count=10
//          node seekingalpha-analysis.mjs top-authors --count=15
//          node seekingalpha-analysis.mjs saved --count=10
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-analysis');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}
function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// CDP integration
// ---------------------------------------------------------------------------

function findCdpScript() {
  const here = dirname(new URL(import.meta.url).pathname);
  const ancestorCandidates = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    ancestorCandidates.push(resolve(dir, 'skills/chrome-cdp/scripts/cdp.mjs'));
    ancestorCandidates.push(resolve(dir, 'chrome-cdp/scripts/cdp.mjs'));
    dir = resolve(dir, '..');
  }
  const candidates = [
    process.env.SHOWRUN_ROOT ? resolve(process.env.SHOWRUN_ROOT, 'skills/chrome-cdp/scripts/cdp.mjs') : null,
    ...ancestorCandidates,
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
  ].filter(Boolean);
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.'); })();
}
function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Seeking Alpha tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('seekingalpha.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No Seeking Alpha tab found. Open seekingalpha.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://seekingalpha.com'] }));
  const { cookies } = JSON.parse(raw);

  // Build full cookie string — PerimeterX cookies are needed
  const cookieStr = cookies
    .filter(c => c.domain.includes('seekingalpha.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to Seeking Alpha?');

  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
  const userCookieKey = cookieMap['user_cookie_key'] || null;
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints (saved) may not work.');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    userCookieKey,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node seekingalpha-analysis.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function apiFetch(auth, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(auth), ...options.headers },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node seekingalpha-analysis.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

// Available analysis article categories (filter[category] values)
const CATEGORIES = {
  'latest-articles':     { label: 'Latest Articles',       description: 'All latest analysis articles' },
  'top-ideas':           { label: 'Top Ideas',             description: 'High-conviction long or short with asymmetric risk/reward profiles' },
  'editors-picks':       { label: "Editors' Picks",        description: 'The most compelling stock analysis hand-picked by editors' },
  'stock-ideas':         { label: 'Stock Ideas',           description: 'Long and short stock investment ideas' },
  'dividends':           { label: 'Dividends',             description: 'High dividend stock ideas, research and analysis' },
  'etfs-and-funds':      { label: 'ETFs & Funds',          description: 'ETF evaluation, mutual and closed-end fund research' },
  'market-outlook':      { label: 'Market Outlook',        description: 'Stock market outlook, forecasts and macro analysis' },
  'investing-strategy':  { label: 'Investing Strategy',    description: 'Investing strategies and techniques for all market scenarios' },
  'trending':            { label: 'Trending',              description: 'Currently trending analysis articles' },
};

// Short aliases for convenience (e.g. --category=etfs resolves to etfs-and-funds)
const CATEGORY_ALIASES = {
  'latest':      'latest-articles',
  'top':         'top-ideas',
  'editors':     'editors-picks',
  'picks':       'editors-picks',
  'stocks':      'stock-ideas',
  'etfs':        'etfs-and-funds',
  'etf':         'etfs-and-funds',
  'funds':       'etfs-and-funds',
  'macro':       'market-outlook',
  'outlook':     'market-outlook',
  'strategy':    'investing-strategy',
};

function resolveCategory(input) {
  if (!input) return 'latest-articles';
  const key = input.toLowerCase();
  if (CATEGORIES[key]) return key;
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  const matches = Object.keys(CATEGORIES).filter(k => k.includes(key));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous category "${input}". Matches: ${matches.join(', ')}`);
    console.error('Run: node seekingalpha-analysis.mjs categories');
    process.exit(1);
  }
  console.error(`Unknown category "${input}". Run: node seekingalpha-analysis.mjs categories`);
  process.exit(1);
}

function parseTicker(input) {
  const urlMatch = input.match(/seekingalpha\.com\/symbol\/([^\s/?#]+)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return input.toLowerCase();
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function snippet(html, maxLen = 300) {
  const text = stripHtml(html);
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

function buildIncludedLookup(data) {
  const lookup = {};
  for (const inc of (data.included || [])) {
    lookup[`${inc.type}:${inc.id}`] = inc;
  }
  return lookup;
}

function resolveTickers(relationships, included) {
  const tickers = [];
  for (const key of ['primaryTickers', 'secondaryTickers']) {
    const refs = relationships?.[key]?.data;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const inc = included[`${ref.type}:${ref.id}`];
        const slug = inc?.attributes?.slug || inc?.attributes?.name || ref.id;
        tickers.push(slug.toUpperCase());
      }
    }
  }
  return tickers.length ? tickers : null;
}

function resolveAuthor(relationships, included) {
  const authorRef = relationships?.author?.data;
  if (!authorRef) return null;
  const authorInc = included[`${authorRef.type}:${authorRef.id}`];
  if (!authorInc) return null;
  const attrs = authorInc.attributes || {};
  return {
    id: authorInc.id,
    name: attrs.nick || attrs.slug || null,
    slug: attrs.slug || null,
    url: attrs.slug ? `https://seekingalpha.com/author/${attrs.slug}` : null,
  };
}

function resolveSentiment(article, relationships, included) {
  // Sentiment can come from structuredInsights or sentiments relationship
  const attrs = article.attributes || {};

  // Check structuredInsights first
  const insights = attrs.structuredInsights;
  if (insights) {
    if (typeof insights === 'object') {
      if (insights.sentiment) return insights.sentiment;
      if (insights.thesis) return insights.thesis;
    }
  }

  // Check sentiments from relationships/included
  // Sentiment objects have: attributes.type ("bullish"/"bearish"/etc)
  // and relationships.tag.data -> tag in included with the ticker slug
  const sentimentRefs = relationships?.sentiments?.data;
  if (Array.isArray(sentimentRefs) && sentimentRefs.length > 0) {
    const sentiments = [];
    for (const ref of sentimentRefs) {
      const inc = included[`${ref.type}:${ref.id}`];
      if (inc?.attributes) {
        // Resolve ticker from sentiment's tag relationship
        const tagRef = inc.relationships?.tag?.data;
        if (!tagRef) continue;
        const tagInc = included[`${tagRef.type}:${tagRef.id}`];
        // Skip sentiments whose tag isn't in included (non-ticker tags like sectors)
        if (!tagInc?.attributes) continue;
        const ticker = (tagInc.attributes.name || tagInc.attributes.slug || tagRef.id).toUpperCase();
        sentiments.push({
          ticker,
          sentiment: inc.attributes.type || null,
        });
      }
    }
    if (sentiments.length) return sentiments;
  }

  return null;
}

function parseArticle(item, included) {
  const attrs = item.attributes || {};
  const tickers = resolveTickers(item.relationships, included);
  const author = resolveAuthor(item.relationships, included);
  const sentiment = resolveSentiment(item, item.relationships, included);

  return {
    id: item.id,
    title: attrs.title || '',
    author,
    publishedAt: attrs.publishOn || attrs.publish_on || attrs.date || null,
    summary: snippet(attrs.summary || attrs.content || ''),
    sentiment,
    primaryTickers: tickers,
    commentCount: attrs.commentCount || attrs.comment_count || 0,
    isRead: attrs.isRead || false,
    url: item.links?.self
      ? `https://seekingalpha.com${item.links.self}`
      : `https://seekingalpha.com/article/${item.id}`,
  };
}

// ---------------------------------------------------------------------------
// API: Analysis Articles (by category)
// ---------------------------------------------------------------------------

async function fetchLatest(auth, count = 10, page = 1, category = 'latest-articles') {
  const catInfo = CATEGORIES[category] || { label: category };
  console.log(`Fetching ${catInfo.label} (page ${page}, count ${count})...`);
  const url = `${API_BASE}/articles?` + [
    'fields[article]=structuredInsights,publishOn,author,commentCount,title,primaryTickers,secondaryTickers,summary,isRead,sentiments',
    `filter[category]=${category}`,
    'filter[since]=0',
    'filter[until]=0',
    'include=author,primaryTickers,secondaryTickers,sentiments',
    `page[size]=${count}`,
    `page[number]=${page}`,
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => parseArticle(item, included));

  const totalArticles = data.meta?.page?.total ?? null;
  const result = { command: 'latest', category, categoryLabel: catInfo.label, page, count: articles.length, totalArticles, articles };

  const cacheFile = resolve(CACHE_DIR, `${category}-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Analysis for Specific Ticker
// ---------------------------------------------------------------------------

async function fetchForTicker(auth, ticker, count = 10, page = 1) {
  console.log(`Fetching analysis for ${ticker.toUpperCase()} (page ${page}, count ${count})...`);
  const url = `${API_BASE}/symbols/${ticker}/analysis?` + [
    'filter[until]=0',
    'filter[related]=false',
    'include=author,primaryTickers,secondaryTickers,sentiments',
    `page[size]=${count}`,
    `page[number]=${page}`,
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => parseArticle(item, included));

  const result = { command: 'for-ticker', ticker: ticker.toUpperCase(), page, count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-analysis-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top Authors / Analysts
// ---------------------------------------------------------------------------

async function fetchTopAuthors(auth, count = 15) {
  console.log(`Fetching top authors (count ${count})...`);
  const url = `${API_BASE}/author_metrics?per_page=${count}&include=author`;

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);

  const authors = items.map(item => {
    const attrs = item.attributes || {};

    // Resolve author details from included via relationship
    const authorRef = item.relationships?.author?.data;
    let name = null, slug = null, followersCount = null;
    if (authorRef) {
      const authorInc = included[`${authorRef.type}:${authorRef.id}`];
      if (authorInc?.attributes) {
        name = authorInc.attributes.nick || authorInc.attributes.slug || null;
        slug = authorInc.attributes.slug || null;
        followersCount = authorInc.attributes.followersCount ?? null;
      }
    }

    // Extract picks summary
    const picks = (attrs.picks || []).map(p => ({
      ticker: (p.slug || '').toUpperCase(),
      rating: p.rating || null,
      pickDate: p.pick_date || null,
      holdingReturn: p.holding_return ?? null,
      articleTitle: p.article_title || null,
    }));

    return {
      id: authorRef?.id || item.id,
      name,
      slug,
      averageReturn: attrs.averageReturn ?? null,
      successRate: attrs.successRate ?? null,
      followersCount,
      picksCount: picks.length,
      picks,
      url: slug ? `https://seekingalpha.com/author/${slug}` : null,
    };
  });

  const result = { command: 'top-authors', count: authors.length, authors };

  const cacheFile = resolve(CACHE_DIR, 'top-authors.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Saved / Bookmarked Articles
// ---------------------------------------------------------------------------

async function fetchSaved(auth, count = 10, page = 1) {
  if (!auth.userCookieKey) {
    throw new Error('user_cookie_key not available. Re-run auth while logged in to Seeking Alpha.');
  }

  console.log(`Fetching saved articles (page ${page}, count ${count})...`);
  const url = `${API_BASE}/saved_headlines?` + [
    'include=author,primaryTickers,secondaryTickers',
    `page[size]=${count}`,
    `page[number]=${page}`,
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => parseArticle(item, included));

  const result = { command: 'saved', page, count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `saved-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] || '';
const { flags, positional } = parseFlags(args.slice(1));

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'latest': {
      const count = parseInt(flags.count || '10', 10);
      const page = parseInt(flags.page || '1', 10);
      const category = resolveCategory(flags.category || 'latest-articles');
      const result = await fetchLatest(getAuth(), count, page, category);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'categories': {
      const result = {
        command: 'categories',
        count: Object.keys(CATEGORIES).length,
        categories: Object.entries(CATEGORIES).map(([slug, info]) => ({
          slug,
          label: info.label,
          description: info.description,
          aliases: Object.entries(CATEGORY_ALIASES)
            .filter(([, v]) => v === slug)
            .map(([k]) => k),
        })),
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'for-ticker': {
      const tickerArg = positional[0];
      if (!tickerArg) { console.error('Usage: seekingalpha-analysis.mjs for-ticker <ticker> [--count=10] [--page=1]'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const count = parseInt(flags.count || '10', 10);
      const page = parseInt(flags.page || '1', 10);
      const result = await fetchForTicker(getAuth(), ticker, count, page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'top-authors': {
      const count = parseInt(flags.count || '15', 10);
      const result = await fetchTopAuthors(getAuth(), count);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'saved': {
      const count = parseInt(flags.count || '10', 10);
      const page = parseInt(flags.page || '1', 10);
      const result = await fetchSaved(getAuth(), count, page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-analysis.mjs';
      console.log(`
seekingalpha-analysis — Expert analysis articles, author metrics, and saved articles from Seeking Alpha

Setup:
  node ${script} auth                                  Extract cookies from Chrome

Commands:
  node ${script} latest [--count=10] [--page=1]        Latest analysis articles
       [--category=<category>]                          Filter by category (see 'categories')
  node ${script} categories                             List all available categories
  node ${script} for-ticker <ticker>                   Analysis for a specific ticker
       [--count=10] [--page=1]
  node ${script} top-authors [--count=15]              Top performing authors/analysts
  node ${script} saved [--count=10] [--page=1]         Your saved/bookmarked articles

Categories (use with --category):
  latest-articles    All latest analysis (default)
  top-ideas          High-conviction ideas
  editors-picks      Editor-curated picks
  stock-ideas        Long and short stock ideas
  dividends          Dividend stock analysis
  etfs-and-funds     ETF and fund research
  market-outlook     Market forecasts and macro
  investing-strategy Investing strategies
  trending           Currently trending articles

Ticker formats:
  AAPL                                                 Plain ticker symbol
  aapl                                                 Case-insensitive
  https://seekingalpha.com/symbol/AAPL                 URL format

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
