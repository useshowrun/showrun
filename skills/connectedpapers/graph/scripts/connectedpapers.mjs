#!/usr/bin/env node
// connectedpapers.mjs — Build Connected Papers graphs via the public frontend API.
//
// Endpoints discovered at rest.prod.connectedpapers.com (no auth, no token):
//   GET /autocomplete/<query>              — keyword search → {matches:[{id,title,authorsYear}]}
//   GET /graph_no_build/<s2id[+<s2id>...]> — cached graph binary (CPGR format, see below)
//   GET /fresh_graph_no_build/<s2id>       — same but forces fresh copy
//   GET /versions/<s2id>/<version>         — list graph versions (uuid, corpus_date)
//
// IDs are 40-hex Semantic Scholar paper IDs. You can chain multiple with `+`.
//
// CPGR binary format (little-endian, reverse-engineered from index-DXrY1AMA.js → Ff()):
//   bytes  0..3   magic "CPGR"
//   bytes  4..7   uint32 status  1=OK 2=LONG_PAPER 3=IN_PROGRESS 4=NOT_RUN
//                                5=ADDED_TO_QUEUE 6=ERROR 7=OVERLOADED
//                                8=IN_QUEUE 9=NOT_IN_API
//   bytes  8..11  uint32 data_length
//   bytes  12..12+data_length   zlib-deflated UTF-8 JSON (for status=OK)
//   trailing              optional 4-byte uuid_len + uuid bytes
//
// Graph JSON shape:
//   { nodes: {id:{...paper}}, edges: [[from,to,weight],...],
//     common_citations: {"0":{...},...}, common_references: {"0":{...},...},
//     common_authors: {...}, parameters: {...}, path_lengths: {...},
//     start_id, current_corpus_date, creation_time }
//
// Each node contains: id, corpusid, title, authors[], year, venue, doi, arxivId,
// externalIds, abstract, tldr, citations_length, references_length, fieldsOfStudy,
// isOpenAccess, publicationDate, url, path, path_length, pos (graph coords), etc.
//
// Requires Node 22+ (built-in fetch). Stdlib only.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { inflateSync } from 'zlib';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/connectedpapers');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

const API_BASE = 'https://rest.prod.connectedpapers.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 connectedpapers-skill/1.0';
const TIMEOUT_MS = 30_000;

const STATUS = {
  1: 'OK', 2: 'LONG_PAPER', 3: 'IN_PROGRESS', 4: 'NOT_RUN',
  5: 'ADDED_TO_QUEUE', 6: 'ERROR', 7: 'OVERLOADED',
  8: 'IN_QUEUE', 9: 'NOT_IN_API',
};

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function apiGet(path, { binary = false } = {}) {
  const url = `${API_BASE}${path}`;
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
    signal: ctl,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  if (binary) return Buffer.from(await res.arrayBuffer());
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch { return txt; }
}

// ---------------------------------------------------------------------------
// CPGR decoder
// ---------------------------------------------------------------------------

function decodeCPGR(buf) {
  if (buf.length < 12) throw new Error('Response too short to be CPGR');
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'CPGR') throw new Error(`Bad magic: ${magic}`);
  const status = buf.readUInt32LE(4);
  const statusName = STATUS[status] || `UNKNOWN_${status}`;
  const dataLen = buf.readUInt32LE(8);
  const data = buf.slice(12, 12 + dataLen);
  if (data.length !== dataLen) {
    throw new Error(`Length mismatch: header says ${dataLen}, got ${data.length}`);
  }
  let payload = null;
  if (status === 1 && dataLen > 0) {
    payload = JSON.parse(inflateSync(data).toString('utf8'));
  } else if (status === 3 && dataLen === 4) {
    payload = { progress: data.readUInt32LE(0) };
  }
  // Trailing uuid
  let uuid = null;
  const tail = buf.slice(12 + dataLen);
  if (tail.length >= 4) {
    const uuidLen = tail.readUInt32LE(0);
    if (uuidLen > 0 && tail.length >= 4 + uuidLen) {
      uuid = tail.slice(4, 4 + uuidLen).toString('hex');
    }
  }
  if (payload && uuid) payload.uuid = uuid;
  return { status: statusName, payload };
}

// ---------------------------------------------------------------------------
// ID resolution
// ---------------------------------------------------------------------------

function isS2Id(s) {
  return /^[a-f0-9]{40}$/i.test(s);
}

