#!/usr/bin/env node
// tranco.mjs — Tranco-list.eu domain ranking wrapper.
//
// Endpoints used (no auth, public):
//   GET https://tranco-list.eu/api/lists/date/<YYYY-MM-DD>
//   GET https://tranco-list.eu/api/lists/date/latest
//   GET https://tranco-list.eu/api/ranks/domain/<domain>
//   GET https://tranco-list.eu/download/<list-id>/<count>
//
// Requires Node 22+ (built-in fetch + zlib).

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { homedir } from 'os';
import { gunzipSync, inflateSync } from 'zlib';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/tranco');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API_BASE = 'https://tranco-list.eu';
const USER_AGENT = 'tranco-skill/1.0';
const TIMEOUT_MS = 60_000;

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(path, fb) { if (!existsSync(path)) return fb; try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fb; } }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g,'').slice(0,80); }
function normDomain(d) { return String(d).toLowerCase().trim().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0]; }

async function getJSON(path) {
  const url = `${API_BASE}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { headers:{'Accept':'application/json','User-Agent':USER_AGENT}, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

async function getBytes(path) {
  const url = `${API_BASE}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS*2);
  let res;
  try { res = await fetch(url, { headers:{'User-Agent':USER_AGENT}, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0,200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLatest() {
  const d = await getJSON('/api/lists/date/latest');
  saveJson(resolve(CACHE_DIR,'latest.json'), { fetched_at: new Date().toISOString(), ...d });
  console.log(`# Tranco — latest list\n`);
  for (const [k,v] of Object.entries(d)) console.log(`  ${k}: ${v}`);
  return d;
}

async function cmdList(id) {
  if (!id) throw new Error('Usage: list <list-id>');
  const d = await getJSON(`/api/lists/id/${encodeURIComponent(id)}`);
  saveJson(resolve(CACHE_DIR,`list-${slug(id)}.json`), { fetched_at: new Date().toISOString(), ...d });
  console.log(`# Tranco list ${id}\n`);
  for (const [k,v] of Object.entries(d)) console.log(`  ${k}: ${v}`);
  return d;
}

async function cmdRank(domain, opts={}) {
  if (!domain) throw new Error('Usage: rank <domain>');
  const dom = normDomain(domain);
  const cacheFile = resolve(CACHE_DIR, `rank-${slug(dom)}.json`);
  const d = await getJSON(`/api/ranks/domain/${encodeURIComponent(dom)}`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), domain: dom, ...d });
  const ranks = d.ranks || [];
  if (!ranks.length) {
    console.log(`# Tranco rank — ${dom}\n  not in the latest top 1M\n`);
    return null;
  }
  // Pick by date if specified, else latest
  let pick;
  if (opts.date) {
    pick = ranks.find(r => (r.date||'').startsWith(opts.date));
  }
  if (!pick) pick = ranks.reduce((a,b)=> (a && a.date > b.date) ? a : b);
  console.log(`# Tranco rank — ${dom}  (date ${pick.date || '?'})\n`);
  console.log(`   rank: ${Number(pick.rank).toLocaleString()}`);
  console.log(`   history points (latest 5):`);
  ranks.slice(-5).forEach(r => console.log(`     ${r.date}  rank=${Number(r.rank).toLocaleString()}`));
  return pick;
}

async function cmdRanks(domains) {
  if (!domains || !domains.length) throw new Error('Usage: ranks <domain1> <domain2> ...');
  console.log(`# Tranco ranks — ${domains.length} domains\n`);
  const results = [];
  for (const d of domains) {
    try {
      const dom = normDomain(d);
      const r = await getJSON(`/api/ranks/domain/${encodeURIComponent(dom)}`);
      const latest = (r.ranks||[]).reduce((a,b)=> (a && a.date > b.date) ? a : b, null);
      if (latest) {
        console.log(`  rank=${String(latest.rank).padStart(8)}  ${dom}  (${latest.date})`);
        results.push({domain:dom, rank:latest.rank, date:latest.date});
      } else {
        console.log(`  rank=  not in 1M  ${dom}`);
        results.push({domain:dom, rank:null});
      }
    } catch (e) {
      console.log(`  err: ${d}: ${e.message.slice(0,80)}`);
    }
    await new Promise(r=>setTimeout(r,400)); // gentle rate limiting
  }
  saveJson(resolve(CACHE_DIR,`ranks-${slug(domains.join('-'))}.json`), { fetched_at: new Date().toISOString(), results });
  return results;
}

async function cmdTop(opts={}) {
  // Resolve latest list-id
  const latest = await getJSON('/api/lists/date/latest');
  const listId = latest?.list_id || latest?.id;
  if (!listId) throw new Error('Could not resolve latest list-id from API: ' + JSON.stringify(latest));
  const limit = opts.limit || 1000;
  const cacheFile = resolve(CACHE_DIR, `top-${listId}-${limit}.csv`);
  if (existsSync(cacheFile)) {
    process.stderr.write(`[cache hit] ${cacheFile}\n`);
    process.stdout.write(readFileSync(cacheFile,'utf8'));
    return;
  }
  // Tranco supports several download sizes
  const sizeMap = { 1000:'1000', 10000:'10000', 100000:'100000', 1000000:'full' };
  const sz = sizeMap[limit] || 'full';
  process.stderr.write(`Downloading top-${sz} from list ${listId} ...\n`);
  const buf = await getBytes(`/download/${listId}/${sz}`);
  // Tranco serves either gzip, zip, or plain CSV depending on size; auto-detect
  let csv;
  if (buf[0]===0x1f && buf[1]===0x8b) csv = gunzipSync(buf).toString('utf8');
  else if (buf[0]===0x50 && buf[1]===0x4b) {
    // zip — extract first file via simple parser (zip local file header)
    // limit=1000/10000/100000 endpoints often serve plain CSV; full serves a zip
    // Minimal zip handling: find local file header signature and inflate raw stream
    const idx = 0;
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('zip parse error');
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const dataStart = 30 + nameLen + extraLen;
    const compMethod = buf.readUInt16LE(8);
    const compSize = buf.readUInt32LE(18);
    const data = buf.slice(dataStart, dataStart + compSize);
    if (compMethod === 0) csv = data.toString('utf8');
    else if (compMethod === 8) csv = inflateSync(data).toString('utf8'); // raw deflate
    else throw new Error(`unsupported zip compression method ${compMethod}`);
  } else {
    csv = buf.toString('utf8');
  }
  // Trim to limit if needed
  if (limit < 1000000) {
    const lines = csv.split(/\r?\n/);
    csv = lines.slice(0, limit + 1).join('\n');
  }
  ensureDir(dirname(cacheFile));
  writeFileSync(cacheFile, csv);
  process.stderr.write(`Cached: ${cacheFile} (${(csv.length/1024).toFixed(0)} KB)\n`);
  process.stdout.write(csv);
}

async function cmdFilter(pattern) {
  if (!pattern) throw new Error('Usage: filter <regex>');
  // Find the most recent cached top file
  const fs = await import('fs');
  const files = fs.readdirSync(CACHE_DIR).filter(f=>f.startsWith('top-') && f.endsWith('.csv'));
  if (!files.length) throw new Error('No cached top file. Run `top --limit=1000000` first.');
  const file = files.sort().pop();
  const csv = readFileSync(resolve(CACHE_DIR,file),'utf8');
  const re = new RegExp(pattern);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  console.log(`# Tranco — filter "${pattern}" against ${file} (${lines.length.toLocaleString()} domains)\n`);
  let n=0;
  for (const line of lines) {
    const [rank, dom] = line.split(',');
    if (re.test(dom||'')) { console.log(`  ${rank.padStart(8)}  ${dom}`); n++; if (n>=200) { console.log(`  ... (truncated at 200; refine pattern)`); break; } }
  }
  console.log(`\nMatched ${n} (capped at 200)`);
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
  tranco.mjs latest
  tranco.mjs list <list-id>
  tranco.mjs rank <domain> [--date=YYYY-MM-DD]
  tranco.mjs ranks <domain1> <domain2> ...
  tranco.mjs top [--limit=1000|10000|100000|1000000]
  tranco.mjs filter <regex>             # filter cached top-1M by domain regex

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
      case 'latest':  await cmdLatest(); break;
      case 'list':    await cmdList(flags.positional[0]); break;
      case 'rank':    await cmdRank(flags.positional[0], flags); break;
      case 'ranks':   await cmdRanks(flags.positional); break;
      case 'top':     await cmdTop(flags); break;
      case 'filter':  await cmdFilter(flags.positional[0]); break;
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
