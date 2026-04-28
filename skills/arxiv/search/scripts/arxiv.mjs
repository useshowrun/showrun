#!/usr/bin/env node
// arxiv.mjs — arXiv search (Atom API) + site-wide stats (CSV endpoints).
//
// Two independent surfaces, both fully public, no auth:
//
// 1. Query API — documented at https://info.arxiv.org/help/api/user-manual.html
//    Base:   https://export.arxiv.org/api/query
//    Params: search_query, id_list, start, max_results (cap 2000),
//            sortBy (relevance|lastUpdatedDate|submittedDate),
//            sortOrder (ascending|descending)
//    Returns Atom 1.0 XML with opensearch + arxiv: namespaces.
//
//    Rate limit: arXiv asks for a 3s gap between requests. `search --page` and
//    multi-batch fetches in this script respect that.
//
// 2. Stats CSV endpoints — discovered from https://arxiv.org/stats/* (d3.csv(...))
//    /stats/get_monthly_submissions  → month,submissions,historical_delta
//    /stats/get_monthly_downloads    → month,downloads
//    /stats/get_hourly?date=YYYYMMDD → hourly breakdown for a given day
//
//    These power the charts at /stats/monthly_submissions, /stats/monthly_downloads,
//    and /stats/today. No documented API — URLs reverse-engineered from the page JS.
//
// Requires Node 22+ (built-in fetch). Stdlib only.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/arxiv');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const INDEX_FILE = resolve(CACHE_DIR, 'index.jsonl');

