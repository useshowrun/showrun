#!/usr/bin/env node
// wikipedia-pageviews.mjs — Wikimedia Pageviews API wrapper.
//
// Endpoints used (no auth, public):
//   GET /metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}
//   GET /metrics/pageviews/top/{project}/{access}/{year}/{month}/{day}
//   GET /metrics/pageviews/aggregate/{project}/{access}/{agent}/{granularity}/{start}/{end}
//   GET https://en.wikipedia.org/w/api.php?action=opensearch&search=...
//
// Requires Node 22+ (built-in fetch). Stdlib only, no dependencies.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/wikipedia-stats');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const PAGEVIEWS_BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
const USER_AGENT = 'wikipedia-pageviews-skill/1.0 (researcher; node; eyup@showrun.co)';
const TIMEOUT_MS = 60_000;
const RATE_GAP_MS = 250;

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g,'').slice(0,80); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

function encodeArticle(title) {
  const t = String(title).trim().replace(/ /g,'_');
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

function bar(value, max, width=40) {
  if (!max || !value) return '';
  const n = Math.max(1, Math.round((value/max)*width));
  return '#'.repeat(Math.min(n, width));
}
function fmt(n) { return n == null ? '-' : Number(n).toLocaleString(); }

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
  const cachePath = resolve(CACHE_DIR, `pageviews-${slug(project)}-${slug(article)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`);

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

  const dispLimit = 60;
  const display = items.length > dispLimit
    ? items.filter((_,i)=> i % Math.ceil(items.length/dispLimit) === 0)
    : items;
  for (const it of display) {
    const ts = it.timestamp || '';
    const date = granularity === 'monthly'
      ? `${ts.slice(0,4)}-${ts.slice(4,6)}`
      : `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
    console.log(`   ${date}  ${String(fmt(it.views)).padStart(10)}  ${bar(it.views, max, 50)}`);
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
  const cachePath = resolve(CACHE_DIR, `top-${slug(project)}-${y}-${m}-${d}.json`);

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
  const cachePath = resolve(CACHE_DIR, `aggregate-${slug(project)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`);

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
  const cachePath = resolve(CACHE_DIR, `search-${lang}-${slug(term)}-${limit}.json`);

  let result;
  if (existsSync(cachePath)) {
    result = JSON.parse(readFileSync(cachePath,'utf8'));
    process.stderr.write(`[cache hit] ${cachePath}\n`);
  } else {
    result = await getJSON(url);
    saveJson(cachePath, { fetched_at: new Date().toISOString(), url, raw: result });
  }
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
    const cachePath = resolve(CACHE_DIR, `pageviews-${slug(project)}-${slug(art)}-${access}-${agent}-${granularity}-${range.from}-${range.to}.json`);
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
  results.sort((a,b)=> (b.total||0) - (a.total||0));
  const max = Math.max(...results.map(r=>r.total||0));
  for (const r of results) {
    if (r.error) { console.log(`   err  ${r.article}: ${r.error}`); continue; }
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
  wikipedia-pageviews.mjs pageviews <article> [--project=en.wikipedia.org] [--from=YYYYMMDD] [--to=YYYYMMDD] [--granularity=daily|monthly] [--access=all-access|desktop|mobile-web|mobile-app] [--agent=user|all-agents|bot|spider]
  wikipedia-pageviews.mjs top <project> <year> <month> [day]    # day defaults to all-days
  wikipedia-pageviews.mjs aggregate <project> [--from] [--to] [--granularity=daily|monthly] [--access] [--agent]
  wikipedia-pageviews.mjs search <term> [--project=en.wikipedia.org] [--limit=10]
  wikipedia-pageviews.mjs compare <article1> <article2> [...] [--project] [--from] [--to] [--granularity]
  wikipedia-pageviews.mjs help

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
      case 'pageviews': await cmdPageviews(flags.positional[0], flags); break;
      case 'top':       await cmdTop(flags.positional[0], flags.positional[1], flags.positional[2], flags.positional[3]); break;
      case 'aggregate': await cmdAggregate(flags.positional[0], flags); break;
      case 'search':    await cmdSearch(flags.positional[0], flags); break;
      case 'compare':   await cmdCompare(flags.positional, flags); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':    usage(); break;
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
