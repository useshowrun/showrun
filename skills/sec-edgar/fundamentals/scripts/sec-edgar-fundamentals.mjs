#!/usr/bin/env node
// sec-edgar-fundamentals.mjs — SEC EDGAR XBRL Financial Data API.
//
// Endpoints (all under https://data.sec.gov):
//   /api/xbrl/companyfacts/CIK{10}.json                          — every XBRL fact for one company
//   /api/xbrl/companyconcept/CIK{10}/{taxonomy}/{Concept}.json   — one concept's time series
//   /api/xbrl/frames/{taxonomy}/{Concept}/{unit}/{period}.json   — one concept across all companies
//
// No auth. SEC requires a contact User-Agent and limits to 10 req/sec.
//
// Commands:
//   concepts <ticker-or-cik>                            — list available XBRL concepts
//   series <ticker-or-cik> <concept> [--unit=USD]       — time series of one concept
//   summary <ticker-or-cik>                             — key financials (latest annual values)
//   facts <ticker-or-cik> [--save=path]                 — fetch full companyfacts JSON
//   peer <concept> --period=CY2024Q4 [--unit=USD] [--top=N]  — cross-sectional peer comparison

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/sec-edgar');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const XBRL_BASE = 'https://data.sec.gov/api/xbrl';
const CONTACT = process.env.SEC_EDGAR_CONTACT || 'showrun-skills@showrun.co';
const USER_AGENT = `showrun-sec-edgar/1.0 (${CONTACT})`;
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 110;
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const TICKERS_TTL_MS = 24 * 3600_000;
const FACTS_TTL_MS = 24 * 3600_000;

// Headline concepts for `summary` — annual-reporting essentials.
const SUMMARY_CONCEPTS = [
  ['Revenues',                                'Revenue'],
  ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenue (ASC 606)'],
  ['CostOfRevenue',                           'Cost of revenue'],
  ['GrossProfit',                             'Gross profit'],
  ['OperatingIncomeLoss',                     'Operating income'],
  ['NetIncomeLoss',                           'Net income'],
  ['EarningsPerShareDiluted',                 'EPS (diluted)'],
  ['Assets',                                  'Total assets'],
  ['Liabilities',                             'Total liabilities'],
  ['StockholdersEquity',                      'Stockholders equity'],
  ['CashAndCashEquivalentsAtCarryingValue',   'Cash & equivalents'],
  ['LongTermDebt',                            'Long-term debt'],
  ['NetCashProvidedByUsedInOperatingActivities', 'Operating cash flow'],
];

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function cikPad(n) { return String(n).replace(/^CIK/i,'').replace(/^0+/,'').padStart(10, '0'); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return (n/1e9).toFixed(2)  + 'B';
  if (a >= 1e6)  return (n/1e6).toFixed(2)  + 'M';
  if (a >= 1e3)  return (n/1e3).toFixed(2)  + 'K';
  return Number(n).toLocaleString();
}

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
// Ticker → CIK
// ---------------------------------------------------------------------------

async function loadTickers() {
  const cacheFile = resolve(CACHE_DIR, 'tickers.json');
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TICKERS_TTL_MS)) return loadJson(cacheFile, null);
  const data = await fetchJson(TICKERS_URL);
  saveJson(cacheFile, data);
  return data;
}

async function resolveCik(query) {
  if (!query) throw new Error('requires a ticker, name, or CIK');
  const q = String(query).trim();
  if (/^\d+$/.test(q) || /^CIK\d+$/i.test(q)) return { cik: cikPad(q), ticker: null, name: null };
  const tickers = await loadTickers();
  const rows = Object.values(tickers);
  const upper = q.toUpperCase();
  const exact = rows.find(r => r.ticker.toUpperCase() === upper);
  if (exact) return { cik: cikPad(exact.cik_str), ticker: exact.ticker, name: exact.title };
  const lc = q.toLowerCase();
  const matches = rows.filter(r => r.title.toLowerCase().includes(lc));
  if (matches.length === 1) return { cik: cikPad(matches[0].cik_str), ticker: matches[0].ticker, name: matches[0].title };
  if (matches.length > 1) { const e = new Error(`ambiguous: ${matches.length} companies match "${query}"; pass CIK or exact ticker`); e.matches = matches.slice(0,10); throw e; }
  throw new Error(`no public-company match for "${query}"`);
}

// ---------------------------------------------------------------------------
// XBRL data
// ---------------------------------------------------------------------------

