#!/usr/bin/env node
// sec-edgar-search.mjs — SEC EDGAR Full-Text Search (EFTS) wrapper.
//
// Endpoint: https://efts.sec.gov/LATEST/search-index
//   Params: q, forms, dateRange=custom, startdt, enddt, ciks, entityName, from, hits
//
// No auth. SEC requires a contact User-Agent and limits to 10 req/sec.
//
// Commands:
//   query "<phrase>" [--forms=10-K,8-K] [--from=YYYY-MM-DD] [--to=...] [--limit=N]
//   company <name>   [--forms=...] [--from=...] [--to=...] [--limit=N]
//   rounds           [--company=NAME] [--from=...] [--to=...] [--limit=N]   (forms=D, private placements)
//   recent --form=8-K [--days=7] [--limit=N]

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/sec-edgar');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const EFTS_URL = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const CONTACT = process.env.SEC_EDGAR_CONTACT || 'showrun-skills@showrun.co';
const USER_AGENT = `showrun-sec-edgar/1.0 (${CONTACT})`;
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 110;
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const PAGE_SIZE = 100;       // EFTS max per page
const HARD_CAP = 1000;       // safety cap on total fetched

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
  const u = new URL(EFTS_URL);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  return u.toString();
}

async function efts(params) {
  const url = buildUrl(params);
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
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}`);
    }
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`Non-JSON response from EFTS: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    throw new Error(`HTTP ${res.status} on EFTS: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

// Pull `limit` distinct filings (deduped by accession), paginating in PAGE_SIZE chunks.
// EFTS returns one hit per document inside a filing, so an N-document filing is N hits.
async function search(params, limit = 25) {
  limit = Math.min(limit, HARD_CAP);
  const seen = new Set();
  const out = [];
  let total = null;
  let from = 0;
  while (out.length < limit) {
    const data = await efts({ ...params, from, hits: PAGE_SIZE });
    if (total === null) total = data.hits?.total?.value ?? 0;
    const hits = data.hits?.hits || [];
    if (!hits.length) break;
    for (const h of hits) {
      const accn = h._source?.adsh || (h._id || '').split(':')[0];
      if (!accn || seen.has(accn)) continue;
      seen.add(accn);
      out.push(h);
      if (out.length >= limit) break;
    }
    if (hits.length < PAGE_SIZE) break;
    from += hits.length;
    if (from >= HARD_CAP) break;
  }
  return { total, hits: out };
}

function fmtHit(h) {
  const s = h._source || {};
  const accn = s.adsh || (h._id || '').split(':')[0];
  const filer = (s.display_names || [])[0] || '';
  const form = (s.form || '').padEnd(8);
  // Build filing URL: data/{cikInt}/{accnNoDash}/{accn}-index.htm
  const cik = (s.ciks || [])[0];
  const accnNoDash = accn ? accn.replace(/-/g, '') : '';
  const url = (cik && accnNoDash) ? `${ARCHIVES_BASE}/${parseInt(cik,10)}/${accnNoDash}/${accn}-index.htm` : '';
  return `   ${s.file_date || '-'.padEnd(10)}  ${form}  ${accn}  ${filer}\n      ${url}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdQuery(phrase, opts = {}) {
  if (!phrase) throw new Error('Usage: query "<phrase>" [--forms=10-K,8-K] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]');
  const limit = opts.limit || 25;
  const params = { q: phrase };
  if (opts.forms) params.forms = opts.forms;
  if (opts.from || opts.to) { params.dateRange = 'custom'; params.startdt = opts.from || '2001-01-01'; params.enddt = opts.to || new Date().toISOString().slice(0,10); }
  const { total, hits } = await search(params, limit);
  const cacheFile = resolve(CACHE_DIR, `search-query-${slug(phrase)}-${slug(opts.forms||'all')}-${opts.from||''}-${opts.to||''}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), phrase, params, total, hits });
  console.log(`# SEC EDGAR full-text search — "${phrase}"`);
  console.log(`   forms=${opts.forms || 'any'}  from=${opts.from || '-'}  to=${opts.to || '-'}`);
  console.log(`   matches: ${total?.toLocaleString() || 0}    showing ${hits.length}\n`);
  if (!hits.length) { console.log('   (no matches)'); return; }
  for (const h of hits) console.log(fmtHit(h));
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdCompany(name, opts = {}) {
  if (!name) throw new Error('Usage: company <name> [--forms=...] [--limit=N]');
  const limit = opts.limit || 25;
  const params = { entityName: name };
  if (opts.forms) params.forms = opts.forms;
  if (opts.from || opts.to) { params.dateRange = 'custom'; params.startdt = opts.from || '2001-01-01'; params.enddt = opts.to || new Date().toISOString().slice(0,10); }
  const { total, hits } = await search(params, limit);
  const cacheFile = resolve(CACHE_DIR, `search-company-${slug(name)}-${slug(opts.forms||'all')}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), name, params, total, hits });
  console.log(`# SEC EDGAR — filings by company "${name}"`);
  console.log(`   forms=${opts.forms || 'any'}  matches: ${total?.toLocaleString() || 0}    showing ${hits.length}\n`);
  if (!hits.length) { console.log('   (no matches — try a fuzzier name; EFTS entityName is permissive but case matters less than spelling)'); return; }
  for (const h of hits) console.log(fmtHit(h));
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdRounds(opts = {}) {
  const limit = opts.limit || 25;
  const params = { forms: 'D' };
  if (opts.company) params.entityName = opts.company;
  if (opts.from || opts.to) { params.dateRange = 'custom'; params.startdt = opts.from || '2001-01-01'; params.enddt = opts.to || new Date().toISOString().slice(0,10); }
  const { total, hits } = await search(params, limit);
  const cacheFile = resolve(CACHE_DIR, `search-rounds-${slug(opts.company||'all')}-${opts.from||''}-${opts.to||''}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), opts, params, total, hits });
  console.log(`# SEC EDGAR — Form D (private placements)${opts.company ? `  filer=${opts.company}` : ''}`);
  console.log(`   from=${opts.from || '-'}  to=${opts.to || '-'}    matches: ${total?.toLocaleString() || 0}    showing ${hits.length}\n`);
  if (!hits.length) { console.log('   (no Form D filings match)'); return; }
  for (const h of hits) console.log(fmtHit(h));
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdRecent(opts = {}) {
  if (!opts.form) throw new Error('Usage: recent --form=FORM [--days=N] [--limit=N]');
  const days = parseInt(opts.days || 7, 10);
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0,10);
  const to   = new Date().toISOString().slice(0,10);
  const limit = opts.limit || 25;
  const params = { forms: opts.form, dateRange: 'custom', startdt: from, enddt: to };
  const { total, hits } = await search(params, limit);
  const cacheFile = resolve(CACHE_DIR, `search-recent-${slug(opts.form)}-${days}d-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), opts, params, total, hits });
  console.log(`# SEC EDGAR — recent ${opts.form} filings  (last ${days} days)`);
  console.log(`   matches: ${total?.toLocaleString() || 0}    showing ${hits.length}\n`);
  if (!hits.length) { console.log('   (none)'); return; }
  for (const h of hits) console.log(fmtHit(h));
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
  sec-edgar-search.mjs query "<phrase>" [--forms=10-K,8-K] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]
  sec-edgar-search.mjs company <name>   [--forms=...] [--from=...] [--to=...] [--limit=N]
  sec-edgar-search.mjs rounds           [--company=NAME] [--from=...] [--to=...] [--limit=N]
  sec-edgar-search.mjs recent --form=8-K [--days=7] [--limit=N]

Data dir: ${DATA_DIR}
SEC requires a contact User-Agent — defaults to showrun-skills@showrun.co; override via SEC_EDGAR_CONTACT env var. Rate-limit: 10 req/s.
EFTS caps total results at 10 000; this script caps each call at ${HARD_CAP}.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'query':   await cmdQuery(flags.positional[0], flags); break;
      case 'company': await cmdCompany(flags.positional[0], flags); break;
      case 'rounds':  await cmdRounds(flags); break;
      case 'recent':  await cmdRecent(flags); break;
      case undefined:
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
