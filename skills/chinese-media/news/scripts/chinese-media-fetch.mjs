#!/usr/bin/env node
// chinese-media-fetch.mjs — Fetch Chinese English-language media (Xinhua, Global Times, People's Daily, CGTN, SCMP, MOFA).
//
// Tries RSS first, falls back to per-source HTML listing scraping when feeds are dead or stale.
// No auth required.
//
// Commands:
//   node chinese-media-fetch.mjs list
//   node chinese-media-fetch.mjs sources
//   node chinese-media-fetch.mjs latest <source> [N]
//   node chinese-media-fetch.mjs latest-all [N]
//   node chinese-media-fetch.mjs view <source>
//   node chinese-media-fetch.mjs search <keyword> [--source=slug]
//   node chinese-media-fetch.mjs add-rss <slug> "<name>" <rss-url>
//   node chinese-media-fetch.mjs remove-source <slug>
//   node chinese-media-fetch.mjs reset-sources
//
// Requires Node 22+ (built-in fetch).

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/chinese-media');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const SOURCES_FILE = resolve(DATA_DIR, 'sources.json');
const INDEX_FILE = resolve(CACHE_DIR, 'index.jsonl');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 chinese-media/1.0';
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Defaults — seeded to sources.json on first run
// ---------------------------------------------------------------------------

const DEFAULT_SOURCES = {
  xinhua: {
    name: 'Xinhua News Agency (English)',
    feeds: [
      { kind: 'rss', url: 'https://english.news.cn/rss/worldrs.xml' },
      { kind: 'rss', url: 'https://english.news.cn/rss/chinars.xml' },
    ],
    fallback: {
      kind: 'html',
      url: 'https://english.news.cn/',
      pattern: '/\\d{8}/[0-9a-f]{20,}/|/2\\d{3}-\\d{2}/\\d{2}/c_\\d+\\.htm',
    },
  },
  globaltimes: {
    name: 'Global Times',
    feeds: [
      { kind: 'rss', url: 'https://www.globaltimes.cn/rss/china.xml' },
      { kind: 'rss', url: 'https://www.globaltimes.cn/rss/opinion.xml' },
    ],
    fallback: {
      kind: 'html',
      url: 'https://www.globaltimes.cn/china/',
      pattern: '/page/\\d{6}/\\d+\\.shtml',
    },
  },
  peoplesdaily: {
    name: "People's Daily (English)",
    feeds: [
      { kind: 'rss', url: 'http://en.people.cn/rss/90000.xml' },
      { kind: 'rss', url: 'http://en.people.cn/rss/90780.xml' },
      { kind: 'rss', url: 'http://en.people.cn/rss/90777.xml' },
    ],
    fallback: {
      kind: 'html',
      url: 'http://en.people.cn/',
      pattern: '/n3/\\d{4}/\\d{4}/c\\d+-\\d+\\.html',
    },
  },
  cgtn: {
    name: 'CGTN',
    feeds: [
      { kind: 'rss', url: 'https://www.cgtn.com/subscribe/rss/section/world.xml' },
      { kind: 'rss', url: 'https://www.cgtn.com/subscribe/rss/section/china.xml' },
    ],
    fallback: {
      kind: 'html',
      url: 'https://www.cgtn.com/world',
      pattern: '/news/[0-9A-Za-z\\-]+/[A-Za-z0-9\\-]+-[A-Za-z0-9]+/index\\.html|/news/\\d{4}-\\d{2}-\\d{2}/',
    },
  },
  scmp: {
    name: 'South China Morning Post',
    feeds: [
      { kind: 'rss', url: 'https://www.scmp.com/rss/91/feed' },
      { kind: 'rss', url: 'https://www.scmp.com/rss/2/feed' },
      { kind: 'rss', url: 'https://www.scmp.com/rss/318198/feed' },
    ],
    fallback: {
      kind: 'html',
      url: 'https://www.scmp.com/news/china',
      pattern: '/news/(china|hong-kong|asia)/[a-z\\-]+/article/\\d+/',
    },
  },
  mofa: {
    name: 'China MOFA (Ministry of Foreign Affairs)',
    feeds: [
      { kind: 'rss', url: 'https://www.fmprc.gov.cn/eng/xw/zyxw/rss.xml' },
    ],
    fallback: {
      kind: 'html',
      url: 'https://www.fmprc.gov.cn/eng/xw/zyxw/',
      pattern: '/eng/.+/\\d{6}/t\\d+[_\\d]*\\.html',
    },
  },
};

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadSources() {
  ensureDir(DATA_DIR);
  if (!existsSync(SOURCES_FILE)) {
    saveJson(SOURCES_FILE, DEFAULT_SOURCES);
    return structuredClone(DEFAULT_SOURCES);
  }
  return loadJson(SOURCES_FILE, {});
}

