#!/usr/bin/env node
// similarweb-backlinks.mjs — Backlink analytics from SimilarWeb: summary, referring domains, individual backlinks
//
// Setup:   node similarweb-backlinks.mjs auth
// Usage:   node similarweb-backlinks.mjs summary chatgpt.com
//          node similarweb-backlinks.mjs domains chatgpt.com --count=20
//          node similarweb-backlinks.mjs links chatgpt.com --count=20
//
// Requires Node 22+ (built-in fetch + crypto).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/similarweb-backlinks');
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
// CDP integration
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
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 100 * 1024 * 1024 }).trim();
}

// ---------------------------------------------------------------------------
// Auth — reuses similarweb-website session if available
// ---------------------------------------------------------------------------

async function doAuth() {
  const websiteSession = resolve(homedir(), '.local/share/showrun/data/similarweb-website/session.json');
  if (existsSync(websiteSession)) {
    const ws = JSON.parse(readFileSync(websiteSession, 'utf8'));
    if (ws.cookie) {
      saveJson(SESSION_FILE, ws);
      console.log(`Reused session from similarweb-website (extracted at ${ws.extractedAt})`);
      console.log(`Saved to: ${SESSION_FILE}`);
      return;
    }
  }

  console.log('Finding SimilarWeb tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('similarweb.com')) { target = line.trim().split(/\s+/)[0]; break; }
  }
  if (!target) throw new Error('No SimilarWeb tab found. Open pro.similarweb.com in Chrome first.');

  console.log('Extracting cookies...');
  const raw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://pro.similarweb.com'] }));
  const { cookies } = JSON.parse(raw);

  const cookieStr = cookies
    .filter(c => c.domain.includes('similarweb.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Are you logged in to SimilarWeb?');

  saveJson(SESSION_FILE, {
    cookie: cookieStr,
    extractedAt: new Date().toISOString(),
  });
  console.log(`Auth saved to: ${SESSION_FILE}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run: node similarweb-backlinks.mjs auth');
    process.exit(1);
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    'accept': 'application/json',
    'content-type': 'application/json; charset=utf-8',
    'cookie': auth.cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    'x-sw-page': 'https://pro.similarweb.com/',
    'x-sw-page-view-id': crypto.randomUUID(),
  };
}

async function apiFetch(auth, url, options = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      headers: { ...baseHeaders(auth), ...options.headers },
    });
  } catch (err) {
    throw new Error(`Network error fetching ${url.split('?')[0]}: ${err.message}`);
  }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      console.error('Session expired or blocked. Run: node similarweb-backlinks.mjs auth');
    }
    throw new Error(`API error (HTTP ${resp.status}): ${typeof data === 'string' ? data.substring(0, 300) : JSON.stringify(data).substring(0, 300)}`);
  }
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://pro.similarweb.com/api';

function parseDomain(input) {
  let domain = input.trim();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/\/.*$/, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/:\d+$/, '');
  return domain.toLowerCase();
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function fmtLarge(val) {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return String(val);
}

function fmtPct(val, decimals = 2) {
  if (val == null) return 'N/A';
  return (val * 100).toFixed(decimals) + '%';
}

function safeDomainFilename(domain) {
  return domain.replace(/\./g, '_');
}

// ---------------------------------------------------------------------------
// API: Summary
// ---------------------------------------------------------------------------

async function fetchSummary(auth, domain) {
  console.log(`Fetching backlink summary for ${domain}...`);
  const url = `${API_BASE}/backlinks/summary?Key=${domain}&Status=All`;
  const { data } = await apiFetch(auth, url);

  const totalBacklinks = data.TopTlds?.reduce((sum, t) => sum + (t.Count || 0), 0) || null;
  const topTlds = (data.TopTlds || []).map(t => ({
    tld: t.Tld || null,
    count: t.Count ?? null,
    countFormatted: t.Count != null ? fmtLarge(t.Count) : 'N/A',
    share: totalBacklinks ? (t.Count || 0) / totalBacklinks : null,
    shareFormatted: totalBacklinks ? fmtPct((t.Count || 0) / totalBacklinks) : 'N/A',
  }));

  const totalByCountry = data.TopCountries?.reduce((sum, c) => sum + (c.Count || 0), 0) || null;
  const topCountries = (data.TopCountries || []).filter(c => c.Country).map(c => ({
    country: c.Country || null,
    count: c.Count ?? null,
    countFormatted: c.Count != null ? fmtLarge(c.Count) : 'N/A',
    share: totalByCountry ? (c.Count || 0) / totalByCountry : null,
    shareFormatted: totalByCountry ? fmtPct((c.Count || 0) / totalByCountry) : 'N/A',
  }));

  const result = {
    domain,
    totalBacklinks,
    totalBacklinksFormatted: totalBacklinks != null ? fmtLarge(totalBacklinks) : 'N/A',
    topTlds,
    topCountries,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-summary.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Referring Domains
// ---------------------------------------------------------------------------

async function fetchDomains(auth, domain, count = 20, sort = 'BacklinksCount') {
  console.log(`Fetching referring domains for ${domain} (count=${count})...`);
  const url = `${API_BASE}/backlinks/refdomains?Page=1&PageSize=${count}&Status=All&Key=${domain}&asc=false&sort=${sort}`;
  const { data } = await apiFetch(auth, url, { method: 'POST', body: '[]' });

  const records = (data.Records || []).map(r => ({
    domain: r.Name || null,
    rank: r.Rank ?? null,
    backlinksCount: r.BacklinksCount ?? null,
    backlinksCountFormatted: r.BacklinksCount != null ? fmtLarge(r.BacklinksCount) : 'N/A',
    referringPages: r.ReferringPages ?? null,
    referringPagesFormatted: r.ReferringPages != null ? fmtLarge(r.ReferringPages) : 'N/A',
    followLinks: r.ReferringPagesFollow ?? null,
    nofollowLinks: r.ReferringPagesNofollow ?? null,
    firstSeen: r.FirstSeen || null,
    favicon: r.Favicon || null,
  }));

  const result = {
    domain,
    totalReferringDomains: data.TotalRecords ?? null,
    totalReferringDomainsFormatted: data.TotalRecords != null ? fmtLarge(data.TotalRecords) : 'N/A',
    count: records.length,
    referringDomains: records,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-domains.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// API: Backlinks
// ---------------------------------------------------------------------------

async function fetchLinks(auth, domain, count = 20, sort = 'DomainScore', duration = '28d') {
  console.log(`Fetching backlinks for ${domain} (count=${count}, duration=${duration})...`);
  const url = `${API_BASE}/backlinks/backlinks?Page=1&PageSize=${count}&Status=All&Key=${domain}&asc=false&sort=${sort}&duration=${duration}`;
  const { data } = await apiFetch(auth, url, { method: 'POST', body: '[]' });

  const records = (data.Records || []).map(r => ({
    sourceUrl: r.UrlFrom || null,
    targetUrl: r.UrlTo || null,
    anchorText: r.Anchor || null,
    title: r.Title || null,
    domainScore: r.DomainScore ?? null,
    pageScore: r.PageScore ?? null,
    sourceRank: r.Rank ?? null,
    firstSeen: r.FirstSeen || null,
    lastVisited: r.LastVisited || null,
    isNew: r.IsNew ?? false,
    isLost: r.IsLost ?? false,
    isBroken: r.IsBroken ?? false,
    isImage: r.Image ?? false,
  }));

  const result = {
    domain,
    totalBacklinks: data.TotalRecords ?? null,
    totalBacklinksFormatted: data.TotalRecords != null ? fmtLarge(data.TotalRecords) : 'N/A',
    duration,
    count: records.length,
    backlinks: records,
  };

  const cacheFile = resolve(CACHE_DIR, `${safeDomainFilename(domain)}-links-${duration}.json`);
  saveJson(cacheFile, result);
  console.log(`Cached: ${cacheFile}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const domainArg = positional[0];

try {
  switch (command) {
    case 'auth': {
      await doAuth();
      break;
    }

    case 'summary': {
      if (!domainArg) { console.error('Usage: similarweb-backlinks.mjs summary <domain>'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const result = await fetchSummary(getAuth(), domain);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'domains': {
      if (!domainArg) { console.error('Usage: similarweb-backlinks.mjs domains <domain> [--count=20] [--sort=BacklinksCount]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const count = parseInt(flags.count || '20', 10);
      const sort = flags.sort || 'BacklinksCount';
      const result = await fetchDomains(getAuth(), domain, count, sort);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'links': {
      if (!domainArg) { console.error('Usage: similarweb-backlinks.mjs links <domain> [--count=20] [--sort=DomainScore] [--duration=28d]'); process.exit(1); }
      const domain = parseDomain(domainArg);
      const count = parseInt(flags.count || '20', 10);
      const sort = flags.sort || 'DomainScore';
      const duration = flags.duration || '28d';
      const result = await fetchLinks(getAuth(), domain, count, sort, duration);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default: {
      const script = 'similarweb-backlinks.mjs';
      console.log(`
similarweb-backlinks — Backlink analytics from SimilarWeb

Setup:
  node ${script} auth                              Extract cookies from Chrome

Commands:
  node ${script} summary <domain>                  Backlink summary: TLD distribution, top countries
  node ${script} domains <domain>                  Top referring domains by backlink count
       [--count=20]                                 Number of results (default: 20)
       [--sort=BacklinksCount]                      Sort: BacklinksCount, Rank (default: BacklinksCount)
  node ${script} links <domain>                    Individual backlinks with source URLs, anchors, scores
       [--count=20]                                 Number of results (default: 20)
       [--sort=DomainScore]                         Sort: DomainScore, PageScore, Rank (default: DomainScore)
       [--duration=28d]                             Time window: 28d, 3m, 6m, 13m (default: 28d)

Examples:
  node ${script} summary chatgpt.com
  node ${script} domains chatgpt.com --count=50
  node ${script} links shopify.com --sort=PageScore --duration=3m

Domain formats:
  google.com                                        Plain domain
  www.google.com                                    www prefix stripped automatically
  https://google.com/search                         URL — domain extracted automatically

Data stored in: ${DATA_DIR}
`);
      break;
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