const API_BASE = 'https://export.arxiv.org/api/query';
const STATS_BASE = 'https://arxiv.org/stats';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) arxiv-skill/1.0 (+contact: eyup@showrun.co)';
const TIMEOUT_MS = 30_000;
const RATE_LIMIT_MS = 3000;          // arXiv asks for a 3s gap between API calls

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function loadJson(path, fallback) { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, 'utf8')); }
function appendIndex(row) { ensureDir(CACHE_DIR); appendFileSync(INDEX_FILE, JSON.stringify(row) + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let lastApiCall = 0;

async function httpGet(url, { asText = true, rateLimit = false } = {}) {
  if (rateLimit) {
    const gap = Date.now() - lastApiCall;
    if (gap < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - gap);
    lastApiCall = Date.now();
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  return asText ? await res.text() : Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Minimal Atom XML parser (stdlib-only)
// ---------------------------------------------------------------------------
//
// Handles the fields arXiv emits. Robust enough for well-formed Atom but not
// a full XML parser — unknown nesting is ignored, not crashed on.

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function extractAll(xml, tagName) {
  const rx = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'g');
  const out = [];
  let m;
  while ((m = rx.exec(xml)) !== null) out.push({ attrs: m[0].match(/<[^>]*>/)[0], body: m[1] });
  return out;
}

function extractOne(xml, tagName) {
  const rx = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`);
  const m = rx.exec(xml);
  return m ? { attrs: m[0].match(/<[^>]*>/)[0], body: m[1] } : null;
}

function extractSelfClosing(xml, tagName) {
  const rx = new RegExp(`<${tagName}\\b[^>]*/>`, 'g');
  const out = [];
  let m;
  while ((m = rx.exec(xml)) !== null) out.push(m[0]);
  return out;
}

function attr(tagStr, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tagStr);
  return m ? decodeEntities(m[1]) : null;
}

function text(node) {
  if (!node) return null;
  return decodeEntities(node.body.trim().replace(/\s+/g, ' '));
}

function parseFeed(xml) {
  const total = extractOne(xml, 'opensearch:totalResults');
  const start = extractOne(xml, 'opensearch:startIndex');
  const per = extractOne(xml, 'opensearch:itemsPerPage');
  const entries = extractAll(xml, 'entry').map(e => parseEntry(e.body));
  return {
    total: total ? parseInt(text(total), 10) : 0,
    start: start ? parseInt(text(start), 10) : 0,
    per_page: per ? parseInt(text(per), 10) : 0,
    entries,
  };
}

function parseEntry(body) {
  const idNode = extractOne(body, 'id');
  const id = idNode ? text(idNode) : null;                     // e.g. http://arxiv.org/abs/1706.03762v5
  const arxiv_id = id ? id.split('/').pop() : null;            // e.g. 1706.03762v5
  const arxiv_id_base = arxiv_id ? arxiv_id.replace(/v\d+$/, '') : null;

  // Links
  const linkTags = [
    ...extractSelfClosing(body, 'link'),
    ...extractAll(body, 'link').map(l => l.attrs),
  ];
  const links = linkTags.map(t => ({
    rel: attr(t, 'rel'), href: attr(t, 'href'), title: attr(t, 'title'), type: attr(t, 'type'),
  }));
  const pdfLink = links.find(l => l.title === 'pdf') || links.find(l => l.type === 'application/pdf');
  const absLink = links.find(l => l.rel === 'alternate' && l.type === 'text/html');
  const doiLink = links.find(l => l.title === 'doi');

  // Authors
  const authors = extractAll(body, 'author').map(a => {
    const name = extractOne(a.body, 'name');
    const aff = extractOne(a.body, 'arxiv:affiliation');
    return { name: name ? text(name) : null, affiliation: aff ? text(aff) : null };
  });

  // Categories
  const categories = [
    ...extractSelfClosing(body, 'category').map(t => attr(t, 'term')),
    ...extractAll(body, 'category').map(c => attr(c.attrs, 'term')),
  ].filter(Boolean);

  const primary = extractSelfClosing(body, 'arxiv:primary_category')[0]
                || (extractAll(body, 'arxiv:primary_category')[0] || {}).attrs;
  const primary_category = primary ? attr(primary, 'term') : null;

  const doi = text(extractOne(body, 'arxiv:doi'));
  const journal_ref = text(extractOne(body, 'arxiv:journal_ref'));
  const comment = text(extractOne(body, 'arxiv:comment'));

  return {
    arxiv_id,
    arxiv_id_base,
    title: text(extractOne(body, 'title')),
    summary: text(extractOne(body, 'summary')),
    authors,
    published: text(extractOne(body, 'published')),
    updated: text(extractOne(body, 'updated')),
    primary_category,
    categories,
    doi,
    journal_ref,
    comment,
    abs_url: absLink ? absLink.href : (id || null),
    pdf_url: pdfLink ? pdfLink.href : null,
    doi_url: doiLink ? doiLink.href : null,
  };
}

// ---------------------------------------------------------------------------
// arXiv query helpers
// ---------------------------------------------------------------------------

function buildQuery({ search, idList, start, maxResults, sortBy, sortOrder }) {
  const qs = new URLSearchParams();
  if (search) qs.set('search_query', search);
  if (idList) qs.set('id_list', idList);
  if (start != null) qs.set('start', String(start));
  if (maxResults != null) qs.set('max_results', String(maxResults));
  if (sortBy) qs.set('sortBy', sortBy);
  if (sortOrder) qs.set('sortOrder', sortOrder);
  return `${API_BASE}?${qs.toString()}`;
}

async function apiQuery(params) {
  const url = buildQuery(params);
  const xml = await httpGet(url, { rateLimit: true });
  return parseFeed(xml);
}

function formatEntry(e) {
  const authors = e.authors.map(a => a.name).slice(0, 3).join(', ')
    + (e.authors.length > 3 ? ` +${e.authors.length - 3}` : '');
  const date = (e.published || '').slice(0, 10);
  const cat = e.primary_category || (e.categories || [])[0] || '';
  const lines = [
    `- ${e.title}`,
    `    ${authors} · ${date} · ${cat}`,
    `    arXiv:${e.arxiv_id_base}  ${e.abs_url}${e.pdf_url ? '  pdf=' + e.pdf_url : ''}`,
  ];
  if (e.doi) lines.push(`    doi:${e.doi}`);
  if (e.journal_ref) lines.push(`    journal: ${e.journal_ref}`);
  if (e.comment) lines.push(`    comment: ${e.comment.slice(0, 140)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands — search & metadata
// ---------------------------------------------------------------------------

async function cmdSearch(query, opts) {
  const limit = Math.min(parseInt(opts.limit || '20', 10), 2000);
  const start = parseInt(opts.start || '0', 10);
  const sortBy = opts.sort || 'relevance';    // relevance | lastUpdatedDate | submittedDate
  const order = opts.order || 'descending';
  const search = opts.field ? `${opts.field}:${query}` : query;
  const feed = await apiQuery({ search, start, maxResults: limit, sortBy, sortOrder: order });

  const slug = slugify(`${opts.field || 'all'}-${query}`);
  saveJson(resolve(CACHE_DIR, `search-${slug}.json`), { query, sortBy, order, fetched_at: new Date().toISOString(), total: feed.total, entries: feed.entries });
  for (const e of feed.entries) appendIndex({ kind: 'search_hit', arxiv_id: e.arxiv_id_base, title: e.title, published: e.published, ts: Date.now() });

  if (opts.json) { console.log(JSON.stringify(feed, null, 2)); return; }
  console.log(`# arXiv search: ${search}   (${feed.total.toLocaleString()} total, showing ${feed.entries.length} starting at ${feed.start}, sort=${sortBy}/${order})\n`);
  for (const e of feed.entries) console.log(formatEntry(e) + '\n');
}

async function cmdPaper(idOrUrl, opts) {
  const ids = idOrUrl.split(',').map(extractArxivId).join(',');
  const feed = await apiQuery({ idList: ids, maxResults: Math.max(1, ids.split(',').length) });
  for (const e of feed.entries) {
    saveJson(resolve(CACHE_DIR, `paper-${e.arxiv_id_base}.json`), { fetched_at: new Date().toISOString(), entry: e });
    appendIndex({ kind: 'paper', arxiv_id: e.arxiv_id_base, title: e.title, published: e.published, ts: Date.now() });
  }
  if (opts.json) { console.log(JSON.stringify(feed.entries, null, 2)); return; }
  for (const e of feed.entries) {
    console.log(`# ${e.title}`);
    console.log(`  ${e.authors.map(a => a.name).join(', ')}`);
    console.log(`  arXiv:${e.arxiv_id}  (${e.primary_category})  ${(e.published || '').slice(0, 10)}`);
    if (e.doi) console.log(`  doi:${e.doi}`);
    if (e.journal_ref) console.log(`  journal: ${e.journal_ref}`);
    if (e.comment) console.log(`  comment: ${e.comment}`);
    console.log(`  abs: ${e.abs_url}`);
    if (e.pdf_url) console.log(`  pdf: ${e.pdf_url}`);
    console.log(`\n${e.summary}\n`);
  }
}

async function cmdCategory(cat, opts) {
  // Convenience: newest papers in a given category. Maps to cat:<cat> sorted by submittedDate desc.
  const limit = Math.min(parseInt(opts.limit || '20', 10), 2000);
  const feed = await apiQuery({ search: `cat:${cat}`, maxResults: limit, sortBy: 'submittedDate', sortOrder: 'descending' });
  if (opts.json) { console.log(JSON.stringify(feed.entries, null, 2)); return; }
  console.log(`# Newest in ${cat}   (${feed.total.toLocaleString()} total, showing ${feed.entries.length})\n`);
  for (const e of feed.entries) console.log(formatEntry(e) + '\n');
}

async function cmdAuthor(name, opts) {
  // Convenience: papers by author, sorted newest first.
  const limit = Math.min(parseInt(opts.limit || '20', 10), 2000);
  const quoted = name.includes(' ') ? `"${name}"` : name;
  const feed = await apiQuery({ search: `au:${quoted}`, maxResults: limit, sortBy: 'submittedDate', sortOrder: 'descending' });
  if (opts.json) { console.log(JSON.stringify(feed.entries, null, 2)); return; }
  console.log(`# Papers by ${name}   (${feed.total.toLocaleString()} total, showing ${feed.entries.length})\n`);
  for (const e of feed.entries) console.log(formatEntry(e) + '\n');
}

// ---------------------------------------------------------------------------
// Commands — stats
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      const v = cells[i];
      row[h] = v == null ? null : (isNaN(Number(v)) ? v : Number(v));
    });
    return row;
  });
}

