#!/usr/bin/env node
// http-archive.mjs — HTTP Archive (httparchive.org) wrapper.
//
// Two access paths:
//   1. BigQuery REST API — POST https://bigquery.googleapis.com/bigquery/v2/projects/<project>/queries
//      Auth: OAuth2 access token via gcloud (or service account). Bearer token.
//   2. Public dashboard JSON — GET https://cdn.httparchive.org/reports/<id>.json (no auth).
//
// Requires Node 22+ (built-in fetch). Stdlib only.
//
// Onboarding (one-time):
//   1) gcloud init                                # pick a GCP project
//   2) gcloud auth application-default login      # browser OAuth
//   3) gcloud config set project <PROJECT_ID>     # set default project
//   4) node scripts/http-archive.mjs setup        # populates auth.json
//
// BigQuery sandbox is free for 1 TB / month — but the project still needs
// a billing account or sandbox-enabled state, otherwise queries 403.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/http-archive');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_FILE = resolve(DATA_DIR, 'auth.json');
const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const REPORTS_BASE = 'https://cdn.httparchive.org/v1/static/reports';
const USER_AGENT = 'http-archive-skill/1.0';
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(path, fb) { if (!existsSync(path)) return fb; try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fb; } }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g,'').slice(0,80); }

function loadAuth() {
  const a = loadJson(AUTH_FILE, {});
  const project = process.env.HTTP_ARCHIVE_GCP_PROJECT || a.project;
  const token = process.env.HTTP_ARCHIVE_ACCESS_TOKEN || a.token;
  const expires = a.token_expires_at;
  return { project, token, expires };
}

