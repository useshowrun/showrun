#!/usr/bin/env node
// fred.mjs — St. Louis Fed FRED economic-data API wrapper.
//
// Endpoint: https://api.stlouisfed.org/fred
// Free API key required: https://fred.stlouisfed.org/docs/api/api_key.html
//
// 800K+ macro time series — interest rates, inflation, GDP, employment,
// FX, commodities, money supply, financial conditions, etc.
//
// Commands:
//   info <series-id>                        — series metadata
//   fetch <series-id> [--from=...] [--to=...] [--limit=N]   — observation values
//   recent <series-id> [--limit=N]          — most recent N values
//   search "<query>" [--limit=N] [--popularity]             — keyword search

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/fred');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TOKEN_FILE = resolve(DATA_DIR, 'token.txt');
const API = 'https://api.stlouisfed.org/fred';
const USER_AGENT = 'showrun-fred/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 600;          // FRED limit is 120/min — ~500ms; pad to 600
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const SERIES_TTL_MS = 12 * 3600_000;
const META_TTL_MS = 24 * 3600_000;

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function fmtNum(n) {
  if (n === null || n === undefined || n === '.' || Number.isNaN(+n)) return '-';
  const v = Number(n);
  if (Math.abs(v) >= 1e12) return (v/1e12).toFixed(2) + 'T';
  if (Math.abs(v) >= 1e9)  return (v/1e9).toFixed(2)  + 'B';
  if (Math.abs(v) >= 1e6)  return (v/1e6).toFixed(2)  + 'M';
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function loadKey() {
  const k = process.env.FRED_API_KEY;
  if (k) return k.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error(`FRED API key not set.\n  Get a free key: https://fred.stlouisfed.org/docs/api/api_key.html\n  Then either:\n    export FRED_API_KEY=<your-32-char-key>\n    # or:\n    echo "<your-key>" > ${TOKEN_FILE}`);
}

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function fetchJson(path, params = {}) {
  const key = loadKey();
  const u = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  u.searchParams.append('api_key', key);
  u.searchParams.append('file_type', 'json');
  const url = u.toString();
  const safeUrl = url.replace(key, '<KEY>');
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, signal: ctrl.signal }); }
    catch (e) { lastErr = e; res = null; }
    finally { clearTimeout(t); }
    if (!res) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}  (${safeUrl})`);
    }
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`Non-JSON response from ${safeUrl}: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 400 || res.status === 403) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status} on ${safeUrl}: ${t.slice(0,300)}`);
    }
    throw new Error(`HTTP ${res.status} on ${safeUrl}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInfo(seriesId) {
  if (!seriesId) throw new Error('Usage: info <series-id>  (e.g. GDP, UNRATE, CPIAUCSL)');
  const id = seriesId.toUpperCase();
  const cacheFile = resolve(CACHE_DIR, `info-${slug(id)}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < META_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson(`/series`, { series_id: id }); saveJson(cacheFile, data); }
  const s = data.seriess?.[0];
  if (!s) { console.log(`# FRED info — ${id}\n   (series not found)`); return; }
  console.log(`# FRED series — ${s.id}`);
  console.log(`   title:       ${s.title}`);
  console.log(`   units:       ${s.units}    units (short): ${s.units_short || '-'}`);
  console.log(`   frequency:   ${s.frequency}    seasonal adj: ${s.seasonal_adjustment_short || s.seasonal_adjustment || '-'}`);
  console.log(`   span:        ${s.observation_start} → ${s.observation_end}`);
  console.log(`   last updated: ${s.last_updated}`);
  if (s.notes) {
    const n = s.notes.replace(/\s+/g, ' ').trim();
    console.log(`\n   notes: ${n.slice(0, 500)}${n.length > 500 ? '…' : ''}`);
  }
}

async function fetchObservations(seriesId, opts = {}) {
  const params = { series_id: seriesId, sort_order: 'desc' };
  if (opts.from) params.observation_start = opts.from;
  if (opts.to)   params.observation_end = opts.to;
  if (opts.limit) params.limit = opts.limit;
  return fetchJson('/series/observations', params);
}

async function cmdFetch(seriesId, opts = {}) {
  if (!seriesId) throw new Error('Usage: fetch <series-id> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]');
  const id = seriesId.toUpperCase();
  const limit = opts.limit || 100;
  const cacheKey = `obs-${slug(id)}-${opts.from||''}-${opts.to||''}-${limit}.json`;
  const cacheFile = resolve(CACHE_DIR, cacheKey);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < SERIES_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchObservations(id, { ...opts, limit }); saveJson(cacheFile, data); }
  const obs = (data.observations || []).filter(o => o.value !== '.');  // FRED uses '.' for missing
  if (!obs.length) { console.log(`# FRED — ${id}\n   (no observations in range)`); return; }
  obs.sort((a,b) => a.date.localeCompare(b.date));   // ascending for chart
  // Get series metadata for header
  const meta = await fetchJson('/series', { series_id: id });
  const s = meta.seriess?.[0] || {};
  const vals = obs.map(o => +o.value).filter(v => !Number.isNaN(v));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 40;
  console.log(`# FRED — ${s.title || id}  (${id}, ${s.frequency || '-'}, ${s.units_short || s.units || '-'})`);
  console.log(`   range: ${obs[0].date} → ${obs[obs.length-1].date}    n=${obs.length}    min=${fmtNum(lo)}  max=${fmtNum(hi)}\n`);
  for (const o of obs) {
    const v = +o.value;
    const frac = (v - lo) / Math.max(1e-9, hi - lo);
    const bar = '█'.repeat(Math.max(1, Math.round(W * frac)));
    console.log(`   ${o.date}  ${String(fmtNum(v)).padStart(12)}  ${bar}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdRecent(seriesId, opts = {}) {
  if (!seriesId) throw new Error('Usage: recent <series-id> [--limit=N]');
  await cmdFetch(seriesId, { limit: opts.limit || 10 });
}

async function cmdSearch(query, opts = {}) {
  if (!query) throw new Error('Usage: search "<query>" [--limit=N] [--popularity]');
  const limit = opts.limit || 25;
  const params = { search_text: query, limit };
  if (opts.popularity) { params.order_by = 'popularity'; params.sort_order = 'desc'; }
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}-${limit}-${opts.popularity?'pop':'rel'}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < META_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson('/series/search', params); saveJson(cacheFile, data); }
  const hits = data.seriess || [];
  console.log(`# FRED search — "${query}"  ${opts.popularity ? '(by popularity)' : '(by relevance)'}`);
  console.log(`   matches: ${data.count?.toLocaleString() || hits.length}    showing ${hits.length}\n`);
  for (const s of hits) {
    console.log(`   ${s.id.padEnd(20)} ${(s.frequency_short||'-').padEnd(4)} ${(s.units_short || s.units || '-').slice(0, 18).padEnd(18)} ${s.title}`);
  }
  console.log(`\nCached: ${cacheFile}`);
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
  fred.mjs info <series-id>
  fred.mjs fetch <series-id> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]
  fred.mjs recent <series-id> [--limit=N]
  fred.mjs search "<query>" [--limit=N] [--popularity]

Examples:
  fred.mjs info GDP
  fred.mjs fetch UNRATE --from=2020-01-01
  fred.mjs search "consumer price" --popularity --limit=10

Data dir: ${DATA_DIR}
Get a free API key: https://fred.stlouisfed.org/docs/api/api_key.html
Then: export FRED_API_KEY=<key>   or:   echo "<key>" > ${TOKEN_FILE}
Rate limit: 120 req/min — script self-throttles to ~100 req/min.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'info':   await cmdInfo(flags.positional[0]); break;
      case 'fetch':  await cmdFetch(flags.positional[0], flags); break;
      case 'recent': await cmdRecent(flags.positional[0], flags); break;
      case 'search': await cmdSearch(flags.positional[0], flags); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help': usage(); break;
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
