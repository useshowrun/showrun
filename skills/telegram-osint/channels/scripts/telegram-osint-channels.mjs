#!/usr/bin/env node
// telegram-osint-channels.mjs — Scrape public Telegram channel previews (t.me/s/<slug>).
//
// No auth required. Reads the public web preview page only.
//
// Commands:
//   node telegram-osint-channels.mjs list
//   node telegram-osint-channels.mjs subscribe <channel> "description"
//   node telegram-osint-channels.mjs unsubscribe <channel>
//   node telegram-osint-channels.mjs fetch <channel>
//   node telegram-osint-channels.mjs fetch-all
//   node telegram-osint-channels.mjs view <channel>
//   node telegram-osint-channels.mjs verify <channel>
//
// Requires Node 22+ (built-in fetch).

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data directory (matches showrun convention)
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/telegram-osint');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const CHANNELS_FILE = resolve(DATA_DIR, 'channels.json');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 telegram-osint/1.0';
const TIMEOUT_MS = 20_000;

// Seeded on first run. Do not edit here — use `subscribe` / `unsubscribe`.
const SEED_CHANNELS = {
  clashreport:   'Clash Report — conflict news aggregator (English)',
  IntelSlava:    'Intel Slava Z — Russian-leaning aggregator (English)',
  IranIntl_En:   'Iran International (opposition, English)',
  ASBMilitary:   'ASB Military — Israeli defense analysis (English)',
  rybar_en:      'Rybar — Russian military analysis (Russian content)',
  abualiexpress: 'Abu Ali Express — Israeli analysis (Hebrew content)',
};

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

function loadChannels() {
  ensureDir(DATA_DIR);
  if (!existsSync(CHANNELS_FILE)) {
    saveJson(CHANNELS_FILE, SEED_CHANNELS);
    return { ...SEED_CHANNELS };
  }
  return loadJson(CHANNELS_FILE, {});
}

function saveChannels(channels) {
  saveJson(CHANNELS_FILE, channels);
}

// ---------------------------------------------------------------------------
// HTTP — no redirect follow
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const err = new Error(`redirected to ${res.headers.get('location') || '?'} — channel has no public preview`);
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML parsing (regex only — mirrors tg_osint_fetch.py)
// ---------------------------------------------------------------------------