function saveSources(sources) {
  saveJson(SOURCES_FILE, sources);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha1(s) {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}

function stableId(url, title) {
  return sha1(url || title || '');
}

function warn(msg) {
  process.stderr.write(`[warn] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// HTTP (with timeout)
// ---------------------------------------------------------------------------

async function httpGetOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // identity encoding avoids some CN servers' buggy chunked encoding
        'Accept-Encoding': 'identity',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    // Attempt to decode with charset from Content-Type; fetch() defaults to utf-8.
    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    return { text, ctype };
  } finally {
    clearTimeout(timer);
  }
}

// Retry once on network-termination errors (some CN servers — notably fmprc.gov.cn —
// send malformed chunked encoding that Node's fetch() cannot parse).
async function httpGet(url) {
  try {
    return await httpGetOnce(url);
  } catch (e) {
    const msg = e.message || '';
    const retriable = /terminated|ECONNRESET|ETIMEDOUT|socket hang up|aborted/i.test(msg);
    if (!retriable) throw e;
    await sleep(500);
    return await httpGetOnce(url);
  }
}

// ---------------------------------------------------------------------------
// HTML / entity handling
// ---------------------------------------------------------------------------

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&ldquo;': '"', '&rdquo;': '"',
  '&lsquo;': "'", '&rsquo;': "'", '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|ldquo|rdquo|lsquo|rsquo|mdash|ndash|hellip);|&#39;/g, (m) => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(s) {
  if (!s) return '';
  // Remove CDATA wrappers first
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// RSS / Atom parser (regex-based, handles RSS 2.0 and Atom)
// ---------------------------------------------------------------------------

function extractTagText(xml, tagName) {
  // match <tag ...>content</tag>, allow CDATA inside
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return stripHtml(m[1]);
}

function extractAllTagTexts(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const txt = stripHtml(m[1]);
    if (txt) out.push(txt);
  }
  return out;
}

function extractLinkFromItem(itemXml) {
  // 1) <link>url</link>
  const m1 = itemXml.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (m1 && m1[1].trim().startsWith('http')) return m1[1].trim();
  // 2) Atom: <link href="..."/>
  const m2 = itemXml.match(/<link[^>]*href="([^"]+)"/i);
  if (m2) return m2[1];
  // 3) <guid isPermaLink="true">url</guid>
  const m3 = itemXml.match(/<guid[^>]*>([^<]+)<\/guid>/i);
  if (m3 && m3[1].trim().startsWith('http')) return m3[1].trim();
  return '';
}

function parseRss(xmlText) {
  // Strip BOM and leading whitespace
  xmlText = xmlText.replace(/^\uFEFF/, '').trimStart();
  if (!xmlText.includes('<rss') && !xmlText.includes('<feed') && !xmlText.includes('<?xml')) {
    throw new Error('not XML');
  }
  const out = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const body = m[2];
    const title = extractTagText(body, 'title');
    const link = extractLinkFromItem(body);
    const desc =
      extractTagText(body, 'description') ||
      extractTagText(body, 'summary') ||
      extractTagText(body, 'content');
    const pub =
      extractTagText(body, 'pubDate') ||
      extractTagText(body, 'published') ||
      extractTagText(body, 'updated') ||
      extractTagText(body, 'dc:date');
    const cats = extractAllTagTexts(body, 'category');
    if (!title && !link) continue;
    out.push({
      id: stableId(link, title),
      url: link,
      title,
      published: pub,
      summary: (desc || '').slice(0, 400),
      categories: cats,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML listing parser
// ---------------------------------------------------------------------------

function absolutize(base, href) {
  if (!href) return '';
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  const rootMatch = base.match(/(https?:\/\/[^/]+)/);
  const root = rootMatch ? rootMatch[1] : '';
  let full;
  if (href.startsWith('/')) {
    full = root + href;
  } else {
    while (href.startsWith('./')) href = href.slice(2);
    full = base.replace(/\/$/, '') + '/' + href;
  }
  return full.replace(/\/\.\//g, '/');
}

function extractLinks(html) {
  // <a href="..." [attrs]>text</a>
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = stripHtml(m[2]);
    if (href && text) out.push({ href, text });
  }
  return out;
}

function parseHtmlListing(html, baseUrl, pattern) {
  const links = extractLinks(html);
  const re = pattern ? new RegExp(pattern) : null;
  const seen = new Set();
  const stories = [];
  for (const { href, text } of links) {
    const full = absolutize(baseUrl, href);
    if (!full.startsWith('http')) continue;
    if (re && !re.test(full)) continue;
    if (text.length < 15) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    stories.push({
      id: stableId(full, text),
      url: full,
      title: text,
      published: '',
      summary: '',
      categories: [],
    });
  }
  return stories;
}

// ---------------------------------------------------------------------------
// Source fetching
// ---------------------------------------------------------------------------

async function fetchSource(slug, cfg) {
  const errors = [];
  let stories = [];
  for (const feed of cfg.feeds || []) {
    try {
      const { text, ctype } = await httpGet(feed.url);
      if (feed.kind === 'rss') {
        if (!text.includes('<rss') && !text.includes('<feed') && !text.includes('<?xml')) {
          errors.push(`${feed.url} -> not XML (ctype=${ctype})`);
          warn(`${slug}: ${feed.url} did not return XML`);
          continue;
        }
        try {
          const items = parseRss(text);
          stories.push(...items);
        } catch (e) {
          errors.push(`${feed.url} -> parse error: ${e.message}`);
          warn(`${slug}: ${feed.url} parse failed: ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`${feed.url} -> ${e.message}`);
      warn(`${slug}: ${feed.url} failed: ${e.message}`);
    }
  }
  if (stories.length === 0 && cfg.fallback) {
    try {
      const { text } = await httpGet(cfg.fallback.url);
      stories = parseHtmlListing(text, cfg.fallback.url, cfg.fallback.pattern);
      if (stories.length === 0) {
        errors.push(`fallback ${cfg.fallback.url} -> no articles matched`);
      }
    } catch (e) {
      errors.push(`fallback ${cfg.fallback.url} -> ${e.message}`);
      warn(`${slug}: fallback ${cfg.fallback.url} failed: ${e.message}`);
    }
  }
  // dedupe by id, preserve order
  const seen = new Set();
  const deduped = [];
  for (const s of stories) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }
  return { stories: deduped, errors };
}