async function cmdStatsSubmissions(opts) {
  const csv = await httpGet(`${STATS_BASE}/get_monthly_submissions`);
  const rows = parseCSV(csv);
  saveJson(resolve(CACHE_DIR, 'stats-submissions.json'), { fetched_at: new Date().toISOString(), rows });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }

  const total = rows.reduce((s, r) => s + (r.submissions || 0), 0);
  const last12 = rows.slice(-12);
  const lastYear = last12.reduce((s, r) => s + (r.submissions || 0), 0);
  const prior12 = rows.slice(-24, -12);
  const priorYear = prior12.reduce((s, r) => s + (r.submissions || 0), 0);
  const yoy = priorYear ? ((lastYear - priorYear) / priorYear * 100) : null;

  console.log(`# arXiv monthly submissions (since ${rows[0].month})`);
  console.log(`  Total all-time: ${total.toLocaleString()}`);
  console.log(`  Last 12 months: ${lastYear.toLocaleString()}`);
  console.log(`  Prior 12 months: ${priorYear.toLocaleString()}`);
  if (yoy != null) console.log(`  YoY: ${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%`);
  console.log(`\n  Last 12 months:`);
  for (const r of last12) console.log(`    ${r.month}  ${String(r.submissions).padStart(6)}`);
}

async function cmdStatsDownloads(opts) {
  const csv = await httpGet(`${STATS_BASE}/get_monthly_downloads`);
  const rows = parseCSV(csv);
  saveJson(resolve(CACHE_DIR, 'stats-downloads.json'), { fetched_at: new Date().toISOString(), rows });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }

  const total = rows.reduce((s, r) => s + (r.downloads || 0), 0);
  const last12 = rows.slice(-12);
  const lastYear = last12.reduce((s, r) => s + (r.downloads || 0), 0);
  console.log(`# arXiv monthly downloads (since ${rows[0].month})`);
  console.log(`  Total all-time: ${total.toLocaleString()}`);
  console.log(`  Last 12 months: ${lastYear.toLocaleString()}`);
  console.log(`\n  Last 12 months:`);
  for (const r of last12) console.log(`    ${r.month}  ${String(r.downloads).padStart(10)}`);
}

