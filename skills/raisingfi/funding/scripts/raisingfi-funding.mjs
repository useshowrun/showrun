#!/usr/bin/env node

/**
 * Raising.fi funding rounds fetcher.
 *
 * Usage:
 *   node raisingfi-funding.mjs list [--limit=N] [--page=N]
 *   node raisingfi-funding.mjs fetch-all
 *   node raisingfi-funding.mjs search <query>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), '.local', 'share', 'showrun', 'data', 'raisingfi-funding');
const CACHE_DIR = join(DATA_DIR, 'cache');
const CACHE_FILE = join(CACHE_DIR, 'funding.json');

const BASE_URL = 'https://raising.fi/api/funding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveCache(data) {
  ensureDir(CACHE_DIR);
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      flags[key] = val ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchPage(page = 1, limit = 100) {
  const url = `${BASE_URL}?page=${page}&limit=${limit}`;
  const res = await fetch(url);

  const remaining = res.headers.get('x-ratelimit-remaining');
  const resetTs = res.headers.get('x-ratelimit-reset');

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const resetDate = resetTs ? new Date(parseInt(resetTs) * 1000) : null;
      console.error(`Rate limited. ${retryAfter ? `Retry after ${retryAfter}s.` : ''} ${resetDate ? `Resets at ${resetDate.toLocaleTimeString()}.` : ''}`);
      return null;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();

  if (remaining !== null) {
    console.error(`  [rate limit: ${remaining} remaining]`);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(flags) {
  const page = parseInt(flags.page || '1', 10);
  const limit = parseInt(flags.limit || '10', 10);

  console.error(`Fetching page ${page} (limit ${limit})...`);
  const result = await fetchPage(page, limit);
  if (!result) return;

  const { data, pagination } = result;

  for (const item of data) {
    console.log(`${item.dateOfRaise}  ${item.companyName}  ${item.raiseType}  ${item.amountRaised}  [${item.leadInvestor}]  ${item.industry}`);
  }

  console.error(`\nPage ${pagination.page}/${pagination.totalPages} (${pagination.total} total)`);
  if (pagination.hasNextPage) {
    console.error(`Next: --page=${pagination.page + 1}`);
  }
}

async function cmdFetchAll() {
  const all = [];
  let page = 1;
  const limit = 100;

  while (true) {
    console.error(`Fetching page ${page}...`);
    const result = await fetchPage(page, limit);

    if (!result) {
      console.error('Stopped due to rate limit. Saving what we have.');
      break;
    }

    const fetchedAt = new Date().toISOString();
    for (const item of result.data) {
      all.push({ ...item, source: 'raising.fi', fetchedAt });
    }

    if (!result.pagination.hasNextPage) break;
    page += 1;
    await sleep(500);
  }

  saveCache(all);
  console.log(`Fetched ${all.length} funding round(s). Saved to ${CACHE_FILE}`);
}

async function cmdSearch(query) {
  if (!query) {
    console.error('Usage: raisingfi-funding.mjs search <query>');
    process.exit(1);
  }

  const cache = loadCache();
  if (!cache.length) {
    console.error('No cached data. Run `fetch-all` first.');
    process.exit(1);
  }

  const q = query.toLowerCase();
  const matches = cache.filter(
    (item) =>
      item.companyName?.toLowerCase().includes(q) ||
      item.industry?.toLowerCase().includes(q) ||
      item.leadInvestor?.toLowerCase().includes(q) ||
      item.investors?.toLowerCase().includes(q)
  );

  if (!matches.length) {
    console.log(`No results for "${query}".`);
    return;
  }

  console.log(`Found ${matches.length} result(s):\n`);
  for (const item of matches) {
    console.log(`${item.dateOfRaise}  ${item.companyName}  ${item.raiseType}  ${item.amountRaised}`);
    console.log(`  Lead: ${item.leadInvestor}`);
    console.log(`  Investors: ${item.investors}`);
    console.log(`  Industry: ${item.industry}  Location: ${item.location}`);
    console.log(`  Website: ${item.website}`);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);

try {
  switch (cmd) {
    case 'list':
      await cmdList(flags);
      break;
    case 'fetch-all':
      await cmdFetchAll();
      break;
    case 'search':
      await cmdSearch(positional[0] || flags.query);
      break;
    default:
      console.log(`raisingfi-funding — Fetch startup funding rounds from Raising.fi

Usage:
  raisingfi-funding.mjs list [--limit=N] [--page=N]   List recent funding rounds
  raisingfi-funding.mjs fetch-all                      Fetch all pages, save to cache
  raisingfi-funding.mjs search <query>                 Search cached results by company/investor/industry

Rate limit: 10 requests/hour (free tier, last 20 raises only)`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
