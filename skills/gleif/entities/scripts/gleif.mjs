#!/usr/bin/env node
// gleif.mjs — Global Legal Entity Identifier Foundation (LEI) registry wrapper.
//
// Endpoint: https://api.gleif.org/api/v1
// No auth. Public.
//
// Returns LEI records (the global standard for identifying legal entities)
// and the parent/child relationship graph between them — i.e. who owns whom.
//
// Commands:
//   lookup <name-or-lei>                       — name search OR LEI fetch
//   view <lei>                                 — full record for one LEI
//   parent <lei> [--ultimate]                  — direct or ultimate parent
//   children <lei> [--limit=N]                 — direct subsidiaries
//   tree <lei> [--depth=N] [--limit=N]         — ownership tree (children, recursive)

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/gleif');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API = 'https://api.gleif.org/api/v1';
const USER_AGENT = 'showrun-gleif/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 200;
const RETRY_DELAYS_MS = [1500, 4000, 9000];

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

async function fetchJson(url, allow404 = false) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.api+json' }, signal: ctrl.signal }); }
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
    if (res.status === 404 && allow404) return null;
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 404) throw new Error(`HTTP 404 (not found): ${url}`);
    throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

const isLei = s => typeof s === 'string' && /^[A-Z0-9]{18}[0-9]{2}$/i.test(s.trim());

function summary(rec) {
  const a = rec.attributes || {};
  const e = a.entity || {};
  const reg = a.registration || {};
  const addr = e.headquartersAddress || e.legalAddress || {};
  return {
    lei: a.lei || rec.id,
    name: e.legalName?.name || '(unnamed)',
    status: e.status || '-',
    category: e.category || '-',
    country: addr.country || '-',
    city: addr.city || '-',
    legalForm: e.legalForm?.id || '-',
    regStatus: reg.status || '-',
    initialReg: reg.initialRegistrationDate?.slice(0,10) || '-',
    lastUpdate: reg.lastUpdateDate?.slice(0,10) || '-',
    nextRenewal: reg.nextRenewalDate?.slice(0,10) || '-',
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLookup(query, opts = {}) {
  if (!query) throw new Error('Usage: lookup <name-or-lei>');
  if (isLei(query)) {
    const data = await fetchJson(`${API}/lei-records/${query.toUpperCase()}`);
    const rec = data.data;
    const s = summary(rec);
    const cacheFile = resolve(CACHE_DIR, `lookup-${s.lei}.json`);
    saveJson(cacheFile, { fetched_at: new Date().toISOString(), record: rec });
    console.log(`# GLEIF lookup — ${s.lei}\n   name:    ${s.name}\n   status:  ${s.status} (registration: ${s.regStatus})\n   country: ${s.country}, ${s.city}    legal form: ${s.legalForm}\n   first registered: ${s.initialReg}    last updated: ${s.lastUpdate}\n\nCached: ${cacheFile}`);
    return;
  }
  const limit = opts.limit || 20;
  const url = `${API}/lei-records?filter[entity.legalName]=${encodeURIComponent(query)}&page[size]=${limit}`;
  const data = await fetchJson(url);
  const total = data.meta?.pagination?.total ?? data.data.length;
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), query, total, records: data.data });
  console.log(`# GLEIF search — "${query}"\n   matches: ${total.toLocaleString()}    showing ${data.data.length}\n`);
  if (!data.data.length) { console.log('   (no matches — try a wider search; GLEIF filter is case-insensitive substring on legalName)'); return; }
  for (const rec of data.data) {
    const s = summary(rec);
    console.log(`   ${s.lei}  ${s.country.padEnd(2)}  ${s.status.padEnd(8)} ${s.name}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdView(lei) {
  if (!isLei(lei)) throw new Error('Usage: view <lei>  (LEI is a 20-char alphanumeric)');
  const data = await fetchJson(`${API}/lei-records/${lei.toUpperCase()}`);
  const rec = data.data;
  const a = rec.attributes;
  const e = a.entity;
  const reg = a.registration;
  const cacheFile = resolve(CACHE_DIR, `view-${a.lei}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), record: rec });
  console.log(`# GLEIF entity — ${a.lei}`);
  console.log(`   name:        ${e.legalName?.name || '-'}`);
  if (e.otherNames?.length) console.log(`   other names: ${e.otherNames.map(n => n.name).join(' | ')}`);
  console.log(`   category:    ${e.category || '-'}    legal form: ${e.legalForm?.id || '-'}`);
  console.log(`   status:      ${e.status || '-'}    registration: ${reg.status || '-'}`);
  const ha = e.headquartersAddress || {}, la = e.legalAddress || {};
  if (ha.country) console.log(`   HQ:          ${[ha.addressLines?.join(', '), ha.city, ha.region, ha.postalCode, ha.country].filter(Boolean).join(', ')}`);
  if (la.country) console.log(`   legal addr:  ${[la.addressLines?.join(', '), la.city, la.region, la.postalCode, la.country].filter(Boolean).join(', ')}`);
  if (e.jurisdiction) console.log(`   jurisdiction: ${e.jurisdiction}`);
  if (e.registeredAt?.id) console.log(`   registered with: ${e.registeredAt.id}    business reg ID: ${e.registeredAs || '-'}`);
  if (reg.initialRegistrationDate) console.log(`   first registered: ${reg.initialRegistrationDate.slice(0,10)}    last updated: ${reg.lastUpdateDate?.slice(0,10) || '-'}    next renewal: ${reg.nextRenewalDate?.slice(0,10) || '-'}`);
  // Relationships hint
  const rel = rec.relationships || {};
  const has = k => rel[k]?.links?.related;
  console.log(`\n   relationships available:`);
  console.log(`     direct-parent:    ${has('direct-parent')   ? 'yes' : 'no'}`);
  console.log(`     ultimate-parent:  ${has('ultimate-parent') ? 'yes' : 'no'}`);
  console.log(`     direct-children:  ${has('direct-children') ? 'yes' : 'no'}`);
  console.log(`     ultimate-children:${has('ultimate-children')? 'yes' : 'no'}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdParent(lei, opts = {}) {
  if (!isLei(lei)) throw new Error('Usage: parent <lei> [--ultimate]');
  const which = opts.ultimate ? 'ultimate-parent' : 'direct-parent';
  const data = await fetchJson(`${API}/lei-records/${lei.toUpperCase()}/${which}`, true);
  if (!data || !data.data) {
    console.log(`# GLEIF ${which} — ${lei}\n   (no ${which} record on file — entity reports it has none, or hasn't reported)\n`);
    return;
  }
  const s = summary(data.data);
  const cacheFile = resolve(CACHE_DIR, `parent-${which}-${lei.toUpperCase()}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), child: lei, record: data.data });
  console.log(`# GLEIF ${which} — ${lei}\n   parent LEI: ${s.lei}\n   name:       ${s.name}\n   country:    ${s.country}    status: ${s.status}\n\nCached: ${cacheFile}`);
}

