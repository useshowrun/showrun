#!/usr/bin/env node
// gdelt.mjs — GDELT 2.0 DOC API wrapper.
//
// Endpoint (no auth, public):
//   GET https://api.gdeltproject.org/api/v2/doc/doc?query=...&mode=...&format=...&timespan=...
//
// GDELT politely asks for ≤ 1 request / 5 s. The script self-throttles to 5500 ms.
//
// Modes used:
//   ArtList            — top recent articles (returns {articles:[...]})
//   ArtListWithImage   — same + image fields
//   TimelineVol        — daily volume intensity (% of monitored articles)
//   TimelineTone       — daily average tone (-10 negative … +10 positive)
//   TimelineLang       — top languages over time
//   TimelineSourceCountry — top source countries over time (proxy for "geo")
//   ToneChart          — histogram of tones with sample articles per bin
//   WordCloud          — top words/phrases
//   ImageCollage       — collage of social-share images
//
// Query syntax (most useful operators, all combinable with implicit AND):
//   "exact phrase"     — quoted exact match
//   wordA wordB        — implicit AND
//   (wordA OR wordB)   — boolean OR
//   -wordA             — negation
//   near10:"word1 word2"  — words within N tokens
//   repeat3:"word"     — word must appear ≥ N times in article
//   domain:nytimes.com — restrict to a single source domain
//   sourcecountry:US   — restrict to source-country code
//   theme:KILL         — articles tagged with a GDELT theme
//   tone>5             — tone score above N
//   tone<-5            — tone score below N
//   imagewebcount>0    — articles whose lead image was already on the web
//
// Timespan format: 15min, 60min, 24h, 7d, 30d, 6m, 1y, 2y. Default in this skill: 7d.
//
// Requires Node 22+ (built-in fetch). Stdlib only.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { setDefaultResultOrder } from 'dns';
import https from 'https';

// GDELT's api.gdeltproject.org sometimes only resolves cleanly over IPv4 from
// cloud egress; the AAAA record black-holes inside undici's 10s connect timeout.
// Force IPv4 globally and skip global fetch entirely (use https module below).
try { setDefaultResultOrder('ipv4first'); } catch {}

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/gdelt');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const USER_AGENT = 'gdelt-skill/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 5500;            // GDELT asks for ≤ 1 req / 5 s
const RETRY_DELAYS_MS = [6000, 12000, 24000];

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fmtDate(stamp) {
  // 20260425T180000Z → 2026-04-25 18:00 UTC
  if (!stamp || stamp.length < 13) return stamp || '?';
  return `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)} ${stamp.slice(9,11)}:${stamp.slice(11,13)} UTC`;
}
function shortDate(stamp) {
  if (!stamp || stamp.length < 8) return stamp || '?';
  return `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}`;
}

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

function buildUrl(params) {
  const u = new URL(API_BASE);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  return u.toString();
}

function httpsGetIPv4(urlStr, headers) {
  // Use the stdlib https module so we can pass `family: 4` and a generous timeout —
  // global fetch() is undici-backed and gives no easy IPv6-disable knob.
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers, Host: u.hostname },
      family: 4,
      timeout: TIMEOUT_MS,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)); });
    req.end();
  });
}

async function gdelt(params) {
  // Always force JSON; the doc endpoint can also serve csv/html/rss
  const url = buildUrl({ format: 'json', ...params });
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    let res;
    try { res = await httpsGetIPv4(url, { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }); }
    catch (e) { lastErr = e; res = null; }
    if (!res) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error on GDELT after retries: ${lastErr?.message || 'unknown'}`);
    }
    const text = res.body;
    // GDELT rate-limit is a plain text response, not 429
    if (/limit requests to one every/i.test(text)) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`GDELT rate-limit: ${text.slice(0,200)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 429 || res.status === 503) {
        if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      }
      throw new Error(`HTTP ${res.status} on GDELT: ${text.slice(0,200)}`);
    }
    if (!text.trim()) return {};
    // Some modes (Image*, WordCloud) sometimes return non-JSON; degrade gracefully
    let data;
    try { data = JSON.parse(text); }
    catch { return { _raw: text }; }
    return data;
  }
  throw lastErr || new Error('GDELT exhausted retries');
}

