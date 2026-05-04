#!/usr/bin/env node
// openalex.mjs — OpenAlex scholarly-works API wrapper.
//
// Endpoint: https://api.openalex.org
// No auth. Public.  240M+ works, 90M authors, 110K institutions, 250K venues.
//
// Commands:
//   search "<query>" [--from=YYYY] [--to=YYYY] [--type=article|book|...] [--limit=N]
//   author <name> [--limit=N]              — works by an author (top-cited)
//   institution <name> [--limit=N]         — works by an institution (top-cited)
//   view <work-id-or-doi>                  — single work details
//   stats <author-or-institution>          — productivity / citation stats

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/openalex');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API = 'https://api.openalex.org';
const CONTACT = process.env.OPENALEX_CONTACT || 'showrun-skills@showrun.co';
const USER_AGENT = `showrun-openalex/1.0 (${CONTACT})`;
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 200;
const RETRY_DELAYS_MS = [1500, 4000, 9000];
const TTL_MS = 24 * 3600_000;

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

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
  // OpenAlex prefers the contact email in `mailto=` for the polite pool
  u.searchParams.append('mailto', CONTACT);
  const url = u.toString();
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
      catch { throw new Error(`Non-JSON response from ${path}: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 404) throw new Error(`HTTP 404: ${url}`);
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

function shortId(s) { return s ? String(s).replace(/^https:\/\/openalex\.org\//, '') : ''; }
function authorsLine(work) {
  const auths = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean);
  if (auths.length <= 3) return auths.join(', ');
  return `${auths.slice(0, 3).join(', ')}, +${auths.length - 3}`;
}
function venueLine(work) {
  const v = work.primary_location?.source?.display_name || work.host_venue?.display_name;
  return v || '(no venue)';
}
function fmtWork(w) {
  return `   ${w.publication_year || '----'}  ${shortId(w.id).padEnd(12)}  cited:${String(w.cited_by_count || 0).padStart(5)}  ${w.title || w.display_name}`;
}

// ---------------------------------------------------------------------------
// Resolve helpers
// ---------------------------------------------------------------------------

async function resolveAuthor(name, idHint) {
  if (idHint) {
    const data = await fetchJson(`/authors/${idHint}`);
    return { picked: data, candidates: [data] };
  }
  const data = await fetchJson('/authors', { search: name, per_page: 5 });
  const cands = data.results || [];
  return { picked: cands[0] || null, candidates: cands };
}

async function resolveInstitution(name, idHint) {
  if (idHint) {
    const data = await fetchJson(`/institutions/${idHint}`);
    return { picked: data, candidates: [data] };
  }
  const data = await fetchJson('/institutions', { search: name, per_page: 5 });
  const cands = data.results || [];
  return { picked: cands[0] || null, candidates: cands };
}

function printCandidates(candidates, picked) {
  for (const c of candidates) {
    if (c.id === picked?.id) continue;
    const id = shortId(c.id);
    const country = c.country_code || c.last_known_institution?.country_code || '?';
    console.log(`     ${id.padEnd(12)} works=${String(c.works_count || 0).padStart(5)}  cit=${String(c.cited_by_count || 0).padStart(7)}  ${c.display_name}  [${country}]`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSearch(query, opts = {}) {
  if (!query) throw new Error('Usage: search "<query>" [--full-text] [--top-cited] [--from=YYYY] [--to=YYYY] [--type=article|book|...] [--limit=N]');
  const limit = Math.min(opts.limit || 25, 200);
  const filters = [];
  if (opts.from) filters.push(`from_publication_date:${opts.from.length === 4 ? `${opts.from}-01-01` : opts.from}`);
  if (opts.to)   filters.push(`to_publication_date:${opts.to.length === 4 ? `${opts.to}-12-31` : opts.to}`);
  if (opts.type) filters.push(`type:${opts.type}`);
  // Default: title-only relevance search (best for "find this paper").
  // --full-text: search all fields (titles + abstracts + fulltext, broader).
  const params = { per_page: limit };
  if (opts.fulltext) params.search = query;
  else filters.unshift(`display_name.search:${query}`);
  if (filters.length) params.filter = filters.join(',');
  if (opts.topcited) params.sort = 'cited_by_count:desc';
  const sortMode = opts.topcited ? 'cited' : 'relevance';
  const searchMode = opts.fulltext ? 'full-text' : 'title';
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}-${searchMode}-${sortMode}-${opts.from||''}-${opts.to||''}-${opts.type||''}-${limit}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson('/works', params); saveJson(cacheFile, data); }
  const works = data.results || [];
  const total = data.meta?.count ?? works.length;
  console.log(`# OpenAlex search — "${query}"  (${searchMode}-search, ${sortMode}-sort)  ${opts.type ? `type=${opts.type}` : ''} ${opts.from ? `${opts.from}–${opts.to||'…'}` : ''}`);
  console.log(`   matches: ${total.toLocaleString()}    showing ${works.length}\n`);
  for (const w of works) {
    console.log(fmtWork(w));
    console.log(`              ${authorsLine(w)}  —  ${venueLine(w)}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdAuthor(name, opts = {}) {
  if (!name) throw new Error('Usage: author <name> [--id=<id>] [--limit=N]');
  const limit = Math.min(opts.limit || 25, 200);
  const { picked: a, candidates } = await resolveAuthor(name, opts.id);
  if (!a) { console.log(`# OpenAlex author — "${name}"\n   (no match)`); return; }
  const params = { filter: `author.id:${shortId(a.id)}`, per_page: limit, sort: 'cited_by_count:desc' };
  const data = await fetchJson('/works', params);
  const works = data.results || [];
  const cacheFile = resolve(CACHE_DIR, `author-${slug(name)}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), author: a, results: works, total: data.meta?.count });
  console.log(`# OpenAlex author — ${a.display_name}  (${shortId(a.id)})`);
  if (a.last_known_institution) console.log(`   affiliation: ${a.last_known_institution.display_name} (${a.last_known_institution.country_code || '?'})`);
  console.log(`   total works: ${a.works_count?.toLocaleString() || 0}    total citations: ${a.cited_by_count?.toLocaleString() || 0}    h-index: ${a.summary_stats?.h_index ?? '-'}`);
  console.log(`   showing top ${works.length} by citations:\n`);
  for (const w of works) {
    console.log(fmtWork(w));
    console.log(`              ${venueLine(w)}`);
  }
  if (!opts.id && candidates.length > 1) {
    console.log(`\n   ${candidates.length - 1} other candidate(s) for "${name}" — pass --id=<id> to switch:`);
    printCandidates(candidates, a);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdInstitution(name, opts = {}) {
  if (!name) throw new Error('Usage: institution <name> [--id=<id>] [--limit=N]');
  const limit = Math.min(opts.limit || 25, 200);
  const { picked: inst, candidates } = await resolveInstitution(name, opts.id);
  if (!inst) { console.log(`# OpenAlex institution — "${name}"\n   (no match)`); return; }
  const params = { filter: `institutions.id:${shortId(inst.id)}`, per_page: limit, sort: 'cited_by_count:desc' };
  const data = await fetchJson('/works', params);
  const works = data.results || [];
  const cacheFile = resolve(CACHE_DIR, `inst-${slug(name)}-${limit}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), institution: inst, results: works, total: data.meta?.count });
  console.log(`# OpenAlex institution — ${inst.display_name}  (${shortId(inst.id)})`);
  console.log(`   country: ${inst.country_code || '?'}    type: ${inst.type || '?'}`);
  console.log(`   total works: ${inst.works_count?.toLocaleString() || 0}    total citations: ${inst.cited_by_count?.toLocaleString() || 0}`);
  console.log(`   showing top ${works.length} by citations:\n`);
  for (const w of works) {
    console.log(fmtWork(w));
    console.log(`              ${authorsLine(w)}  —  ${venueLine(w)}`);
  }
  if (!opts.id && candidates.length > 1) {
    console.log(`\n   ${candidates.length - 1} other candidate(s) for "${name}" — pass --id=<id> to switch:`);
    printCandidates(candidates, inst);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdView(idOrDoi) {
  if (!idOrDoi) throw new Error('Usage: view <work-id-or-doi>');
  const id = idOrDoi.startsWith('10.') || idOrDoi.startsWith('doi:') ? `doi:${idOrDoi.replace(/^doi:/,'')}` : idOrDoi.replace(/^https:\/\/openalex\.org\//, '');
  const data = await fetchJson(`/works/${id}`);
  const w = data;
  console.log(`# OpenAlex work — ${shortId(w.id)}`);
  console.log(`   title:    ${w.title || w.display_name}`);
  console.log(`   year:     ${w.publication_year}    type: ${w.type || '-'}    cited: ${w.cited_by_count}`);
  console.log(`   doi:      ${w.doi || '-'}`);
  if (w.open_access?.is_oa) console.log(`   OA:       yes — ${w.open_access.oa_url || '(no URL)'}`);
  console.log(`   venue:    ${venueLine(w)}`);
  const auths = (w.authorships || []).slice(0, 10).map(a => `${a.author?.display_name}${a.institutions?.[0]?.display_name ? ` (${a.institutions[0].display_name})` : ''}`);
  if (auths.length) console.log(`   authors:  ${auths.join(' | ')}${(w.authorships?.length || 0) > 10 ? `, +${w.authorships.length - 10}` : ''}`);
  if (w.abstract_inverted_index) {
    // Reconstruct abstract from inverted index
    const idx = w.abstract_inverted_index;
    const positions = [];
    for (const [word, pos] of Object.entries(idx)) for (const p of pos) positions[p] = word;
    const abs = positions.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 600);
    console.log(`\n   abstract: ${abs}${abs.length === 600 ? '…' : ''}`);
  }
  if (w.concepts?.length) {
    console.log(`\n   concepts: ${w.concepts.slice(0, 6).map(c => `${c.display_name} (${(c.score*100).toFixed(0)}%)`).join(', ')}`);
  }
}

async function cmdStats(name, opts = {}) {
  if (!name) throw new Error('Usage: stats <author-or-institution> [--id=<id>]');
  // Try author first, fall back to institution
  const { picked: a } = await resolveAuthor(name, opts.id);
  if (a && a.cited_by_count > 0) {
    console.log(`# OpenAlex stats — ${a.display_name}  (author)`);
    if (a.last_known_institution) console.log(`   affiliation: ${a.last_known_institution.display_name}`);
    console.log(`   total works:    ${a.works_count?.toLocaleString() || 0}`);
    console.log(`   total citations:${a.cited_by_count?.toLocaleString() || 0}`);
    console.log(`   h-index:        ${a.summary_stats?.h_index ?? '-'}`);
    console.log(`   i10-index:      ${a.summary_stats?.i10_index ?? '-'}`);
    console.log(`   2y mean cit/yr: ${a.summary_stats?.['2yr_mean_citedness']?.toFixed(2) ?? '-'}`);
    if (a.counts_by_year?.length) {
      console.log(`\n   recent yearly output (works / citations):`);
      for (const c of a.counts_by_year.slice(0, 6)) console.log(`     ${c.year}:  ${String(c.works_count).padStart(4)}w  ${String(c.cited_by_count).padStart(6)}c`);
    }
    return;
  }
  const { picked: inst } = await resolveInstitution(name, opts.id);
  if (inst) {
    console.log(`# OpenAlex stats — ${inst.display_name}  (institution, ${inst.country_code || '?'})`);
    console.log(`   type:           ${inst.type || '?'}`);
    console.log(`   total works:    ${inst.works_count?.toLocaleString() || 0}`);
    console.log(`   total citations:${inst.cited_by_count?.toLocaleString() || 0}`);
    console.log(`   2y mean cit/yr: ${inst.summary_stats?.['2yr_mean_citedness']?.toFixed(2) ?? '-'}`);
    if (inst.counts_by_year?.length) {
      console.log(`\n   recent yearly output (works / citations):`);
      for (const c of inst.counts_by_year.slice(0, 6)) console.log(`     ${c.year}:  ${String(c.works_count).padStart(5)}w  ${String(c.cited_by_count).padStart(7)}c`);
    }
    return;
  }
  console.log(`# OpenAlex stats — "${name}"\n   (no author or institution match)`);
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
  openalex.mjs search "<query>" [--from=YYYY] [--to=YYYY] [--type=article|book|...] [--limit=N]
  openalex.mjs author <name>      [--limit=N]
  openalex.mjs institution <name> [--limit=N]
  openalex.mjs view <work-id-or-doi>
  openalex.mjs stats <author-or-institution>

Data dir: ${DATA_DIR}
No auth. OpenAlex prefers a contact email — set OPENALEX_CONTACT=you@example.com to identify your traffic for the polite pool.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'search':      await cmdSearch(flags.positional[0], flags); break;
      case 'author':      await cmdAuthor(flags.positional[0], flags); break;
      case 'institution': await cmdInstitution(flags.positional[0], flags); break;
      case 'view':        await cmdView(flags.positional[0]); break;
      case 'stats':       await cmdStats(flags.positional[0], flags); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':      usage(); break;
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