function saveSource(slug, cfg, stories) {
  const sdir = resolve(CACHE_DIR, slug);
  ensureDir(sdir);
  const path = resolve(sdir, 'latest.json');
  const payload = {
    fetched_at: nowIso(),
    source: slug,
    source_name: cfg.name,
    count: stories.length,
    data: stories,
  };
  saveJson(path, payload);
  return path;
}

function appendIndex(slug, cfg, stories) {
  ensureDir(CACHE_DIR);
  const ts = nowIso();
  const lines = stories.map((s) =>
    JSON.stringify({ fetched_at: ts, source: slug, source_name: cfg.name, ...s }),
  );
  if (lines.length) appendFileSync(INDEX_FILE, lines.join('\n') + '\n');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function fmtStory(s) {
  const title = (s.title || '').slice(0, 120);
  const pub = (s.published || '').slice(0, 25);
  const url = s.url || '';
  const summary = (s.summary || '').slice(0, 180);
  let out = `- ${title}\n    ${pub}  ${url}`;
  if (summary) out += `\n    ${summary}`;
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const sources = loadSources();
  const entries = Object.entries(sources);
  console.log(`Configured Chinese media sources (${entries.length}):\n`);
  for (const [slug, cfg] of entries) {
    const path = resolve(CACHE_DIR, slug, 'latest.json');
    let status = 'never fetched';
    if (existsSync(path)) {
      const blob = loadJson(path, {});
      status = `last=${blob.fetched_at}  stories=${blob.count}`;
    }
    console.log(`  ${slug.padEnd(14)} ${status}`);
    console.log(`      ${cfg.name}`);
  }
  console.log(`\nConfig: ${SOURCES_FILE}`);
  console.log(`Cache:  ${CACHE_DIR}`);
}

function cmdSources() {
  const sources = loadSources();
  console.log('Configured Chinese media sources:\n');
  for (const [slug, cfg] of Object.entries(sources)) {
    console.log(`  ${slug.padEnd(14)} ${cfg.name}`);
    for (const feed of cfg.feeds || []) {
      console.log(`                  [${feed.kind}] ${feed.url}`);
    }
    if (cfg.fallback) {
      console.log(`                  [fallback ${cfg.fallback.kind}] ${cfg.fallback.url}`);
    }
    console.log();
  }
}

async function cmdLatest(slug, n) {
  const sources = loadSources();
  if (!sources[slug]) {
    console.log(`Unknown source '${slug}'. Try: ${Object.keys(sources).join(', ')}`);
    process.exit(2);
  }
  const cfg = sources[slug];
  const { stories, errors } = await fetchSource(slug, cfg);
  const limit = Number(n) || 15;
  const kept = stories.slice(0, limit);
  const path = saveSource(slug, cfg, kept);
  appendIndex(slug, cfg, kept);
  console.log(`${cfg.name}: ${kept.length} stories -> ${path}`);
  if (errors.length && kept.length === 0) {
    console.log('  errors:');
    for (const e of errors) console.log(`    ! ${e}`);
  }
  console.log();
  for (const s of kept) {
    console.log(fmtStory(s));
    console.log();
  }
}

async function cmdLatestAll(n) {
  const sources = loadSources();
  const results = {};
  const entries = Object.entries(sources);
  const limit = Number(n) || 15;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) await sleep(1000);
    const [slug, cfg] = entries[i];
    let stories = [];
    let errors = [];
    try {
      ({ stories, errors } = await fetchSource(slug, cfg));
    } catch (e) {
      warn(`${slug}: unexpected error: ${e.message}`);
      errors = [e.message];
    }
    const kept = stories.slice(0, limit);
    saveSource(slug, cfg, kept);
    appendIndex(slug, cfg, kept);
    results[slug] = { stories: kept, errors };
    console.log(`[${slug}] ${kept.length} stories`);
  }

  console.log('\n=== Summary ===\n');
  for (const [slug, { stories, errors }] of Object.entries(results)) {
    const cfg = sources[slug];
    const status = stories.length ? 'OK  ' : 'FAIL';
    console.log(`${status}  ${slug.padEnd(14)} ${String(stories.length).padStart(3)}  ${cfg.name}`);
    if (!stories.length && errors.length) {
      for (const e of errors.slice(0, 3)) console.log(`        ! ${e}`);
    }
  }

  console.log('\n=== Sample headlines ===\n');
  for (const [slug, { stories }] of Object.entries(results)) {
    if (!stories.length) continue;
    console.log(`## ${sources[slug].name} (${slug})`);
    for (const s of stories.slice(0, 3)) console.log(fmtStory(s));
    console.log();
  }
}

