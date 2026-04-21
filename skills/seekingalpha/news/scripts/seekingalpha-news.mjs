#!/usr/bin/env node
// seekingalpha-news.mjs — Market news, breaking news, trending articles from Seeking Alpha
//
// Setup:   node seekingalpha-news.mjs auth
// Usage:   node seekingalpha-news.mjs latest --count=25
//          node seekingalpha-news.mjs latest --category=crypto --count=10
//          node seekingalpha-news.mjs categories
//          node seekingalpha-news.mjs trending --count=10
//          node seekingalpha-news.mjs breaking
//          node seekingalpha-news.mjs top-stories
//          node seekingalpha-news.mjs for-ticker AAPL --count=12
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/seekingalpha-news');
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
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
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
  if (!userCookieKey) console.warn('Warning: user_cookie_key not found. Account-specific endpoints may not work.');

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
    console.error('No auth found. Run: node seekingalpha-news.mjs auth');
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
      console.error('Session expired or blocked. Run: node seekingalpha-news.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://seekingalpha.com/api/v3';

// All known news categories for filter[category]=market-news::<slug>
const NEWS_CATEGORIES = {
  'all':             'All news',
  'top-news':        'Top news',
  'on-the-move':     'On the move (stocks making moves)',
  'technology':      'Technology',
  'crypto':          'Cryptocurrency',
  'earnings':        'Earnings',
  'commodities':     'Commodities',
  'politics':        'Politics',
  'ipos':            'IPOs',
  'm-a':             'Mergers & Acquisitions',
  'us-economy':      'US Economy',
  'healthcare':      'Healthcare',
  'energy':          'Energy',
  'spacs':           'SPACs',
  'reits':           'REITs',
  'financials':      'Financials',
  'consumer':        'Consumer',
  'gold':            'Gold',
  'dividend-stocks': 'Dividend stocks',
};

function resolveCategory(input) {
  if (!input || input === 'all') return 'all';
  const key = input.toLowerCase();
  if (NEWS_CATEGORIES[key]) return key;
  // Try matching by partial name or alias
  const aliases = {
    'tech': 'technology', 'biotech': 'healthcare', 'bio': 'healthcare',
    'mergers': 'm-a', 'acquisitions': 'm-a', 'ma': 'm-a',
    'economy': 'us-economy', 'macro': 'us-economy',
    'dividends': 'dividend-stocks', 'dividend': 'dividend-stocks',
    'reit': 'reits', 'spac': 'spacs', 'ipo': 'ipos',
    'stocks-moving': 'on-the-move', 'movers': 'on-the-move',
    'top': 'top-news', 'finance': 'financials',
    'commodity': 'commodities', 'oil': 'commodities',
    'health': 'healthcare', 'pharma': 'healthcare',
  };
  if (aliases[key]) return aliases[key];
  throw new Error(`Unknown category: "${input}". Run: node seekingalpha-news.mjs categories`);
}

function parseTicker(input) {
  // Accept URLs like https://seekingalpha.com/symbol/AAPL or plain tickers
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

function snippet(html, maxLen = 200) {
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

// ---------------------------------------------------------------------------
// API: Latest Market News
// ---------------------------------------------------------------------------

async function fetchLatest(auth, count = 25, page = 1, category = 'all') {
  const catSlug = resolveCategory(category);
  const catLabel = NEWS_CATEGORIES[catSlug] || catSlug;
  const logLabel = catSlug === 'all' ? 'latest market' : catLabel;
  console.log(`Fetching ${logLabel} news (page ${page}, count ${count})...`);
  const url = `${API_BASE}/news?` + [
    'fields[news]=title,date,comment_count,content,disclosure,primaryTickers,secondaryTickers,tag,gettyImageUrl,publishOn',
    'fields[tag]=slug,name',
    `filter[category]=market-news::${catSlug}`,
    'filter[since]=0',
    'filter[until]=0',
    'include=primaryTickers,secondaryTickers',
    `page[size]=${count}`,
    `page[number]=${page}`,
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const tickers = resolveTickers(item.relationships, included);
    return {
      id: item.id,
      title: attrs.title || '',
      publishedAt: attrs.publishOn || attrs.date || null,
      content: snippet(attrs.content),
      commentCount: attrs.comment_count || 0,
      tickers,
      imageUrl: attrs.gettyImageUrl || null,
      url: `https://seekingalpha.com/news/${item.id}`,
    };
  });

  const result = { command: 'latest', category: catSlug, page, count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `latest-${catSlug}-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Trending Articles
// ---------------------------------------------------------------------------

async function fetchTrending(auth, count = 25, page = 1) {
  console.log(`Fetching trending articles (page ${page}, count ${count})...`);
  const url = `${API_BASE}/news/trending?` + [
    `page[size]=${count}`,
    `page[number]=${page}`,
    'include=author',
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => {
    const attrs = item.attributes || {};
    const links = item.links || {};

    // Resolve author from included
    const authorRef = item.relationships?.author?.data;
    const authorInc = authorRef ? included[`${authorRef.type}:${authorRef.id}`] : null;

    return {
      id: item.id,
      title: attrs.title || '',
      author: authorInc?.attributes?.nick || null,
      imageUrl: links.uriImage || null,
      url: links.self ? `https://seekingalpha.com${links.self}` : `https://seekingalpha.com/news/${item.id}`,
    };
  });

  const result = { command: 'trending', page, count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `trending-p${page}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Breaking News
// ---------------------------------------------------------------------------

async function fetchBreaking(auth) {
  console.log('Fetching breaking news...');
  const url = `${API_BASE}/breaking_news`;
  const { data } = await apiFetch(auth, url);

  // breaking_news may return a single item or a list
  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);

  const headlines = items.map(item => {
    const attrs = item.attributes || {};
    return {
      id: item.id,
      type: item.type || null,
      title: attrs.title || attrs.headline || '',
      url: attrs.uri ? `https://seekingalpha.com${attrs.uri}` : `https://seekingalpha.com/news/${item.id}`,
    };
  });

  const result = { command: 'breaking', count: headlines.length, headlines };

  const cacheFile = resolve(CACHE_DIR, 'breaking.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Top Stories (Leading News Stories)
// ---------------------------------------------------------------------------

async function fetchTopStories(auth) {
  console.log('Fetching top stories...');
  const url = `${API_BASE}/leading_news_stories`;
  const { data } = await apiFetch(auth, url);

  const items = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);

  const stories = items.map(item => {
    const attrs = item.attributes || {};
    return {
      id: item.id,
      title: attrs.headline || attrs.title || '',
      type: attrs.type || null,
      url: attrs.url || (attrs.uri ? `https://seekingalpha.com${attrs.uri}` : null),
    };
  });

  const sectionTitle = data.meta?.title || null;
  const result = { command: 'top-stories', sectionTitle, count: stories.length, stories };

  const cacheFile = resolve(CACHE_DIR, 'top-stories.json');
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: News for Ticker
// ---------------------------------------------------------------------------

async function fetchForTicker(auth, ticker, count = 12, page = 1) {
  console.log(`Fetching news for ${ticker.toUpperCase()} (page ${page}, count ${count})...`);
  const url = `${API_BASE}/symbols/${ticker}/news?` + [
    'filter[category]=news_card',
    'filter[until]=0',
    'include=author,primaryTickers,secondaryTickers,sentiments,otherTags',
    `page[size]=${count}`,
    `page[number]=${page}`,
  ].join('&');

  const { data } = await apiFetch(auth, url);
  const included = buildIncludedLookup(data);

  const articles = (data.data || []).map(item => {
    const attrs = item.attributes || {};

    // Resolve author
    const authorRef = item.relationships?.author?.data;
    const authorInc = authorRef ? included[`${authorRef.type}:${authorRef.id}`] : null;

    const tickers = resolveTickers(item.relationships, included);

    return {
      id: item.id,
      title: attrs.title || '',
      publishedAt: attrs.publishOn || attrs.publish_on || attrs.date || null,
      content: snippet(attrs.content),
      commentCount: attrs.comment_count || 0,
      source: attrs.source || null,
      author: authorInc?.attributes?.nick || authorInc?.attributes?.slug || null,
      tickers,
      uri: attrs.uri || null,
      url: attrs.uri ? `https://seekingalpha.com${attrs.uri}` : `https://seekingalpha.com/news/${item.id}`,
    };
  });

  const result = { command: 'for-ticker', ticker: ticker.toUpperCase(), page, count: articles.length, articles };

  const cacheFile = resolve(CACHE_DIR, `${ticker}-news-p${page}.json`);
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
      const count = parseInt(flags.count || '25', 10);
      const page = parseInt(flags.page || '1', 10);
      const category = flags.category || 'all';
      const result = await fetchLatest(getAuth(), count, page, category);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'categories': {
      const result = {
        command: 'categories',
        count: Object.keys(NEWS_CATEGORIES).length,
        categories: Object.entries(NEWS_CATEGORIES).map(([slug, description]) => ({
          slug,
          description,
          usage: `node seekingalpha-news.mjs latest --category=${slug}`,
        })),
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'trending': {
      const count = parseInt(flags.count || '25', 10);
      const page = parseInt(flags.page || '1', 10);
      const result = await fetchTrending(getAuth(), count, page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'breaking': {
      const result = await fetchBreaking(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'top-stories': {
      const result = await fetchTopStories(getAuth());
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'for-ticker': {
      const tickerArg = positional[0];
      if (!tickerArg) { console.error('Usage: seekingalpha-news.mjs for-ticker <ticker> [--count=12] [--page=1]'); process.exit(1); }
      const ticker = parseTicker(tickerArg);
      const count = parseInt(flags.count || '12', 10);
      const page = parseInt(flags.page || '1', 10);
      const result = await fetchForTicker(getAuth(), ticker, count, page);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'seekingalpha-news.mjs';
      const catList = Object.entries(NEWS_CATEGORIES).map(([k, v]) => `    ${k.padEnd(18)} ${v}`).join('\n');
      console.log(`
seekingalpha-news — Market news, breaking news, trending articles from Seeking Alpha

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} latest [--count=25] [--page=1]    Latest market news
       [--category=all]                             Filter by category (see below)
  node ${script} categories                        List all available categories
  node ${script} trending [--count=25] [--page=1]  Trending articles
  node ${script} breaking                          Current breaking news headlines
  node ${script} top-stories                       Leading news stories
  node ${script} for-ticker <ticker>               News for a specific ticker
       [--count=12] [--page=1]

Categories (use with --category):
${catList}

Ticker formats:
  AAPL                                             Plain ticker symbol
  aapl                                             Case-insensitive
  https://seekingalpha.com/symbol/AAPL             URL format

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