async function cmdStatsToday(opts) {
  const d = opts.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const csv = await httpGet(`${STATS_BASE}/get_hourly?date=${d}`);
  const rows = parseCSV(csv);
  saveJson(resolve(CACHE_DIR, `stats-hourly-${d}.json`), { fetched_at: new Date().toISOString(), date: d, rows });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`# arXiv hourly usage for ${d}\n`);
  for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

async function cmdSearchCache(query) {
  if (!existsSync(INDEX_FILE)) { console.error('No index yet.'); return; }
  const q = query.toLowerCase();
  const lines = readFileSync(INDEX_FILE, 'utf8').split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const text = (row.title || '').toLowerCase();
      if (row.arxiv_id && text.includes(q) && !seen.has(row.arxiv_id)) {
        seen.add(row.arxiv_id);
        console.log(`- ${row.title}\n    arXiv:${row.arxiv_id}  ${(row.published || '').slice(0, 10)}`);
      }
    } catch {}
  }
}

async function cmdViewCache(idOrUrl) {
  const id = extractArxivId(idOrUrl);
  const cachePath = resolve(CACHE_DIR, `paper-${id}.json`);
  if (!existsSync(cachePath)) { console.error(`No cache for ${id}. Run: paper ${id}`); process.exit(2); }
  console.log(JSON.stringify(loadJson(cachePath).entry, null, 2));
}

// ---------------------------------------------------------------------------
// ID extraction
// ---------------------------------------------------------------------------

