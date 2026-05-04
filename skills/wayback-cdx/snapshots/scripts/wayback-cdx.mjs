#!/usr/bin/env node
// wayback-cdx.mjs — Internet Archive Wayback CDX API wrapper.
//
// Endpoint: https://web.archive.org/cdx/search/cdx
// No auth. Public.
//
// Commands:
//   count <url>                    — total snapshot count
//   span <url>                     — first + last snapshot dates
//   timeline <url> --bin=year|month — counts per year/month
//   list <url> --limit=N           — list recent snapshots
//   snapshot <url> --date=YYYYMMDD — print web.archive.org snapshot URL

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/wayback-cdx');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API = 'https://web.archive.org/cdx/search/cdx';
const USER_AGENT = 'wayback-cdx-skill/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 1200;
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

function buildUrl(params) {
  const u = new URL(API);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  return u.toString();
}

async function cdx(params) {
  const url = buildUrl({ output: 'json', ...params });
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
    let res;
    try { res = await fetch(url, { headers:{'User-Agent':USER_AGENT,'Accept':'application/json'}, signal: ctrl.signal }); }
    catch (e) { lastErr = e; res = null; }
    finally { clearTimeout(t); }
    if (!res) {
      // Network error — retry
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error on CDX after retries: ${lastErr?.message || 'unknown'}`);
    }
    if (res.ok) {
      const text = await res.text();
      if (!text.trim()) return { rows: [], header: [] };
      let arr; try { arr = JSON.parse(text); } catch { throw new Error(`CDX returned non-JSON: ${text.slice(0,200)}`); }
      if (!arr.length) return { rows: [], header: [] };
      return { header: arr[0], rows: arr.slice(1) };
    }
    // Retry on 429 / 503; abort on 4xx other than 429
    if (res.status === 429 || res.status === 503) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
    }
    throw new Error(`HTTP ${res.status} on CDX: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('CDX exhausted retries');
}

function applyMatch(url, match) {
  if (match === 'domain') {
    // Convert example.com → *.example.com (CDX matchType=domain expects this)
    if (!url.includes('*')) url = url.replace(/^(https?:\/\/)?/, '');
    if (!url.startsWith('*')) url = `*.${url}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCount(url, opts={}) {
  if (!url) throw new Error('Usage: count <url>');
  const matchType = opts.match || 'exact';
  const u = applyMatch(url, matchType);
  // CDX has &showNumPages and &page; but for total count, use &fl=urlkey&output=json with showResumeKey then count rows
  // Faster: use ?fl=timestamp&matchType=...&limit=0  (limit=0 means show pagination summary). Simpler: paginate.
  // Use limit=-1 trick: not supported. Best path: stream pages of 100000.
  let total = 0;
  let resumeKey = '';
  while (true) {
    const params = { url: u, matchType, fl: 'urlkey', limit: 100000, showResumeKey: 'true' };
    if (resumeKey) params.resumeKey = resumeKey;
    const { rows } = await cdx(params);
    if (!rows.length) break;
    // Last 1-2 rows might be empty + resumeKey
    let dataRows = rows.filter(r => r && r[0]);
    let rk = '';
    // resumeKey is a single-cell row at the end
    const last = rows[rows.length - 1];
    if (Array.isArray(last) && last.length === 1 && last[0] && !dataRows.includes(last)) {
      rk = last[0];
      dataRows = dataRows.filter(r => r !== last);
    }
    total += dataRows.length;
    if (!rk || rk === resumeKey) break;
    resumeKey = rk;
    if (total > 5_000_000) break; // safety cap
  }
  const cacheFile = resolve(CACHE_DIR, `count-${slug(u)}-${matchType}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), url: u, matchType, total });
  console.log(`# Wayback CDX — ${url}  (match=${matchType})\n   total snapshots: ${total.toLocaleString()}\n\nCached: ${cacheFile}`);
}