async function fetchCompanyFacts(cik) {
  const cacheFile = resolve(CACHE_DIR, `companyfacts-CIK${cik}.json`);
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < FACTS_TTL_MS)) return loadJson(cacheFile, null);
  const data = await fetchJson(`${XBRL_BASE}/companyfacts/CIK${cik}.json`);
  saveJson(cacheFile, data);
  return data;
}

async function fetchCompanyConcept(cik, taxonomy, concept) {
  const cacheFile = resolve(CACHE_DIR, `companyconcept-CIK${cik}-${slug(taxonomy)}-${slug(concept)}.json`);
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < FACTS_TTL_MS)) return loadJson(cacheFile, null);
  const data = await fetchJson(`${XBRL_BASE}/companyconcept/CIK${cik}/${taxonomy}/${concept}.json`);
  saveJson(cacheFile, data);
  return data;
}

async function fetchFrame(taxonomy, concept, unit, period) {
  const cacheFile = resolve(CACHE_DIR, `frames-${slug(taxonomy)}-${slug(concept)}-${slug(unit)}-${slug(period)}.json`);
  if (existsSync(cacheFile)) return loadJson(cacheFile, null);  // frames are immutable
  const data = await fetchJson(`${XBRL_BASE}/frames/${taxonomy}/${concept}/${unit}/${period}.json`);
  saveJson(cacheFile, data);
  return data;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdConcepts(query) {
  const r = await resolveCik(query);
  const facts = await fetchCompanyFacts(r.cik);
  const out = [];
  for (const tax of Object.keys(facts.facts || {})) {
    for (const [concept, info] of Object.entries(facts.facts[tax])) {
      const units = Object.keys(info.units || {});
      const totalPoints = units.reduce((s, u) => s + (info.units[u]?.length || 0), 0);
      out.push({ tax, concept, label: info.label, units, points: totalPoints });
    }
  }
  out.sort((a,b) => b.points - a.points);
  console.log(`# SEC EDGAR concepts — ${facts.entityName} (CIK ${r.cik})`);
  console.log(`   ${out.length} concepts across ${new Set(out.map(o=>o.tax)).size} taxonomies\n`);
  for (const c of out.slice(0, 60)) {
    console.log(`   [${c.tax.padEnd(8)}] ${c.concept.padEnd(48)} ${String(c.points).padStart(5)} pts  units=${c.units.join(',')}`);
  }
  if (out.length > 60) console.log(`   … ${out.length - 60} more (full list cached in companyfacts-CIK${r.cik}.json)`);
}

async function cmdSeries(query, concept, opts = {}) {
  if (!concept) throw new Error('Usage: series <ticker-or-cik> <concept> [--taxonomy=us-gaap] [--unit=USD] [--form=10-K] [--limit=N]');
  const r = await resolveCik(query);
  const taxonomy = opts.taxonomy || 'us-gaap';
  const data = await fetchCompanyConcept(r.cik, taxonomy, concept);
  const unit = opts.unit || Object.keys(data.units)[0];
  let points = data.units[unit] || [];
  if (!points.length) throw new Error(`no data for unit "${unit}". Available: ${Object.keys(data.units).join(', ')}`);
  if (opts.form) points = points.filter(p => p.form === opts.form);
  // Sort by end-date desc; deduplicate same end-date keeping the latest-filed
  points.sort((a,b) => (b.end||'').localeCompare(a.end||'') || (b.filed||'').localeCompare(a.filed||''));
  const seen = new Set(); const dedup = [];
  for (const p of points) { const k = `${p.end}-${p.fp}-${p.form}`; if (seen.has(k)) continue; seen.add(k); dedup.push(p); }
  const limit = opts.limit || 20;
  const shown = dedup.slice(0, limit);
  console.log(`# ${data.entityName} — ${data.label || concept}  (${taxonomy}/${concept}, unit=${unit})`);
  console.log(`   ${dedup.length} distinct periods${opts.form ? ` (form=${opts.form})` : ''} — showing ${shown.length}\n`);
  for (const p of shown) {
    const period = p.start ? `${p.start} → ${p.end}` : p.end;
    console.log(`   ${period.padEnd(25)} ${p.fp.padEnd(3)} ${p.form.padEnd(5)} ${fmtNum(p.val).padStart(12)}  filed ${p.filed}`);
  }
}

async function cmdSummary(query) {
  const r = await resolveCik(query);
  const facts = await fetchCompanyFacts(r.cik);
  console.log(`# SEC EDGAR summary — ${facts.entityName}  (CIK ${r.cik})\n`);
  const usgaap = facts.facts['us-gaap'] || {};
  const ifrs   = facts.facts['ifrs-full'] || {};
  for (const [concept, label] of SUMMARY_CONCEPTS) {
    const info = usgaap[concept] || ifrs[concept];
    if (!info) continue;
    const unit = Object.keys(info.units)[0];
    const pts = info.units[unit] || [];
    // Latest annual: form 10-K or 20-F, fp=FY (or any if no FY tag)
    const annual = pts.filter(p => ['10-K','20-F','40-F'].includes(p.form) && (p.fp === 'FY' || !p.start || (p.start && p.end && (Date.parse(p.end)-Date.parse(p.start)) > 300*86400_000)));
    annual.sort((a,b) => (b.end||'').localeCompare(a.end||''));
    const latest = annual[0];
    if (!latest) continue;
    const periodTag = latest.frame || `${latest.fy}${latest.fp}` || latest.end;
    console.log(`   ${label.padEnd(24)} ${fmtNum(latest.val).padStart(12)} ${unit.padEnd(4)}  ${periodTag.padEnd(10)}  (${latest.form})`);
  }
  console.log(`\n   source: companyfacts-CIK${r.cik}.json    use 'concepts' to list every available tag`);
}

async function cmdFacts(query, opts = {}) {
  const r = await resolveCik(query);
  const data = await fetchCompanyFacts(r.cik);
  if (opts.save) {
    saveJson(resolve(opts.save), data);
    console.log(`# SEC EDGAR companyfacts — ${data.entityName} (CIK ${r.cik})\n   saved to: ${resolve(opts.save)}`);
    return;
  }
  const taxes = Object.keys(data.facts || {});
  const total = taxes.reduce((s,t) => s + Object.keys(data.facts[t]).length, 0);
  console.log(`# SEC EDGAR companyfacts — ${data.entityName} (CIK ${r.cik})`);
  console.log(`   taxonomies: ${taxes.join(', ')}    total concepts: ${total}`);
  console.log(`   cached:     ${resolve(CACHE_DIR, `companyfacts-CIK${r.cik}.json`)}\n   pass --save=PATH to copy the JSON elsewhere.`);
}

async function cmdPeer(concept, opts = {}) {
  if (!concept || !opts.period) throw new Error('Usage: peer <concept> --period=CY2024Q4 [--taxonomy=us-gaap] [--unit=USD] [--top=N]');
  const taxonomy = opts.taxonomy || 'us-gaap';
  const unit = opts.unit || 'USD';
  const period = opts.period;
  const data = await fetchFrame(taxonomy, concept, unit, period);
  const rows = (data.data || []).slice().sort((a,b) => b.val - a.val);
  const top = opts.top ? parseInt(opts.top, 10) : 25;
  console.log(`# SEC EDGAR frames — ${data.label || concept}  (${taxonomy}/${concept}, unit=${unit}, ${period})`);
  console.log(`   ${rows.length} filers — top ${Math.min(top, rows.length)} by value\n`);
  for (const row of rows.slice(0, top)) {
    console.log(`   ${fmtNum(row.val).padStart(10)}  CIK ${cikPad(row.cik).padEnd(10)} ${row.entityName}`);
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
  sec-edgar-fundamentals.mjs concepts <ticker-or-cik>
  sec-edgar-fundamentals.mjs series <ticker-or-cik> <concept> [--taxonomy=us-gaap] [--unit=USD] [--form=10-K] [--limit=N]
  sec-edgar-fundamentals.mjs summary <ticker-or-cik>
  sec-edgar-fundamentals.mjs facts <ticker-or-cik> [--save=PATH]
  sec-edgar-fundamentals.mjs peer <concept> --period=CY2024Q4 [--taxonomy=us-gaap] [--unit=USD] [--top=N]

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
      case 'concepts': await cmdConcepts(flags.positional[0]); break;
      case 'series':   await cmdSeries(flags.positional[0], flags.positional[1], flags); break;
      case 'summary':  await cmdSummary(flags.positional[0]); break;
      case 'facts':    await cmdFacts(flags.positional[0], flags); break;
      case 'peer':     await cmdPeer(flags.positional[0], flags); break;
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
    if (e.matches) for (const m of e.matches) console.error(`   CIK ${cikPad(m.cik_str)}  ${m.ticker.padEnd(6)} ${m.title}`);
    process.exit(1);
  }
}

main();