function extractArxivId(s) {
  s = s.trim();
  // abs URL:   http://arxiv.org/abs/1706.03762[v5]
  // pdf URL:   http://arxiv.org/pdf/1706.03762[v5][.pdf]
  // new id:    1706.03762 or 1706.03762v5   (YYMM.NNNNN[v#])
  // old id:    cs.CL/0601121 or hep-th/9901001 (sometimes without slash mangled)
  const m = s.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?([a-z\-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (!m) throw new Error(`Unrecognized arXiv ID / URL: ${s}`);
  return m[1].replace(/\.pdf$/, '');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v == null ? true : v;
    } else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `arxiv — arXiv search + site-wide stats (no auth)

Search & metadata  (uses https://export.arxiv.org/api/query):
  search <query>               Keyword search across all fields
  search <query> --field=ti    Restrict to field: ti au abs cat all co jr rn id
  search <query> --sort=submittedDate --order=descending --limit=20 --start=0
  paper <id|url|id,id,...>     Fetch full metadata for one or more papers
  category <cat>               Newest papers in a category (e.g. cs.CL, cs.LG, stat.ML)
  author "Full Name"           Papers by an author, newest first

Stats  (uses https://arxiv.org/stats/get_*  —  undocumented but stable):
  stats-submissions            Monthly submission totals (1991–present)
  stats-downloads              Monthly download totals  (1994–present)
  stats-today [--date=YYYYMMDD]  Hourly usage for a day (default: today)

Offline:
  view-cache <id>              Print cached paper metadata
  search-cache <query>         Grep local index.jsonl

Flags (most commands):
  --limit=N                    Cap results (API cap 2000/call)
  --json                       Machine-readable JSON output

IDs accepted (auto-extracted):
  1706.03762    1706.03762v5
  https://arxiv.org/abs/1706.03762    https://arxiv.org/pdf/1706.03762v5.pdf
  cs.CL/0601121  (pre-2007 identifier scheme)

Examples:
  node scripts/arxiv.mjs search "state space model" --sort=submittedDate --limit=10
  node scripts/arxiv.mjs search "mamba" --field=ti
  node scripts/arxiv.mjs paper 1706.03762
  node scripts/arxiv.mjs paper 2312.00752,1810.04805 --json
  node scripts/arxiv.mjs category cs.CL --limit=15
  node scripts/arxiv.mjs author "Yann LeCun" --limit=5
  node scripts/arxiv.mjs stats-submissions
  node scripts/arxiv.mjs stats-today --date=20260410

Data layout: ~/.local/share/showrun/data/arxiv/cache/
  paper-<id>.json, search-<slug>.json, stats-*.json, index.jsonl
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  try {
    switch (cmd) {
      case 'search':
        if (!positional[1]) { console.error('Usage: search <query>'); process.exit(1); }
        await cmdSearch(positional.slice(1).join(' '), flags); break;
      case 'paper':
        if (!positional[1]) { console.error('Usage: paper <id|url>'); process.exit(1); }
        await cmdPaper(positional[1], flags); break;
      case 'category':
        if (!positional[1]) { console.error('Usage: category <cat>  (e.g. cs.CL)'); process.exit(1); }
        await cmdCategory(positional[1], flags); break;
      case 'author':
        if (!positional[1]) { console.error('Usage: author <name>'); process.exit(1); }
        await cmdAuthor(positional.slice(1).join(' '), flags); break;
      case 'stats-submissions': await cmdStatsSubmissions(flags); break;
      case 'stats-downloads':   await cmdStatsDownloads(flags); break;
      case 'stats-today':       await cmdStatsToday(flags); break;
      case 'view-cache':
        if (!positional[1]) { console.error('Usage: view-cache <id>'); process.exit(1); }
        await cmdViewCache(positional[1]); break;
      case 'search-cache':
        if (!positional[1]) { console.error('Usage: search-cache <query>'); process.exit(1); }
        await cmdSearchCache(positional.slice(1).join(' ')); break;
      default:
        console.log(HELP);
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
