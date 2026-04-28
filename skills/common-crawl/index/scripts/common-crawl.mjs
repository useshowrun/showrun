#!/usr/bin/env node
// common-crawl.mjs — Common Crawl Index API wrapper.
//
// Endpoints (no auth, public):
//   GET https://index.commoncrawl.org/collinfo.json
//   GET https://index.commoncrawl.org/<crawl-id>-index?url=<url>&output=json[&matchType=...&limit=...&from=...&to=...]
//   GET https://data.commoncrawl.org/<filename>          (with Range header for WARC slice)
//
// Commands:
//   crawls [N]                               — list latest N crawls
//   search <url> [--crawl=...] [--match=...] [--limit=...]
//   latest <url> [--match=...]               — search the latest crawl, summary
//   history <url> [--limit-crawls=N]         — captures across last N crawls
//   domain-count <domain>                    — distinct URL count for *.<domain> in latest crawl
//   fetch <crawl-id> <filename> <offset> <length>  — base64 of gzipped WARC record

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/common-crawl');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const COLLINFO = 'https://index.commoncrawl.org/collinfo.json';
const INDEX_BASE = 'https://index.commoncrawl.org';
const WARC_BASE = 'https://data.commoncrawl.org';
const USER_AGENT = 'common-crawl-skill/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 1500;
const RETRY_DELAYS_MS = [3000, 6000, 12000];

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function httpGet(url, { accept = 'application/json', headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': accept, ...headers },
        signal: ctrl.signal,
      });
    } catch (e) { lastErr = e; res = null; }
    finally { clearTimeout(t); }
    if (!res) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}`);
    }
    if (res.ok || res.status === 206) return res;
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
    }
    throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

async function getJson(url) {
  const res = await httpGet(url, { accept: 'application/json' });
  const text = await res.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0,200)}`); }
}

// CDX endpoints return NDJSON (one JSON object per line).
async function getNdjson(url) {
  const res = await httpGet(url, { accept: 'application/x-ndjson, application/json' });
  const text = await res.text();
  if (!text.trim()) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip bad/truncated line */ }
  }
  return out;
}

function buildIndexUrl(crawlId, params) {
  const u = new URL(`${INDEX_BASE}/${crawlId}-index`);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  return u.toString();
}

function applyMatch(target, match) {
  // Common Crawl matchType values: exact, prefix, host, domain
  // For matchType=domain, supplying a bare hostname works. Strip schemes for safety.
  let s = String(target).trim();
  if (match === 'domain' || match === 'host') {
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return s;
}

let _crawlsCache = null;
async function listCrawls() {
  if (_crawlsCache) return _crawlsCache;
  const cacheFile = resolve(CACHE_DIR, 'collinfo.json');
  // Cache for 1 hour
  if (existsSync(cacheFile)) {
    const stats = readFileSync(cacheFile, 'utf8');
    try {
      const parsed = JSON.parse(stats);
      if (parsed?.fetched_at && Date.now() - Date.parse(parsed.fetched_at) < 3600_000) {
        _crawlsCache = parsed.crawls;
        return _crawlsCache;
      }
    } catch {}
  }
  const arr = await getJson(COLLINFO);
  if (!Array.isArray(arr)) throw new Error('collinfo.json did not return an array');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), crawls: arr });
  _crawlsCache = arr;
  return arr;
}

// Extract YYYY-WW from a CC-MAIN-YYYY-WW id and approximate calendar date.
function crawlDate(id) {
  const m = /CC-MAIN-(\d{4})-(\d{2})/.exec(id || '');
  if (!m) return '?';
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  // ISO-week-ish approximation (Jan 1 + 7*(week-1))
  const d = new Date(Date.UTC(year, 0, 1 + 7 * (week - 1)));
  return d.toISOString().slice(0, 10);
}