function cmdView(slug) {
  if (!slug) throw new Error('view requires <source>');
  const path = resolve(CACHE_DIR, slug, 'latest.json');
  if (!existsSync(path)) {
    console.log(`No cache for ${slug}. Run: latest ${slug}`);
    return;
  }
  const blob = loadJson(path, {});
  console.log(`${blob.source_name} (${slug})`);
  console.log(`fetched_at=${blob.fetched_at}  count=${blob.count}\n`);
  for (const s of blob.data || []) {
    console.log(fmtStory(s));
    console.log();
  }
}

function* iterIndex() {
  if (!existsSync(INDEX_FILE)) return;
  const content = readFileSync(INDEX_FILE, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function cmdSearch(q, flags) {
  if (!q) throw new Error('search requires <keyword>');
  const ql = q.toLowerCase();
  // dedupe by id, keep newest fetched_at
  const byId = new Map();
  for (const r of iterIndex()) {
    if (flags.source && r.source !== flags.source) continue;
    const existing = byId.get(r.id);
    if (!existing || (r.fetched_at || '') > (existing.fetched_at || '')) {
      byId.set(r.id, r);
    }
  }
  const rows = Array.from(byId.values());
  const matches = rows.filter((r) => {
    const hay = [
      r.title || '',
      r.summary || '',
      (r.categories || []).join(' '),
    ].join(' ').toLowerCase();
    return hay.includes(ql);
  });
  matches.sort((a, b) => (b.fetched_at || '').localeCompare(a.fetched_at || ''));
  console.log(
    `Found ${matches.length} cached stories matching "${q}"${flags.source ? ` in ${flags.source}` : ''} (across ${rows.length} unique):\n`,
  );
  for (const r of matches.slice(0, 40)) {
    const title = (r.title || '').slice(0, 120);
    const pub = (r.published || '').slice(0, 25);
    const url = r.url || '';
    const summary = (r.summary || '').slice(0, 200);
    console.log(`- [${r.source}] ${title}`);
    console.log(`    ${pub}  ${url}`);
    if (summary) console.log(`    ${summary}`);
    console.log();
  }
}

function cmdAddRss(slug, name, url) {
  if (!slug || !name || !url) {
    throw new Error('add-rss requires <slug> "<name>" <rss-url>');
  }
  const sources = loadSources();
  if (sources[slug]) {
    console.log(`! ${slug} already exists; overwriting feed list`);
  }
  sources[slug] = {
    name,
    feeds: [{ kind: 'rss', url }],
  };
  saveSources(sources);
  console.log(`+ added RSS source: ${slug}`);
  console.log(`  ${name}`);
  console.log(`  ${url}`);
  console.log(`  (run 'latest ${slug}' to pull)`);
}

function cmdRemoveSource(slug) {
  if (!slug) throw new Error('remove-source requires <slug>');
  const sources = loadSources();
  if (!(slug in sources)) {
    console.log(`  ${slug} not configured`);
    return;
  }
  delete sources[slug];
  saveSources(sources);
  console.log(`- removed source: ${slug}`);
}

function cmdResetSources() {
  saveSources(structuredClone(DEFAULT_SOURCES));
  console.log(`sources.json reset to defaults (${Object.keys(DEFAULT_SOURCES).length} sources)`);
  console.log(`  ${SOURCES_FILE}`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage() {
  console.log(`chinese-media-fetch — Chinese English-language media scraper

Commands:
  list                              Show sources + last-fetch status
  sources                           Show sources with feed URLs
  latest <source> [N]               Fetch latest N stories from one source (default 15)
  latest-all [N]                    Fetch latest from every source, 1s between
  view <source>                     Print cached latest without re-fetching
  search <keyword> [--source=slug]  Search cached index
  add-rss <slug> "<name>" <url>     Add a simple RSS source
  remove-source <slug>              Remove a source from config
  reset-sources                     Restore default sources

Data: ${DATA_DIR}
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  try {
    switch (cmd) {
      case undefined:
      case 'list':          cmdList(); break;
      case 'sources':       cmdSources(); break;
      case 'latest':        await cmdLatest(positional[0], positional[1]); break;
      case 'latest-all':    await cmdLatestAll(positional[0]); break;
      case 'view':          cmdView(positional[0]); break;
      case 'search':        cmdSearch(positional.join(' '), flags); break;
      case 'add-rss':       cmdAddRss(positional[0], positional[1], positional[2]); break;
      case 'remove-source': cmdRemoveSource(positional[0]); break;
      case 'reset-sources': cmdResetSources(); break;
      case 'help':
      case '-h':
      case '--help':        usage(); break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        usage();
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
