#!/usr/bin/env node
// cloudflare-radar.mjs — Public Cloudflare Radar API wrapper.
//
// Endpoints used (all under https://api.cloudflare.com/client/v4/radar/):
//   GET /ranking/top                  — top global / category / location domains
//   GET /ranking/domain/<domain>      — per-domain bucket rank + trend
//   GET /ranking/categories           — list of categories
//   GET /http/locations               — HTTP traffic share by country
//   GET /annotations/outages          — detected internet outages
//   GET /entities/asns/<asn>          — AS info
//   GET <raw path>                    — raw passthrough
//
// Auth: Bearer token from CLOUDFLARE_API_TOKEN env, or token.txt in DATA_DIR.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/cloudflare-radar');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TOKEN_FILE = resolve(DATA_DIR, 'token.txt');
const API_BASE = 'https://api.cloudflare.com/client/v4/radar';
const USER_AGENT = 'cloudflare-radar-skill/1.0 (+https://github.com)';
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function getToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error('No Cloudflare API token. Set CLOUDFLARE_API_TOKEN env or write to ' + TOKEN_FILE);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(path, params = {}, fallbackRange = null) {
  const token = getToken();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } finally { clearTimeout(t); }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!res.ok) {
    const errs = body?.errors?.map(e => `[${e.code}] ${e.message}`).join('; ') || text.slice(0, 200);
    // If the error is a date-range rejection and we have a fallback, retry
    if (fallbackRange && /dateRange|date_range|range/i.test(errs)) {
      params.dateRange = fallbackRange;
      return api(path, params); // single retry without further fallback
    }
    throw new Error(`API error (HTTP ${res.status}): ${errs}`);
  }
  if (body?.success === false) {
    const errs = body?.errors?.map(e => `[${e.code}] ${e.message}`).join('; ') || 'unknown';
    throw new Error(`API success=false: ${errs}`);
  }
  return body?.result ?? body;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdTop(opts) {
  const params = {
    limit: opts.limit || 100,
    dateRange: opts.dateRange || '7d',
  };
  if (opts.location) params.location = opts.location;
  if (opts.category) params.category = opts.category;
  const cacheFile = resolve(CACHE_DIR, `top-${slug(opts.location||'global')}-${slug(params.dateRange)}-${slug(opts.category||'all')}-${params.limit}.json`);
  const result = await api('/ranking/top', params, '7d');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), params, result });
  const items = result?.top_0 || result?.top || result;
  console.log(`# Cloudflare Radar — top domains  (location=${params.location||'GLOBAL'}, range=${params.dateRange}, category=${opts.category||'all'})\n`);
  if (Array.isArray(items)) {
    items.slice(0, params.limit).forEach((it, i) => {
      const dom = it.domain || it.name || it;
      const rank = it.rank ?? (i+1);
      const cat = (it.categories?.map(c=>c.name).join(', ')) || '';
      console.log(`  ${String(rank).padStart(4)}. ${dom}${cat ? `  [${cat}]` : ''}`);
    });
  } else {
    console.log(JSON.stringify(items, null, 2).slice(0, 4000));
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdDomain(domain, opts) {
  if (!domain) throw new Error('Usage: domain <domain>');
  const params = { dateRange: opts.dateRange || '7d' };
  if (opts.location) params.location = opts.location;
  const cacheFile = resolve(CACHE_DIR, `domain-${slug(domain)}-${slug(params.dateRange)}.json`);
  const result = await api(`/ranking/domain/${encodeURIComponent(domain)}`, params, '7d');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), domain, params, result });
  console.log(`# Cloudflare Radar — ${domain}  (range=${params.dateRange})\n`);
  // Result shape: { details_0: { rank, bucket, categories } } or similar
  const dt = result?.details_0 || result?.details || result;
  if (dt?.bucket) console.log(`  bucket: ${dt.bucket}  rank≈${dt.rank ?? '?'}`);
  if (dt?.categories?.length) console.log(`  categories: ${dt.categories.map(c=>c.name).join(', ')}`);
  // Trend data may be under .trend or similar
  if (dt?.trend?.length) {
    console.log(`  trend (${dt.trend.length} buckets):`);
    dt.trend.forEach(t => console.log(`    ${t.timestamp || t.date || ''}  rank=${t.rank}`));
  }
  console.log(`\nFull result:\n${JSON.stringify(dt, null, 2).slice(0, 3000)}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdCategories() {
  const cacheFile = resolve(CACHE_DIR, 'categories.json');
  const result = await api('/ranking/categories');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), result });
  const cats = result?.categories || result;
  console.log(`# Cloudflare Radar — categories (${Array.isArray(cats) ? cats.length : '?'})\n`);
  if (Array.isArray(cats)) {
    cats.forEach(c => console.log(`  ${c.id || c.code || ''}  ${c.name || c}`));
  } else { console.log(JSON.stringify(cats, null, 2).slice(0, 4000)); }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdHttpLocations(opts) {
  const params = { dateRange: opts.dateRange || '7d', limit: opts.limit || 30 };
  const cacheFile = resolve(CACHE_DIR, `http-locations-${slug(params.dateRange)}.json`);
  const result = await api('/http/top/locations', params, '7d');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), params, result });
  const top = result?.top_0 || result?.top || result;
  console.log(`# Cloudflare Radar — HTTP traffic share by country (range=${params.dateRange})\n`);
  if (Array.isArray(top)) {
    top.slice(0, params.limit).forEach(r => {
      const code = r.clientCountryAlpha2 || r.alpha2 || r.code || '';
      const name = r.clientCountryName || r.name || '';
      const val = r.value ?? r.share ?? '';
      console.log(`  ${code} ${name.padEnd(28).slice(0,28)} ${val}`);
    });
  } else { console.log(JSON.stringify(top, null, 2).slice(0, 3000)); }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdEvents() {
  const cacheFile = resolve(CACHE_DIR, 'events.json');
  const result = await api('/annotations/outages');
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), result });
  const arr = result?.annotations || result;
  console.log(`# Cloudflare Radar — recent internet outages\n`);
  if (Array.isArray(arr)) {
    arr.slice(0, 30).forEach(a => {
      console.log(`  [${a.startDate || a.start || '?'}] ${a.locations?.map(l=>l.code).join(',') || ''}  ${a.description?.slice(0,120) || ''}`);
    });
  } else { console.log(JSON.stringify(arr, null, 2).slice(0, 3000)); }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdAS(asn) {
  if (!asn) throw new Error('Usage: as <asn>  (e.g. AS13335 or 13335)');
  const num = String(asn).replace(/^AS/i, '');
  const cacheFile = resolve(CACHE_DIR, `as-${num}.json`);
  const result = await api(`/entities/asns/${num}`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), asn: num, result });
  console.log(`# Cloudflare Radar — AS${num}\n`);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdRaw(path) {
  if (!path) throw new Error('Usage: raw <path>  e.g. /radar/datasets?dateRange=7d');
  // path may include query string after ?
  const [p, qs] = path.startsWith('/radar') ? path.replace(/^\/radar/, '').split('?') : path.split('?');
  const params = {};
  if (qs) for (const kv of qs.split('&')) { const [k,v]=kv.split('='); params[k]=decodeURIComponent(v||''); }
  const result = await api(p, params);
  const cacheFile = resolve(CACHE_DIR, `raw-${slug(p)}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), path, result });
  console.log(JSON.stringify(result, null, 2).slice(0, 8000));
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
  // map common aliases
  if (out.daterange && !out.dateRange) out.dateRange = out.daterange;
  if (out.limit) out.limit = parseInt(out.limit, 10);
  return out;
}

function usage() {
  console.log(`Usage:
  cloudflare-radar.mjs top [--location=US] [--category=Gaming] [--date-range=7d] [--limit=100]
  cloudflare-radar.mjs domain <domain> [--date-range=7d]
  cloudflare-radar.mjs categories
  cloudflare-radar.mjs http-locations [--date-range=7d] [--limit=30]
  cloudflare-radar.mjs events
  cloudflare-radar.mjs as <asn>
  cloudflare-radar.mjs raw <path>

Auth:
  CLOUDFLARE_API_TOKEN env var, or write token to:
  ${TOKEN_FILE}

Data dir: ${DATA_DIR}
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'top':            await cmdTop(flags); break;
      case 'domain':         await cmdDomain(flags.positional[0], flags); break;
      case 'categories':     await cmdCategories(); break;
      case 'http-locations': await cmdHttpLocations(flags); break;
      case 'events':         await cmdEvents(); break;
      case 'as':             await cmdAS(flags.positional[0]); break;
      case 'raw':            await cmdRaw(flags.positional[0]); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':         usage(); break;
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
