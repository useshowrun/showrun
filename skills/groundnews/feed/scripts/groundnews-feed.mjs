#!/usr/bin/env node
// groundnews-feed.mjs — Ground News feeds and stories from the terminal
//
// Setup (one-time, requires Chrome with ground.news open):
//   node groundnews-feed.mjs auth
//
// Commands:
//   node groundnews-feed.mjs top-feed [--edition=us] [--limit=20] [--offset=0] Top news headlines
//   node groundnews-feed.mjs blindspot-feed [--side=left] [--limit=20]         Blindspot stories
//   node groundnews-feed.mjs daily-briefing                                    AI-curated daily digest
//   node groundnews-feed.mjs local-news <place-id> [--limit=10]               Local news for a place
//   node groundnews-feed.mjs story <event-id>                                  Story summary
//   node groundnews-feed.mjs story-full <event-id>                             Full story with AI summaries
//   node groundnews-feed.mjs sources <event-id> [--bias=X] [--limit=20]        Source articles
//   node groundnews-feed.mjs interest-feed <uuid> [--limit=20] [--offset=0] [--sort=time] Topic stories
//   node groundnews-feed.mjs editions                                          List feed editions
//
// Requires Node 22+ (built-in fetch).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/groundnews-feed');
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
  for (const pref of ['/interest/', '/blindspot', '/my-feed', 'ground.news']) {
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
  const tokenCookie = cookies.find(c => c.name === 'GROUND_LOGIN_TOKEN');
  if (!tokenCookie) throw new Error('GROUND_LOGIN_TOKEN cookie not found. Are you logged in?');

  const token = tokenCookie.value;
  saveJson(SESSION_FILE, { token, extractedAt: new Date().toISOString() });
  console.log(`Auth saved to: ${SESSION_FILE}`);
  console.log(`Token: ${token.substring(0, 20)}...`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://web-api-cdn.ground.news/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.token) {
    console.error('No auth found. Run: node groundnews-feed.mjs auth');
    process.exit(1);
  }
  return auth;
}

