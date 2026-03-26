#!/usr/bin/env node
// groundnews-interests.mjs — Ground News interests, topics, sources & stories
//
// Setup (one-time, requires Chrome with Ground News open):
//   node groundnews-interests.mjs auth
//
// Commands:
//   node groundnews-interests.mjs detail <slug-or-uuid>               Interest/topic detail
//   node groundnews-interests.mjs events <uuid> [--limit N] [--sort time] [--offset N]
//                                                                       Story IDs for an interest
//   node groundnews-interests.mjs events-detail <uuid> [--limit N] [--sort time]
//                                                                       Stories with full summaries
//   node groundnews-interests.mjs blindspots <uuid> [--side left|right] [--limit N]
//                                                                       Blindspot stories for a topic
//   node groundnews-interests.mjs popular <slug-or-uuid>              Popular related interests
//   node groundnews-interests.mjs trending <slug-or-uuid>             Trending sub-interests
//   node groundnews-interests.mjs source <uuid>                       Publisher/source detail
//   node groundnews-interests.mjs editions                            List feed editions
//   node groundnews-interests.mjs place <id>                          Place detail
//   node groundnews-interests.mjs place-interest <id>                 Interest entity for a place
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/groundnews-interests');
const SESSION_FILE = resolve(DATA_DIR, 'session.json');
const CACHE_DIR = resolve(DATA_DIR, 'cache');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  ensureDir(resolve(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// CDP integration (only needed for auth)
// ---------------------------------------------------------------------------

function findCdpScript() {
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found.'); })();
}

function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

// ---------------------------------------------------------------------------
// Auth: extract GROUND_LOGIN_TOKEN cookie from Chrome ground.news tab
// ---------------------------------------------------------------------------

async function doAuth() {
  console.log('Finding Ground News tab...');
  const list = cdp('list');
  let target;
  for (const pref of ['/interest/', '/my-news', 'ground.news']) {
    for (const line of list.split('\n')) {
      if (line.includes('ground.news') && line.includes(pref)) {
        target = line.trim().split(/\s+/)[0];
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    for (const line of list.split('\n')) {
      if (line.includes('ground.news')) { target = line.trim().split(/\s+/)[0]; break; }
    }
  }
  if (!target) throw new Error('No Ground News tab found. Open ground.news in Chrome first.');

  console.log(`Using tab: ${target}`);

  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://ground.news'] }));
  const { cookies } = JSON.parse(raw);
  const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));

  const token = cookieMap['GROUND_LOGIN_TOKEN'];
  if (!token) throw new Error('GROUND_LOGIN_TOKEN cookie not found. Are you logged in to Ground News?');

  saveJson(SESSION_FILE, { token, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://web-api-cdn.ground.news/api';

/**
 * Public API fetch — NO Authorization header.
 * Expired tokens cause 401 even on public endpoints, so we never send one.
 */
async function apiFetchPublic(url) {
  const resp = await fetch(url, {
    headers: {
      'x-gn-v': 'web',
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

// ---------------------------------------------------------------------------
// Concurrency helper (semaphore for parallel fetches)
// ---------------------------------------------------------------------------

function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  function next() {
    if (queue.length === 0 || active >= max) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ---------------------------------------------------------------------------
// parseFlags helper
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    else positional.push(arg);
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Interest/topic detail */
async function fetchInterestDetail(id) {
  const url = `${API_BASE}/public/interest/${encodeURIComponent(id)}`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch interest "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Event IDs for an interest (UUID required) */
async function fetchEvents(id, { limit = 20, offset = 0, sort = 'time' } = {}) {
  const url = `${API_BASE}/public/interest/${encodeURIComponent(id)}/events?limit=${limit}&offset=${offset}&sort=${sort}`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch events for "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Single event summary */
async function fetchEventSummary(eventId) {
  const url = `${API_BASE}/public/event/${encodeURIComponent(eventId)}/summary`;
  const result = await apiFetchPublic(url);
  if (!result.ok) return null;
  // API wraps in { summary: { ... } }
  return result.data?.summary || result.data;
}

/** Blindspot stories for a topic (UUID required) */
async function fetchBlindspots(id, { customLimit = 5, side, highFactuality } = {}) {
  let url = `${API_BASE}/public/interest/${encodeURIComponent(id)}/blindspots?customLimit=${customLimit}`;
  if (side) url += `&side=${side}`;
  if (highFactuality) url += `&highFactuality=true`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch blindspots for "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Popular related interests */
async function fetchPopular(id) {
  const url = `${API_BASE}/public/interest/${encodeURIComponent(id)}/popular`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch popular for "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Trending sub-interests */
async function fetchTrending(id) {
  const url = `${API_BASE}/public/interest/${encodeURIComponent(id)}/trending`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch trending for "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Source/publisher detail (UUID only) */
async function fetchSource(id) {
  const url = `${API_BASE}/public/source/${encodeURIComponent(id)}`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch source "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** List feed editions */
async function fetchEditions() {
  const url = `${API_BASE}/v04/customFeed/topFeedEditions`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch editions (HTTP ${result.status})`);
  return result.data;
}

/** Place detail */
async function fetchPlace(id) {
  const url = `${API_BASE}/public/place/${encodeURIComponent(id)}`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch place "${id}" (HTTP ${result.status})`);
  return result.data;
}

/** Place interest mapping */
async function fetchPlaceInterest(id) {
  const url = `${API_BASE}/public/place/${encodeURIComponent(id)}/interest`;
  const result = await apiFetchPublic(url);
  if (!result.ok) throw new Error(`Failed to fetch place interest for "${id}" (HTTP ${result.status})`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatBias(bias) {
  if (bias === undefined || bias === null) return 'unknown';
  const numLabels = { '-2': 'Far Left', '-1': 'Left', '0': 'Center', '1': 'Right', '2': 'Far Right' };
  const strLabels = {
    'farleft': 'Far Left', 'left': 'Left', 'leanleft': 'Lean Left',
    'center': 'Center', 'leanright': 'Lean Right', 'right': 'Right', 'farright': 'Far Right',
  };
  return numLabels[String(bias)] || strLabels[String(bias).toLowerCase()] || String(bias);
}

function formatFactuality(factuality) {
  if (factuality === undefined || factuality === null) return 'unknown';
  const numLabels = { '-1': 'Low', '0': 'Mixed', '1': 'High' };
  const strLabels = { 'low': 'Low', 'mixed': 'Mixed', 'high': 'High' };
  return numLabels[String(factuality)] || strLabels[String(factuality).toLowerCase()] || String(factuality);
}

function formatBiasBreakdown(biasBreakdown) {
  if (!biasBreakdown) return '';
  const parts = [];
  if (biasBreakdown.left != null) parts.push(`Left: ${(biasBreakdown.left * 100).toFixed(0)}%`);
  if (biasBreakdown.center != null) parts.push(`Center: ${(biasBreakdown.center * 100).toFixed(0)}%`);
  if (biasBreakdown.right != null) parts.push(`Right: ${(biasBreakdown.right * 100).toFixed(0)}%`);
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

switch (command) {
  case 'auth': {
    await doAuth();
    break;
  }

  case 'detail': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs detail <slug-or-uuid>');
      process.exit(1);
    }
    console.log(`Fetching interest: ${id}...`);
    const rawData = await fetchInterestDetail(id);
    const outFile = resolve(CACHE_DIR, `interest-${id}.json`);
    saveJson(outFile, rawData);

    // API wraps in { interest: { ... } }
    const data = rawData.interest || rawData;

    console.log(`\n${data.name || id}`);
    if (data.type) console.log(`  Type: ${data.type}`);
    if (data.slug) console.log(`  Slug: ${data.slug}`);
    if (data.id) console.log(`  UUID: ${data.id}`);
    if (data.refCount != null) console.log(`  Stories: ${data.refCount}`);
    if (data.totalStories90Days != null) console.log(`  Stories (90d): ${data.totalStories90Days}`);

    // 90-day bias breakdown from leftSrcPercent/cntrSrcPercent/rightSrcPercent
    if (data.leftSrcPercent != null || data.cntrSrcPercent != null || data.rightSrcPercent != null) {
      const parts = [];
      if (data.leftSrcPercent != null) parts.push(`Left: ${(data.leftSrcPercent * 100).toFixed(0)}%`);
      if (data.cntrSrcPercent != null) parts.push(`Center: ${(data.cntrSrcPercent * 100).toFixed(0)}%`);
      if (data.rightSrcPercent != null) parts.push(`Right: ${(data.rightSrcPercent * 100).toFixed(0)}%`);
      console.log(`  Bias (90d): ${parts.join(' | ')}`);
    }

    // Top covering sources
    const sources = data.coveredMostBy || data.topSources || data.sources;
    if (sources && sources.length) {
      console.log(`\n  Top Sources (${sources.length}):`);
      for (const s of sources.slice(0, 10)) {
        const biasLabel = s.bias || 'unknown';
        console.log(`    ${s.name || s.domain || 'unknown'} — bias: ${biasLabel}, stories: ${s.storyCount || s.refCount || '?'}`);
      }
    }

    // Wikipedia link
    if (data.wikipedia) {
      console.log(`\n  Wikipedia: ${data.wikipedia}`);
    }

    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'events': {
    const { flags, positional } = parseFlags(args);
    const id = positional[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs events <uuid> [--limit=20] [--sort=time] [--offset=0]');
      console.error('\nNote: UUID is required — slugs return empty arrays.');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '20');
    const offset = parseInt(flags.offset || '0');
    const sort = flags.sort || 'time';

    console.log(`Fetching events for ${id} (limit=${limit}, offset=${offset}, sort=${sort})...`);
    const data = await fetchEvents(id, { limit, offset, sort });
    const outFile = resolve(CACHE_DIR, `events-${id}.json`);
    saveJson(outFile, data);

    const eventIds = data.eventIds || [];
    const breakingIds = data.breakingStoryIds || [];
    console.log(`\nEvent IDs (${eventIds.length}):`);
    for (const eid of eventIds) {
      console.log(`  ${eid}`);
    }
    if (breakingIds.length) {
      console.log(`\nBreaking Story IDs (${breakingIds.length}):`);
      for (const bid of breakingIds) console.log(`  ${bid}`);
    }
    if (data.topStoryId) console.log(`\nTop Story: ${data.topStoryId}`);

    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'events-detail': {
    const { flags, positional } = parseFlags(args);
    const id = positional[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs events-detail <uuid> [--limit=20] [--sort=time]');
      console.error('\nNote: UUID is required — slugs return empty arrays.');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '20');
    const sort = flags.sort || 'time';

    console.log(`Fetching events for ${id} (limit=${limit}, sort=${sort})...`);
    const eventsData = await fetchEvents(id, { limit, sort });
    const eventIds = eventsData.eventIds || [];

    if (!eventIds.length) {
      console.log('No events found. Make sure you are using a UUID, not a slug.');
      break;
    }

    console.log(`Fetching summaries for ${eventIds.length} events...`);
    const sem = makeSemaphore(5);
    const summaries = await Promise.all(
      eventIds.map(eid => sem(() => fetchEventSummary(eid)))
    );

    const results = eventIds.map((eid, i) => ({ eventId: eid, summary: summaries[i] }));
    const outFile = resolve(CACHE_DIR, `events-detail-${id}.json`);
    saveJson(outFile, { interest: id, events: results });

    console.log(`\nStories (${results.length}):\n`);
    for (const r of results) {
      const s = r.summary;
      if (!s) {
        console.log(`  [${r.eventId}] (summary unavailable)`);
        continue;
      }
      const title = s.title || s.generatedHeadline || '(no title)';
      const sourceCount = s.sourceCount || s.biasSourceCount || '?';
      console.log(`  ${title}`);
      console.log(`    Event: ${r.eventId}`);
      console.log(`    Sources: ${sourceCount}`);
      // Bias breakdown from blindspotData
      const bd = s.blindspotData;
      if (bd) {
        const parts = [];
        if (bd.leftPercent != null) parts.push(`Left: ${bd.leftPercent}%`);
        if (bd.centerPercent != null) parts.push(`Center: ${bd.centerPercent}%`);
        if (bd.rightPercent != null) parts.push(`Right: ${bd.rightPercent}%`);
        if (parts.length) console.log(`    Bias: ${parts.join(' | ')}`);
        if (bd.blindspotFor) console.log(`    Blindspot for: ${bd.blindspotFor}`);
      }
      console.log();
    }
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'blindspots': {
    const { flags, positional } = parseFlags(args);
    const id = positional[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs blindspots <uuid> [--side=left|right] [--limit=5]');
      console.error('\nNote: UUID is required.');
      process.exit(1);
    }
    const customLimit = parseInt(flags.limit || '5');
    const side = flags.side || undefined;

    console.log(`Fetching blindspots for ${id}...`);
    const data = await fetchBlindspots(id, { customLimit, side });

    const leftIds = data.left || [];
    const rightIds = data.right || [];
    const allIds = [...new Set([...leftIds, ...rightIds])];

    console.log(`Found ${leftIds.length} left blindspot(s), ${rightIds.length} right blindspot(s).`);

    if (allIds.length) {
      console.log('Fetching summaries...');
      const sem = makeSemaphore(5);
      const summaryMap = {};
      await Promise.all(
        allIds.map(eid => sem(async () => {
          summaryMap[eid] = await fetchEventSummary(eid);
        }))
      );

      const outFile = resolve(CACHE_DIR, `blindspots-${id}.json`);
      saveJson(outFile, { interest: id, left: leftIds, right: rightIds, summaries: summaryMap });

      if (leftIds.length) {
        console.log(`\nLeft Blindspots (stories the left is missing):`);
        for (const eid of leftIds) {
          const s = summaryMap[eid];
          const title = s?.title || s?.generatedHeadline || '(no title)';
          console.log(`  ${title}`);
          console.log(`    Event: ${eid}`);
          const bd = s?.blindspotData;
          if (bd) {
            const parts = [];
            if (bd.leftPercent != null) parts.push(`Left: ${bd.leftPercent}%`);
            if (bd.centerPercent != null) parts.push(`Center: ${bd.centerPercent}%`);
            if (bd.rightPercent != null) parts.push(`Right: ${bd.rightPercent}%`);
            if (parts.length) console.log(`    Bias: ${parts.join(' | ')}`);
          }
        }
      }
      if (rightIds.length) {
        console.log(`\nRight Blindspots (stories the right is missing):`);
        for (const eid of rightIds) {
          const s = summaryMap[eid];
          const title = s?.title || s?.generatedHeadline || '(no title)';
          console.log(`  ${title}`);
          console.log(`    Event: ${eid}`);
          const bd = s?.blindspotData;
          if (bd) {
            const parts = [];
            if (bd.leftPercent != null) parts.push(`Left: ${bd.leftPercent}%`);
            if (bd.centerPercent != null) parts.push(`Center: ${bd.centerPercent}%`);
            if (bd.rightPercent != null) parts.push(`Right: ${bd.rightPercent}%`);
            if (parts.length) console.log(`    Bias: ${parts.join(' | ')}`);
          }
        }
      }

      console.log(`\nSaved to: ${outFile}`);
    } else {
      console.log('No blindspot stories found.');
    }
    break;
  }

  case 'popular': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs popular <slug-or-uuid>');
      process.exit(1);
    }
    console.log(`Fetching popular interests related to ${id}...`);
    const data = await fetchPopular(id);
    const outFile = resolve(CACHE_DIR, `popular-${id}.json`);
    saveJson(outFile, data);

    const interests = data.interests || [];
    console.log(`\nPopular Related Interests (${interests.length}):\n`);
    for (const i of interests) {
      console.log(`  ${i.name || '(unnamed)'}`);
      if (i.type) console.log(`    Type: ${i.type}`);
      if (i.slug) console.log(`    Slug: ${i.slug}`);
      if (i.id) console.log(`    UUID: ${i.id}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'trending': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs trending <slug-or-uuid>');
      process.exit(1);
    }
    console.log(`Fetching trending sub-interests for ${id}...`);
    const data = await fetchTrending(id);
    const outFile = resolve(CACHE_DIR, `trending-${id}.json`);
    saveJson(outFile, data);

    const interests = data.interests || [];
    if (interests.length) {
      console.log(`\nTrending Sub-Interests (${interests.length}):\n`);
      for (const i of interests) {
        console.log(`  ${i.name || '(unnamed)'}`);
        if (i.type) console.log(`    Type: ${i.type}`);
        if (i.slug) console.log(`    Slug: ${i.slug}`);
      }
    } else {
      console.log('No trending sub-interests found.');
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'source': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs source <uuid>');
      console.error('\nNote: UUID only — slugs return 404.');
      process.exit(1);
    }
    console.log(`Fetching source: ${id}...`);
    const rawData = await fetchSource(id);
    const outFile = resolve(CACHE_DIR, `source-${id}.json`);
    saveJson(outFile, rawData);

    // API wraps in { source: { ... } }
    const data = rawData.source || rawData;

    console.log(`\n${data.name || id}`);
    const domain = Array.isArray(data.domain) ? data.domain.join(', ') : data.domain;
    if (domain) console.log(`  Domain: ${domain}`);
    console.log(`  Bias: ${formatBias(data.bias)}`);
    console.log(`  Factuality: ${formatFactuality(data.factuality)}`);
    if (data.satire) console.log(`  Satire: yes`);
    if (data.paywall) console.log(`  Paywall: ${data.paywall}`);
    if (data.storyCount != null) console.log(`  Stories: ${data.storyCount}`);
    if (data.recentStoryCount != null) console.log(`  Recent Stories: ${data.recentStoryCount}`);

    // Ownership info
    const owners = data.owners || [];
    if (owners.length) {
      console.log(`  Ownership: ${owners.map(o => o.name || o.id || JSON.stringify(o)).join(', ')}`);
    }

    // Place
    const places = Array.isArray(data.place) ? data.place : data.place ? [data.place] : [];
    if (places.length) {
      console.log(`  Location: ${places.map(p => p.name || p.id).join(' > ')}`);
    }

    // Reviewer ratings
    const biasRatings = data.biasRatings || [];
    const factRatings = data.factualityRatings || [];
    if (biasRatings.length) {
      console.log(`\n  Bias Ratings:`);
      for (const r of biasRatings) {
        const reviewerName = r.reviewer?.name || r.reviewerId || 'unknown';
        console.log(`    ${reviewerName}: ${formatBias(r.politicalBias || r.bias)} (${r.referenceUrl || ''})`);
      }
    }
    if (factRatings.length) {
      console.log(`\n  Factuality Ratings:`);
      for (const r of factRatings) {
        const reviewerName = r.reviewer?.name || r.reviewerId || 'unknown';
        console.log(`    ${reviewerName}: ${formatFactuality(r.normalizedScore || r.factuality)} (${r.referenceUrl || ''})`);
      }
    }

    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'editions': {
    console.log('Fetching editions...');
    const data = await fetchEditions();
    const outFile = resolve(CACHE_DIR, 'editions.json');
    saveJson(outFile, data);

    const editions = Array.isArray(data) ? data : data.editions || data.feeds || [];
    console.log(`\nEditions (${editions.length}):\n`);
    for (const e of editions) {
      console.log(`  ${e.name || e.title || '(unnamed)'}`);
      if (e.id) console.log(`    ID: ${e.id}`);
      if (e.slug) console.log(`    Slug: ${e.slug}`);
      if (e.region || e.country) console.log(`    Region: ${e.region || e.country}`);
    }
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'place': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs place <id>');
      console.error('\nID format: country code (US, TR) or compound (Istanbul,Istanbul,TR)');
      process.exit(1);
    }
    console.log(`Fetching place: ${id}...`);
    const rawData = await fetchPlace(id);
    const outFile = resolve(CACHE_DIR, `place-${id}.json`);
    saveJson(outFile, rawData);

    // API wraps in { place: { ... } }
    const data = rawData.place || rawData;

    console.log(`\n${data.name || id}`);
    if (data.type) console.log(`  Type: ${data.type}`);
    if (data.timeZoneId) console.log(`  Timezone: ${data.timeZoneId}`);
    if (data.lat != null && data.lon != null) console.log(`  Coordinates: ${data.lat}, ${data.lon}`);
    if (data.id) console.log(`  ID: ${data.id}`);
    if (data.parentId) console.log(`  Parent: ${data.parentId}`);

    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'place-interest': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node groundnews-interests.mjs place-interest <id>');
      console.error('\nID format: country code (US, TR) or compound (Istanbul,Istanbul,TR)');
      process.exit(1);
    }
    console.log(`Fetching place interest for: ${id}...`);
    const rawData = await fetchPlaceInterest(id);
    const outFile = resolve(CACHE_DIR, `place-interest-${id}.json`);
    saveJson(outFile, rawData);

    // API wraps in { interest: { ... } }
    const data = rawData.interest || rawData;

    if (data.id) console.log(`  Interest UUID: ${data.id}`);
    if (data.name) console.log(`  Name: ${data.name}`);
    if (data.slug) console.log(`  Slug: ${data.slug}`);
    if (data.type) console.log(`  Type: ${data.type}`);

    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  default:
    console.log(`groundnews-interests — Ground News interests, topics, sources & stories

Commands:
  auth                              Authenticate via Chrome (one-time)
  detail <slug-or-uuid>             Interest/topic detail
  events <uuid> [--limit=20] [--sort=time] [--offset=0]
                                    Story IDs for an interest (UUID required)
  events-detail <uuid> [--limit=20] [--sort=time]
                                    Stories with full summaries (UUID required)
  blindspots <uuid> [--side=left|right] [--limit=5]
                                    Blindspot stories for a topic (UUID required)
  popular <slug-or-uuid>            Popular related interests
  trending <slug-or-uuid>           Trending sub-interests
  source <uuid>                     Publisher/source detail (UUID only)
  editions                          List feed editions
  place <id>                        Place detail
  place-interest <id>               Interest entity for a place

ID formats:
  slug:     politics, donald-trump, climate-change
  uuid:     a1b2c3d4-e5f6-7890-abcd-ef1234567890
  place:    US, TR, Istanbul,Istanbul,TR

Notes:
  - events/events-detail/blindspots require UUID (slugs return empty)
  - source requires UUID (slugs return 404)
  - All endpoints are public (no auth needed for data)
  - Auth is only needed to save session for other ground-news taskpacks

Data: ${DATA_DIR}/
  session.json     Auth token
  cache/           Cached API responses`);
}