// Get the total number of pages for a query (uses showNumPages=true).
async function getNumPages(crawlId, params) {
  const url = buildIndexUrl(crawlId, { ...params, output: 'json', showNumPages: 'true' });
  // showNumPages returns a single JSON object (not NDJSON): {pages, pageSize, blocks}
  try {
    const res = await httpGet(url, { accept: 'application/json' });
    const text = await res.text();
    if (!text.trim()) return { pages: 0, pageSize: 0 };
    // Handle either a JSON object or NDJSON-style first line
    const firstLine = text.split(/\r?\n/).find(l => l.trim());
    return JSON.parse(firstLine);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return { pages: 0, pageSize: 0 };
    throw e;
  }
}

// Fetch all records across pages for a query.
async function searchAll(crawlId, params, { hardCap = 200_000 } = {}) {
  const meta = await getNumPages(crawlId, params);
  const pages = meta.pages || 0;
  if (!pages) return { records: [], pages: 0, pageSize: meta.pageSize || 0 };
  const all = [];
  for (let p = 0; p < pages; p++) {
    const url = buildIndexUrl(crawlId, { ...params, output: 'json', page: p });
    let records;
    try { records = await getNdjson(url); }
    catch (e) {
      // One retry already inside httpGet. Skip page on persistent failure.
      console.error(`[warn] page ${p} failed: ${e.message.slice(0,120)}`);
      continue;
    }
    all.push(...records);
    if (all.length >= hardCap) break;
  }
  return { records: all, pages, pageSize: meta.pageSize || 0 };
}