function asciiBar(value, maxValue, width = 40) {
  if (!maxValue) return '';
  const len = Math.max(0, Math.round(width * (value / maxValue)));
  return '█'.repeat(len);
}

function asciiSignedBar(value, absMax, halfWidth = 20) {
  // For tone (-10 … +10): print a centred bar
  if (!absMax) return '';
  const len = Math.round(halfWidth * Math.min(Math.abs(value), absMax) / absMax);
  if (value >= 0) return ' '.repeat(halfWidth) + '┤' + '█'.repeat(len);
  return ' '.repeat(halfWidth - len) + '█'.repeat(len) + '├';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSearch(query, opts = {}) {
  if (!query) throw new Error('Usage: search <query> [--timespan=7d] [--max=20]');
  const timespan = opts.timespan || '7d';
  const maxrecords = Math.min(parseInt(opts.max || '20', 10) || 20, 250);
  const sort = opts.sort || 'DateDesc';   // DateDesc, DateAsc, ToneDesc, ToneAsc, HybridRel
  const data = await gdelt({ query, mode: 'ArtList', maxrecords, timespan, sort });
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}-${timespan}-${maxrecords}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), query, timespan, maxrecords, ...data });
  const arts = data.articles || [];
  console.log(`# GDELT search — "${query}"  (timespan=${timespan}, sort=${sort})\n`);
  if (!arts.length) { console.log(`   no articles matched\n\nCached: ${cacheFile}`); return; }
  console.log(`   ${arts.length} articles:`);
  for (const a of arts) {
    console.log(`\n   • [${shortDate(a.seendate)}] ${a.domain || '?'}  (${a.sourcecountry || '?'}, ${a.language || '?'})`);
    console.log(`     ${(a.title || '').replace(/\s+/g,' ').trim().slice(0,180)}`);
    console.log(`     ${a.url}`);
  }
  // Quick aggregates
  const byCountry = {};
  const byDomain = {};
  for (const a of arts) {
    byCountry[a.sourcecountry || '?'] = (byCountry[a.sourcecountry || '?'] || 0) + 1;
    byDomain[a.domain || '?'] = (byDomain[a.domain || '?'] || 0) + 1;
  }
  const topCountries = Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topDomains = Object.entries(byDomain).sort((a,b)=>b[1]-a[1]).slice(0,5);
  console.log(`\n   Top countries: ${topCountries.map(([k,v])=>`${k}(${v})`).join(', ')}`);
  console.log(`   Top domains:   ${topDomains.map(([k,v])=>`${k}(${v})`).join(', ')}`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdTimeline(query, opts = {}) {
  if (!query) throw new Error('Usage: timeline <query> [--timespan=30d] [--mode=volume|tone|lang|country]');
  const timespan = opts.timespan || '30d';
  const which = (opts.mode || 'volume').toLowerCase();
  const modeMap = {
    volume:  'TimelineVol',
    tone:    'TimelineTone',
    lang:    'TimelineLang',
    language:'TimelineLang',
    country: 'TimelineSourceCountry',
    sourcecountry: 'TimelineSourceCountry',
  };
  const mode = modeMap[which];
  if (!mode) throw new Error(`Unknown timeline mode: ${which}. Try volume|tone|lang|country.`);
  const data = await gdelt({ query, mode, timespan });
  const cacheFile = resolve(CACHE_DIR, `timeline-${slug(query)}-${which}-${timespan}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), query, mode, timespan, ...data });

  console.log(`# GDELT timeline — "${query}"  (mode=${mode}, timespan=${timespan})\n`);
  const series = data.timeline || [];
  if (!series.length) { console.log(`   no timeline data\n\nCached: ${cacheFile}`); return; }

  for (const s of series) {
    const rows = s.data || [];
    if (!rows.length) continue;
    console.log(`   series: ${s.series}  (${rows.length} points)`);
    if (mode === 'TimelineTone') {
      // Centered signed bar
      const absMax = Math.max(1, ...rows.map(r => Math.abs(r.value)));
      for (const r of rows) {
        const v = Number(r.value);
        const bar = asciiSignedBar(v, absMax, 18);
        console.log(`     ${shortDate(r.date)}  ${v.toFixed(2).padStart(7)}  ${bar}`);
      }
    } else {
      const maxV = Math.max(1e-9, ...rows.map(r => Number(r.value)));
      for (const r of rows) {
        const v = Number(r.value);
        const bar = asciiBar(v, maxV, 36);
        const vStr = v >= 1 ? v.toFixed(0).padStart(6) : v.toFixed(4).padStart(6);
        console.log(`     ${shortDate(r.date)}  ${vStr}  ${bar}`);
      }
    }
    console.log('');
  }
  console.log(`Cached: ${cacheFile}`);
}

async function cmdDomain(domain, opts = {}) {
  if (!domain) throw new Error('Usage: domain <domain> [--timespan=7d] [--max=20]');
  const timespan = opts.timespan || '7d';
  const max = Math.min(parseInt(opts.max || '20', 10) || 20, 250);
  const query = `domain:${domain}`;
  const data = await gdelt({ query, mode: 'ArtList', maxrecords: max, timespan, sort: 'DateDesc' });
  const cacheFile = resolve(CACHE_DIR, `domain-${slug(domain)}-${timespan}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), domain, timespan, ...data });
  const arts = data.articles || [];
  console.log(`# GDELT domain — ${domain}  (timespan=${timespan})\n`);
  if (!arts.length) { console.log(`   no articles matched\n\nCached: ${cacheFile}`); return; }
  console.log(`   ${arts.length} most recent articles:`);
  for (const a of arts) {
    console.log(`\n   • [${shortDate(a.seendate)}] (${a.language || '?'})`);
    console.log(`     ${(a.title || '').replace(/\s+/g,' ').trim().slice(0,180)}`);
    console.log(`     ${a.url}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdTheme(theme, opts = {}) {
  if (!theme) throw new Error('Usage: theme <theme-code> [--timespan=7d] [--max=20]');
  const timespan = opts.timespan || '7d';
  const max = Math.min(parseInt(opts.max || '20', 10) || 20, 250);
  const themeCode = theme.toUpperCase().replace(/^THEME:/,'');
  const query = `theme:${themeCode}`;
  const data = await gdelt({ query, mode: 'ArtList', maxrecords: max, timespan, sort: 'DateDesc' });
  const cacheFile = resolve(CACHE_DIR, `theme-${slug(themeCode)}-${timespan}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), theme: themeCode, timespan, ...data });
  const arts = data.articles || [];
  console.log(`# GDELT theme — ${themeCode}  (timespan=${timespan})\n`);
  if (!arts.length) { console.log(`   no articles tagged ${themeCode} in this window\n\nCached: ${cacheFile}`); return; }
  console.log(`   ${arts.length} recent articles:`);
  for (const a of arts) {
    console.log(`\n   • [${shortDate(a.seendate)}] ${a.domain || '?'}  (${a.sourcecountry || '?'})`);
    console.log(`     ${(a.title || '').replace(/\s+/g,' ').trim().slice(0,180)}`);
    console.log(`     ${a.url}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdGeo(query, opts = {}) {
  // Note: the dedicated /api/v2/geo/geo path returns 404 in the public API.
  // We approximate "geographic events for a query" by pulling TimelineSourceCountry
  // (per-country article volume over time), which is the closest free signal.
  if (!query) throw new Error('Usage: geo <query> [--timespan=7d]');
  const timespan = opts.timespan || '7d';
  const data = await gdelt({ query, mode: 'TimelineSourceCountry', timespan });
  const cacheFile = resolve(CACHE_DIR, `geo-${slug(query)}-${timespan}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), query, timespan, ...data });

  const series = data.timeline || [];
  console.log(`# GDELT geo (source-country volume) — "${query}"  (timespan=${timespan})\n`);
  if (!series.length) { console.log(`   no geo data\n\nCached: ${cacheFile}`); return; }

  // Each series is one country; sum its values to rank.
  const totals = series.map(s => ({
    country: s.series,
    total: (s.data || []).reduce((a, r) => a + Number(r.value || 0), 0),
    points: (s.data || []).length,
  })).sort((a,b) => b.total - a.total);

  const max = Math.max(1, ...totals.map(t => t.total));
  console.log(`   Top source countries by total volume:`);
  for (const t of totals.slice(0, 25)) {
    const bar = asciiBar(t.total, max, 36);
    console.log(`     ${t.country.padEnd(28)} ${t.total.toFixed(2).padStart(8)}  ${bar}`);
  }
  console.log(`\n   ${totals.length} countries total. (GDELT has no free lat/lon endpoint;`);
  console.log(`   /api/v2/geo/geo is documented but returns 404 — see SKILL.md.)`);
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdRaw(mode, query, opts = {}) {
  if (!mode || !query) throw new Error('Usage: raw <mode> <query> [--timespan=7d] [--max=20]');
  const timespan = opts.timespan || '7d';
  const params = { query, mode, timespan };
  if (opts.max) params.maxrecords = parseInt(opts.max, 10);
  if (opts.sort) params.sort = opts.sort;
  const data = await gdelt(params);
  const cacheFile = resolve(CACHE_DIR, `raw-${slug(mode)}-${slug(query)}-${timespan}.json`);
  saveJson(cacheFile, { fetched_at: new Date().toISOString(), mode, query, timespan, ...data });
  console.log(`# GDELT raw — mode=${mode}  query="${query}"  timespan=${timespan}\n`);
  console.log(JSON.stringify(data, null, 2).split('\n').slice(0, 200).join('\n'));
  if (JSON.stringify(data, null, 2).split('\n').length > 200) console.log(`   ... (truncated; full JSON in cache file)`);
  console.log(`\nCached: ${cacheFile}`);
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
  return out;
}

function usage() {
  console.log(`Usage:
  gdelt.mjs search <query> [--timespan=7d] [--max=20] [--sort=DateDesc|HybridRel|ToneDesc]
  gdelt.mjs timeline <query> [--timespan=30d] [--mode=volume|tone|lang|country]
  gdelt.mjs domain <domain> [--timespan=7d] [--max=20]
  gdelt.mjs theme <theme-code> [--timespan=7d] [--max=20]    # e.g. KILL, PROTEST, ECON_BANKING
  gdelt.mjs geo <query> [--timespan=7d]                       # source-country volume (geo/geo path is 404)
  gdelt.mjs raw <mode> <query> [--timespan=7d] [--max=20]     # any GDELT mode
  gdelt.mjs help

Modes worth surfacing for raw:
  ArtList, ArtListWithImage, TimelineVol, TimelineTone, TimelineLang,
  TimelineSourceCountry, ToneChart, WordCloud, ImageCollage

Query syntax (combine freely):
  "exact phrase"  near10:"a b"  repeat3:"x"  -word
  domain:nytimes.com  sourcecountry:US  theme:KILL
  tone>5  tone<-5  imagewebcount>0

Data dir: ${DATA_DIR}
Throttle: 5500 ms between requests (GDELT politeness).
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
      case 'timeline': await cmdTimeline(flags.positional[0], flags); break;
      case 'domain':   await cmdDomain(flags.positional[0], flags); break;
      case 'theme':    await cmdTheme(flags.positional[0], flags); break;
      case 'geo':      await cmdGeo(flags.positional[0], flags); break;
      case 'raw':      await cmdRaw(flags.positional[0], flags.positional[1], flags); break;
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
