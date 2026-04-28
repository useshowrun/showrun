#!/usr/bin/env node
// polymarket-markets.mjs — Fetch Polymarket prediction-market data via the public Gamma API.
//
// No auth required. Uses https://gamma-api.polymarket.com/ (free, public).
//
// Commands:
//   node polymarket-markets.mjs top [N]
//   node polymarket-markets.mjs search <keyword>
//   node polymarket-markets.mjs tags
//   node polymarket-markets.mjs tag <tag-id> [N]
//   node polymarket-markets.mjs events <keyword>
//   node polymarket-markets.mjs market <market-id>
//
// Requires Node 22+ (built-in fetch).

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/polymarket');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const ALL_ACTIVE_FILE = resolve(CACHE_DIR, 'all-active.json');

const API_BASE = 'https://gamma-api.polymarket.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 polymarket-skill/1.0';
const TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PAGE_SIZE = 500;
const MAX_OFFSET = 3000;

// Tag keywords we consider "relevant" for `tags` command — matches the Python filter.
const TAG_KEYWORDS = ['iran', 'middle', 'trump', 'ai', 'artif', 'turkey', 'israel', 'tech', 'job', 'geopol'];

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

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function warn(msg) {
  process.stderr.write(`[warn] ${msg}\n`);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Save raw JSON with metadata wrapper (mirrors Python save_json).
function saveSnapshot(name, payload) {
  const path = resolve(CACHE_DIR, `${name}.json`);
  saveJson(path, {
    fetched_at: nowIso(),
    count: Array.isArray(payload) ? payload.length : 1,
    data: payload,
  });
  return path;
}

// ---------------------------------------------------------------------------
// HTTP — the Gamma API requires a User-Agent header or returns 403.
// ---------------------------------------------------------------------------

async function apiGet(path) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Formatting — mirrors Python fmt_market exactly.
// ---------------------------------------------------------------------------

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function marketVolume(m) {
  return toNumber(m.volumeNum) || toNumber(m.volume);
}

function fmtUsd(n) {
  // "$1,234,567" — no decimals, grouped thousands.
  return '$' + Math.round(n).toLocaleString('en-US');
}

function parseMaybeJsonArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x !== 'string' || !x) return [];
  try {
    const v = JSON.parse(x);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function fmtMarket(m) {
  const q = (m.question || '?').slice(0, 85);
  const vol = marketVolume(m);
  const end = (m.endDate || '').slice(0, 10);
  const active = m.active;
  const closed = m.closed;
  let pairs = '';
  try {
    const outcomes = parseMaybeJsonArray(m.outcomes);
    const prices = parseMaybeJsonArray(m.outcomePrices);
    const parts = [];
    for (let i = 0; i < Math.min(outcomes.length, prices.length); i++) {
      const pct = (toNumber(prices[i]) * 100).toFixed(0);
      parts.push(`${outcomes[i]}=${pct}%`);
    }
    pairs = parts.join(' | ');
  } catch {
    pairs = '';
  }
  return `- ${q}\n    vol=${fmtUsd(vol)}  end=${end}  active=${active} closed=${closed}\n    ${pairs}`;
}

// ---------------------------------------------------------------------------
// All-active cache (TTL 30 min) — paginates through every active market.
// ---------------------------------------------------------------------------

async function fetchAllActive() {
  if (existsSync(ALL_ACTIVE_FILE)) {
    try {
      const blob = loadJson(ALL_ACTIVE_FILE, null);
      if (blob && blob.fetched_at) {
        const ageMs = Date.now() - Date.parse(blob.fetched_at);
        if (ageMs >= 0 && ageMs < CACHE_TTL_MS && Array.isArray(blob.data)) {
          return blob.data;
        }
      }
    } catch (e) {
      warn(`all-active cache unreadable: ${e.message}`);
    }
  }

  const all = [];
  let offset = 0;
  while (true) {
    const url = `/markets?active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`;
    let chunk;
    try {
      chunk = await apiGet(url);
    } catch (e) {
      warn(`pagination failed at offset=${offset}: ${e.message}`);
      break;
    }
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset > MAX_OFFSET) break;
  }
  saveSnapshot('all-active', all);
  return all;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdTop(limitArg) {
  const limit = Number(limitArg) || 20;
  // Fetch a big batch and sort client-side (Gamma's `order=volumeNum` is unreliable).
  const url = `/markets?active=true&closed=false&limit=500&order=volumeNum&ascending=false`;
  const data = await apiGet(url);
  if (!Array.isArray(data)) throw new Error('unexpected API response (not an array)');
  data.sort((a, b) => marketVolume(b) - marketVolume(a));
  const top = data.slice(0, limit);
  const path = saveSnapshot('top-by-volume', top);
  console.log(`Top ${limit} active markets by volume (of ${data.length}) -> ${path}\n`);
  for (const m of top) {
    console.log(fmtMarket(m));
    console.log();
  }
}

async function cmdSearch(q) {
  if (!q) throw new Error('search requires <keyword>');
  const all = await fetchAllActive();
  const ql = q.toLowerCase();
  const matches = all.filter((m) => (m.question || '').toLowerCase().includes(ql));
  matches.sort((a, b) => marketVolume(b) - marketVolume(a));
  const slug = slugify(q);
  const path = saveSnapshot(`search-${slug}`, matches);
  console.log(`Found ${matches.length} markets matching "${q}" in ${all.length} active -> ${path}\n`);
  for (const m of matches.slice(0, 25)) {
    console.log(fmtMarket(m));
    console.log();
  }
}

async function cmdTags() {
  const data = await apiGet('/tags?limit=200');
  if (!Array.isArray(data)) throw new Error('unexpected API response (not an array)');
  saveSnapshot('tags', data);
  const filtered = data.filter((t) => {
    const label = (t.label || '').toLowerCase();
    const slug = (t.slug || '').toLowerCase();
    const hay = label + ' ' + slug;
    return TAG_KEYWORDS.some((k) => hay.includes(k));
  });
  console.log(`Relevant tags (${filtered.length} of ${data.length}) — filter: ${TAG_KEYWORDS.join(', ')}\n`);
  for (const t of filtered) {
    console.log(`  id=${t.id} label=${t.label} slug=${t.slug}`);
  }
}

async function cmdTag(tagId, limitArg) {
  if (!tagId) throw new Error('tag requires <tag-id>');
  const limit = Number(limitArg) || 20;
  const url = `/markets?active=true&closed=false&limit=${limit}&order=volume&ascending=false&tag_id=${encodeURIComponent(tagId)}`;
  const data = await apiGet(url);
  if (!Array.isArray(data)) throw new Error('unexpected API response (not an array)');
  const path = saveSnapshot(`tag-${slugify(tagId)}`, data);
  console.log(`Top ${data.length} markets for tag ${tagId} -> ${path}\n`);
  for (const m of data) {
    console.log(fmtMarket(m));
    console.log();
  }
}

async function cmdEvents(q, limitArg) {
  if (!q) throw new Error('events requires <keyword>');
  const limit = Number(limitArg) || 50;
  const url = `/events?active=true&closed=false&limit=${limit}&order=volume&ascending=false`;
  const data = await apiGet(url);
  if (!Array.isArray(data)) throw new Error('unexpected API response (not an array)');
  const ql = q.toLowerCase();
  const matches = data.filter((e) => {
    const title = (e.title || '').toLowerCase();
    const desc = (e.description || '').toLowerCase();
    return title.includes(ql) || desc.includes(ql);
  });
  const path = saveSnapshot(`events-${slugify(q)}`, matches);
  console.log(`Found ${matches.length} events matching "${q}" in ${data.length} -> ${path}\n`);
  for (const e of matches) {
    const title = (e.title || '?').slice(0, 100);
    const vol = toNumber(e.volume);
    const end = (e.endDate || '').slice(0, 10);
    console.log(`- ${title}`);
    console.log(`    vol=${fmtUsd(vol)}  end=${end}  id=${e.id}`);
    const children = Array.isArray(e.markets) ? e.markets.slice(0, 6) : [];
    for (const m of children) {
      const indented = fmtMarket(m).replace(/\n/g, '\n      ');
      console.log(`    · ${indented}`);
    }
    console.log();
  }
}

async function cmdMarket(marketId) {
  if (!marketId) throw new Error('market requires <market-id>');
  // Gamma supports /markets/<id> for numeric ids; for slug we fall back to query filter.
  let data;
  try {
    data = await apiGet(`/markets/${encodeURIComponent(marketId)}`);
  } catch (e) {
    warn(`direct /markets/${marketId} failed (${e.message}); trying query`);
    const list = await apiGet(`/markets?slug=${encodeURIComponent(marketId)}`);
    data = Array.isArray(list) && list.length ? list[0] : null;
  }
  if (!data) {
    console.log(`No market found for id/slug '${marketId}'`);
    process.exit(2);
  }
  const path = saveSnapshot(`market-${slugify(marketId)}`, data);
  console.log(`Market ${marketId} -> ${path}\n`);
  console.log(fmtMarket(data));
  console.log();
  // Extra detail — show raw fields that fmtMarket drops.
  const extras = [];
  if (data.slug) extras.push(`slug=${data.slug}`);
  if (data.id) extras.push(`id=${data.id}`);
  if (data.conditionId) extras.push(`conditionId=${data.conditionId}`);
  if (data.startDate) extras.push(`start=${String(data.startDate).slice(0, 10)}`);
  if (extras.length) console.log(`    ${extras.join('  ')}`);
  if (data.description) {
    const desc = String(data.description).replace(/\s+/g, ' ').slice(0, 400);
    console.log(`    ${desc}`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing / main
// ---------------------------------------------------------------------------

function usage() {
  console.log(`polymarket-markets — Polymarket prediction-market fetcher (Gamma API)

Commands:
  top [N]                   Top N active markets by volume (default 20)
  search <keyword>          Keyword search across all active markets (30-min cache)
  tags                      List tags matching built-in geopolitical/tech keyword filter
  tag <tag-id> [N]          Top N markets for a given tag id
  events <keyword>          Search events (groups of related markets)
  market <market-id>        Single market detail (id or slug)

Data: ${DATA_DIR}
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case undefined:
      case 'top':     await cmdTop(rest[0]); break;
      case 'search':  await cmdSearch(rest[0]); break;
      case 'tags':    await cmdTags(); break;
      case 'tag':     await cmdTag(rest[0], rest[1]); break;
      case 'events':  await cmdEvents(rest[0], rest[1]); break;
      case 'market':  await cmdMarket(rest[0]); break;
      case 'help':
      case '-h':
      case '--help':  usage(); break;
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