const RE_WRAP_START = /<div class="tgme_widget_message_wrap[^"]*">/g;
const RE_MSG_OPEN = /<div class="tgme_widget_message [^"]*?"[^>]*?data-post="([^"]+)"/;
const RE_TEXT = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const RE_TIME = /<time[^>]*datetime="([^"]+)"/;
const RE_VIEWS = /<span class="tgme_widget_message_views">([^<]+)<\/span>/;
const RE_PHOTO = /tgme_widget_message_photo_wrap[^>]*background-image:url\((?:&#39;|')([^')]+?)(?:&#39;|')\)/;
const RE_LINK = /<a\s+href="([^"]+)"/g;
const RE_TAG = /<[^>]+>/g;
const RE_BR = /<br\s*\/?>/gi;

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
};
function decodeEntities(s) {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#39;/g, (m) => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(html) {
  const withNewlines = html.replace(RE_BR, '\n');
  const noTags = withNewlines.replace(RE_TAG, '');
  const decoded = decodeEntities(noTags);
  // Collapse runs of spaces/tabs within each line, then drop empty lines.
  return decoded
    .split('\n')
    .map((ln) => ln.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function splitMessages(page) {
  const starts = [];
  let m;
  RE_WRAP_START.lastIndex = 0;
  while ((m = RE_WRAP_START.exec(page)) !== null) {
    starts.push(m.index);
  }
  starts.push(page.length);
  const chunks = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const chunk = page.slice(starts[i], starts[i + 1]);
    const open = chunk.match(RE_MSG_OPEN);
    if (!open) continue;
    chunks.push([open[1], chunk]);
  }
  return chunks;
}

function parseMessage(msgId, chunk) {
  const textM = chunk.match(RE_TEXT);
  const textHtml = textM ? textM[1] : '';
  const text = textHtml ? stripHtml(textHtml) : '';

  const timeM = chunk.match(RE_TIME);
  let ts = null;
  if (timeM) {
    try {
      ts = new Date(timeM[1]).toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch {
      ts = timeM[1];
    }
  }

  const viewsM = chunk.match(RE_VIEWS);
  const views = viewsM ? viewsM[1].trim() : null;

  const photoM = chunk.match(RE_PHOTO);
  const imageUrl = photoM ? photoM[1] : null;

  const links = [];
  if (textHtml) {
    RE_LINK.lastIndex = 0;
    let linkM;
    while ((linkM = RE_LINK.exec(textHtml)) !== null) {
      const href = linkM[1];
      if (href.startsWith('http') && !href.includes('t.me/') && !links.includes(href)) {
        links.push(href);
      }
    }
  }

  return {
    id: msgId,
    url: `https://t.me/${msgId}`,
    ts,
    text,
    links,
    image_url: imageUrl,
    views,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchChannel(channel, description) {
  const url = `https://t.me/s/${channel}`;
  let page;
  try {
    page = await fetchHtml(url);
  } catch (e) {
    console.log(`  ! ${channel}: ${e.message}`);
    return null;
  }
  const chunks = splitMessages(page);
  const messages = chunks.map(([id, c]) => parseMessage(id, c));
  const payload = {
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    channel,
    channel_description: description || '',
    count: messages.length,
    messages,
  };
  const chDir = resolve(CACHE_DIR, channel);
  ensureDir(chDir);
  saveJson(resolve(chDir, 'latest.json'), payload);
  console.log(`  + ${channel}: ${messages.length} msgs`);
  return payload;
}

async function verifyChannel(channel) {
  const url = `https://t.me/s/${channel}`;
  try {
    await fetchHtml(url);
    console.log(`  ✓ ${channel}: reachable`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${channel}: ${e.message}`);
    return false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Arg parsing (tiny)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const channels = loadChannels();
  const entries = Object.entries(channels);
  console.log(`Subscribed channels (${entries.length}):\n`);
  for (const [slug, desc] of entries) {
    const path = resolve(CACHE_DIR, slug, 'latest.json');
    let status = 'never fetched';
    if (existsSync(path)) {
      const blob = loadJson(path, {});
      status = `last=${blob.fetched_at}  msgs=${blob.count}`;
    }
    console.log(`  ${slug.padEnd(22)} ${status}`);
    console.log(`      ${desc}`);
  }
  console.log(`\nConfig: ${CHANNELS_FILE}`);
  console.log(`Cache:  ${CACHE_DIR}`);
}

function cmdSubscribe(channel, description) {
  if (!channel) throw new Error('subscribe requires <channel>');
  const channels = loadChannels();
  channels[channel] = description || channels[channel] || '';
  saveChannels(channels);
  console.log(`+ subscribed: ${channel}`);
  console.log(`  ${channels[channel]}`);
  console.log(`  (run 'verify ${channel}' to test reachability, then 'fetch ${channel}' to pull)`);
}

function cmdUnsubscribe(channel) {
  if (!channel) throw new Error('unsubscribe requires <channel>');
  const channels = loadChannels();
  if (!(channel in channels)) {
    console.log(`  ${channel} not subscribed`);
    return;
  }
  delete channels[channel];
  saveChannels(channels);
  console.log(`- unsubscribed: ${channel}`);
}

async function cmdFetch(channel) {
  if (!channel) throw new Error('fetch requires <channel>');
  const channels = loadChannels();
  if (!(channel in channels)) {
    console.log(`! ${channel} not subscribed; fetching anyway (use 'subscribe' to persist)`);
  }
  console.log(`Fetching ${channel}...`);
  await fetchChannel(channel, channels[channel]);
}

async function cmdFetchAll(flags) {
  const channels = loadChannels();
  const entries = Object.entries(channels);
  console.log(`Fetching ${entries.length} subscribed channels...`);
  let ok = 0;
  const parallel = Number(flags.parallel) || 1;
  if (parallel <= 1) {
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) await sleep(2000);
      const [slug, desc] = entries[i];
      const res = await fetchChannel(slug, desc);
      if (res) ok++;
    }
  } else {
    // parallel batches
    for (let i = 0; i < entries.length; i += parallel) {
      const batch = entries.slice(i, i + parallel);
      const results = await Promise.all(batch.map(([slug, desc]) => fetchChannel(slug, desc)));
      ok += results.filter(Boolean).length;
      if (i + parallel < entries.length) await sleep(2000);
    }
  }
  console.log(`\nDone: ${ok}/${entries.length} channels returned data`);
}

async function cmdVerify(channel) {
  if (!channel) throw new Error('verify requires <channel>');
  await verifyChannel(channel);
}

function cmdView(channel) {
  if (!channel) throw new Error('view requires <channel>');
  const path = resolve(CACHE_DIR, channel, 'latest.json');
  if (!existsSync(path)) {
    console.log(`No cache for ${channel}. Run: fetch ${channel}`);
    return;
  }
  const blob = loadJson(path, {});
  console.log(`${channel} — ${blob.channel_description}`);
  console.log(`fetched_at=${blob.fetched_at}  count=${blob.count}\n`);
  for (const m of blob.messages || []) printMessage({ ...m, channel });
}

function printMessage(m) {
  const ts = (m.ts || '').slice(0, 16).replace('T', ' ');
  const ch = m.channel || '?';
  let txt = (m.text || '').replace(/\n/g, ' ');
  if (txt.length > 200) txt = txt.slice(0, 197) + '...';
  const views = m.views || '';
  console.log(`[${ts}] ${ch}  (${views})`);
  console.log(`  ${txt}`);
  if (m.links && m.links.length) console.log(`  links: ${m.links.slice(0, 3).join(', ')}`);
  console.log(`  ${m.url}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  console.log(`telegram-osint-channels — scrape public Telegram channel previews

Commands:
  list                              Show subscribed channels + last-fetch status
  subscribe <channel> "desc"        Add a channel to the subscription list
  unsubscribe <channel>             Remove a channel from the subscription list
  fetch <channel>                   Fetch one channel
  fetch-all [--parallel=N]          Fetch every subscribed channel
  view <channel>                    Print last fetch of one channel
  verify <channel>                  HEAD-check a channel without saving

Data: ${DATA_DIR}
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  try {
    switch (cmd) {
      case undefined:
      case 'list':          cmdList(); break;
      case 'subscribe':     cmdSubscribe(positional[0], positional.slice(1).join(' ')); break;
      case 'unsubscribe':   cmdUnsubscribe(positional[0]); break;
      case 'fetch':         await cmdFetch(positional[0]); break;
      case 'fetch-all':     await cmdFetchAll(flags); break;
      case 'verify':        await cmdVerify(positional[0]); break;
      case 'view':          cmdView(positional[0]); break;
      case 'help':
      case '-h':
      case '--help':        usage(); break;
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