async function resolveId(input) {
  // Normalize: S2 IDs are lowercase hex on the server side.
  if (isS2Id(input)) return input.toLowerCase();
  // Multi-paper (already chained)
  if (/^[a-f0-9]{40}(\+[a-f0-9]{40})+$/i.test(input)) return input.toLowerCase();
  // Otherwise treat as free-text query → autocomplete → first match
  const res = await apiGet(`/autocomplete/${encodeURIComponent(input)}`);
  if (!res || !res.matches || res.matches.length === 0) {
    throw new Error(`No paper found matching: ${input}`);
  }
  const first = res.matches[0];
  console.error(`[resolved] "${input}" → ${first.id}  (${first.title} — ${first.authorsYear})`);
  return first.id;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function paperLine(p) {
  const authors = (p.authors || []).map(a => a.name).slice(0, 3).join(', ');
  const extra = (p.authors || []).length > 3 ? ` +${p.authors.length - 3}` : '';
  const year = p.year || '';
  const venue = p.venue || '';
  const cites = p.citations_length != null ? `citations=${p.citations_length}` : '';
  const refs = p.references_length != null ? `refs=${p.references_length}` : '';
  const meta = [cites, refs].filter(Boolean).join(' ');
  const ids = [];
  if (p.arxivId) ids.push(`arXiv:${p.arxivId}`);
  if (p.doi) ids.push(`doi:${p.doi}`);
  return `- ${p.title} (${year}) — ${authors}${extra}\n    ${venue}${venue && meta ? '  |  ' : ''}${meta}\n    id=${p.id}${ids.length ? '  ' + ids.join('  ') : ''}`;
}

async function cmdSearch(query, opts = {}) {
  const limit = parseInt(opts.limit || '20', 10);
  const res = await apiGet(`/autocomplete/${encodeURIComponent(query)}`);
  const matches = (res && res.matches || []).slice(0, limit);
  if (opts.json) {
    console.log(JSON.stringify(matches, null, 2));
  } else {
    for (const m of matches) {
      console.log(`- ${m.title}  (${m.authorsYear})\n    id=${m.id}`);
    }
    console.log(`\n${matches.length} matches`);
  }
  saveJson(resolve(CACHE_DIR, `search-${slugify(query)}.json`), { query, fetched_at: new Date().toISOString(), matches });
  return matches;
}

async function cmdGraph(input, opts = {}) {
  const id = await resolveId(input);
  const path = opts.fresh ? `/fresh_graph_no_build/${id}` : `/graph_no_build/${id}`;
  const buf = await apiGet(path, { binary: true });
  const { status, payload } = decodeCPGR(buf);
  if (status !== 'OK' || !payload) {
    console.error(`Graph not ready: status=${status}${payload && payload.progress != null ? ` progress=${payload.progress}%` : ''}`);
    console.error(`If status=NOT_RUN / IN_QUEUE / ADDED_TO_QUEUE, the graph is being computed. Wait a minute and retry.`);
    process.exit(2);
  }
  // Cache
  const cachePath = resolve(CACHE_DIR, `graph-${id}.json`);
  saveJson(cachePath, { fetched_at: new Date().toISOString(), graph: payload });
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  // Pretty summary
  const origin = payload.nodes && payload.nodes[payload.start_id];
  const nodes = Object.values(payload.nodes || {}).sort((a, b) => (b.citations_length || 0) - (a.citations_length || 0));
  const limit = parseInt(opts.limit || '15', 10);
  console.log(`# ${origin ? origin.title : id}`);
  if (origin) {
    console.log(`  ${(origin.authors || []).map(a => a.name).join(', ')} (${origin.year || '?'})`);
    console.log(`  venue=${origin.venue || '?'}  citations=${origin.citations_length}  refs=${origin.references_length}`);
    if (origin.doi) console.log(`  doi=${origin.doi}`);
    if (origin.arxivId) console.log(`  arxiv=${origin.arxivId}`);
  }
  console.log(`\nGraph: ${Object.keys(payload.nodes).length} nodes, ${payload.edges.length} edges`);
  console.log(`Corpus date: ${payload.current_corpus_date}\n`);
  console.log(`Top ${limit} related nodes by citation count:`);
  for (const n of nodes.slice(0, limit)) console.log(paperLine(n));
  console.log(`\nCached → ${cachePath}`);
  return payload;
}

async function cmdPrior(input, opts = {}) {
  const id = await resolveId(input);
  const graph = await fetchGraphRaw(id, opts.fresh);
  const list = Object.values(graph.common_references || {})
    .map(p => ({ ...p, _score: (p.citations_length || 0) }))
    .sort((a, b) => b._score - a._score);
  const limit = parseInt(opts.limit || '20', 10);
  if (opts.json) {
    console.log(JSON.stringify(list.slice(0, limit), null, 2));
    return;
  }
  const origin = graph.nodes[graph.start_id];
  console.log(`# Prior works for "${origin ? origin.title : id}"`);
  console.log(`(Papers most-referenced by the graph — these shaped the origin's field)\n`);
  for (const n of list.slice(0, limit)) console.log(paperLine(n));
}

async function cmdDerivative(input, opts = {}) {
  const id = await resolveId(input);
  const graph = await fetchGraphRaw(id, opts.fresh);
  const list = Object.values(graph.common_citations || {})
    .map(p => ({ ...p, _score: (p.citations_length || 0) }))
    .sort((a, b) => b._score - a._score);
  const limit = parseInt(opts.limit || '20', 10);
  if (opts.json) {
    console.log(JSON.stringify(list.slice(0, limit), null, 2));
    return;
  }
  const origin = graph.nodes[graph.start_id];
  console.log(`# Derivative works for "${origin ? origin.title : id}"`);
  console.log(`(Papers that cite the most graph nodes — where this work was taken up)\n`);
  for (const n of list.slice(0, limit)) console.log(paperLine(n));
}

async function cmdPaper(input, opts = {}) {
  const id = await resolveId(input);
  const graph = await fetchGraphRaw(id, opts.fresh);
  const p = graph.nodes[graph.start_id];
  if (!p) throw new Error(`Origin node missing in graph for ${id}`);
  if (opts.json) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(paperLine(p));
  if (p.abstract) console.log(`\nAbstract:\n${p.abstract}`);
  if (p.tldr && p.tldr.text) console.log(`\nTL;DR: ${p.tldr.text}`);
}

async function cmdVersions(input) {
  const id = await resolveId(input);
  const res = await apiGet(`/versions/${id}/1`);
  console.log(JSON.stringify(res, null, 2));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchGraphRaw(id, fresh) {
  const cachePath = resolve(CACHE_DIR, `graph-${id}.json`);
  if (!fresh && existsSync(cachePath)) {
    return loadJson(cachePath).graph;
  }
  const path = fresh ? `/fresh_graph_no_build/${id}` : `/graph_no_build/${id}`;
  const buf = await apiGet(path, { binary: true });
  const { status, payload } = decodeCPGR(buf);
  if (status !== 'OK' || !payload) {
    throw new Error(`Graph not ready: status=${status}`);
  }
  saveJson(cachePath, { fetched_at: new Date().toISOString(), graph: payload });
  return payload;
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
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP = `connectedpapers — Connected Papers graph + impact data (no auth)

Commands:
  search <query>                 Keyword search via autocomplete
  graph <paper>                  Build/fetch graph + summary (top related papers)
  paper <paper>                  Origin paper metadata
  prior <paper>                  Common references (what shaped the paper's field)
  derivative <paper>             Common citations (where the work was taken up)
  versions <paper>               List graph versions / corpus dates

<paper> can be:
  - A 40-hex Semantic Scholar paper ID
  - Multiple S2 IDs chained with + (multi-paper graph)
  - Free text (title, DOI, arXiv ID) — resolved via /autocomplete

Flags:
  --limit=N      Cap output lines (default 15-20 depending on command)
  --json         Machine-readable JSON output
  --fresh        Force fresh graph fetch (bypass local + server cache)

Examples:
  node scripts/connectedpapers.mjs search "attention is all you need"
  node scripts/connectedpapers.mjs graph 204e3073870fae3d05bcbc2f6a8e263d9b72e776
  node scripts/connectedpapers.mjs graph "attention is all you need" --limit=30
  node scripts/connectedpapers.mjs prior 204e3073870fae3d05bcbc2f6a8e263d9b72e776 --json
  node scripts/connectedpapers.mjs derivative "llama open foundation" --json

Data layout: ~/.local/share/showrun/data/connectedpapers/cache/
  graph-<id>.json     per-paper full graph JSON (decoded CPGR payload)
  search-<slug>.json  per-query autocomplete result
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  try {
    switch (cmd) {
      case 'search': {
        if (!positional[1]) { console.error('Usage: search <query>'); process.exit(1); }
        await cmdSearch(positional.slice(1).join(' '), flags);
        break;
      }
      case 'graph': {
        if (!positional[1]) { console.error('Usage: graph <paper>'); process.exit(1); }
        await cmdGraph(positional.slice(1).join(' '), flags);
        break;
      }
      case 'paper': {
        if (!positional[1]) { console.error('Usage: paper <paper>'); process.exit(1); }
        await cmdPaper(positional.slice(1).join(' '), flags);
        break;
      }
      case 'prior': {
        if (!positional[1]) { console.error('Usage: prior <paper>'); process.exit(1); }
        await cmdPrior(positional.slice(1).join(' '), flags);
        break;
      }
      case 'derivative':
      case 'deriv': {
        if (!positional[1]) { console.error('Usage: derivative <paper>'); process.exit(1); }
        await cmdDerivative(positional.slice(1).join(' '), flags);
        break;
      }
      case 'versions': {
        if (!positional[1]) { console.error('Usage: versions <paper>'); process.exit(1); }
        await cmdVersions(positional.slice(1).join(' '));
        break;
      }
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
