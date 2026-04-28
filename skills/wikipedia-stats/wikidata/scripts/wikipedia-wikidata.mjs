#!/usr/bin/env node
// wikipedia-wikidata.mjs — Wikidata SPARQL + EntityData lookup wrapper.
//
// Endpoints used (no auth, public):
//   GET https://www.wikidata.org/wiki/Special:EntityData/{Q-id}.json
//   GET https://query.wikidata.org/sparql?query=...&format=json
//   GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=...   (Q-id resolution)
//
// Requires Node 22+ (built-in fetch). Stdlib only, no dependencies.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/wikipedia-stats');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData';
const USER_AGENT = 'wikipedia-wikidata-skill/1.0 (researcher; node; eyup@showrun.co)';
const TIMEOUT_MS = 60_000;

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g,'').slice(0,80); }

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0,200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdEntity(idOrSearch) {
  if (!idOrSearch) throw new Error('Usage: entity <Q-id or search term>');
  let qid = idOrSearch;
  if (!/^Q\d+$/i.test(qid)) {
    const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(idOrSearch)}&language=en&format=json&limit=5`;
    const sRes = await getJSON(sUrl);
    const hits = sRes.search || [];
    if (!hits.length) { console.log(`# Wikidata entity — no match for "${idOrSearch}"`); return; }
    console.log(`# Wikidata search — "${idOrSearch}"  (${hits.length} hits)`);
    for (const h of hits) console.log(`   ${h.id}  ${h.label}  — ${h.description || ''}`);
    qid = hits[0].id;
    console.log(`\n→ fetching first result: ${qid}\n`);
  }
  qid = qid.toUpperCase();
  const url = `${WIKIDATA_ENTITY}/${qid}.json`;
  const cachePath = resolve(CACHE_DIR, `entity-${qid}.json`);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, ...result });
  }
  const ent = result.entities && result.entities[qid];
  if (!ent) { console.log(`# Wikidata entity — ${qid}\n  not found`); return; }

  const labelEn = ent.labels?.en?.value || '(no label)';
  const descEn = ent.descriptions?.en?.value || '';
  const aliases = (ent.aliases?.en || []).map(a=>a.value).slice(0,5);
  const claims = ent.claims || {};
  const claimCount = Object.keys(claims).length;
  const sitelinks = Object.keys(ent.sitelinks || {});

  console.log(`# Wikidata entity — ${qid}  ${labelEn}`);
  console.log(`   description: ${descEn}`);
  if (aliases.length) console.log(`   aliases: ${aliases.join(', ')}`);
  console.log(`   claims: ${claimCount} properties`);
  console.log(`   sitelinks: ${sitelinks.length} (${sitelinks.slice(0,8).join(', ')}${sitelinks.length>8?', …':''})`);

  const notable = ['P31','P17','P571','P112','P856','P1813','P154','P159'];
  const propLabels = {
    P31:'instance of', P17:'country', P571:'inception', P112:'founder',
    P856:'website', P1813:'short name', P154:'logo', P159:'HQ',
  };
  console.log(`\n   notable claims:`);
  for (const p of notable) {
    if (!claims[p]) continue;
    const vals = claims[p].slice(0,3).map(c => {
      const v = c.mainsnak?.datavalue?.value;
      if (!v) return '?';
      if (typeof v === 'string') return v;
      if (v.id) return v.id;
      if (v.time) return v.time;
      if (v.amount) return v.amount;
      return JSON.stringify(v).slice(0,60);
    });
    console.log(`     ${p} (${propLabels[p]}): ${vals.join(' | ')}`);
  }
  console.log(`\nCached: ${cachePath}`);
}

async function cmdSparql(query) {
  if (!query) throw new Error('Usage: sparql <query>');
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const cachePath = resolve(CACHE_DIR, `sparql-${slug(query.slice(0,80))}-${Buffer.from(query).toString('base64').slice(0,12)}.json`);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), query, ...result });
  }
  const vars = result.head?.vars || [];
  const rows = result.results?.bindings || [];
  console.log(`# Wikidata SPARQL — ${rows.length} rows  (vars: ${vars.join(', ')})\n`);
  if (!rows.length) { console.log('   no results'); return; }
  const widths = vars.map(v => Math.max(v.length, ...rows.slice(0,50).map(r => (r[v]?.value || '').toString().length)));
  console.log('   ' + vars.map((v,i) => v.padEnd(Math.min(widths[i], 40))).join('  '));
  console.log('   ' + vars.map((_,i) => '-'.repeat(Math.min(widths[i], 40))).join('  '));
  for (const r of rows.slice(0,50)) {
    console.log('   ' + vars.map((v,i) => (r[v]?.value || '').toString().slice(0, 40).padEnd(Math.min(widths[i],40))).join('  '));
  }
  if (rows.length > 50) console.log(`   ... (${rows.length - 50} more rows)`);
  console.log(`\nCached: ${cachePath}`);
}

async function cmdSparqlFile(path) {
  if (!path) throw new Error('Usage: sparql-file <path>');
  const query = readFileSync(path, 'utf8');
  return cmdSparql(query);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Usage:
  wikipedia-wikidata.mjs entity <Q-id-or-search>
  wikipedia-wikidata.mjs sparql <SPARQL query string>
  wikipedia-wikidata.mjs sparql-file <path-to-.rq>
  wikipedia-wikidata.mjs help

User-Agent sent: ${USER_AGENT}
Data dir:        ${DATA_DIR}
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const positional = argv.slice(1);
  try {
    switch (cmd) {
      case 'entity':      await cmdEntity(positional[0]); break;
      case 'sparql':      await cmdSparql(positional.join(' ')); break;
      case 'sparql-file': await cmdSparqlFile(positional[0]); break;
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
