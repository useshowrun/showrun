#!/usr/bin/env node
// patentsview.mjs — USPTO PatentsView Search v1 API wrapper.
//
// Endpoints (POST, JSON body):
//   https://search.patentsview.org/api/v1/patent/
//   https://search.patentsview.org/api/v1/assignee/
//   https://search.patentsview.org/api/v1/inventor/
//
// Free API key required (since 2024 redesign): https://patentsview.org/apis/keys
// Sent as `X-Api-Key: <key>` header.
//
// Commands:
//   search "<query>" [--from=YYYY-MM-DD] [--to=...] [--limit=N]
//   assignee <name> [--from=...] [--limit=N]                        — patents by company
//   inventor <name> [--limit=N]                                      — patents by inventor
//   view <patent-id>                                                  — single patent details

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/patentsview');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TOKEN_FILE = resolve(DATA_DIR, 'token.txt');
const API = 'https://search.patentsview.org/api/v1';
const USER_AGENT = 'showrun-patentsview/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 1600;     // PatentsView limit: 45 req/min — pad to ~37/min
const RETRY_DELAYS_MS = [3000, 8000, 20000];
const TTL_MS = 7 * 24 * 3600_000;     // patents don't update often; cache 7 days

const PATENT_FIELDS = [
  'patent_id', 'patent_title', 'patent_date', 'patent_abstract', 'patent_type',
  'assignees.assignee_organization', 'assignees.assignee_individual_name_first', 'assignees.assignee_individual_name_last',
  'inventors.inventor_name_first', 'inventors.inventor_name_last',
  'cpc_current.cpc_class_id', 'cpc_current.cpc_class_title',
];

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

function loadKey() {
  const k = process.env.PATENTSVIEW_API_KEY;
  if (k) return k.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error(`PatentsView API key not set.\n  Get a free key: https://patentsview.org/apis/keys\n  Then either:\n    export PATENTSVIEW_API_KEY=<your-key>\n    # or:\n    echo "<your-key>" > ${TOKEN_FILE}`);
}

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function postJson(path, body) {
  const key = loadKey();
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) { lastErr = e; res = null; }
    finally { clearTimeout(t); }
    if (!res) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}`);
    }
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`Non-JSON response from ${path}: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 403) throw new Error(`HTTP 403 on ${path} — check your PATENTSVIEW_API_KEY value.`);
    throw new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0,400)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

