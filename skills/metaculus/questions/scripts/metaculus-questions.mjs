#!/usr/bin/env node
// metaculus-questions.mjs — Fetch Metaculus community predictions via the /api/posts/ endpoint.
//
// Metaculus requires API-token auth for every endpoint as of early 2026 (anon access
// was still live in Dec 2025, then removed). Get a token at:
//
//     https://www.metaculus.com/accounts/settings/   →   "API Access"
//
// Make it available to this script in either of these ways:
//     export METACULUS_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//     echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" > ~/.local/share/showrun/data/metaculus/token.txt
//
// Schema confirmed from the official OpenAPI spec (openapi.3e93510ce7a9.yml) and a
// Dec 2025 Wayback snapshot of /api2/questions/ — both return the same "Post" shape:
//   { count, next, previous, results: [Post] }
// Post fields used here:
//   id, title, slug, status, resolved, scheduled_close_time, nr_forecasters,
//   forecasts_count, description, projects{default_project,tournament,category},
//   question{ type, resolution, scaling, aggregations.{unweighted|recency_weighted}.latest.centers }
//
// The legacy /api2/questions/ alias still forwards to the same handler — either path
// works. We use /api/posts/ because it matches the published OpenAPI spec.
//
// Commands:
//   latest [N]               newest active questions, default 20
//   top [N]                  most-forecasted (order_by=forecasts_count desc)
//   search <keyword>         keyword search (Django REST ?search= — undocumented but works)
//   question <id>            single post detail
//   tournament <slug> [N]    posts in one tournament/project
//   tournaments              best-effort list of tournament slugs seen in cached posts
//   view-cache <id>          print cached question detail without refetching
//   search-cache <keyword>   grep the local index.jsonl, not live
//
// Requires Node 22+ (built-in fetch). Stdlib only, no dependencies.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Config & data dir (matches showrun convention)
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/metaculus');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const TOKEN_FILE = resolve(DATA_DIR, 'token.txt');
const INDEX_FILE = resolve(CACHE_DIR, 'index.jsonl');