async function cmdSpan(url, opts={}) {
  if (!url) throw new Error('Usage: span <url>');
  const matchType = opts.match || 'exact';
  const u = applyMatch(url, matchType);
  // earliest: limit=1, sort by timestamp asc
  const earliest = await cdx({ url: u, matchType, limit: 1, fl: 'timestamp,original', from: '19960101' });
  // latest: limit=1, sort desc
  const latest = await cdx({ url: u, matchType, limit: -1, fl: 'timestamp,original' });
  const fmt = ts => `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)} ${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)} UTC`;
  const first = earliest.rows[0];
  const last = latest.rows[0];
  if (!first) {
    console.log(`# Wayback CDX — ${url}\n   no snapshots found\n`);
    return;
  }
  const firstTs = first[0];
  const lastTs = last ? last[0] : firstTs;
  const days = Math.floor((Date.parse(fmt(lastTs).replace(' UTC','Z')) - Date.parse(fmt(firstTs).replace(' UTC','Z'))) / 86400000);
  const cacheFile = resolve(CACHE_DIR, `span-${slug(u)}-${matchType}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), url: u, first: firstTs, last: lastTs, days });
  console.log(`# Wayback CDX — ${url}  (match=${matchType})\n   first: ${fmt(firstTs)}\n   last:  ${fmt(lastTs)}\n   span:  ${days.toLocaleString()} days\n\nCached: ${cacheFile}`);
}

async function cmdTimeline(url, opts={}) {
  if (!url) throw new Error('Usage: timeline <url>');
  const bin = opts.bin || 'year';
  const matchType = opts.match || 'exact';
  const u = applyMatch(url, matchType);

  const baseParams = { url: u, matchType, fl: 'timestamp', limit: 100000, showResumeKey: 'true' };
  if (opts.from) baseParams.from = String(opts.from).replace(/[^0-9]/g, '');
  if (opts.to)   baseParams.to   = String(opts.to).replace(/[^0-9]/g, '');

  const buckets = {};
  let totalFetched = 0;
  let resumeKey = '';
  while (true) {
    const params = { ...baseParams };
    if (resumeKey) params.resumeKey = resumeKey;
    const { rows } = await cdx(params);
    if (!rows.length) break;
    let dataRows = rows.filter(r => r && r[0]);
    let rk = '';
    const last = rows[rows.length - 1];
    if (Array.isArray(last) && last.length === 1 && last[0] && !dataRows.includes(last)) {
      rk = last[0];
      dataRows = dataRows.filter(r => r !== last);
    }
    for (const r of dataRows) {
      const ts = r[0];
      if (!ts) continue;
      const key = bin === 'month' ? `${ts.slice(0,4)}-${ts.slice(4,6)}` : ts.slice(0,4);
      buckets[key] = (buckets[key] || 0) + 1;
    }
    totalFetched += dataRows.length;
    if (!rk || rk === resumeKey) break;
    resumeKey = rk;
    if (totalFetched > 5_000_000) break;
  }

  if (!totalFetched) {
    console.log(`# Wayback CDX timeline — ${url}\n   no snapshots found\n`);
    return;
  }

  const cacheFile = resolve(CACHE_DIR, `timeline-${slug(u)}-${bin}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), url: u, bin, buckets, total_snapshots: totalFetched });
  console.log(`# Wayback CDX timeline — ${url}  (match=${matchType}, bin=${bin})\n`);
  console.log(`   total snapshots: ${totalFetched.toLocaleString()}`);
  const maxN = Math.max(1, ...Object.values(buckets));
  Object.entries(buckets).sort().forEach(([k,n]) => {
    const bar = '█'.repeat(Math.max(1, Math.round(40 * n / maxN)));
    console.log(`   ${k}: ${String(n).padStart(6)}  ${bar}`);
  });
  console.log(`\n   bins: ${Object.keys(buckets).length}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdList(url, opts={}) {
  if (!url) throw new Error('Usage: list <url>');
  const limit = opts.limit || 20;
  const matchType = opts.match || 'exact';
  const u = applyMatch(url, matchType);
  const params = { url: u, matchType, limit: -limit, fl: 'timestamp,original,statuscode,mimetype,length' };
  if (opts.filter) params.filter = opts.filter;
  const { rows } = await cdx(params);
  const cacheFile = resolve(CACHE_DIR, `list-${slug(u)}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), url: u, limit, rows });
  console.log(`# Wayback CDX — recent snapshots of ${url}\n`);
  for (const r of rows) {
    const [ts, orig, sc, mt, len] = r;
    console.log(`  ${ts}  [${sc} ${mt}]  ${len?String(len).padStart(8):''}  ${orig}`);
  }
  console.log(`\n  Returned ${rows.length} rows`);
  console.log(`\nCached: ${cacheFile}`);
}

function cmdSnapshot(url, opts={}) {
  if (!url || !opts.date) throw new Error('Usage: snapshot <url> --date=YYYYMMDD');
  const stamp = opts.date.replace(/-/g, '').padEnd(14, '0');
  const wb = `https://web.archive.org/web/${stamp}/${url}`;
  console.log(`# Wayback snapshot URL\n   ${wb}`);
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
  if (out.limit) out.limit = parseInt(out.limit, 10);
  return out;
}

function usage() {
  console.log(`Usage:
  wayback-cdx.mjs count <url> [--match=exact|prefix|host|domain]
  wayback-cdx.mjs span <url> [--match=exact|prefix|host|domain]
  wayback-cdx.mjs timeline <url> [--bin=year|month|day] [--from=YYYY-MM] [--to=YYYY-MM]
  wayback-cdx.mjs list <url> [--limit=N] [--filter=statuscode:200]
  wayback-cdx.mjs snapshot <url> --date=YYYYMMDD

Data dir: ${DATA_DIR}
Throttle: 500 ms between requests (Internet Archive politeness).
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'count':    await cmdCount(flags.positional[0], flags); break;
      case 'span':     await cmdSpan(flags.positional[0], flags); break;
      case 'timeline': await cmdTimeline(flags.positional[0], flags); break;
      case 'list':     await cmdList(flags.positional[0], flags); break;
      case 'snapshot': cmdSnapshot(flags.positional[0], flags); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':   usage(); break;
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