function fmtPatent(p) {
  const assignees = (p.assignees || []).map(a => a.assignee_organization || `${a.assignee_individual_name_first || ''} ${a.assignee_individual_name_last || ''}`.trim()).filter(Boolean);
  const inventors = (p.inventors || []).map(i => `${i.inventor_name_first || ''} ${i.inventor_name_last || ''}`.trim()).filter(Boolean);
  return { id: p.patent_id, date: p.patent_date, title: p.patent_title, assignees, inventors, type: p.patent_type };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSearch(phrase, opts = {}) {
  if (!phrase) throw new Error('Usage: search "<phrase>" [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]');
  const limit = Math.min(opts.limit || 25, 1000);
  const conds = [{ '_text_phrase': { 'patent_title': phrase } }];
  if (opts.from) conds.push({ '_gte': { 'patent_date': opts.from } });
  if (opts.to)   conds.push({ '_lte': { 'patent_date': opts.to } });
  const body = {
    q: conds.length === 1 ? conds[0] : { '_and': conds },
    f: PATENT_FIELDS,
    o: { size: limit, page: 1 },
    s: [{ 'patent_date': 'desc' }],
  };
  const cacheFile = resolve(CACHE_DIR, `search-${slug(phrase)}-${opts.from||''}-${opts.to||''}-${limit}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await postJson('/patent/', body); saveJson(cacheFile, data); }
  const hits = data.patents || [];
  console.log(`# PatentsView — title contains "${phrase}"  ${opts.from||opts.to ? `(${opts.from||'…'} → ${opts.to||'…'})` : ''}`);
  console.log(`   total: ${data.total_hits?.toLocaleString() || hits.length}    showing ${hits.length}\n`);
  for (const p of hits) {
    const f = fmtPatent(p);
    console.log(`   ${f.date}  ${f.id.padEnd(10)}  ${f.title}`);
    if (f.assignees.length) console.log(`              assignees: ${f.assignees.slice(0, 3).join(', ')}${f.assignees.length > 3 ? `, +${f.assignees.length - 3}` : ''}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdAssignee(name, opts = {}) {
  if (!name) throw new Error('Usage: assignee <name> [--from=YYYY-MM-DD] [--limit=N]');
  const limit = Math.min(opts.limit || 25, 1000);
  const conds = [{ '_contains': { 'assignees.assignee_organization': name } }];
  if (opts.from) conds.push({ '_gte': { 'patent_date': opts.from } });
  if (opts.to)   conds.push({ '_lte': { 'patent_date': opts.to } });
  const body = {
    q: { '_and': conds },
    f: PATENT_FIELDS,
    o: { size: limit, page: 1 },
    s: [{ 'patent_date': 'desc' }],
  };
  const cacheFile = resolve(CACHE_DIR, `assignee-${slug(name)}-${opts.from||''}-${limit}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await postJson('/patent/', body); saveJson(cacheFile, data); }
  const hits = data.patents || [];
  console.log(`# PatentsView — patents assigned to "${name}"`);
  console.log(`   total: ${data.total_hits?.toLocaleString() || hits.length}    showing ${hits.length}\n`);
  for (const p of hits) {
    const f = fmtPatent(p);
    console.log(`   ${f.date}  ${f.id.padEnd(10)}  ${f.title}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdInventor(name, opts = {}) {
  if (!name) throw new Error('Usage: inventor <name> [--limit=N]');
  const limit = Math.min(opts.limit || 25, 1000);
  const parts = name.split(/\s+/);
  const last = parts.pop();
  const first = parts.join(' ');
  const conds = [];
  if (last)  conds.push({ '_contains': { 'inventors.inventor_name_last': last } });
  if (first) conds.push({ '_contains': { 'inventors.inventor_name_first': first } });
  const body = {
    q: conds.length === 1 ? conds[0] : { '_and': conds },
    f: PATENT_FIELDS,
    o: { size: limit, page: 1 },
    s: [{ 'patent_date': 'desc' }],
  };
  const cacheFile = resolve(CACHE_DIR, `inventor-${slug(name)}-${limit}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await postJson('/patent/', body); saveJson(cacheFile, data); }
  const hits = data.patents || [];
  console.log(`# PatentsView — patents listing inventor "${name}"`);
  console.log(`   total: ${data.total_hits?.toLocaleString() || hits.length}    showing ${hits.length}\n`);
  for (const p of hits) {
    const f = fmtPatent(p);
    console.log(`   ${f.date}  ${f.id.padEnd(10)}  ${f.title}`);
    if (f.assignees.length) console.log(`              assignees: ${f.assignees.slice(0, 3).join(', ')}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdView(patentId) {
  if (!patentId) throw new Error('Usage: view <patent-id>');
  const body = {
    q: { '_eq': { 'patent_id': String(patentId) } },
    f: [...PATENT_FIELDS, 'patent_abstract', 'patent_num_claims', 'patent_processing_days'],
    o: { size: 1 },
  };
  const data = await postJson('/patent/', body);
  const p = (data.patents || [])[0];
  if (!p) { console.log(`# PatentsView — patent ${patentId}\n   (not found)`); return; }
  const f = fmtPatent(p);
  console.log(`# Patent ${f.id}`);
  console.log(`   title:     ${f.title}`);
  console.log(`   date:      ${f.date}    type: ${f.type || '-'}`);
  if (f.assignees.length) console.log(`   assignees: ${f.assignees.join(' | ')}`);
  if (f.inventors.length) console.log(`   inventors: ${f.inventors.join(' | ')}`);
  if (p.cpc_current?.length) console.log(`   CPC:       ${p.cpc_current.slice(0,5).map(c => `${c.cpc_class_id} (${c.cpc_class_title || ''})`).join(' | ')}`);
  if (p.patent_abstract) console.log(`\n   abstract:  ${p.patent_abstract.replace(/\s+/g,' ').slice(0, 600)}${p.patent_abstract.length > 600 ? '…' : ''}`);
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
  patentsview.mjs search "<phrase>" [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]
  patentsview.mjs assignee <name>   [--from=YYYY-MM-DD] [--limit=N]
  patentsview.mjs inventor <name>   [--limit=N]
  patentsview.mjs view <patent-id>

Data dir: ${DATA_DIR}
Get a free API key: https://patentsview.org/apis/keys
Then: export PATENTSVIEW_API_KEY=<key>   or:   echo "<key>" > ${TOKEN_FILE}
Rate limit: 45 req/min — script self-throttles to ~37/min.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'search':   await cmdSearch(flags.positional[0], flags); break;
      case 'assignee': await cmdAssignee(flags.positional[0], flags); break;
      case 'inventor': await cmdInventor(flags.positional[0], flags); break;
      case 'view':     await cmdView(flags.positional[0]); break;
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
