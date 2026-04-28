#!/usr/bin/env node
// wikipedia-stats.mjs — Wikimedia Pageviews + Wikidata SPARQL wrapper.
//
// Endpoints used (no auth, public):
//   GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}
//   GET https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{project}/{access}/{year}/{month}/{day}
//   GET https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/{project}/{access}/{agent}/{granularity}/{start}/{end}
//   GET https://en.wikipedia.org/w/api.php?action=opensearch&search=...
//   GET https://www.wikidata.org/wiki/Special:EntityData/{Q-id}.json
//   GET https://query.wikidata.org/sparql?query=...&format=json
//
// Requires Node 22+ (built-in fetch). Stdlib only, no dependencies.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/wikipedia-stats');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const PAGEVIEWS_BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData';
const USER_AGENT = 'wikipedia-stats-skill/1.0 (researcher; node; eyup@showrun.co)';
const TIMEOUT_MS = 60_000;
const RATE_GAP_MS = 250;

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function loadJson(path, fb) { if (!existsSync(path)) return fb; try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fb; } }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g,'').slice(0,80); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// Wikipedia article title canonicalisation: spaces -> underscores, then percent-encode.
function encodeArticle(title) {
  const t = String(title).trim().replace(/ /g,'_');
  // encodeURIComponent will percent-encode slashes and other reserved chars
  // but the API expects underscores literal — so we encode each path char individually.
  return encodeURIComponent(t);
}

function pad2(n) { return String(n).padStart(2,'0'); }
function ymd(d) {
  const y = d.getUTCFullYear();
  return `${y}${pad2(d.getUTCMonth()+1)}${pad2(d.getUTCDate())}`;
}
function defaultRange(days=365) {
  const end = new Date();
  const start = new Date(end.getTime() - days*86400000);
  return { from: ymd(start), to: ymd(end) };
}

async function getJSON(url, { acceptText=false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Accept': acceptText ? 'text/plain' : 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0,200)}`);
  }
  return acceptText ? res.text() : res.json();
}

// ASCII bar — width chars proportional to value/max
function bar(value, max, width=40) {
  if (!max || !value) return '';
  const n = Math.max(1, Math.round((value/max)*width));
  return '#'.repeat(Math.min(n, width));
}

function fmt(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString();
}

function cachedOrFetch(cacheKey, fetcher, opts={}) {
  const path = resolve(CACHE_DIR, cacheKey);
  if (!opts.refresh && existsSync(path)) {
    const stat = readFileSync(path,'utf8');
    process.stderr.write(`[cache hit] ${path}\n`);
    return Promise.resolve({ data: JSON.parse(stat), path, cached: true });
  }
  return fetcher().then(data => {
    saveJson(path, { fetched_at: new Date().toISOString(), ...data });
    return { data, path, cached: false };
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPageviews(article, opts={}) {
  if (!article) throw new Error('Usage: pageviews <article> [--project=en.wikipedia.org] [--from=YYYYMMDD] [--to=YYYYMMDD] [--granularity=daily|monthly] [--access=all-access] [--agent=user]');
  const project = opts.project || 'en.wikipedia.org';
  const access = opts.access || 'all-access';
  const agent = opts.agent || 'user';
  const granularity = opts.granularity || 'daily';
  const range = (opts.from && opts.to) ? { from: opts.from, to: opts.to } : defaultRange(90);

  const enc = encodeArticle(article);
  const url = `${PAGEVIEWS_BASE}/per-article/${project}/${access}/${agent}/${enc}/${granularity}/${range.from}/${range.to}`;
  const cacheKey = `pageviews-${slug(project)}-${slug(article)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

  let result;
  if (existsSync(cachePath) && !opts.refresh) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, ...result });
  }

  const items = result.items || [];
  if (!items.length) {
    console.log(`# Wikipedia pageviews — ${article}\n  no data returned (${range.from} → ${range.to})`);
    return;
  }
  const total = items.reduce((s,i)=>s+(i.views||0),0);
  const max = Math.max(...items.map(i=>i.views||0));
  const avg = total / items.length;

  console.log(`# Wikipedia pageviews — ${article}  (${project}, ${access}/${agent}, ${granularity})`);
  console.log(`   range: ${range.from} → ${range.to}  (${items.length} buckets)`);
  console.log(`   total: ${fmt(total)}   avg/bucket: ${fmt(Math.round(avg))}   peak: ${fmt(max)}\n`);

  // Compact rows + ASCII bars
  const showWidth = 50;
  const dispLimit = 60;
  const display = items.length > dispLimit
    ? items.filter((_,i)=> i % Math.ceil(items.length/dispLimit) === 0)
    : items;
  for (const it of display) {
    const ts = it.timestamp || '';
    const date = granularity === 'monthly'
      ? `${ts.slice(0,4)}-${ts.slice(4,6)}`
      : `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
    console.log(`   ${date}  ${String(fmt(it.views)).padStart(10)}  ${bar(it.views, max, showWidth)}`);
  }
  console.log(`\nCached: ${cachePath}`);
}

async function cmdTop(project, year, month, day) {
  if (!project || !year || !month) throw new Error('Usage: top <project> <year> <month> [day]   (day defaults to all-days)');
  const access = 'all-access';
  const y = String(year);
  const m = pad2(month);
  const d = day ? pad2(day) : 'all-days';
  const url = `${PAGEVIEWS_BASE}/top/${project}/${access}/${y}/${m}/${d}`;
  const cacheKey = `top-${slug(project)}-${y}-${m}-${d}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, ...result });
  }
  const items = (result.items && result.items[0] && result.items[0].articles) || [];
  if (!items.length) {
    console.log(`# Wikipedia top — ${project} ${y}-${m}-${d}\n  no data`);
    return;
  }
  const top = items.slice(0,50);
  const max = Math.max(...top.map(a=>a.views));
  console.log(`# Wikipedia top articles — ${project}  (${y}-${m}${d==='all-days'?'':'-'+d}, access=${access})\n`);
  for (const a of top) {
    console.log(`   ${String(a.rank).padStart(3)}.  ${String(fmt(a.views)).padStart(10)}  ${a.article.padEnd(40).slice(0,40)}  ${bar(a.views, max, 30)}`);
  }
  console.log(`\nCached: ${cachePath}`);
}

