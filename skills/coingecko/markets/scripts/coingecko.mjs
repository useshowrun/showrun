#!/usr/bin/env node
// coingecko.mjs — CoinGecko public market-data API wrapper.
//
// Endpoint: https://api.coingecko.com/api/v3
// No auth on free public tier. Rate limit ~30 req/min — script self-throttles.
//
// Commands:
//   top [--limit=N] [--vs=usd]                  — top coins by market cap
//   search "<query>" [--limit=N]                — search coins by name/symbol
//   view <coin-id>                              — full coin details (e.g. bitcoin)
//   history <coin-id> [--days=N] [--vs=usd]     — historical price chart
//   global                                       — global market overview

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/coingecko');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const API = 'https://api.coingecko.com/api/v3';
const USER_AGENT = 'showrun-coingecko/1.0';
const TIMEOUT_MS = 60_000;
const REQ_DELAY_MS = 2500;     // free tier ~10–30/min; pad to ~24/min
const RETRY_DELAYS_MS = [4000, 10000, 25000];
const PRICE_TTL_MS = 5 * 60_000;   // 5 min for live prices
const LONG_TTL_MS  = 24 * 3600_000;

let _lastReq = 0;

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(p, fb) { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function saveJson(p, d) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(d, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }
function fileMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function fmtMoney(n, vs = 'usd') {
  if (n === null || n === undefined || Number.isNaN(+n)) return '-';
  const v = +n;
  const sym = vs === 'usd' ? '$' : '';
  if (Math.abs(v) >= 1e12) return `${sym}${(v/1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9)  return `${sym}${(v/1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6)  return `${sym}${(v/1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1)    return `${sym}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${sym}${v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}
function fmtPct(p) { if (p === null || p === undefined) return '-'; const s = p >= 0 ? '+' : ''; return `${s}${p.toFixed(2)}%`; }

async function throttle() {
  const since = Date.now() - _lastReq;
  if (since < REQ_DELAY_MS) await new Promise(r => setTimeout(r, REQ_DELAY_MS - since));
  _lastReq = Date.now();
}

async function fetchJson(path, params = {}) {
  const u = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, v);
  }
  const url = u.toString();
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, signal: ctrl.signal }); }
    catch (e) { lastErr = e; res = null; }
    finally { clearTimeout(t); }
    if (!res) {
      if (attempt < RETRY_DELAYS_MS.length) { await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue; }
      throw new Error(`Network error after retries: ${lastErr?.message || 'unknown'}`);
    }
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`Non-JSON response: ${text.slice(0,200)}`); }
    }
    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt])); continue;
    }
    if (res.status === 404) throw new Error(`HTTP 404: ${url}`);
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  }
  throw lastErr || new Error('exhausted retries');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdTop(opts = {}) {
  const limit = Math.min(opts.limit || 25, 250);
  const vs = (opts.vs || 'usd').toLowerCase();
  const cacheFile = resolve(CACHE_DIR, `top-${vs}-${limit}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < PRICE_TTL_MS)) data = loadJson(cacheFile, null);
  else {
    data = await fetchJson('/coins/markets', { vs_currency: vs, order: 'market_cap_desc', per_page: limit, page: 1, price_change_percentage: '24h,7d' });
    saveJson(cacheFile, data);
  }
  console.log(`# CoinGecko — top ${data.length} coins by market cap  (vs ${vs.toUpperCase()})\n`);
  console.log(`   #     Symbol    Price          24h       7d        Market cap     Volume24h`);
  for (const c of data) {
    const sym = (c.symbol || '').toUpperCase().padEnd(8);
    const rank = String(c.market_cap_rank || '-').padStart(4);
    console.log(`   ${rank}  ${sym}  ${fmtMoney(c.current_price, vs).padStart(12)}  ${fmtPct(c.price_change_percentage_24h_in_currency).padStart(8)}  ${fmtPct(c.price_change_percentage_7d_in_currency).padStart(8)}  ${fmtMoney(c.market_cap, vs).padStart(12)}  ${fmtMoney(c.total_volume, vs).padStart(10)}  ${c.name}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdSearch(query, opts = {}) {
  if (!query) throw new Error('Usage: search "<query>" [--limit=N]');
  const limit = opts.limit || 20;
  const cacheFile = resolve(CACHE_DIR, `search-${slug(query)}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < LONG_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson('/search', { query }); saveJson(cacheFile, data); }
  const coins = (data.coins || []).slice(0, limit);
  console.log(`# CoinGecko search — "${query}"\n   matches: ${data.coins?.length || 0}    showing ${coins.length}\n`);
  for (const c of coins) {
    const rank = c.market_cap_rank ? `#${c.market_cap_rank}`.padStart(6) : '   -  ';
    console.log(`   ${rank}  ${(c.symbol || '').toUpperCase().padEnd(10)} ${c.id.padEnd(28)} ${c.name}`);
  }
  console.log(`\nCached: ${cacheFile}`);
}

async function cmdView(coinId) {
  if (!coinId) throw new Error('Usage: view <coin-id>  (e.g. bitcoin, ethereum)');
  const cacheFile = resolve(CACHE_DIR, `view-${slug(coinId)}.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < PRICE_TTL_MS)) data = loadJson(cacheFile, null);
  else {
    data = await fetchJson(`/coins/${coinId}`, { localization: 'false', tickers: 'false', community_data: 'false', developer_data: 'false', sparkline: 'false' });
    saveJson(cacheFile, data);
  }
  const md = data.market_data || {};
  console.log(`# CoinGecko — ${data.name}  (${data.symbol?.toUpperCase()})  rank #${data.market_cap_rank || '-'}`);
  if (data.categories?.length) console.log(`   categories: ${data.categories.filter(Boolean).slice(0, 5).join(', ')}`);
  console.log(`   genesis:    ${data.genesis_date || '-'}    homepage: ${data.links?.homepage?.[0] || '-'}`);
  console.log(`\n   price:        ${fmtMoney(md.current_price?.usd)}     ATH ${fmtMoney(md.ath?.usd)} (${md.ath_date?.usd?.slice(0,10)})`);
  console.log(`   24h change:   ${fmtPct(md.price_change_percentage_24h)}`);
  console.log(`   7d change:    ${fmtPct(md.price_change_percentage_7d)}`);
  console.log(`   30d change:   ${fmtPct(md.price_change_percentage_30d)}`);
  console.log(`   1y change:    ${fmtPct(md.price_change_percentage_1y)}`);
  console.log(`   market cap:   ${fmtMoney(md.market_cap?.usd)}    fdv: ${fmtMoney(md.fully_diluted_valuation?.usd)}`);
  console.log(`   24h volume:   ${fmtMoney(md.total_volume?.usd)}`);
  console.log(`   circulating:  ${md.circulating_supply?.toLocaleString() || '-'}    total: ${md.total_supply?.toLocaleString() || '-'}    max: ${md.max_supply?.toLocaleString() || '-'}`);
  if (data.description?.en) {
    const desc = data.description.en.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (desc) console.log(`\n   ${desc}${desc.length === 500 ? '…' : ''}`);
  }
}

async function cmdHistory(coinId, opts = {}) {
  if (!coinId) throw new Error('Usage: history <coin-id> [--days=N] [--vs=usd]');
  const days = parseInt(opts.days || 30, 10);
  const vs = (opts.vs || 'usd').toLowerCase();
  const cacheFile = resolve(CACHE_DIR, `history-${slug(coinId)}-${vs}-${days}d.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < PRICE_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson(`/coins/${coinId}/market_chart`, { vs_currency: vs, days }); saveJson(cacheFile, data); }
  const prices = data.prices || [];
  if (!prices.length) { console.log(`# CoinGecko history — ${coinId}\n   (no data)`); return; }
  // Downsample to ~30 buckets for chart
  const step = Math.max(1, Math.floor(prices.length / 30));
  const samples = prices.filter((_, i) => i % step === 0).concat([prices[prices.length-1]]);
  const vals = samples.map(p => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 40;
  console.log(`# CoinGecko history — ${coinId}  (${days}d, vs ${vs.toUpperCase()})`);
  console.log(`   range: ${new Date(prices[0][0]).toISOString().slice(0,10)} → ${new Date(prices[prices.length-1][0]).toISOString().slice(0,10)}    n=${prices.length}    min=${fmtMoney(lo, vs)}  max=${fmtMoney(hi, vs)}`);
  console.log(`   start=${fmtMoney(prices[0][1], vs)}  end=${fmtMoney(prices[prices.length-1][1], vs)}  change=${fmtPct(((prices[prices.length-1][1] - prices[0][1]) / prices[0][1]) * 100)}\n`);
  for (const [ts, v] of samples) {
    const frac = (v - lo) / Math.max(1e-9, hi - lo);
    const bar = '█'.repeat(Math.max(1, Math.round(W * frac)));
    console.log(`   ${new Date(ts).toISOString().slice(0,10)}  ${fmtMoney(v, vs).padStart(12)}  ${bar}`);
  }
}

async function cmdGlobal() {
  const cacheFile = resolve(CACHE_DIR, `global.json`);
  let data;
  if (existsSync(cacheFile) && (Date.now() - fileMtime(cacheFile) < PRICE_TTL_MS)) data = loadJson(cacheFile, null);
  else { data = await fetchJson('/global'); saveJson(cacheFile, data); }
  const g = data.data || {};
  console.log(`# CoinGecko — global market overview`);
  console.log(`   active cryptos:     ${g.active_cryptocurrencies?.toLocaleString() || '-'}    markets: ${g.markets?.toLocaleString() || '-'}`);
  console.log(`   total market cap:   ${fmtMoney(g.total_market_cap?.usd)}`);
  console.log(`   total 24h volume:   ${fmtMoney(g.total_volume?.usd)}`);
  console.log(`   24h mcap change:    ${fmtPct(g.market_cap_change_percentage_24h_usd)}`);
  console.log(`\n   dominance:`);
  const dom = Object.entries(g.market_cap_percentage || {}).sort((a,b) => b[1] - a[1]).slice(0, 8);
  for (const [sym, pct] of dom) console.log(`     ${sym.toUpperCase().padEnd(6)} ${pct.toFixed(2)}%`);
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
  coingecko.mjs top [--limit=N] [--vs=usd]
  coingecko.mjs search "<query>" [--limit=N]
  coingecko.mjs view <coin-id>          (e.g. bitcoin, ethereum, solana)
  coingecko.mjs history <coin-id> [--days=N] [--vs=usd]
  coingecko.mjs global

Data dir: ${DATA_DIR}
Free public API; rate-limit ~10–30 req/min. Script self-throttles to ~24/min.
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'top':     await cmdTop(flags); break;
      case 'search':  await cmdSearch(flags.positional[0], flags); break;
      case 'view':    await cmdView(flags.positional[0]); break;
      case 'history': await cmdHistory(flags.positional[0], flags); break;
      case 'global':  await cmdGlobal(); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':  usage(); break;
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