const API_BASE = 'https://www.metaculus.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 metaculus-skill/1.0';
const TIMEOUT_MS = 20_000;
const PAGE_SLEEP_MS = 500;
const MAX_SEARCH_PAGES = 6;    // ~120 results cap for keyword search
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadToken() {
  if (process.env.METACULUS_TOKEN) return process.env.METACULUS_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  return null;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'query';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchJson(path, params) {
  const token = loadToken();
  if (!token) {
    throw new Error(
      'No Metaculus API token. Set METACULUS_TOKEN env var or write the token to ' +
      TOKEN_FILE + '\n' +
      '  Get one at: https://www.metaculus.com/accounts/settings/ (section "API Access")\n' +
      '  (Metaculus disabled anonymous API access in early 2026.)'
    );
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
    else qs.append(k, String(v));
  }
  const url = API_BASE + path + (qs.toString() ? `?${qs}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Authorization': `Token ${token}`,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${res.status} ${res.statusText} ${url}\n  ${snippet}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${url}\n  ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Post / question field extraction — tolerant of nested shape drift
// ---------------------------------------------------------------------------

function getAggregationLatest(post) {
  const q = post?.question || {};
  const aggs = q.aggregations || {};
  // Prefer recency_weighted (newer preference), then unweighted, then any aggregation
  const keys = ['recency_weighted', 'unweighted', 'metaculus_prediction', 'single_aggregation'];
  for (const k of keys) {
    const latest = aggs[k]?.latest;
    if (latest && Array.isArray(latest.centers) && latest.centers.length) return latest;
  }
  for (const k of Object.keys(aggs)) {
    const latest = aggs[k]?.latest;
    if (latest && Array.isArray(latest.centers) && latest.centers.length) return latest;
  }
  return null;
}

function getMetaculusPredictionLatest(post) {
  const aggs = post?.question?.aggregations || {};
  const latest = aggs.metaculus_prediction?.latest;
  if (latest && Array.isArray(latest.centers) && latest.centers.length) return latest;
  return null;
}

function unscale(v, scaling) {
  if (v == null || !scaling) return null;
  const { range_min, range_max, zero_point } = scaling;
  if (range_min == null || range_max == null) return null;
  // Linear only — matches what the OpenAPI examples show for date/numeric.
  // zero_point-based log scaling exists but the scaled value itself is still in [0,1];
  // reversing it accurately requires knowing the derivative ratio, which is often absent.
  if (zero_point == null || zero_point === 0) {
    return range_min + v * (range_max - range_min);
  }
  return range_min + v * (range_max - range_min); // best-effort fallback
}

function formatCenter(post, center) {
  const q = post?.question || {};
  const type = q.type || 'binary';
  if (center == null) return '?';
  if (type === 'binary') return `${Math.round(center * 100)}%`;
  if (type === 'multiple_choice') return `${Math.round(center * 100)}%`;
  if (type === 'numeric' || type === 'date') {
    const val = unscale(center, q.scaling);
    if (val == null) return center.toFixed(3);
    if (type === 'date') {
      try { return new Date(val * 1000).toISOString().slice(0, 10); } catch { return String(val); }
    }
    // Numeric: trim to 4 sig figs
    if (Math.abs(val) >= 1000) return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return val.toPrecision(4);
  }
  return String(center);
}

function formatResolution(post) {
  const q = post?.question || {};
  const r = q.resolution;
  if (r == null || r === '') return 'unresolved';
  if (q.type === 'binary') {
    // Metaculus returns "yes" / "no" / "ambiguous" / numeric strings
    if (r === 'yes' || r === '1.0' || r === 1) return 'YES';
    if (r === 'no'  || r === '0.0' || r === 0) return 'NO';
    if (r === 'ambiguous') return 'ambiguous';
    return String(r);
  }
  return String(r);
}

function postStatus(post) {
  if (post.resolved) return 'resolved';
  return post.status || '?';
}

function postCloseDate(post) {
  const t = post.scheduled_close_time || post.actual_close_time;
  if (!t) return '?';
  return String(t).slice(0, 10);
}

function postUrl(post) {
  const slug = post.slug || post.url_title || '';
  const tail = slug ? `/${slugify(slug)}/` : '/';
  return `${API_BASE}/questions/${post.id}${tail}`;
}

function postDescription(post) {
  const d = post.description || post?.question?.description || '';
  const cleaned = String(d).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 300) return cleaned;
  return cleaned.slice(0, 297) + '...';
}

function postTournamentSlugs(post) {
  const out = [];
  const p = post.projects || {};
  const buckets = [p.tournament, p.question_series, p.category, p.topic];
  for (const b of buckets) {
    if (!b) continue;
    const arr = Array.isArray(b) ? b : [b];
    for (const x of arr) if (x?.slug) out.push(x.slug);
  }
  if (p.default_project?.slug) out.push(p.default_project.slug);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPost(post) {
  const q = post?.question || {};
  const type = q.type || '?';
  const id = post.id;
  const title = (post.title || q.title || '(untitled)').replace(/\s+/g, ' ').trim();
  const status = postStatus(post);

  let cp = '?';
  if (post.resolved) {
    cp = `resolution=${formatResolution(post)}`;
  } else {
    const latest = getAggregationLatest(post);
    const c = latest?.centers?.[0];
    cp = `community=${formatCenter(post, c)}`;
  }

  const mpLatest = getMetaculusPredictionLatest(post);
  const mp = mpLatest?.centers?.[0];
  const mpStr = `metaculus=${mp == null ? '?' : formatCenter(post, mp)}`;

  const close = postCloseDate(post);
  const forecasts = post.forecasts_count ?? post?.question?.aggregations?.unweighted?.latest?.forecaster_count ?? post.nr_forecasters ?? '?';

  console.log(`- [${type}] ${title} (Q#${id})`);
  console.log(`    ${cp}  ${mpStr}   close=${close}  forecasts=${forecasts}  status=${status}`);
  console.log(`    ${postUrl(post)}`);
  const desc = postDescription(post);
  if (desc) console.log(`    ${desc}`);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheListing(name, payload) {
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `${name}.json`), {
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    count: Array.isArray(payload.results) ? payload.results.length : (payload.count ?? 0),
    data: payload,
  });
}

function cacheQuestion(post) {
  ensureDir(CACHE_DIR);
  saveJson(resolve(CACHE_DIR, `question-${post.id}.json`), {
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    data: post,
  });
}

function loadIndexIds() {
  if (!existsSync(INDEX_FILE)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(INDEX_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { ids.add(JSON.parse(line).id); } catch {}
  }
  return ids;
}

function appendIndex(posts) {
  ensureDir(CACHE_DIR);
  const seen = loadIndexIds();
  const lines = [];
  for (const p of posts) {
    if (!p || p.id == null) continue;
    if (seen.has(p.id)) continue;
    const q = p.question || {};
    const latest = getAggregationLatest(p);
    const center = latest?.centers?.[0] ?? null;
    lines.push(JSON.stringify({
      id: p.id,
      title: p.title || q.title || '',
      slug: p.slug || '',
      type: q.type || null,
      status: postStatus(p),
      resolved: !!p.resolved,
      center,
      resolution: q.resolution ?? null,
      nr_forecasters: p.nr_forecasters ?? null,
      forecasts_count: p.forecasts_count ?? null,
      scheduled_close_time: p.scheduled_close_time || null,
      url: postUrl(p),
      description: (p.description || q.description || '').slice(0, 500),
      tournaments: postTournamentSlugs(p),
    }));
    seen.add(p.id);
  }
  if (lines.length) appendFileSync(INDEX_FILE, lines.join('\n') + '\n');
  return lines.length;
}

function* iterIndex() {
  if (!existsSync(INDEX_FILE)) return;
  for (const line of readFileSync(INDEX_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLatest(n) {
  const limit = Number(n) || DEFAULT_LIMIT;
  console.log(`Fetching latest ${limit} open Metaculus questions...`);
  const data = await fetchJson('/api/posts/', {
    statuses: 'open',
    order_by: '-published_at',
    limit,
    with_cp: true,
  });
  const results = data.results || [];
  cacheListing('latest', data);
  const added = appendIndex(results);
  console.log(`\nGot ${results.length} posts (${added} new). total=${data.count}\n`);
  for (const p of results) renderPost(p);
}

async function cmdTop(n) {
  const limit = Number(n) || DEFAULT_LIMIT;
  console.log(`Fetching top-${limit} open questions by forecasts_count...`);
  const data = await fetchJson('/api/posts/', {
    statuses: 'open',
    order_by: '-forecasts_count',
    limit,
    with_cp: true,
  });
  const results = data.results || [];
  cacheListing('top', data);
  const added = appendIndex(results);
  console.log(`\nGot ${results.length} posts (${added} new).\n`);
  for (const p of results) renderPost(p);
}

async function cmdSearch(keyword) {
  if (!keyword) throw new Error('search requires <keyword>');
  console.log(`Searching Metaculus posts for "${keyword}"...`);
  // ?search= is Django REST's default SearchFilter param. It is NOT in the published
  // OpenAPI spec for /api/posts/, but the web UI uses it and the server honors it.
  // If a future Metaculus release removes it, fall back to cmdSearchCache.
  const all = [];
  let offset = 0;
  const limit = 20;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const data = await fetchJson('/api/posts/', {
      search: keyword,
      order_by: '-published_at',
      limit,
      offset,
      with_cp: true,
    });
    const results = data.results || [];
    if (!results.length) break;
    all.push(...results);
    if (!data.next || results.length < limit) break;
    offset += limit;
    await sleep(PAGE_SLEEP_MS);
  }
  cacheListing(`search-${slugify(keyword)}`, { count: all.length, results: all });
  const added = appendIndex(all);
  console.log(`\nFound ${all.length} posts (${added} new) for "${keyword}".\n`);
  for (const p of all) renderPost(p);
}

async function cmdQuestion(id) {
  if (!id) throw new Error('question requires <id>');
  console.log(`Fetching Metaculus post ${id}...`);
  const post = await fetchJson(`/api/posts/${id}/`, { with_cp: true });
  cacheQuestion(post);
  appendIndex([post]);
  console.log();
  renderPost(post);
  // Extra detail not in the short render:
  const q = post.question || {};
  if (q.resolution_criteria) {
    const rc = String(q.resolution_criteria).replace(/\s+/g, ' ').trim();
    console.log(`\n  resolution_criteria: ${rc.slice(0, 500)}${rc.length > 500 ? '...' : ''}`);
  }
  if (q.fine_print) {
    const fp = String(q.fine_print).replace(/\s+/g, ' ').trim();
    if (fp) console.log(`  fine_print:          ${fp.slice(0, 300)}${fp.length > 300 ? '...' : ''}`);
  }
  const slugs = postTournamentSlugs(post);
  if (slugs.length) console.log(`  tournaments/topics:  ${slugs.join(', ')}`);
}

async function cmdTournament(slug, n) {
  if (!slug) throw new Error('tournament requires <slug-or-id>');
  const limit = Number(n) || DEFAULT_LIMIT;
  console.log(`Fetching up to ${limit} posts in tournament "${slug}"...`);
  const data = await fetchJson('/api/posts/', {
    tournaments: slug,
    limit,
    order_by: '-published_at',
    with_cp: true,
  });
  const results = data.results || [];
  cacheListing(`tournament-${slugify(slug)}`, data);
  appendIndex(results);
  console.log(`\nGot ${results.length} posts in "${slug}".\n`);
  for (const p of results) renderPost(p);
}

function cmdTournaments() {
  // /api/projects/ is not in the OpenAPI spec as a list endpoint, so we build a
  // best-effort listing from tournament slugs that have appeared in the local index.
  const counts = new Map();
  for (const row of iterIndex()) {
    for (const s of row.tournaments || []) counts.set(s, (counts.get(s) || 0) + 1);
  }
  if (!counts.size) {
    console.log('No tournaments seen yet in the local index.\n');
    console.log('Run `latest`, `top`, or `search <keyword>` first to populate cache/index.jsonl,');
    console.log('then re-run `tournaments` — slugs are collected from posts as they are fetched.');
    console.log('\nNote: Metaculus does not publish a `GET /api/projects/` listing endpoint in its');
    console.log('OpenAPI spec. You CAN query one by slug with `tournament <slug>` once you know it.');
    return;
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Tournament / project slugs seen in local index (${sorted.length} total):\n`);
  for (const [slug, n] of sorted) console.log(`  ${String(n).padStart(4)}  ${slug}`);
}

function cmdViewCache(id) {
  if (!id) throw new Error('view-cache requires <id>');
  const path = resolve(CACHE_DIR, `question-${id}.json`);
  if (!existsSync(path)) {
    console.log(`No cached question ${id}. Run: question ${id}`);
    return;
  }
  const blob = loadJson(path, {});
  console.log(`Cached at ${blob.fetched_at}\n`);
  renderPost(blob.data || {});
}

function cmdSearchCache(keyword) {
  if (!keyword) throw new Error('search-cache requires <keyword>');
  const ql = keyword.toLowerCase();
  const hits = [];
  for (const row of iterIndex()) {
    const hay = `${row.title || ''} ${row.description || ''}`.toLowerCase();
    if (hay.includes(ql)) hits.push(row);
  }
  hits.sort((a, b) => (b.scheduled_close_time || '').localeCompare(a.scheduled_close_time || ''));
  console.log(`Found ${hits.length} cached questions matching "${keyword}":\n`);
  for (const r of hits.slice(0, 60)) {
    const cp = r.resolved
      ? `resolution=${r.resolution ?? '?'}`
      : `community=${r.center == null ? '?' : (r.type === 'binary' ? `${Math.round(r.center * 100)}%` : r.center.toFixed(3))}`;
    console.log(`- [${r.type || '?'}] ${r.title} (Q#${r.id})`);
    console.log(`    ${cp}  close=${(r.scheduled_close_time || '').slice(0, 10) || '?'}  forecasts=${r.forecasts_count ?? r.nr_forecasters ?? '?'}  status=${r.status}`);
    console.log(`    ${r.url}`);
    if (r.description) {
      const d = r.description.length > 300 ? r.description.slice(0, 297) + '...' : r.description;
      console.log(`    ${d}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  console.log(`metaculus-questions — Metaculus community forecasts via /api/posts/

Commands:
  latest [N]                         newest open questions (default N=20)
  top [N]                            top open questions by forecasts_count
  search <keyword>                   live keyword search (up to ${MAX_SEARCH_PAGES * 20})
  question <id>                      one post's full detail
  tournament <slug-or-id> [N]        posts in a single tournament/project
  tournaments                        list tournament slugs seen in local index
  view-cache <id>                    print cached question without refetching
  search-cache <keyword>             grep local index.jsonl (offline)

Auth:
  export METACULUS_TOKEN=<token>
  or write token to: ${TOKEN_FILE}
  Get it at https://www.metaculus.com/accounts/settings/ ("API Access")

Data: ${DATA_DIR}
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '-h':
      case '--help':     usage(); break;
      case 'latest':     await cmdLatest(rest[0]); break;
      case 'top':        await cmdTop(rest[0]); break;
      case 'search':     await cmdSearch(rest.join(' ')); break;
      case 'question':   await cmdQuestion(rest[0]); break;
      case 'tournament': await cmdTournament(rest[0], rest[1]); break;
      case 'tournaments': cmdTournaments(); break;
      case 'view-cache': cmdViewCache(rest[0]); break;
      case 'search-cache': cmdSearchCache(rest.join(' ')); break;
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