async function cmdAggregate(project, opts={}) {
  if (!project) throw new Error('Usage: aggregate <project> [--from=YYYYMMDD] [--to=YYYYMMDD] [--granularity=daily|monthly] [--access=all-access] [--agent=all-agents]');
  const access = opts.access || 'all-access';
  const agent = opts.agent || 'all-agents';
  const granularity = opts.granularity || 'monthly';
  const range = (opts.from && opts.to) ? { from: opts.from, to: opts.to } : defaultRange(365);
  const url = `${PAGEVIEWS_BASE}/aggregate/${project}/${access}/${agent}/${granularity}/${range.from}/${range.to}`;
  const cacheKey = `aggregate-${slug(project)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, ...result });
  }
  const items = result.items || [];
  if (!items.length) {
    console.log(`# Wikipedia aggregate — ${project}\n  no data`);
    return;
  }
  const total = items.reduce((s,i)=>s+(i.views||0),0);
  const max = Math.max(...items.map(i=>i.views||0));
  console.log(`# Wikipedia aggregate pageviews — ${project}  (${access}/${agent}, ${granularity})`);
  console.log(`   range: ${range.from} → ${range.to}   total: ${fmt(total)}   peak: ${fmt(max)}\n`);
  for (const it of items) {
    const ts = it.timestamp || '';
    const date = granularity === 'monthly' ? `${ts.slice(0,4)}-${ts.slice(4,6)}` : `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
    console.log(`   ${date}  ${String(fmt(it.views)).padStart(14)}  ${bar(it.views, max, 40)}`);
  }
  console.log(`\nCached: ${cachePath}`);
}

async function cmdSearch(term, opts={}) {
  if (!term) throw new Error('Usage: search <term> [--project=en.wikipedia.org] [--limit=10]');
  const lang = (opts.project || 'en.wikipedia.org').split('.')[0];
  const limit = opts.limit || 10;
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&format=json&limit=${limit}`;
  const cacheKey = `search-${lang}-${slug(term)}-${limit}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, raw: result });
  }
  // OpenSearch shape: [term, [titles], [descriptions], [urls]]
  const raw = result.raw || result;
  const titles = raw[1] || [];
  const descs = raw[2] || [];
  const urls = raw[3] || [];
  console.log(`# Wikipedia opensearch — "${term}"  (${lang}.wikipedia.org)\n`);
  if (!titles.length) { console.log('   no results'); return; }
  for (let i=0; i<titles.length; i++) {
    console.log(`   ${String(i+1).padStart(2)}.  ${titles[i]}`);
    if (descs[i]) console.log(`        ${descs[i].slice(0,120)}`);
    if (urls[i]) console.log(`        ${urls[i]}`);
  }
  console.log(`\nCached: ${cachePath}`);
}