async function apiFetch(url, auth) {
  const headers = {
    'accept': 'application/json',
    'x-gn-v': 'web',
    'Authorization': auth.token,
    'user-agent': UA,
  };
  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error(`Auth failed (HTTP ${resp.status}). Run: node groundnews-feed.mjs auth`);
    }
    throw new Error(`API request failed (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
  }
  return data;
}

async function apiFetchPublic(url) {
  const headers = {
    'accept': 'application/json',
    'x-gn-v': 'web',
    'user-agent': UA,
  };
  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    throw new Error(`Public API request failed (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, positional = [];
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) {
      flags[m[1]] = m[2] !== undefined ? m[2] : 'true';
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Concurrency helper: fetch in parallel with max concurrency
// ---------------------------------------------------------------------------

async function parallelMap(items, fn, concurrency = 5) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatBiasBreakdown(event) {
  const bs = event.blindspotData || event.blindSpotData || {};
  const left = bs.leftPercent ?? event.leftSrcPercent ?? event.leftPercent ?? 0;
  const center = bs.centerPercent ?? event.cntrSrcPercent ?? event.centerPercent ?? 0;
  const right = bs.rightPercent ?? event.rightSrcPercent ?? event.rightPercent ?? 0;
  if (left === 0 && center === 0 && right === 0) return null;
  return `L:${left}% C:${center}% R:${right}%`;
}

function formatBlindspotInfo(event) {
  const bs = event.blindspotData || event.blindSpotData || {};
  if (!bs.coverageProfileStatement) return null;
  // Strip HTML tags from the statement
  return bs.coverageProfileStatement.replace(/<[^>]+>/g, '');
}

// ---------------------------------------------------------------------------
// API: Event summary (public)
// ---------------------------------------------------------------------------

async function fetchEventSummary(eventId) {
  const url = `${API_BASE}/public/event/${encodeURIComponent(eventId)}/summary`;
  const data = await apiFetchPublic(url);
  // API wraps in { summary: { ... } } — unwrap it
  return data.summary || data;
}

// ---------------------------------------------------------------------------
// API: Full event (public)
// ---------------------------------------------------------------------------

async function fetchEventFull(eventId) {
  const url = `${API_BASE}/public/event/${encodeURIComponent(eventId)}`;
  const data = await apiFetchPublic(url);
  // API wraps in { event: { ... } } — unwrap it
  return data.event || data;
}

// ---------------------------------------------------------------------------
// API: Sources for an event (public)
// ---------------------------------------------------------------------------

async function fetchSources(eventId, auth) {
  const url = `${API_BASE}/v06/story/${encodeURIComponent(eventId)}/sources`;
  return await apiFetch(url, auth);
}

// ---------------------------------------------------------------------------
// API: Top feed (auth required)
// ---------------------------------------------------------------------------

async function fetchTopFeedIds(auth, edition = 'us', limit = 20, offset = 0) {
  const url = `${API_BASE}/v06/story/feed/top/${encodeURIComponent(edition)}/ids?limit=${limit}&offset=${offset}`;
  return await apiFetch(url, auth);
}

// ---------------------------------------------------------------------------
// API: Blindspot feed (public)
// ---------------------------------------------------------------------------

async function fetchBlindspotFeedIds(limit = 20, side) {
  let url = `${API_BASE}/v06/story/feed/blindspot/ids?limit=${limit}`;
  if (side) url += `&side=${encodeURIComponent(side)}`;
  return await apiFetchPublic(url);
}

// ---------------------------------------------------------------------------
// API: Interest feed (auth required)
// ---------------------------------------------------------------------------

async function fetchInterestFeedIds(auth, interestId, limit = 20, sort, offset = 0) {
  let url = `${API_BASE}/v06/story/feed/interest/${encodeURIComponent(interestId)}/ids?limit=${limit}&offset=${offset}`;
  if (sort) url += `&sort=${encodeURIComponent(sort)}`;
  return await apiFetch(url, auth);
}

// ---------------------------------------------------------------------------
// API: Editions (public)
// ---------------------------------------------------------------------------

async function fetchEditions() {
  const url = `${API_BASE}/v04/customFeed/topFeedEditions`;
  return await apiFetchPublic(url);
}

// ---------------------------------------------------------------------------
// API: Daily Briefing (parsed from RSC page render — no direct API endpoint)
// ---------------------------------------------------------------------------

async function fetchDailyBriefing(auth) {
  const url = 'https://ground.news/daily-briefing';
  const resp = await fetch(url, {
    headers: {
      'RSC': '1',
      'Cookie': `GROUND_LOGIN_TOKEN=${auth.token}; GROUND_FEED_EDITION=top-eu`,
      'user-agent': UA,
    },
  });
  if (!resp.ok) throw new Error(`Failed to fetch daily briefing page (HTTP ${resp.status})`);
  const rsc = await resp.text();

  // Extract the briefing digest object from the RSC payload
  const edIdx = rsc.indexOf('"editionDate"');
  if (edIdx === -1) throw new Error('Daily briefing data not found in page');
  const start = rsc.lastIndexOf('{', edIdx);

  // Extract story entries from the RSC
  const storyIdMatches = [...rsc.matchAll(/"storyId":"([^"]+)"/g)];
  const storyTitleMatches = [...rsc.matchAll(/"storyTitle":"([^"]+)"/g)];
  const s1hMatches = [...rsc.matchAll(/"summaryOneHeadline":"([^"]*)"/g)];
  const s1tMatches = [...rsc.matchAll(/"summaryOneText":"([^"]*)"/g)];
  const s2hMatches = [...rsc.matchAll(/"summaryTwoHeadline":"([^"]*)"/g)];
  const s2tMatches = [...rsc.matchAll(/"summaryTwoText":"([^"]*)"/g)];
  const taglineMatches = [...rsc.matchAll(/"tagline":"([^"]*)"/g)];
  const dekMatches = [...rsc.matchAll(/"dek":"([^"]*)"/g)];

  // Extract subtitle (one-line summary of today's briefing)
  const subtitleMatch = rsc.match(/"subtitle":"([^"]+)"/);
  const editionDateMatch = rsc.match(/"editionDate":"([^"]+)"/);

  const stories = [];
  for (let i = 0; i < storyIdMatches.length; i++) {
    stories.push({
      eventId: storyIdMatches[i]?.[1] || '',
      title: storyTitleMatches[i]?.[1] || '',
      summaryOneHeadline: s1hMatches[i]?.[1] || '',
      summaryOneText: s1tMatches[i]?.[1] || '',
      summaryTwoHeadline: s2hMatches[i]?.[1] || '',
      summaryTwoText: s2tMatches[i]?.[1] || '',
      tagline: taglineMatches[i]?.[1] || '',
      dek: dekMatches[i]?.[1] || '',
    });
  }

  return {
    editionDate: editionDateMatch?.[1] || '',
    subtitle: subtitleMatch?.[1] || '',
    stories,
  };
}