async function cmdChildren(lei, opts = {}) {
  if (!isLei(lei)) throw new Error('Usage: children <lei> [--limit=N]');
  const limit = opts.limit || 50;
  const url = `${API}/lei-records/${lei.toUpperCase()}/direct-children?page[size]=${limit}`;
  const data = await fetchJson(url, true);
  if (!data || !data.data?.length) {
    console.log(`# GLEIF children — ${lei}\n   (no direct subsidiaries with their own LEIs registered)\n`);
    return;
  }
  const total = data.meta?.pagination?.total ?? data.data.length;
  const cacheFile = resolve(CACHE_DIR, `children-${lei.toUpperCase()}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), parent: lei, total, records: data.data });
  console.log(`# GLEIF direct children — ${lei}\n   ${total} subsidiaries with registered LEIs    showing ${data.data.length}\n`);
  for (const rec of data.data) {
    const s = summary(rec);
    console.log(`   ${s.lei}  ${s.country.padEnd(2)}  ${s.status.padEnd(8)} ${s.name}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdTree(lei, opts = {}) {
  if (!isLei(lei)) throw new Error('Usage: tree <lei> [--depth=N] [--limit=N]');
  const depth = parseInt(opts.depth || 2, 10);
  const limit = parseInt(opts.limit || 25, 10);
  const visited = new Set();
  const lines = [];

  async function walk(currentLei, level) {
    if (level > depth || visited.has(currentLei)) return;
    visited.add(currentLei);
    if (level === 0) {
      const root = await fetchJson(`${API}/lei-records/${currentLei}`, true);
      if (!root?.data) return;
      const s = summary(root.data);
      lines.push(`${'  '.repeat(level)}${s.lei}  ${s.name}  [${s.country}]`);
    }
    const data = await fetchJson(`${API}/lei-records/${currentLei}/direct-children?page[size]=${limit}`, true);
    if (!data?.data?.length) return;
    for (const rec of data.data) {
      const s = summary(rec);
      lines.push(`${'  '.repeat(level + 1)}${s.lei}  ${s.name}  [${s.country}]`);
      await walk(s.lei, level + 1);
    }
  }
  await walk(lei.toUpperCase(), 0);
  const cacheFile = resolve(CACHE_DIR, `tree-${lei.toUpperCase()}-d${depth}-l${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), root: lei, depth, limit, lines });
  console.log(`# GLEIF ownership tree — ${lei}  (depth=${depth}, max ${limit} children/level)\n`);
  for (const line of lines) console.log(`   ${line}`);
  console.log(`\n   ${visited.size} entities reached\nCached: ${cacheFile}`);
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
  gleif.mjs lookup <name-or-lei> [--limit=N]
  gleif.mjs view <lei>
  gleif.mjs parent <lei> [--ultimate]
  gleif.mjs children <lei> [--limit=N]
  gleif.mjs tree <lei> [--depth=N] [--limit=N]

Data dir: ${DATA_DIR}
No auth. Public registry maintained by GLEIF Foundation.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'lookup':   await cmdLookup(flags.positional[0], flags); break;
      case 'view':     await cmdView(flags.positional[0]); break;
      case 'parent':   await cmdParent(flags.positional[0], flags); break;
      case 'children': await cmdChildren(flags.positional[0], flags); break;
      case 'tree':     await cmdTree(flags.positional[0], flags); break;
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
