#!/usr/bin/env node
// sec-edgar-filings.mjs — SEC EDGAR Submissions API wrapper.
//
// Endpoints:
//   https://www.sec.gov/files/company_tickers.json     — ticker → CIK map
//   https://data.sec.gov/submissions/CIK{10}.json      — every filing for one company
//   https://data.sec.gov/submissions/<file>.json       — older filings (paginated)
//
// No auth. SEC requires a contact User-Agent and limits to 10 req/sec.
//
// Commands:
//   lookup <ticker-or-name>                 — resolve to CIK + company name
//   list <ticker-or-cik> [filters]          — list filings (form/date filtered)
//   recent <ticker-or-cik> [--days=N]       — filings in last N days
//   insiders <ticker-or-cik> [--limit=N]    — Form 4 (insider transactions) only
//   view <ticker-or-cik> <accession>        — URLs for one filing

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/sec-edgar');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const CONTACT = process.env.SEC_EDGAR_CONTACT || 'showrun-skills@showrun.co';
const USER_AGENT = `showrun-sec-edgar/1.0 (${CONTACT})`;
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 110;          // ~9 req/s, under SEC's 10/s cap
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const TICKERS_TTL_MS = 24 * 3600_000;

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function cikPad(n) { return String(n).replace(/^CIK/i,'').replace(/^0+/,'').padStart(10, '0'); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function fetchJson(url) {
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
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}  (${url})`);
    }
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 404) throw new Error(`HTTP 404 (not found): ${url}`);
    throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

// ---------------------------------------------------------------------------
// Ticker → CIK resolution
// ---------------------------------------------------------------------------

async function loadTickers() {
  const cacheFile = resolve(CACHE_DIR, 'tickers.json');
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TICKERS_TTL_MS)) {
    return loadJson(cacheFile, null);
  }
  const data = await fetchJson(TICKERS_URL);
  saveJson(cacheFile, data);
  return data;
}

async function resolveCik(query) {
  if (!query) throw new Error('lookup requires a ticker, name, or CIK');
  const q = String(query).trim();
  // CIK number?
  if (/^\d+$/.test(q) || /^CIK\d+$/i.test(q)) {
    const cik = cikPad(q);
    return { cik, ticker: null, name: null, source: 'cik' };
  }
  const tickers = await loadTickers();
  const rows = Object.values(tickers);
  // Exact ticker match
  const upper = q.toUpperCase();
  const exact = rows.find(r => r.ticker.toUpperCase() === upper);
  if (exact) return { cik: cikPad(exact.cik_str), ticker: exact.ticker, name: exact.title, source: 'ticker' };
  // Fuzzy name match (case-insensitive substring)
  const lc = q.toLowerCase();
  const matches = rows.filter(r => r.title.toLowerCase().includes(lc));
  if (matches.length === 1) return { cik: cikPad(matches[0].cik_str), ticker: matches[0].ticker, name: matches[0].title, source: 'name' };
  if (matches.length > 1) return { ambiguous: true, matches: matches.slice(0, 20) };
  return { notFound: true };
}

async function cmdLookup(query) {
  const r = await resolveCik(query);
  if (r.notFound) { console.log(`# SEC EDGAR lookup — "${query}"\n   no public-company match. Try sec-edgar-search.mjs company "${query}" for private filers.`); return; }
  if (r.ambiguous) {
    console.log(`# SEC EDGAR lookup — "${query}"  (${r.matches.length}+ matches; first 20)\n`);
    for (const m of r.matches) console.log(`   CIK ${cikPad(m.cik_str)}  ${m.ticker.padEnd(6)} ${m.title}`);
    return;
  }
  console.log(`# SEC EDGAR lookup — "${query}"\n   CIK:    ${r.cik}\n   ticker: ${r.ticker || '(n/a)'}\n   name:   ${r.name || '(unknown)'}`);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

async function fetchSubmissions(cik) {
  const cacheFile = resolve(CACHE_DIR, `submissions-CIK${cik}.json`);
  // Submissions update frequently; cache for 1h only
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < 3600_000)) return loadJson(cacheFile, null);
  const data = await fetchJson(`${SUBMISSIONS_BASE}/CIK${cik}.json`);
  saveJson(cacheFile, data);
  return data;
}

async function fetchSubmissionsFile(name) {
  const cacheFile = resolve(CACHE_DIR, `submissions-${name}`);
  if (existsSync(cacheFile)) return loadJson(cacheFile, null);  // older files are immutable
  const data = await fetchJson(`${SUBMISSIONS_BASE}/${name}`);
  saveJson(cacheFile, data);
  return data;
}

// Flatten parallel-array filings.recent (or older file) into row objects.
function flattenFilings(block) {
  const n = block.accessionNumber?.length || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      accession: block.accessionNumber[i],
      filingDate: block.filingDate[i],
      reportDate: block.reportDate?.[i] || '',
      form: block.form[i],
      primaryDocument: block.primaryDocument?.[i] || '',
      primaryDocDescription: block.primaryDocDescription?.[i] || '',
      size: block.size?.[i] || 0,
      isXBRL: !!block.isXBRL?.[i],
    });
  }
  return out;
}

async function gatherFilings(cik, opts = {}) {
  const sub = await fetchSubmissions(cik);
  let rows = flattenFilings(sub.filings.recent);
  // If user wants older filings (--limit > recent or --from is far back), pull the older files
  const needOlder = (opts.limit && opts.limit > rows.length) ||
                    (opts.from && rows.length && opts.from < rows[rows.length-1].filingDate);
  if (needOlder && sub.filings.files?.length) {
    for (const f of sub.filings.files) {
      const block = await fetchSubmissionsFile(f.name);
      rows = rows.concat(flattenFilings(block));
      if (rows.length >= 5000) break;  // safety cap
    }
  }
  return { meta: { cik: sub.cik, name: sub.name, tickers: sub.tickers, sic: sub.sic, sicDescription: sub.sicDescription, exchanges: sub.exchanges }, rows };
}

