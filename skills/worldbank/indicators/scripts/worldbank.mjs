#!/usr/bin/env node
// worldbank.mjs — World Bank Open Data API wrapper.
//
// Endpoint: https://api.worldbank.org/v2
// No auth. 16K+ economic / development indicators across 200+ countries.
//
// Commands:
//   search "<query>" [--limit=N]                            — find indicators by name
//   view <indicator>                                         — indicator metadata
//   fetch <country> <indicator> [--from=YYYY] [--to=YYYY]    — time series for country
//   countries [--region=...] [--income=...]                  — list countries
//   compare <indicator> <country1,country2,...> [--year=YYYY] — peer comparison

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/worldbank');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API = 'https://api.worldbank.org/v2';
const USER_AGENT = 'showrun-worldbank/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 250;
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const TTL_MS = 24 * 3600_000;

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(+n)) return '-';
  const v = +n;
  if (Math.abs(v) >= 1e12) return (v/1e12).toFixed(2) + 'T';
  if (Math.abs(v) >= 1e9)  return (v/1e9).toFixed(2)  + 'B';
  if (Math.abs(v) >= 1e6)  return (v/1e6).toFixed(2)  + 'M';
  if (Math.abs(v) >= 1e3)  return (v/1e3).toFixed(2)  + 'K';
  if (Math.abs(v) >= 1)    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toFixed(4);
}

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function fetchJson(path, params = {}) {
  const u = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  u.searchParams.append('format', 'json');
  if (!u.searchParams.has('per_page')) u.searchParams.append('per_page', '100');
  // World Bank rejects %3A in date ranges — keep colons literal.
  const url = u.toString().replace(/%3A/g, ':');
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
      catch { throw new Error(`Non-JSON response: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 404) throw new Error(`HTTP 404: ${url}`);
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

// World Bank returns [meta, data] for success and [{message:[...]}] for errors.
function unwrap(resp) {
  if (Array.isArray(resp) && resp.length === 1 && resp[0]?.message) {
    const m = resp[0].message[0] || {};
    throw new Error(`World Bank API: ${m.value || 'unknown error'} (key=${m.key || '-'}, id=${m.id || '-'})`);
  }
  if (Array.isArray(resp) && resp.length === 2) return { meta: resp[0], data: resp[1] || [] };
  return { meta: null, data: resp };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function fetchAllPages(path, params = {}) {
  let page = 1;
  const out = [];
  for (;;) {
    const resp = await fetchJson(path, { ...params, page });
    const { meta, data } = unwrap(resp);
    if (!data || !data.length) break;
    out.push(...data);
    if (!meta || page >= meta.pages || out.length >= 30_000) break;
    page++;
  }
  return out;
}

async function cmdSearch(query, opts = {}) {
  if (!query) throw new Error('Usage: search "<query>" [--all] [--limit=N]');
  const limit = opts.limit || 25;
  // Default: search the WDI subset (source=2, ~1500 indicators — the headline ones).
  // --all: search the full 22K-indicator catalog (slow on first call, but cached).
  const scope = opts.all ? 'all' : 'wdi';
  const cacheFile = resolve(CACHE_DIR, `indicators-catalog-${scope}.json`);
  let all;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < 7 * TTL_MS)) all = loadJson(cacheFile, null);
  else {
    const params = scope === 'wdi' ? { source: 2 } : {};
    all = await fetchAllPages('/indicator', params);
    saveJson(cacheFile, all);
  }
  const lc = query.toLowerCase();
  const hits = all.filter(i => (i.name && i.name.toLowerCase().includes(lc)) || (i.id && i.id.toLowerCase().includes(lc))).slice(0, limit);
  console.log(`# World Bank — indicator search "${query}"  (scope: ${scope === 'wdi' ? 'WDI' : 'all-sources'})`);
  console.log(`   ${all.length.toLocaleString()} indicators searched    matches: ${hits.length}\n`);
  if (!hits.length) {
    console.log(`   (no matches; try broader terms${scope === 'wdi' ? ' or pass --all to search every indicator catalog' : ''})`);
    return;
  }
  for (const i of hits) {
    console.log(`   ${i.id.padEnd(24)} ${i.name}`);
    if (i.sourceOrganization) console.log(`     source: ${i.sourceOrganization.slice(0, 80)}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdView(indicator) {
  if (!indicator) throw new Error('Usage: view <indicator>  (e.g. NY.GDP.MKTP.CD)');
  const resp = await fetchJson(`/indicator/${indicator}`);
  const { data } = unwrap(resp);
  const i = data?.[0];
  if (!i) { console.log(`# World Bank — ${indicator}\n   (not found)`); return; }
  console.log(`# World Bank indicator — ${i.id}`);
  console.log(`   name:           ${i.name}`);
  console.log(`   unit:           ${i.unit || '-'}`);
  console.log(`   source:         ${i.source?.value || '-'}`);
  console.log(`   topic(s):       ${(i.topics || []).map(t => t.value).join(', ') || '-'}`);
  if (i.sourceOrganization) console.log(`   source org:     ${i.sourceOrganization}`);
  if (i.sourceNote) console.log(`\n   notes: ${i.sourceNote.replace(/\s+/g,' ').slice(0, 600)}${i.sourceNote.length > 600 ? '…' : ''}`);
}

async function cmdFetch(country, indicator, opts = {}) {
  if (!country || !indicator) throw new Error('Usage: fetch <country> <indicator> [--from=YYYY] [--to=YYYY]');
  const params = {};
  if (opts.from && opts.to) params.date = `${opts.from}:${opts.to}`;
  else if (opts.from) params.date = `${opts.from}:${new Date().getUTCFullYear()}`;
  const cacheFile = resolve(CACHE_DIR, `fetch-${slug(country)}-${slug(indicator)}-${opts.from||''}-${opts.to||''}.json`);
  let rows;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TTL_MS)) rows = loadJson(cacheFile, null);
  else {
    rows = await fetchAllPages(`/country/${country}/indicator/${indicator}`, params);
    saveJson(cacheFile, rows);
  }
  const meta = rows[0];
  if (!meta) { console.log(`# World Bank — ${country} / ${indicator}\n   (no data)`); return; }
  // World Bank returns descending by year; sort ascending for chart
  const obs = rows.filter(r => r.value !== null).sort((a,b) => a.date.localeCompare(b.date));
  if (!obs.length) { console.log(`# World Bank — ${meta.country?.value} / ${meta.indicator?.value}\n   (no non-null observations in range)`); return; }
  const vals = obs.map(o => o.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 40;
  console.log(`# World Bank — ${meta.indicator?.value}`);
  console.log(`   country: ${meta.country?.value} (${meta.countryiso3code || country})    indicator: ${meta.indicator?.id}`);
  console.log(`   range:   ${obs[0].date} → ${obs[obs.length-1].date}    n=${obs.length}    min=${fmtNum(lo)}  max=${fmtNum(hi)}\n`);
  for (const o of obs) {
    const frac = (o.value - lo) / Math.max(1e-9, hi - lo);
    const bar = '█'.repeat(Math.max(1, Math.round(W * frac)));
    console.log(`   ${o.date}  ${fmtNum(o.value).padStart(12)}  ${bar}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdCountries(opts = {}) {
  const cacheFile = resolve(CACHE_DIR, `countries.json`);
  let all;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < 7 * TTL_MS)) all = loadJson(cacheFile, null);
  else { all = await fetchAllPages('/country'); saveJson(cacheFile, all); }
  let rows = all;
  if (opts.region) rows = rows.filter(c => (c.region?.value || '').toLowerCase().includes(opts.region.toLowerCase()) || c.region?.id === opts.region);
  if (opts.income) rows = rows.filter(c => (c.incomeLevel?.value || '').toLowerCase().includes(opts.income.toLowerCase()) || c.incomeLevel?.id === opts.income);
  // Filter out aggregates (regions, income groups) — those have region.id === 'NA'
  if (!opts.aggregates) rows = rows.filter(c => c.region?.id && c.region.id !== 'NA');
  console.log(`# World Bank — countries${opts.region ? ` (region=${opts.region})` : ''}${opts.income ? ` (income=${opts.income})` : ''}`);
  console.log(`   showing ${rows.length} of ${all.length}\n`);
  for (const c of rows) {
    console.log(`   ${c.id.padEnd(4)} ${(c.iso2Code || '').padEnd(3)} ${(c.region?.value || '-').slice(0, 28).padEnd(28)} ${(c.incomeLevel?.value || '-').slice(0, 22).padEnd(22)} ${c.name}`);
  }
}

async function cmdCompare(indicator, countriesArg, opts = {}) {
  if (!indicator || !countriesArg) throw new Error('Usage: compare <indicator> <country1,country2,...> [--year=YYYY]');
  const countries = countriesArg.split(',').map(s => s.trim()).filter(Boolean);
  const year = opts.year || (new Date().getUTCFullYear() - 1);
  const params = { date: `${year - 4}:${year}` };
  const path = `/country/${countries.join(';')}/indicator/${indicator}`;
  const rows = await fetchAllPages(path, params);
  // Pick most recent non-null for each country in the window
  const byCountry = {};
  for (const r of rows) {
    if (r.value === null) continue;
    const k = r.countryiso3code || r.country?.id;
    if (!byCountry[k] || r.date > byCountry[k].date) byCountry[k] = r;
  }
  const list = Object.values(byCountry).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  if (!list.length) { console.log(`# World Bank compare — ${indicator}\n   (no data for any country in window ${year-4}-${year})`); return; }
  console.log(`# World Bank compare — ${list[0].indicator?.value}`);
  console.log(`   indicator: ${list[0].indicator?.id}    target year: ${year} (latest available within ±5y)\n`);
  for (const r of list) {
    console.log(`   ${(r.country?.value || r.countryiso3code).padEnd(28)} ${fmtNum(r.value).padStart(14)}    (${r.date})`);
  }
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
  worldbank.mjs search "<query>" [--limit=N]
  worldbank.mjs view <indicator>                                      (e.g. NY.GDP.MKTP.CD)
  worldbank.mjs fetch <country> <indicator> [--from=YYYY] [--to=YYYY] (country = ISO3 like USA, DEU, BRA)
  worldbank.mjs countries [--region=...] [--income=...]
  worldbank.mjs compare <indicator> <country1,country2,...> [--year=YYYY]

Common indicators:
  NY.GDP.MKTP.CD       Nominal GDP (USD)
  NY.GDP.PCAP.CD       GDP per capita (USD)
  NY.GDP.MKTP.KD.ZG    Annual GDP growth (%)
  FP.CPI.TOTL.ZG       Inflation, consumer prices (annual %)
  SL.UEM.TOTL.ZS       Unemployment, total (% of labor force)
  SP.POP.TOTL          Population, total
  EN.ATM.CO2E.PC       CO2 emissions (metric tons per capita)

Data dir: ${DATA_DIR}
No auth. Polite throttle (~4 req/s).
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'search':    await cmdSearch(flags.positional[0], flags); break;
      case 'view':      await cmdView(flags.positional[0]); break;
      case 'fetch':     await cmdFetch(flags.positional[0], flags.positional[1], flags); break;
      case 'countries': await cmdCountries(flags); break;
      case 'compare':   await cmdCompare(flags.positional[0], flags.positional[1], flags); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':    usage(); break;
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