async function cmdEntity(idOrSearch) {
  if (!idOrSearch) throw new Error('Usage: entity <Q-id or search term>');
  let qid = idOrSearch;
  if (!/^Q\d+$/i.test(qid)) {
    // Search Wikidata via wbsearchentities
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
  const cacheKey = `entity-${qid}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

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

  // Show a few notable properties (instance of, founded by, inception, official website)
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
      if (v.id) return v.id;            // wikibase-item
      if (v.time) return v.time;        // time
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
  const cacheKey = `sparql-${slug(query.slice(0,80))}-${Buffer.from(query).toString('base64').slice(0,12)}.json`;
  const cachePath = resolve(CACHE_DIR, cacheKey);

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
  // Print compact table
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

async function cmdCompare(articles, opts={}) {
  if (!articles || articles.length < 2) throw new Error('Usage: compare <article1> <article2> [...]');
  const project = opts.project || 'en.wikipedia.org';
  const access = opts.access || 'all-access';
  const agent = opts.agent || 'user';
  const granularity = opts.granularity || 'monthly';
  const range = (opts.from && opts.to) ? { from: opts.from, to: opts.to } : defaultRange(365);

  console.log(`# Wikipedia pageviews compare — ${articles.length} articles  (${project}, ${access}/${agent}, ${granularity})`);
  console.log(`   range: ${range.from} → ${range.to}\n`);

  const results = [];
  for (const art of articles) {
    const enc = encodeArticle(art);
    const url = `${PAGEVIEWS_BASE}/per-article/${project}/${access}/${agent}/${enc}/${granularity}/${range.from}/${range.to}`;
    const cacheKey = `pageviews-${slug(project)}-${slug(art)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`;
    const cachePath = resolve(CACHE_DIR, cacheKey);
    let r;
    try {
      if (existsSync(cachePath)) {
        r = JSON.parse(readFileSync(cachePath,'utf8'));
      } else {
        r = await getJSON(url);
        saveJson(cachePath, { fetched_at: new Date().toISOString(), url, ...r });
        await sleep(RATE_GAP_MS);
      }
      const items = r.items || [];
      const total = items.reduce((s,i)=>s+(i.views||0),0);
      const peak = items.length ? Math.max(...items.map(i=>i.views||0)) : 0;
      results.push({ article: art, total, peak, buckets: items.length });
    } catch (e) {
      results.push({ article: art, error: e.message.slice(0,100) });
    }
  }
  // Sort by total desc
  results.sort((a,b)=> (b.total||0) - (a.total||0));
  const max = Math.max(...results.map(r=>r.total||0));
  for (const r of results) {
    if (r.error) {
      console.log(`   err  ${r.article}: ${r.error}`);
      continue;
    }
    console.log(`   ${String(fmt(r.total)).padStart(14)}  peak=${String(fmt(r.peak)).padStart(10)}  ${r.article.padEnd(28).slice(0,28)}  ${bar(r.total, max, 30)}`);
  }
  const cachePath = resolve(CACHE_DIR, `compare-${slug(articles.join('-'))}-${range.from}-${range.to}.json`);
  saveJson(cachePath, { fetched_at: new Date().toISOString(), articles, range, results });
  console.log(`\nCached: ${cachePath}`);
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
  wikipedia-stats.mjs pageviews <article> [--project=en.wikipedia.org] [--from=YYYYMMDD] [--to=YYYYMMDD] [--granularity=daily|monthly] [--access=all-access|desktop|mobile-web|mobile-app] [--agent=user|all-agents|bot|spider]
  wikipedia-stats.mjs top <project> <year> <month> [day]    # day defaults to all-days
  wikipedia-stats.mjs aggregate <project> [--from] [--to] [--granularity=daily|monthly] [--access] [--agent]
  wikipedia-stats.mjs search <term> [--project=en.wikipedia.org] [--limit=10]
  wikipedia-stats.mjs entity <Q-id-or-search>
  wikipedia-stats.mjs sparql <SPARQL query string>
  wikipedia-stats.mjs sparql-file <path-to-.rq>
  wikipedia-stats.mjs compare <article1> <article2> [...] [--project] [--from] [--to] [--granularity]
  wikipedia-stats.mjs help

User-Agent sent: ${USER_AGENT}
Data dir:        ${DATA_DIR}
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'pageviews':   await cmdPageviews(flags.positional[0], flags); break;
      case 'top':         await cmdTop(flags.positional[0], flags.positional[1], flags.positional[2], flags.positional[3]); break;
      case 'aggregate':   await cmdAggregate(flags.positional[0], flags); break;
      case 'search':      await cmdSearch(flags.positional[0], flags); break;
      case 'entity':      await cmdEntity(flags.positional[0]); break;
      case 'sparql':      await cmdSparql(flags.positional.join(' ')); break;
      case 'sparql-file': await cmdSparqlFile(flags.positional[0]); break;
      case 'compare':     await cmdCompare(flags.positional, flags); break;
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