// ---------------------------------------------------------------------------
// API: Local news (via place interest)
// ---------------------------------------------------------------------------

async function fetchLocalNewsIds(placeId, limit = 10) {
  // Step 1: resolve place to interest UUID
  const placeUrl = `${API_BASE}/public/place/${encodeURIComponent(placeId)}/interest`;
  const placeData = await apiFetchPublic(placeUrl);
  const interest = placeData.interest || placeData;
  const interestId = interest.id;
  if (!interestId) throw new Error(`No interest found for place: ${placeId}`);

  // Step 2: get events for that interest
  const eventsUrl = `${API_BASE}/public/interest/${encodeURIComponent(interestId)}/events?limit=${limit}`;
  const eventsData = await apiFetchPublic(eventsUrl);
  return { interest, eventsData };
}

// ---------------------------------------------------------------------------
// Display: story summary line
// ---------------------------------------------------------------------------

function displayStorySummary(event, index) {
  const title = event.title || event.generatedHeadline || event.name || '(untitled)';
  const sourceCount = event.sourceCount || event.nSources || event.biasSourceCount || '';
  const prefix = index != null ? `  ${index + 1}. ` : '  ';

  console.log(`${prefix}${title}`);

  const details = [];
  if (sourceCount) details.push(`${sourceCount} sources`);

  const biasStr = formatBiasBreakdown(event);
  if (biasStr) details.push(biasStr);

  const blindspot = formatBlindspotInfo(event);
  if (blindspot) details.push(blindspot);

  if (details.length) {
    console.log(`     ${details.join(' | ')}`);
  }
  if (event.id || event.eventId) {
    console.log(`     ID: ${event.id || event.eventId}`);
  }
}

// ---------------------------------------------------------------------------
// Display: full story detail
// ---------------------------------------------------------------------------

function displayStoryDetail(event) {
  const title = event.title || event.generatedHeadline || event.name || '(untitled)';
  console.log(`\n${title}`);

  if (event.description) {
    console.log(`\n  ${event.description.substring(0, 500)}`);
  }

  const details = [];
  const sourceCount = event.sourceCount || event.nSources || event.biasSourceCount || '';
  if (sourceCount) details.push(`${sourceCount} sources`);

  const biasStr = formatBiasBreakdown(event);
  if (biasStr) details.push(biasStr);

  const blindspot = formatBlindspotInfo(event);
  if (blindspot) details.push(blindspot);

  if (details.length) console.log(`\n  ${details.join(' | ')}`);

  // Factuality
  if (event.factuality) {
    const f = event.factuality;
    const fParts = [];
    if (f.veryHigh != null) fParts.push(`VeryHigh:${f.veryHigh}`);
    if (f.high != null) fParts.push(`High:${f.high}`);
    if (f.mixed != null) fParts.push(`Mixed:${f.mixed}`);
    if (f.low != null) fParts.push(`Low:${f.low}`);
    if (f.veryLow != null) fParts.push(`VeryLow:${f.veryLow}`);
    if (f.unknown != null) fParts.push(`Unknown:${f.unknown}`);
    if (fParts.length) console.log(`  Factuality: ${fParts.join(' ')}`);
  }

  // Ownership
  if (event.ownership) {
    const o = event.ownership;
    const oParts = [];
    for (const [key, val] of Object.entries(o)) {
      if (val > 0) oParts.push(`${key}:${val}`);
    }
    if (oParts.length) console.log(`  Ownership: ${oParts.join(' ')}`);
  }

  // Interests/topics
  const interests = event.interests || event.topics || [];
  if (interests.length) {
    const names = interests.map(i => i.name || i.title || i).filter(Boolean);
    if (names.length) console.log(`  Topics: ${names.join(', ')}`);
  }

  if (event.id || event.eventId) {
    console.log(`  ID: ${event.id || event.eventId}`);
  }

  if (event.slug) {
    console.log(`  URL: https://ground.news/article/${event.slug}`);
  }
}