function maskToken(t) {
  if (!t) return '(none)';
  if (t.length < 12) return '***';
  return t.slice(0,4) + '...' + t.slice(-4) + ` (${t.length} chars)`;
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return String(n);
  const u = ['B','KB','MB','GB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

function fmtNum(n) {
  if (n == null) return 'null';
  const v = Number(n);
  if (isNaN(v)) return String(n);
  return v.toLocaleString();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function bqQuery(sql, opts = {}) {
  const { project, token } = loadAuth();
  if (!project) throw new Error('No GCP project. Run `setup` or set HTTP_ARCHIVE_GCP_PROJECT env var.');
  if (!token)   throw new Error('No access token. Run `setup` or set HTTP_ARCHIVE_ACCESS_TOKEN env var.');
  const url = `${BQ_BASE}/projects/${encodeURIComponent(project)}/queries`;
  const body = {
    query: sql,
    useLegacySql: false,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxResults: opts.maxResults ?? 1000,
  };
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 400);
    const reason = json?.error?.errors?.[0]?.reason || '';
    let hint = '';
    if (/billing/i.test(msg)) hint = '\n  hint: enable BigQuery sandbox or attach a billing account to your GCP project.';
    if (/not been used|disabled/i.test(msg)) hint = '\n  hint: enable the BigQuery API at https://console.cloud.google.com/apis/library/bigquery.googleapis.com';
    if (res.status === 401) hint = '\n  hint: token expired? Re-run `setup` (gcloud tokens last ~1h).';
    throw new Error(`BigQuery ${res.status} (${reason}): ${msg}${hint}`);
  }
  return json;
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { headers:{'Accept':'application/json','User-Agent':USER_AGENT}, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Result table rendering
// ---------------------------------------------------------------------------

function rowsFromBQResult(json) {
  const fields = json?.schema?.fields || [];
  const out = [];
  for (const r of (json.rows || [])) {
    const obj = {};
    (r.f || []).forEach((cell, i) => {
      const fname = fields[i]?.name || `c${i}`;
      obj[fname] = cell?.v ?? null;
    });
    out.push(obj);
  }
  return { fields: fields.map(f => f.name), rows: out };
}

function printTable(fields, rows, opts={}) {
  if (!rows.length) { console.log('(no rows)'); return; }
  const widths = fields.map(f => f.length);
  const view = rows.map(r => fields.map((f,i) => {
    const v = r[f] == null ? '' : (typeof r[f] === 'object' ? JSON.stringify(r[f]) : String(r[f]));
    if (v.length > widths[i]) widths[i] = Math.min(v.length, opts.maxColW ?? 60);
    return v;
  }));
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const headerL = '| ' + fields.map((f,i) => f.padEnd(widths[i])).join(' | ') + ' |';
  console.log(headerL);
  console.log(sep);
  for (const row of view) {
    console.log('| ' + row.map((v,i) => v.length > widths[i] ? v.slice(0, widths[i]-1) + '…' : v.padEnd(widths[i])).join(' | ') + ' |');
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSetup() {
  ensureDir(DATA_DIR);
  console.log('# http-archive setup\n');
  let project, token;
  // Try env first
  if (process.env.HTTP_ARCHIVE_GCP_PROJECT) {
    project = process.env.HTTP_ARCHIVE_GCP_PROJECT.trim();
    console.log(`  project (from env): ${project}`);
  }
  if (process.env.HTTP_ARCHIVE_ACCESS_TOKEN) {
    token = process.env.HTTP_ARCHIVE_ACCESS_TOKEN.trim();
    console.log(`  token   (from env): ${maskToken(token)}`);
  }
  // Fall back to gcloud
  if (!project) {
    try {
      const out = execFileSync('gcloud', ['config','get-value','project'], { stdio:['ignore','pipe','pipe'] });
      project = String(out).trim();
      if (project && !/^\(unset\)/i.test(project)) console.log(`  project (gcloud): ${project}`);
      else { project = null; console.log('  project (gcloud): (unset) — run `gcloud config set project <id>`'); }
    } catch (e) {
      console.log(`  project: gcloud not found — install Google Cloud SDK first.`);
      console.log(`           https://cloud.google.com/sdk/docs/install`);
    }
  }
  if (!token) {
    try {
      const out = execFileSync('gcloud', ['auth','application-default','print-access-token'], { stdio:['ignore','pipe','pipe'] });
      token = String(out).trim();
      console.log(`  token   (gcloud): ${maskToken(token)}`);
    } catch (e) {
      const msg = (e.stderr ? String(e.stderr) : e.message).split('\n')[0];
      console.log(`  token: could not fetch — ${msg}`);
      console.log(`         run: gcloud auth application-default login`);
    }
  }
  // gcloud tokens are short-lived (~1 hour). Pre-compute expiry.
  const expires_at = token ? new Date(Date.now() + 55*60*1000).toISOString() : null;
  if (project || token) {
    saveJson(AUTH_FILE, { project: project || null, token: token || null, token_expires_at: expires_at });
    console.log(`\n  wrote: ${AUTH_FILE}`);
    if (expires_at) console.log(`  token expires_at (estimated): ${expires_at}`);
  }
  if (!project || !token) {
    console.log(`\n  Onboarding (3 steps):`);
    console.log(`    1) gcloud init`);
    console.log(`    2) gcloud auth application-default login`);
    console.log(`    3) gcloud config set project <PROJECT_ID>`);
    console.log(`    then re-run: http-archive.mjs setup`);
    process.exit(1);
  }
}

async function cmdQuery(sql, opts={}) {
  if (!sql) throw new Error('Usage: query "<SQL>" [--limit=100]');
  const limit = opts.limit ?? 100;
  // Append LIMIT if user didn't specify and SQL doesn't already have one
  let q = sql;
  if (!/\blimit\b/i.test(q)) q = `${q.replace(/;\s*$/,'')} LIMIT ${limit}`;
  console.log(`# BigQuery query  (limit=${limit})\n`);
  const json = await bqQuery(q, { maxResults: limit });
  const cacheFile = resolve(CACHE_DIR, `query-${slug(q).slice(0,40)}-${Date.now()}.json`);
  saveJson(cacheFile, json);
  const { fields, rows } = rowsFromBQResult(json);
  console.log(`  rows: ${rows.length}  (totalRows=${json.totalRows ?? '?'}, bytesProcessed=${fmtBytes(json.totalBytesProcessed)})`);
  console.log('');
  printTable(fields, rows);
  console.log(`\n  cached: ${cacheFile}`);
}

async function cmdPage(url, opts={}) {
  if (!url) throw new Error('Usage: page <url> [--month=YYYY-MM] [--device=mobile|desktop]');
  const device = opts.device || 'mobile';
  // Resolve month: default to "most recent available" — query crawl.pages.
  // crawl.pages is partitioned by `date` (DATE column).
  const monthRaw = opts.month;
  let datePred;
  if (monthRaw) {
    // accept YYYY-MM or YYYY-MM-DD
    const m = monthRaw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) throw new Error('--month must be YYYY-MM or YYYY-MM-DD');
    const day = m[3] || '01';
    datePred = `DATE '${m[1]}-${m[2]}-${day}'`;
  } else {
    datePred = `(SELECT MAX(date) FROM \`httparchive.crawl.pages\`)`;
  }
  const u = url.startsWith('http') ? url : `https://${url}`;
  // Match either http or https variants of the URL with optional trailing slash.
  const sql = `
SELECT
  date, client, page,
  SAFE_CAST(JSON_VALUE(summary, '$.bytesTotal') AS INT64)        AS bytes_total,
  SAFE_CAST(JSON_VALUE(summary, '$.reqTotal')   AS INT64)        AS req_total,
  SAFE_CAST(JSON_VALUE(summary, '$.bytesImg')   AS INT64)        AS bytes_img,
  SAFE_CAST(JSON_VALUE(summary, '$.bytesJS')    AS INT64)        AS bytes_js,
  SAFE_CAST(JSON_VALUE(summary, '$.bytesCSS')   AS INT64)        AS bytes_css,
  SAFE_CAST(JSON_VALUE(summary, '$.bytesHtml')  AS INT64)        AS bytes_html,
  SAFE_CAST(JSON_VALUE(summary, '$.reqImg')     AS INT64)        AS req_img,
  SAFE_CAST(JSON_VALUE(summary, '$.reqJS')      AS INT64)        AS req_js,
  SAFE_CAST(JSON_VALUE(summary, '$.reqCSS')     AS INT64)        AS req_css,
  SAFE_CAST(JSON_VALUE(summary, '$.TTFB')       AS INT64)        AS ttfb_ms,
  SAFE_CAST(JSON_VALUE(summary, '$.renderStart') AS INT64)       AS render_start_ms,
  SAFE_CAST(JSON_VALUE(summary, '$.fullyLoaded') AS INT64)       AS fully_loaded_ms,
  SAFE_CAST(JSON_VALUE(summary, '$._cpu.total') AS FLOAT64)      AS cpu_total_ms
FROM \`httparchive.crawl.pages\`
WHERE date = ${datePred}
  AND client = '${device}'
  AND (page = '${u.replace(/'/g,"\\'")}' OR page = '${u.replace(/'/g,"\\'")}/')
LIMIT 5`;
  console.log(`# http-archive page — ${u}  (device=${device}, month=${monthRaw || 'latest'})\n`);
  const json = await bqQuery(sql);
  saveJson(resolve(CACHE_DIR, `page-${slug(u)}-${device}-${monthRaw||'latest'}.json`), json);
  const { fields, rows } = rowsFromBQResult(json);
  if (!rows.length) {
    console.log('  no row found — URL may not have been crawled. Try other device, or strip query/fragment.');
    return;
  }
  const r = rows[0];
  console.log(`  date:           ${r.date}`);
  console.log(`  client:         ${r.client}`);
  console.log(`  page:           ${r.page}`);
  console.log(`  bytes_total:    ${fmtBytes(r.bytes_total)}`);
  console.log(`  req_total:      ${fmtNum(r.req_total)}`);
  console.log(`  bytes_img:      ${fmtBytes(r.bytes_img)} (${fmtNum(r.req_img)} reqs)`);
  console.log(`  bytes_js:       ${fmtBytes(r.bytes_js)} (${fmtNum(r.req_js)} reqs)`);
  console.log(`  bytes_css:      ${fmtBytes(r.bytes_css)} (${fmtNum(r.req_css)} reqs)`);
  console.log(`  bytes_html:     ${fmtBytes(r.bytes_html)}`);
  console.log(`  TTFB:           ${fmtNum(r.ttfb_ms)} ms`);
  console.log(`  render_start:   ${fmtNum(r.render_start_ms)} ms`);
  console.log(`  fully_loaded:   ${fmtNum(r.fully_loaded_ms)} ms`);
  console.log(`  cpu_total:      ${fmtNum(r.cpu_total_ms)} ms`);
}

async function cmdTech(site, opts={}) {
  if (!site) throw new Error('Usage: tech <site> [--month=YYYY-MM]');
  const monthRaw = opts.month;
  let datePred;
  if (monthRaw) {
    const m = monthRaw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) throw new Error('--month must be YYYY-MM');
    datePred = `DATE '${m[1]}-${m[2]}-${m[3]||'01'}'`;
  } else {
    datePred = `(SELECT MAX(date) FROM \`httparchive.technologies.technologies\`)`;
  }
  const u = site.startsWith('http') ? site : `https://${site}`;
  const sql = `
SELECT date, client, app AS technology, ARRAY_TO_STRING(category, ', ') AS categories
FROM \`httparchive.technologies.technologies\`
WHERE date = ${datePred}
  AND (url = '${u.replace(/'/g,"\\'")}' OR url = '${u.replace(/'/g,"\\'")}/')
ORDER BY client, categories, technology
LIMIT 500`;
  console.log(`# http-archive tech — ${u}  (month=${monthRaw || 'latest'})\n`);
  const json = await bqQuery(sql, { maxResults: 500 });
  saveJson(resolve(CACHE_DIR, `tech-${slug(u)}-${monthRaw||'latest'}.json`), json);
  const { rows } = rowsFromBQResult(json);
  if (!rows.length) {
    console.log('  no detected technologies (URL may not be in the crawl, or wrong month).');
    return;
  }
  // Group by client → category
  const byClient = {};
  for (const r of rows) {
    const c = r.client || '?';
    const cat = r.categories || '(uncategorized)';
    byClient[c] ??= {};
    byClient[c][cat] ??= [];
    byClient[c][cat].push(r.technology);
  }
  for (const [client, cats] of Object.entries(byClient)) {
    console.log(`  --- client: ${client} ---`);
    for (const [cat, techs] of Object.entries(cats)) {
      console.log(`  ${cat}:`);
      for (const t of techs) console.log(`    - ${t}`);
    }
    console.log('');
  }
}

async function cmdTopTech(opts={}) {
  const monthRaw = opts.month;
  const limit = opts.limit ?? 50;
  const category = opts.category;
  let datePred;
  if (monthRaw) {
    const m = monthRaw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) throw new Error('--month must be YYYY-MM');
    datePred = `DATE '${m[1]}-${m[2]}-${m[3]||'01'}'`;
  } else {
    datePred = `(SELECT MAX(date) FROM \`httparchive.technologies.technologies\`)`;
  }
  const catFilter = category
    ? `AND EXISTS (SELECT 1 FROM UNNEST(category) AS c WHERE LOWER(c) = LOWER('${category.replace(/'/g,"\\'")}'))`
    : '';
  const sql = `
SELECT app AS technology,
       ARRAY_TO_STRING(ANY_VALUE(category), ', ') AS categories,
       COUNT(DISTINCT url) AS sites
FROM \`httparchive.technologies.technologies\`
WHERE date = ${datePred}
  AND client = 'mobile'
  ${catFilter}
GROUP BY technology
ORDER BY sites DESC
LIMIT ${Number(limit)}`;
  console.log(`# http-archive top-tech  (month=${monthRaw || 'latest'}, category=${category || 'ALL'}, limit=${limit})\n`);
  const json = await bqQuery(sql, { maxResults: limit });
  saveJson(resolve(CACHE_DIR, `top-tech-${slug(category||'all')}-${monthRaw||'latest'}.json`), json);
  const { fields, rows } = rowsFromBQResult(json);
  console.log(`  bytesProcessed: ${fmtBytes(json.totalBytesProcessed)}\n`);
  printTable(fields, rows);
}

async function cmdTrend(selectClause, whereClause, opts={}) {
  if (!selectClause) throw new Error('Usage: trend "<SELECT clause>" "<WHERE clause>" [--months=12]');
  const months = Number(opts.months || 12);
  // Build a UNION ALL across the last N months from crawl.pages, partitioned by month.
  const today = new Date();
  const dates = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    dates.push(`${yyyy}-${mm}-01`);
  }
  // Use a single query with `date IN (...)` — efficient because crawl.pages is partitioned.
  const inList = dates.map(d => `DATE '${d}'`).join(', ');
  const where = whereClause ? `AND (${whereClause})` : '';
  const sql = `
SELECT date, ${selectClause}
FROM \`httparchive.crawl.pages\`
WHERE date IN (${inList})
  ${where}
GROUP BY date
ORDER BY date ASC`;
  console.log(`# http-archive trend  (months=${months})\n`);
  console.log(`  SQL: ${sql.trim().replace(/\s+/g,' ')}\n`);
  const json = await bqQuery(sql, { maxResults: months * 4 });
  saveJson(resolve(CACHE_DIR, `trend-${slug(selectClause)}-${months}mo.json`), json);
  const { fields, rows } = rowsFromBQResult(json);
  console.log(`  bytesProcessed: ${fmtBytes(json.totalBytesProcessed)}\n`);
  printTable(fields, rows);
}

async function cmdReport(reportId) {
  if (!reportId) throw new Error('Usage: report <metric-id>  e.g. bytesTotal, reqJs, fcp\n  optional lens prefix: top1k/bytesTotal');
  // Real endpoint discovered from timeseries.js:
  //   https://cdn.httparchive.org/v1/static/reports/[<lens>/]<metric>.json
  // Where <metric> is one of: bytesTotal, reqTotal, bytesJs, reqJs, bytesCss, reqCss,
  // bytesImg, reqImg, bytesHtml, bytesFont, reqFont, bytesVideo, reqVideo, fcp, lcp,
  // inp, cls, ttfb, etc. Optional <lens>: top1k, top10k, top100k, top1m, wordpress,
  // drupal, magento.
  const url = `${REPORTS_BASE}/${reportId}.json`;
  console.log(`# http-archive report — ${reportId}\n  url: ${url}`);
  let json;
  try {
    json = await getJSON(url);
  } catch (e) {
    console.log(`  fail: ${e.message.slice(0,200)}`);
    console.log(`\n  Discovery flow:`);
    console.log(`    1) open https://httparchive.org/reports/page-weight in browser`);
    console.log(`    2) DevTools → Network → look for cdn.httparchive.org/v1/static/reports/<id>.json`);
    console.log(`    3) common metric ids: bytesTotal, reqTotal, bytesJs, reqJs, bytesCss, reqCss,`);
    console.log(`       bytesImg, reqImg, bytesHtml, bytesFont, reqFont, bytesVideo, fcp, lcp, inp, cls, ttfb`);
    console.log(`    4) lens prefix: top1k/bytesTotal, top10k/bytesTotal, wordpress/bytesTotal, etc.`);
    throw e;
  }
  saveJson(resolve(CACHE_DIR, `report-${slug(reportId)}.json`), json);
  const isArr = Array.isArray(json);
  console.log(`  ok  (${isArr ? `array of ${json.length} rows` : `object with keys: ${Object.keys(json).slice(0,20).join(', ')}`})`);
  if (isArr && json.length) {
    // Each row is typically {date, client, p10, p25, p50, p75, p90, urls?}
    const fields = Object.keys(json[0]);
    console.log(`  fields: ${fields.join(', ')}`);
    // Show last 6 rows as a quick preview (most recent values)
    const sorted = [...json].sort((a,b) => String(b.date).localeCompare(String(a.date)));
    const preview = sorted.slice(0, 8);
    console.log('');
    printTable(fields, preview);
    console.log(`\n  (showing latest 8 of ${json.length} rows; full data in cache)`);
  } else {
    const sample = JSON.stringify(json, null, 2);
    console.log(`\n  --- first 800 chars ---\n${sample.slice(0,800)}${sample.length>800?'\n...':''}`);
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
  if (out.months) out.months = parseInt(out.months, 10);
  return out;
}

function usage() {
  console.log(`Usage:
  http-archive.mjs setup
  http-archive.mjs query "<SQL>" [--limit=100]
  http-archive.mjs page <url> [--month=YYYY-MM] [--device=mobile|desktop]
  http-archive.mjs tech <site> [--month=YYYY-MM]
  http-archive.mjs top-tech [--category=Analytics] [--month=YYYY-MM] [--limit=50]
  http-archive.mjs trend "<SELECT clause>" "<WHERE clause>" [--months=12]
  http-archive.mjs report <report-id>

Auth (one-time):
  gcloud init
  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>
  http-archive.mjs setup

Env overrides:
  HTTP_ARCHIVE_GCP_PROJECT      — project id (else gcloud config)
  HTTP_ARCHIVE_ACCESS_TOKEN     — bearer token (else gcloud ADC)

Data dir: ${DATA_DIR}
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'setup':    await cmdSetup(); break;
      case 'query':    await cmdQuery(flags.positional[0], flags); break;
      case 'page':     await cmdPage(flags.positional[0], flags); break;
      case 'tech':     await cmdTech(flags.positional[0], flags); break;
      case 'top-tech': await cmdTopTech(flags); break;
      case 'trend':    await cmdTrend(flags.positional[0], flags.positional[1], flags); break;
      case 'report':   await cmdReport(flags.positional[0]); break;
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