// Exact capture count by walking all pages and tallying NDJSON records.
// `pageSize` from showNumPages is "blocks per page" (large), not "records per page",
// so we must actually fetch each page to count records. Caps at hardCap to be safe.
async function countCaptures(crawlId, params, { hardCap = 1_000_000 } = {}) {
  const meta = await getNumPages(crawlId, params);
  const pages = meta.pages || 0;
  if (!pages) return { total: 0, pages: 0, pageSize: meta.pageSize || 0, capped: false };
  let total = 0;
  let capped = false;
  for (let p = 0; p < pages; p++) {
    const url = buildIndexUrl(crawlId, { ...params, output: 'json', page: p });
    let records;
    try { records = await getNdjson(url); }
    catch (e) {
      console.error(`[warn] page ${p} failed: ${e.message.slice(0,120)}`);
      continue;
    }
    total += records.length;
    if (total >= hardCap) { capped = true; break; }
  }
  return { total, pages, pageSize: meta.pageSize || 0, capped };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCrawls(n) {
  const N = Math.max(1, parseInt(n || '10', 10));
  const arr = await listCrawls();
  // Newest-first per docs; sort by id desc as a guarantee.
  const sorted = [...arr].sort((a,b) => String(b.id).localeCompare(String(a.id)));
  const top = sorted.slice(0, N);
  const cacheFile = resolve(CACHE_DIR, `crawls-${N}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), crawls: top });
  console.log(`# Common Crawl — latest ${N} crawls\n`);
  console.log(`  ${'id'.padEnd(20)}  ${'approx-date'.padEnd(12)}  name`);
  console.log('  ' + '-'.repeat(78));
  for (const c of top) {
    console.log(`  ${String(c.id||'?').padEnd(20)}  ${crawlDate(c.id).padEnd(12)}  ${c.name || ''}`);
  }
  console.log(`\nCached: ${cacheFile}`);
  return top;
}

async function cmdSearch(url, opts={}) {
  if (!url) throw new Error('Usage: search <url> [--crawl=CC-MAIN-YYYY-WW] [--match=exact|domain|prefix|host] [--limit=N]');
  const matchType = opts.match || 'exact';
  const target = applyMatch(url, matchType);
  let crawlId = opts.crawl;
  if (!crawlId) {
    const crawls = await listCrawls();
    crawlId = [...crawls].sort((a,b) => String(b.id).localeCompare(String(a.id)))[0]?.id;
  }
  if (!crawlId) throw new Error('No crawl id resolved');
  const limit = opts.limit ? parseInt(opts.limit, 10) : 100;
  const params = { url: target, matchType, limit };
  if (opts.from) params.from = opts.from;
  if (opts.to) params.to = opts.to;
  const indexUrl = buildIndexUrl(crawlId, { ...params, output: 'json' });
  const records = await getNdjson(indexUrl);
  const cacheFile = resolve(CACHE_DIR, `search-${slug(crawlId)}-${slug(target)}-${matchType}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), crawl: crawlId, url: target, matchType, limit, count: records.length, records });
  console.log(`# Common Crawl search — ${target}  (crawl=${crawlId}, match=${matchType}, limit=${limit})\n`);
  if (!records.length) { console.log('  no captures found'); }
  else {
    for (const r of records) {
      const ts = r.timestamp || '';
      const status = r.status || '';
      const mime = r['mime-detected'] || r.mime || '';
      const len = r.length || '';
      console.log(`  ${ts}  [${String(status).padStart(3)} ${String(mime).padEnd(20).slice(0,20)}]  ${String(len).padStart(8)}  ${r.url || ''}`);
    }
    console.log(`\n  Returned ${records.length} record(s)`);
  }
  console.log(`\nCached: ${cacheFile}`);
  return records;
}

async function cmdLatest(url, opts={}) {
  if (!url) throw new Error('Usage: latest <url> [--match=exact|domain|prefix|host]');
  const matchType = opts.match || 'exact';
  const target = applyMatch(url, matchType);
  const crawls = await listCrawls();
  const crawlId = [...crawls].sort((a,b) => String(b.id).localeCompare(String(a.id)))[0]?.id;
  if (!crawlId) throw new Error('No crawl id resolved');
  const { total, pages, pageSize, capped } = await countCaptures(crawlId, { url: target, matchType });
  // Sample first 5 records for context.
  let sample = [];
  if (pages) {
    const sUrl = buildIndexUrl(crawlId, { url: target, matchType, output: 'json', page: 0, limit: 5 });
    try { sample = await getNdjson(sUrl); } catch {}
  }
  const cacheFile = resolve(CACHE_DIR, `latest-${slug(crawlId)}-${slug(target)}-${matchType}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), crawl: crawlId, url: target, matchType, pages, pageSize, captures: total, capped, sample });
  console.log(`# Common Crawl latest — ${target}  (crawl=${crawlId}, match=${matchType})\n`);
  console.log(`   pages: ${pages || 0}  (blocks-per-page=${pageSize || 0})`);
  console.log(`   captures: ${total.toLocaleString()}${capped ? ' (capped)' : ''}`);
  if (sample.length) {
    console.log(`\n   sample:`);
    for (const r of sample) {
      console.log(`     ${r.timestamp}  [${r.status}]  ${r.url}`);
    }
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdHistory(url, opts={}) {
  if (!url) throw new Error('Usage: history <url> [--limit-crawls=N] [--match=...]');
  const matchType = opts.match || 'exact';
  const target = applyMatch(url, matchType);
  const N = Math.max(1, parseInt(opts.limitcrawls || '10', 10));
  const crawls = await listCrawls();
  const sorted = [...crawls].sort((a,b) => String(b.id).localeCompare(String(a.id))).slice(0, N);

  const buckets = {};
  for (const c of sorted) {
    const { total } = await countCaptures(c.id, { url: target, matchType }, { hardCap: 50_000 });
    buckets[c.id] = total;
  }

  const cacheFile = resolve(CACHE_DIR, `history-${slug(target)}-${matchType}-${N}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), url: target, matchType, buckets });
  console.log(`# Common Crawl history — ${target}  (match=${matchType}, last ${N} crawls)\n`);
  const maxN = Math.max(1, ...Object.values(buckets));
  // Show oldest at top, newest at bottom for a left-to-right time reading.
  const ordered = Object.entries(buckets).sort((a,b) => a[0].localeCompare(b[0]));
  for (const [id, n] of ordered) {
    const bar = n > 0 ? '#'.repeat(Math.max(1, Math.round(40 * n / maxN))) : '';
    console.log(`   ${id}  (${crawlDate(id)})  ${String(n).padStart(8)}  ${bar}`);
  }
  const total = Object.values(buckets).reduce((a,b)=>a+b, 0);
  console.log(`\n   total captures across ${N} crawls: ${total.toLocaleString()}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdDomainCount(domain) {
  if (!domain) throw new Error('Usage: domain-count <domain>');
  const target = applyMatch(domain, 'domain');
  const crawls = await listCrawls();
  const crawlId = [...crawls].sort((a,b) => String(b.id).localeCompare(String(a.id)))[0]?.id;
  if (!crawlId) throw new Error('No crawl id resolved');
  const { total, pages, pageSize, capped } = await countCaptures(crawlId, { url: target, matchType: 'domain' }, { hardCap: 200_000 });
  const cacheFile = resolve(CACHE_DIR, `domain-count-${slug(target)}-${slug(crawlId)}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), domain: target, crawl: crawlId, pages, pageSize, captures: total, capped });
  console.log(`# Common Crawl domain-count — *.${target}  (crawl=${crawlId})\n`);
  console.log(`   pages: ${pages || 0}  (blocks-per-page=${pageSize || 0})`);
  console.log(`   captures (≈ distinct URL count for this crawl): ${total.toLocaleString()}${capped ? ' (capped)' : ''}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdFetch(crawlId, filename, offset, length) {
  if (!crawlId || !filename || offset === undefined || length === undefined) {
    throw new Error('Usage: fetch <crawl-id> <filename> <offset> <length>');
  }
  const off = parseInt(offset, 10);
  const len = parseInt(length, 10);
  if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0) {
    throw new Error('offset and length must be positive integers');
  }
  const url = `${WARC_BASE}/${filename}`;
  const res = await httpGet(url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, accept: '*/*' });
  const buf = Buffer.from(await res.arrayBuffer());
  const cacheFile = resolve(CACHE_DIR, `warc-${slug(crawlId)}-${slug(filename)}-${off}-${len}.gz`);
  ensureDir(dirname(cacheFile));
  writeFileSync(cacheFile, buf);
  // Print metadata + base64 to stdout. Note: this is GZIPPED WARC content.
  console.log(`# Common Crawl WARC fetch`);
  console.log(`   crawl: ${crawlId}`);
  console.log(`   file:  ${filename}`);
  console.log(`   range: bytes=${off}-${off+len-1}  (${len} bytes)`);
  console.log(`   bytes-fetched: ${buf.length}`);
  console.log(`\nCached: ${cacheFile}`);
  console.log(`\n# base64 (gzipped WARC record):`);
  console.log(buf.toString('base64'));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const out = { positional: [] };
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k.replace(/-/g, '')] = v ?? true;
    } else out.positional.push(a);
  }
  return out;
}

function usage() {
  console.log(`Usage:
  common-crawl.mjs crawls [N]
  common-crawl.mjs search <url> [--crawl=CC-MAIN-YYYY-WW] [--match=exact|domain|prefix|host] [--limit=N] [--from=YYYYMMDDHHMMSS] [--to=YYYYMMDDHHMMSS]
  common-crawl.mjs latest <url> [--match=...]
  common-crawl.mjs history <url> [--limit-crawls=N] [--match=...]
  common-crawl.mjs domain-count <domain>
  common-crawl.mjs fetch <crawl-id> <filename> <offset> <length>

Data dir: ${DATA_DIR}
Throttle: ${REQ_DELAY_MS} ms between requests; up to 3 retries on 429/503/504.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'crawls':       await cmdCrawls(flags.positional[0]); break;
      case 'search':       await cmdSearch(flags.positional[0], flags); break;
      case 'latest':       await cmdLatest(flags.positional[0], flags); break;
      case 'history':      await cmdHistory(flags.positional[0], flags); break;
      case 'domain-count': await cmdDomainCount(flags.positional[0]); break;
      case 'fetch':        await cmdFetch(flags.positional[0], flags.positional[1], flags.positional[2], flags.positional[3]); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':       usage(); break;
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