// ---------------------------------------------------------------------------
// Display: full story with AI summaries
// ---------------------------------------------------------------------------

function displayStoryFull(event) {
  displayStoryDetail(event);

  // AI summaries (chatGptSummaries)
  const aiSummaries = event.chatGptSummaries || event.aiSummaries || null;
  if (aiSummaries && typeof aiSummaries === 'object' && !Array.isArray(aiSummaries) && Object.keys(aiSummaries).length) {
    console.log('\n  --- AI Summaries ---');
    for (const [key, value] of Object.entries(aiSummaries)) {
      if (!value) continue;
      // Skip internal ID fields
      if (key.endsWith('SummaryId')) continue;
      const text = typeof value === 'string' ? value : value.text || value.summary || value.content || JSON.stringify(value);
      const label = key === 'left' ? 'Left-leaning' : key === 'right' ? 'Right-leaning' : key === 'center' ? 'Center' : key === 'analysis' ? 'Analysis' : key;
      console.log(`\n  [${label}]`);
      console.log(`  ${text.substring(0, 800)}`);
    }
  }

  // Coverage analysis
  if (event.newsRoomCoverageAnalysis && typeof event.newsRoomCoverageAnalysis === 'string') {
    console.log(`\n  --- Coverage Analysis ---`);
    console.log(`  ${event.newsRoomCoverageAnalysis.substring(0, 600)}`);
  }

  // Related stories
  const related = event.relatedStoryIds || event.relatedEvents || event.relatedEventIds || [];
  if (related.length) {
    const ids = related.map(r => typeof r === 'string' ? r : r.id || r.eventId).filter(Boolean);
    if (ids.length) console.log(`\n  Related stories: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Display: source article
// ---------------------------------------------------------------------------

function displaySource(src, index) {
  const name = src.sourceName || src.source?.name || src.name || 'Unknown';
  const bias = src.bias || src.source?.bias || '';
  const factuality = src.factuality || src.source?.factuality || '';
  const headline = src.headline || src.title || '(no headline)';
  const url = src.url || src.link || '';
  const prefix = index != null ? `  ${index + 1}. ` : '  ';

  const tags = [];
  if (bias) tags.push(bias);
  if (factuality) tags.push(factuality);
  if (src.isOpinion) tags.push('opinion');
  if (src.paywall && src.paywall !== 'no') tags.push('paywall');
  if (src.placeLabel) tags.push(src.placeLabel);
  const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';

  console.log(`${prefix}${name}${tagStr}`);
  console.log(`     ${headline}`);
  if (src.summary) console.log(`     ${src.summary.substring(0, 200)}`);
  if (url) console.log(`     ${url}`);
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

  case 'top-feed': {
    const { flags } = parseFlags(args);
    const edition = flags.edition || 'us';
    const limit = parseInt(flags.limit || '20');
    const offset = parseInt(flags.offset || '0');
    const auth = getAuth();

    console.log(`Fetching top feed (${edition}, limit ${limit}, offset ${offset})...`);
    const feedData = await fetchTopFeedIds(auth, edition, limit, offset);

    const regularIds = feedData.eventIds || [];
    const breakingIds = feedData.breakingStoryIds || [];
    const topStoryId = feedData.topStoryId || null;

    // Compose the feed in the same order as the homepage:
    // 1) top story, 2) breaking stories, 3) regular feed
    const allIds = [];
    if (topStoryId && offset === 0) allIds.push(topStoryId);
    if (offset === 0) {
      for (const id of breakingIds) {
        if (!allIds.includes(id)) allIds.push(id);
      }
    }
    for (const id of regularIds) {
      if (!allIds.includes(id)) allIds.push(id);
    }
    const displayIds = allIds.slice(0, limit);

    if (!displayIds.length) {
      console.log('No stories found.');
      break;
    }

    console.log(`Fetching ${displayIds.length} story summaries...`);
    const summaries = await parallelMap(displayIds, async (id) => {
      try { return await fetchEventSummary(id); }
      catch (e) { return { id, title: `(failed: ${e.message.substring(0, 60)})` }; }
    });

    // Tag each summary with its feed category
    const topSet = new Set(topStoryId ? [topStoryId] : []);
    const breakSet = new Set(breakingIds);

    console.log(`\nTop Feed — ${edition.toUpperCase()} (${summaries.length} stories${offset ? `, offset ${offset}` : ''})\n`);
    for (let i = 0; i < summaries.length; i++) {
      const id = displayIds[i];
      const tag = topSet.has(id) ? ' [TOP]' : breakSet.has(id) ? ' [BREAKING]' : '';
      const s = summaries[i];
      const title = s.title || s.generatedHeadline || s.name || '(untitled)';
      const sourceCount = s.sourceCount || s.nSources || s.biasSourceCount || '';
      console.log(`  ${i + 1}. ${title}${tag}`);

      const details = [];
      if (sourceCount) details.push(`${sourceCount} sources`);
      const biasStr = formatBiasBreakdown(s);
      if (biasStr) details.push(biasStr);
      const blindspot = formatBlindspotInfo(s);
      if (blindspot) details.push(blindspot);
      if (details.length) console.log(`     ${details.join(' | ')}`);
      if (s.id || s.eventId) console.log(`     ID: ${s.id || s.eventId}`);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, `top-feed-${edition}.json`);
    saveJson(outFile, { feedData, summaries, fetchedAt: new Date().toISOString() });
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'blindspot-feed': {
    const { flags } = parseFlags(args);
    const side = flags.side || null;
    const limit = parseInt(flags.limit || '20');

    console.log(`Fetching blindspot feed${side ? ` (${side} side)` : ''} (limit ${limit})...`);
    const feedData = await fetchBlindspotFeedIds(limit, side);

    const leftIds = feedData.left || [];
    const rightIds = feedData.right || [];
    const allIds = side === 'left' ? leftIds : side === 'right' ? rightIds : [...leftIds, ...rightIds];
    const uniqueIds = [...new Set(allIds)].slice(0, limit);

    if (!uniqueIds.length) {
      console.log('No blindspot stories found.');
      break;
    }

    console.log(`Fetching ${uniqueIds.length} story summaries...`);
    const summaries = await parallelMap(uniqueIds, async (id) => {
      try {
        const s = await fetchEventSummary(id);
        // Tag which side this is a blindspot for
        const isLeft = leftIds.includes(id);
        const isRight = rightIds.includes(id);
        s._blindspotSide = isLeft && isRight ? 'both' : isLeft ? 'left' : 'right';
        return s;
      }
      catch (e) { return { id, title: `(failed: ${e.message.substring(0, 60)})` }; }
    });

    console.log(`\nBlindspot Feed (${summaries.length} stories)\n`);
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const title = s.title || s.generatedHeadline || s.name || '(untitled)';
      const sourceCount = s.sourceCount || s.biasSourceCount || '';
      const sideLabel = s._blindspotSide ? `[${s._blindspotSide} blindspot]` : '';

      console.log(`  ${i + 1}. ${title} ${sideLabel}`);

      const details = [];
      if (sourceCount) details.push(`${sourceCount} sources`);
      const biasStr = formatBiasBreakdown(s);
      if (biasStr) details.push(biasStr);
      if (details.length) console.log(`     ${details.join(' | ')}`);
      if (s.id || s.eventId) console.log(`     ID: ${s.id || s.eventId}`);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, 'blindspot-feed.json');
    saveJson(outFile, { feedData, summaries, fetchedAt: new Date().toISOString() });
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'story': {
    const { positional } = parseFlags(args);
    const eventId = positional[0];
    if (!eventId) {
      console.error('Usage: node groundnews-feed.mjs story <event-id>');
      process.exit(1);
    }

    console.log(`Fetching story summary: ${eventId}...`);
    const event = await fetchEventSummary(eventId);

    displayStoryDetail(event);

    const outFile = resolve(CACHE_DIR, `story-${eventId}.json`);
    saveJson(outFile, event);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'story-full': {
    const { positional } = parseFlags(args);
    const eventId = positional[0];
    if (!eventId) {
      console.error('Usage: node groundnews-feed.mjs story-full <event-id>');
      process.exit(1);
    }

    console.log(`Fetching full story: ${eventId}...`);
    const event = await fetchEventFull(eventId);

    displayStoryFull(event);

    const outFile = resolve(CACHE_DIR, `story-full-${eventId}.json`);
    saveJson(outFile, event);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  case 'sources': {
    const { flags, positional } = parseFlags(args);
    const eventId = positional[0];
    if (!eventId) {
      console.error('Usage: node groundnews-feed.mjs sources <event-id> [--bias=left|center|right] [--limit=20]');
      process.exit(1);
    }
    const biasFilter = flags.bias || null;
    const limit = parseInt(flags.limit || '20');
    const auth = getAuth();

    console.log(`Fetching sources for: ${eventId}...`);
    const sources = await fetchSources(eventId, auth);

    let filtered = Array.isArray(sources) ? sources : (sources.sources || sources.articles || []);
    if (biasFilter) {
      filtered = filtered.filter(s => {
        const b = (s.bias || s.source?.bias || '').toLowerCase();
        return b.includes(biasFilter.toLowerCase());
      });
    }
    filtered = filtered.slice(0, limit);

    console.log(`\nSources for story (${filtered.length}${biasFilter ? `, filtered: ${biasFilter}` : ''})\n`);
    for (let i = 0; i < filtered.length; i++) {
      displaySource(filtered[i], i);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, `sources-${eventId}.json`);
    saveJson(outFile, { sources: filtered, total: (Array.isArray(sources) ? sources : (sources.sources || [])).length, fetchedAt: new Date().toISOString() });
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'interest-feed': {
    const { flags, positional } = parseFlags(args);
    const interestId = positional[0];
    if (!interestId) {
      console.error('Usage: node groundnews-feed.mjs interest-feed <interest-uuid> [--limit=20] [--offset=0] [--sort=time]');
      console.error('\nNote: Use the UUID, not the slug. Slugs return empty results.');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '20');
    const offset = parseInt(flags.offset || '0');
    const sort = flags.sort || null;
    const auth = getAuth();

    console.log(`Fetching interest feed: ${interestId} (limit ${limit}, offset ${offset})...`);
    const feedData = await fetchInterestFeedIds(auth, interestId, limit, sort, offset);

    const eventIds = (feedData.eventIds || feedData.ids || []).slice(0, limit);
    if (!eventIds.length) {
      console.log('No stories found. Make sure you used the UUID, not the slug.');
      break;
    }

    console.log(`Fetching ${eventIds.length} story summaries...`);
    const summaries = await parallelMap(eventIds, async (id) => {
      try { return await fetchEventSummary(id); }
      catch (e) { return { id, title: `(failed: ${e.message.substring(0, 60)})` }; }
    });

    console.log(`\nInterest Feed (${summaries.length} stories)\n`);
    for (let i = 0; i < summaries.length; i++) {
      displayStorySummary(summaries[i], i);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, `interest-feed-${interestId}.json`);
    saveJson(outFile, { feedData, summaries, fetchedAt: new Date().toISOString() });
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'daily-briefing': {
    const auth = getAuth();
    console.log('Fetching daily briefing...');
    const briefing = await fetchDailyBriefing(auth);

    const date = briefing.editionDate ? new Date(briefing.editionDate).toLocaleDateString() : 'today';
    console.log(`\nDaily Briefing — ${date}`);
    if (briefing.subtitle) console.log(`  ${briefing.subtitle}`);
    console.log(`\n  ${briefing.stories.length} stories\n`);

    for (let i = 0; i < briefing.stories.length; i++) {
      const s = briefing.stories[i];
      console.log(`  ${i + 1}. ${s.title}`);
      if (s.tagline) console.log(`     ${s.tagline}`);
      if (s.summaryOneHeadline || s.summaryOneText) {
        console.log(`     ${s.summaryOneHeadline} ${s.summaryOneText.substring(0, 150)}...`);
      }
      if (s.summaryTwoHeadline || s.summaryTwoText) {
        console.log(`     ${s.summaryTwoHeadline} ${s.summaryTwoText.substring(0, 150)}...`);
      }
      console.log(`     ID: ${s.eventId}`);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, 'daily-briefing.json');
    saveJson(outFile, briefing);
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'local-news': {
    const { flags, positional } = parseFlags(args);
    const placeId = positional[0];
    if (!placeId) {
      console.error('Usage: node groundnews-feed.mjs local-news <place-id> [--limit=10]');
      console.error('\nPlace ID formats: "US", "TR", "Istanbul,Istanbul,TR", "London,GreaterLondon,GB"');
      process.exit(1);
    }
    const limit = parseInt(flags.limit || '10');

    console.log(`Fetching local news for: ${placeId}...`);
    const { interest, eventsData } = await fetchLocalNewsIds(placeId, limit);
    console.log(`  Place → ${interest.name || interest.slug} (${interest.id})`);

    const eventIds = (eventsData.eventIds || []).slice(0, limit);
    if (!eventIds.length) {
      console.log('No local news found for this place.');
      break;
    }

    console.log(`Fetching ${eventIds.length} story summaries...`);
    const summaries = await parallelMap(eventIds, async (id) => {
      try { return await fetchEventSummary(id); }
      catch (e) { return { id, title: `(failed: ${e.message.substring(0, 60)})` }; }
    });

    console.log(`\nLocal News — ${interest.name || placeId} (${summaries.length} stories)\n`);
    for (let i = 0; i < summaries.length; i++) {
      displayStorySummary(summaries[i], i);
      console.log();
    }

    const outFile = resolve(CACHE_DIR, `local-news-${placeId.replace(/[,/]/g, '_')}.json`);
    saveJson(outFile, { interest, eventsData, summaries, fetchedAt: new Date().toISOString() });
    console.log(`Saved to: ${outFile}`);
    break;
  }

  case 'editions': {
    console.log('Fetching available editions...');
    const editions = await fetchEditions();

    const edList = Array.isArray(editions) ? editions : (editions.editions || editions.data || []);

    console.log(`\nAvailable Editions (${edList.length})\n`);
    for (const ed of edList) {
      const id = ed.id || ed.editionId || ed.key || '?';
      const name = ed.name || ed.title || ed.label || '?';
      const webFeedId = ed.webFeedId || ed.feedId || '';
      console.log(`  ${id} — ${name}${webFeedId ? ` (feedId: ${webFeedId})` : ''}`);
    }

    const outFile = resolve(CACHE_DIR, 'editions.json');
    saveJson(outFile, editions);
    console.log(`\nSaved to: ${outFile}`);
    break;
  }

  default:
    console.log(`groundnews-feed — Ground News feeds and stories

Commands:
  auth                                     Authenticate via Chrome (one-time)
  top-feed [--edition=us] [--limit=20] [--offset=0]
                                           Top news (breaking + top story + regular)
  daily-briefing                           AI-curated daily news digest
  blindspot-feed [--side=left|right] [--limit=20]
                                           Blindspot stories (left/right coverage gaps)
  local-news <place-id> [--limit=10]       Local news for a place
  story <event-id>                         Story summary with bias data
  story-full <event-id>                    Full story with AI summaries
  sources <event-id> [--bias=X] [--limit=20]
                                           Source articles for a story
  interest-feed <uuid> [--limit=20] [--offset=0] [--sort=time]
                                           Stories for a topic (use UUID, not slug)
  editions                                 List available feed editions

Editions: us, eu, uk, ca, international
Place IDs: US, TR, Istanbul,Istanbul,TR, London,GreaterLondon,GB

Data: ${DATA_DIR}/
  session.json     Auth token
  cache/           Cached feed & story data`);
}