function applyFilters(rows, opts = {}) {
  let out = rows;
  if (opts.forms) {
    const set = new Set(opts.forms.split(',').map(s => s.trim().toUpperCase()));
    out = out.filter(r => set.has(r.form.toUpperCase()));
  } else if (opts.form) {
    const f = opts.form.toUpperCase();
    out = out.filter(r => r.form.toUpperCase() === f);
  }
  if (opts.from) out = out.filter(r => r.filingDate >= opts.from);
  if (opts.to)   out = out.filter(r => r.filingDate <= opts.to);
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

function formatRows(rows) {
  return rows.map(r => `   ${r.filingDate}  ${r.form.padEnd(10)} ${r.accession}  ${r.primaryDocDescription || ''}`).join('\n');
}

async function cmdList(query, opts = {}) {
  if (!query) throw new Error('Usage: list <ticker-or-cik> [--form=10-K] [--forms=10-K,8-K] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]');
  const r = await resolveCik(query);
  if (r.notFound || r.ambiguous) { await cmdLookup(query); return; }
  const limit = opts.limit || 50;
  const { meta, rows } = await gatherFilings(r.cik, { ...opts, limit: Math.max(limit, 1000) });
  const filtered = applyFilters(rows, { ...opts, limit });
  const cacheFile = resolve(CACHE_DIR, `filings-list-${r.cik}-${slug(opts.forms||opts.form||'all')}-${opts.from||''}-${opts.to||''}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), query, cik: r.cik, meta, rows: filtered });
  console.log(`# SEC EDGAR filings — ${meta.name || query}  (CIK ${r.cik})`);
  if (meta.tickers?.length) console.log(`   tickers: ${meta.tickers.join(', ')}    SIC: ${meta.sic} ${meta.sicDescription || ''}`);
  console.log(`   filter: form=${opts.forms || opts.form || 'any'}  from=${opts.from || '-'}  to=${opts.to || '-'}  limit=${limit}\n`);
  if (!filtered.length) { console.log('   (no filings match)'); return; }
  console.log(formatRows(filtered));
  console.log(`\n   ${filtered.length} of ${rows.length} loaded filings shown\nCached: ${cacheFile}`);
}

async function cmdRecent(query, opts = {}) {
  if (!query) throw new Error('Usage: recent <ticker-or-cik> [--days=30] [--form=10-K] [--limit=N]');
  const days = parseInt(opts.days || 30, 10);
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0,10);
  await cmdList(query, { ...opts, from, limit: opts.limit || 100 });
}

async function cmdInsiders(query, opts = {}) {
  if (!query) throw new Error('Usage: insiders <ticker-or-cik> [--limit=N]');
  await cmdList(query, { form: '4', limit: opts.limit || 50 });
}

async function cmdView(query, accession) {
  if (!query || !accession) throw new Error('Usage: view <ticker-or-cik> <accession>');
  const r = await resolveCik(query);
  if (r.notFound || r.ambiguous) { await cmdLookup(query); return; }
  const { meta, rows } = await gatherFilings(r.cik, { limit: 5000 });
  const accn = accession.trim();
  const row = rows.find(x => x.accession === accn);
  const cikInt = parseInt(r.cik, 10);
  const accnNoDash = accn.replace(/-/g, '');
  const indexUrl = `${ARCHIVES_BASE}/${cikInt}/${accnNoDash}/${accn}-index.htm`;
  console.log(`# SEC EDGAR filing — ${meta.name || query}  (${accn})`);
  if (row) {
    console.log(`   form:        ${row.form}`);
    console.log(`   filing date: ${row.filingDate}    report date: ${row.reportDate || '-'}`);
    console.log(`   description: ${row.primaryDocDescription || '-'}`);
    if (row.primaryDocument) console.log(`   primary doc: ${ARCHIVES_BASE}/${cikInt}/${accnNoDash}/${row.primaryDocument}`);
    console.log(`   index page:  ${indexUrl}`);
    console.log(`   XBRL:        ${row.isXBRL ? 'yes' : 'no'}    size: ${row.size.toLocaleString()} bytes`);
  } else {
    console.log(`   (accession not found in submissions; printing canonical URLs anyway)`);
    console.log(`   index page:  ${indexUrl}`);
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
  sec-edgar-filings.mjs lookup <ticker-or-name>
  sec-edgar-filings.mjs list <ticker-or-cik> [--form=10-K | --forms=10-K,8-K] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]
  sec-edgar-filings.mjs recent <ticker-or-cik> [--days=30] [--form=...] [--limit=N]
  sec-edgar-filings.mjs insiders <ticker-or-cik> [--limit=N]
  sec-edgar-filings.mjs view <ticker-or-cik> <accession>

Data dir: ${DATA_DIR}
SEC requires a contact User-Agent — defaults to showrun-skills@showrun.co; override via SEC_EDGAR_CONTACT env var. Rate-limit: 10 req/s.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'lookup':   await cmdLookup(flags.positional[0]); break;
      case 'list':     await cmdList(flags.positional[0], flags); break;
      case 'recent':   await cmdRecent(flags.positional[0], flags); break;
      case 'insiders': await cmdInsiders(flags.positional[0], flags); break;
      case 'view':     await cmdView(flags.positional[0], flags.positional[1]); break;
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
