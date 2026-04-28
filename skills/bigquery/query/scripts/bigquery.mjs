#!/usr/bin/env node
// bigquery.mjs — Generic Google BigQuery REST API wrapper with first-class
// support for the BigQuery Public Datasets program (project `bigquery-public-data`).
//
// Auth: OAuth2 access token via `gcloud auth application-default print-access-token`.
//       Same model as the http-archive skill — see `setup` command.
//
// Endpoints used (https://docs.cloud.google.com/bigquery/docs/reference/rest):
//   POST   /projects/{billingProject}/queries
//   GET    /projects/{project}/jobs/{jobId}/queryResults
//   GET    /projects/{project}/datasets
//   GET    /projects/{project}/datasets/{datasetId}
//   GET    /projects/{project}/datasets/{datasetId}/tables
//   GET    /projects/{project}/datasets/{datasetId}/tables/{tableId}
//
// Requires Node 22+ (built-in fetch). Stdlib only.

import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const DATA_DIR  = resolve(homedir(), '.local/share/showrun/data/bigquery');
const CACHE_DIR = resolve(DATA_DIR, 'cache');
const AUTH_FILE = resolve(DATA_DIR, 'auth.json');
const BQ_BASE   = 'https://bigquery.googleapis.com/bigquery/v2';
const PUBLIC_PROJECT = 'bigquery-public-data';
const USER_AGENT = 'bigquery-skill/1.0';
const FETCH_TIMEOUT_MS = 90_000;
const POLL_MAX_TRIES   = 30;
const POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function loadJson(path, fb) { if (!existsSync(path)) return fb; try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fb; } }
function saveJson(path, data) { ensureDir(dirname(path)); writeFileSync(path, JSON.stringify(data, null, 2)); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9.]+/g,'-').replace(/^-|-$/g,'').slice(0,80); }

function loadAuth() {
  const a = loadJson(AUTH_FILE, {});
  const project = process.env.BIGQUERY_GCP_PROJECT || a.project;
  const token   = process.env.BIGQUERY_ACCESS_TOKEN || a.token;
  const expires = a.token_expires_at;
  return { project, token, expires };
}

function maskToken(t) {
  if (!t) return '(none)';
  if (t.length < 12) return '***';
  return t.slice(0,4) + '...' + t.slice(-4) + ` (${t.length} chars)`;
}

function fmtBytes(n) {
  if (n == null || n === '' || isNaN(Number(n))) return String(n ?? '');
  const u = ['B','KB','MB','GB','TB','PB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

function fmtNum(n) {
  if (n == null) return 'null';
  const v = Number(n);
  if (isNaN(v)) return String(n);
  return v.toLocaleString();
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// HTTP / BigQuery REST
// ---------------------------------------------------------------------------

async function bqFetch(path, opts = {}) {
  const { token } = loadAuth();
  if (!token) throw new Error('No access token. Run `setup` or set BIGQUERY_ACCESS_TOKEN.');
  const url = path.startsWith('http') ? path : `${BQ_BASE}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 400);
    const reason = json?.error?.errors?.[0]?.reason || '';
    let hint = '';
    if (/billing/i.test(msg)) hint = '\n  hint: enable BigQuery sandbox or attach a billing account at console.cloud.google.com/billing.';
    if (/not been used|disabled|API has not/i.test(msg)) hint = '\n  hint: enable the BigQuery API at https://console.cloud.google.com/apis/library/bigquery.googleapis.com';
    if (res.status === 401) hint = '\n  hint: token expired? Re-run `setup` (gcloud tokens last ~1h).';
    if (res.status === 403 && /access.*denied|permission/i.test(msg)) hint = '\n  hint: your billing project must have BigQuery enabled. Public datasets read fine; the *billing* project is the one in auth.json.';
    throw new Error(`BigQuery ${res.status} (${reason}): ${msg}${hint}`);
  }
  return json;
}

async function bqQuery(sql, opts = {}) {
  const { project } = loadAuth();
  if (!project) throw new Error('No GCP billing project. Run `setup` or set BIGQUERY_GCP_PROJECT.');
  const body = {
    query: sql,
    useLegacySql: false,
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxResults: opts.maxResults ?? 1000,
  };
  if (opts.location)  body.location  = opts.location;
  if (opts.dryRun)    body.dryRun    = true;
  if (opts.useQueryCache !== undefined) body.useQueryCache = opts.useQueryCache;
  let json = await bqFetch(`/projects/${encodeURIComponent(project)}/queries`, { method: 'POST', body });
  // If incomplete, poll getQueryResults until done or POLL_MAX_TRIES.
  if (json.jobComplete === false && json.jobReference?.jobId) {
    const jobId = json.jobReference.jobId;
    const loc = json.jobReference.location || opts.location || '';
    for (let i = 0; i < POLL_MAX_TRIES; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const qs = new URLSearchParams();
      if (loc) qs.set('location', loc);
      qs.set('maxResults', String(opts.maxResults ?? 1000));
      qs.set('timeoutMs', '10000');
      const next = await bqFetch(`/projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(jobId)}/queryResults?${qs}`);
      if (next.jobComplete) { json = { ...json, ...next, jobComplete: true }; break; }
    }
    if (json.jobComplete !== true) {
      throw new Error(`Query still running after ${POLL_MAX_TRIES * POLL_INTERVAL_MS / 1000}s — narrow the query or raise POLL_MAX_TRIES.`);
    }
  }
  return json;
}

async function bqGetMoreRows(jobId, location, pageToken, maxResults = 1000) {
  const { project } = loadAuth();
  const qs = new URLSearchParams();
  if (location) qs.set('location', location);
  if (pageToken) qs.set('pageToken', pageToken);
  qs.set('maxResults', String(maxResults));
  return bqFetch(`/projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(jobId)}/queryResults?${qs}`);
}

// ---------------------------------------------------------------------------
// Result decoding (BigQuery's {f:[{v}]} → friendly object) + table renderer
// ---------------------------------------------------------------------------

function decodeCell(cell, field) {
  if (cell == null) return null;
  // Repeated (mode=REPEATED) → array of {v: ...}
  if (field?.mode === 'REPEATED' && Array.isArray(cell.v)) {
    return cell.v.map(c => decodeCell(c, { ...field, mode: 'NULLABLE' }));
  }
  // RECORD/STRUCT → {f: [...]} nested
  if (field?.type === 'RECORD' && cell.v && typeof cell.v === 'object' && Array.isArray(cell.v.f)) {
    const obj = {};
    (field.fields || []).forEach((sub, i) => {
      obj[sub.name] = decodeCell(cell.v.f[i], sub);
    });
    return obj;
  }
  return cell.v ?? null;
}

function rowsFromBQResult(json) {
  const fields = json?.schema?.fields || [];
  const out = [];
  for (const r of (json.rows || [])) {
    const obj = {};
    (r.f || []).forEach((cell, i) => {
      const f = fields[i];
      const fname = f?.name || `c${i}`;
      obj[fname] = decodeCell(cell, f);
    });
    out.push(obj);
  }
  return { fields: fields.map(f => f.name), rows: out };
}

function truncate(s, max) { return s.length > max ? s.slice(0, max-1) + '…' : s; }

function renderTable(fields, rows, opts={}) {
  if (!rows.length) return '(no rows)';
  const maxColW = opts.maxColW ?? 60;
  const widths = fields.map(f => f.length);
  const view = rows.map(r => fields.map((f,i) => {
    let v = r[f];
    if (v == null) v = '';
    else if (typeof v === 'object') v = JSON.stringify(v);
    else v = String(v);
    if (v.length > widths[i]) widths[i] = Math.min(v.length, maxColW);
    return v;
  }));
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const header = '| ' + fields.map((f,i) => f.padEnd(widths[i])).join(' | ') + ' |';
  const lines = [header, sep];
  for (const row of view) {
    lines.push('| ' + row.map((v,i) => truncate(v, widths[i]).padEnd(widths[i])).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderCSV(fields, rows) {
  const esc = v => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const out = [fields.join(',')];
  for (const r of rows) out.push(fields.map(f => esc(r[f])).join(','));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Public dataset catalog (42 entries grouped into 6 categories)
// ---------------------------------------------------------------------------

const PUBLIC_DATASETS = [
  // Advertising / Marketing (2)
  { category: 'Advertising / Marketing', id: 'google_ads_transparency_center',
    desc: 'Every ad shown via Google Ads (creative metadata, advertiser, regions)',
    example: "SELECT advertiser_disclosed_name, COUNT(*) c FROM `bigquery-public-data.google_ads_transparency_center.creative_stats` WHERE region_code='US' GROUP BY 1 ORDER BY c DESC LIMIT 20" },
  { category: 'Advertising / Marketing', id: 'google_trends',
    desc: 'Daily Google Trends top terms / rising terms by US DMA + worldwide',
    example: "SELECT term, score FROM `bigquery-public-data.google_trends.top_terms` WHERE refresh_date = (SELECT MAX(refresh_date) FROM `bigquery-public-data.google_trends.top_terms`) AND rank=1 LIMIT 1" },

  // Web / Open Source (2)
  { category: 'Web / Open Source', id: 'libraries_io',
    desc: 'deps.dev / Libraries.io: every public package across 32 registries + dependency graph',
    example: "SELECT name, COUNT(*) versions FROM `bigquery-public-data.libraries_io.versions` WHERE platform='NPM' GROUP BY name ORDER BY versions DESC LIMIT 10" },
  { category: 'Web / Open Source', id: 'sigstore_rekor',
    desc: 'Sigstore Rekor transparency log entries (every signed open-source artifact)',
    example: "SELECT kind, COUNT(*) n FROM `bigquery-public-data.sigstore_rekor.entries` GROUP BY kind ORDER BY n DESC LIMIT 10" },

  // Blockchain (15)
  { category: 'Blockchain', id: 'crypto_ethereum',
    desc: 'Ethereum mainnet: blocks, transactions, logs, traces, token transfers',
    example: "SELECT DATE(block_timestamp) d, COUNT(*) txs FROM `bigquery-public-data.crypto_ethereum.transactions` WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) GROUP BY d ORDER BY d DESC" },
  { category: 'Blockchain', id: 'crypto_solana_mainnet_us',
    desc: 'Solana mainnet blocks, transactions, instructions, token transfers',
    example: "SELECT DATE(block_timestamp) d, COUNT(*) txs FROM `bigquery-public-data.crypto_solana_mainnet_us.Transactions` WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) GROUP BY d ORDER BY d DESC" }, // TODO: verify exact dataset id (some refs use crypto_solana, others crypto_solana_mainnet_us)
  { category: 'Blockchain', id: 'goog_blockchain_polygon_mainnet_us',
    desc: 'Polygon (MATIC) PoS mainnet — Google-curated blockchain dataset',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.goog_blockchain_polygon_mainnet_us.transactions` WHERE block_timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)" },
  { category: 'Blockchain', id: 'goog_blockchain_fantom_mainnet_us',
    desc: 'Fantom (FTM) opera mainnet — Google-curated blockchain dataset',
    example: "SELECT MAX(block_timestamp) latest FROM `bigquery-public-data.goog_blockchain_fantom_mainnet_us.blocks`" },
  { category: 'Blockchain', id: 'goog_blockchain_optimism_mainnet_us',
    desc: 'Optimism (OP) L2 mainnet — Google-curated blockchain dataset',
    example: "SELECT MAX(block_number) FROM `bigquery-public-data.goog_blockchain_optimism_mainnet_us.blocks`" },
  { category: 'Blockchain', id: 'goog_blockchain_tron_mainnet_us',
    desc: 'Tron (TRX) mainnet — Google-curated blockchain dataset',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.goog_blockchain_tron_mainnet_us.transactions` WHERE block_timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)" },
  { category: 'Blockchain', id: 'crypto_ethereum_goerli',
    desc: 'Ethereum Goerli testnet (deprecated, retained for archive lookups)',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.crypto_ethereum_goerli.blocks`" }, // TODO: dataset may have been retired post-Holesky migration
  { category: 'Blockchain', id: 'crypto_sui_mainnet_us',
    desc: 'Sui mainnet — checkpoints, transactions, events, objects',
    example: "SELECT MAX(timestamp_ms) FROM `bigquery-public-data.crypto_sui_mainnet_us.transactions`" }, // TODO: verify exact id (sometimes documented as crypto_sui)
  { category: 'Blockchain', id: 'goog_blockchain_arbitrum_one_mainnet_us',
    desc: 'Arbitrum One L2 mainnet — Google-curated blockchain dataset',
    example: "SELECT MAX(block_number) FROM `bigquery-public-data.goog_blockchain_arbitrum_one_mainnet_us.blocks`" },
  { category: 'Blockchain', id: 'crypto_multiversx_mainnet_eu',
    desc: 'MultiversX (formerly Elrond) mainnet — blocks, transactions, accounts',
    example: "SELECT MAX(timestamp) FROM `bigquery-public-data.crypto_multiversx_mainnet_eu.transactions`" }, // TODO: confirm canonical id (also seen as crypto_multiversx)
  { category: 'Blockchain', id: 'goog_blockchain_aptos_mainnet_us',
    desc: 'Aptos mainnet — Google-curated blockchain dataset',
    example: "SELECT MAX(block_height) FROM `bigquery-public-data.goog_blockchain_aptos_mainnet_us.blocks`" },
  { category: 'Blockchain', id: 'crypto_near_mainnet',
    desc: 'NEAR Protocol mainnet — blocks, transactions, receipts',
    example: "SELECT MAX(block_timestamp) FROM `bigquery-public-data.crypto_near_mainnet.blocks`" }, // TODO: occasionally listed as crypto_near_mainnet_us
  { category: 'Blockchain', id: 'goog_blockchain_cronos_mainnet_us',
    desc: 'Cronos mainnet (Crypto.com chain) — Google-curated blockchain dataset',
    example: "SELECT MAX(block_number) FROM `bigquery-public-data.goog_blockchain_cronos_mainnet_us.blocks`" },
  { category: 'Blockchain', id: 'goog_blockchain_avalanche_contract_chain_us',
    desc: 'Avalanche C-Chain (EVM contract chain) — Google-curated blockchain dataset',
    example: "SELECT MAX(block_number) FROM `bigquery-public-data.goog_blockchain_avalanche_contract_chain_us.blocks`" },
  { category: 'Blockchain', id: 'crypto_bitcoin',
    desc: 'Bitcoin mainnet — blocks, transactions, inputs, outputs (the original Google crypto dataset)',
    example: "SELECT DATE(block_timestamp) d, COUNT(*) txs FROM `bigquery-public-data.crypto_bitcoin.transactions` WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) GROUP BY d ORDER BY d DESC" },

  // Science / Bio (10)
  { category: 'Science / Bio', id: 'deepmind_alphafold',
    desc: 'AlphaFold predicted protein structures (200M+ entries with confidence scores)',
    example: "SELECT entryId, organismScientificName, sequenceLength FROM `bigquery-public-data.deepmind_alphafold.metadata` WHERE organismScientificName LIKE 'Homo sapiens%' LIMIT 10" },
  { category: 'Science / Bio', id: 'ebi_mgnify_protein',
    desc: 'EBI MGnify protein catalogues from microbiome studies',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.ebi_mgnify_protein.proteins` LIMIT 1" }, // TODO: confirm table name
  { category: 'Science / Bio', id: 'open_targets_platform',
    desc: 'Open Targets: drug-target-disease associations for therapeutic discovery',
    example: "SELECT diseaseId, COUNT(*) n FROM `bigquery-public-data.open_targets_platform.associationByOverallDirect` GROUP BY 1 ORDER BY n DESC LIMIT 10" }, // TODO: snapshot suffix (e.g. _21_06) sometimes required
  { category: 'Science / Bio', id: 'open_targets_genetics',
    desc: 'Open Targets Genetics: GWAS / variant-to-gene mappings',
    example: "SELECT chrom, COUNT(*) FROM `bigquery-public-data.open_targets_genetics.variants` GROUP BY chrom ORDER BY chrom LIMIT 25" }, // TODO: confirm table name
  { category: 'Science / Bio', id: 'idc_current',
    desc: 'NCI Imaging Data Commons — DICOM medical-image series and metadata',
    example: "SELECT collection_id, COUNT(*) n FROM `bigquery-public-data.idc_current.dicom_all` GROUP BY 1 ORDER BY n DESC LIMIT 10" },
  { category: 'Science / Bio', id: 'ncbi_pubmed_central',
    desc: 'PubMed Central full-text biomedical papers (open-access subset)',
    example: "SELECT pmid, title FROM `bigquery-public-data.ncbi_pubmed_central.articles` LIMIT 5" }, // TODO: confirm table name (may be `pmc_oa_index`)
  { category: 'Science / Bio', id: 'human_variant_annotation',
    desc: 'Annotated human genomic variants (ClinVar / dbSNP / consequence predictions)',
    example: "SELECT chromosome, COUNT(*) n FROM `bigquery-public-data.human_variant_annotation.ncbi_clinvar_hg38` GROUP BY chromosome ORDER BY chromosome LIMIT 25" }, // TODO: confirm table name
  { category: 'Science / Bio', id: 'gbif',
    desc: 'GBIF Global Biodiversity Information Facility — species occurrence records',
    example: "SELECT countryCode, COUNT(*) n FROM `bigquery-public-data.gbif.occurrences` WHERE year = 2024 GROUP BY 1 ORDER BY n DESC LIMIT 20" }, // TODO: dataset is sometimes published as `gbif_occurrence`
  { category: 'Science / Bio', id: 'modis_terra_net_primary_production',
    desc: 'NASA MODIS Terra net primary production (vegetation productivity)',
    example: "SELECT date, AVG(npp) FROM `bigquery-public-data.modis_terra_net_primary_production.MOD17A3HGF` WHERE date >= '2020-01-01' GROUP BY date ORDER BY date" }, // TODO: confirm table name
  { category: 'Science / Bio', id: 'arc_virtual_cell_atlas',
    desc: 'ARC Virtual Cell Atlas — single-cell transcriptomics + perturbations',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.arc_virtual_cell_atlas.cells` LIMIT 1" }, // TODO: confirm dataset id and table name

  // Earth / Climate (6)
  { category: 'Earth / Climate', id: 'himawari_8_9',
    desc: 'JMA Himawari-8/9 geostationary satellite imagery (Asia-Pacific)',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.himawari_8_9.full_disk` WHERE DATE(observation_time) = CURRENT_DATE()-1" }, // TODO: confirm table name
  { category: 'Earth / Climate', id: 'eumetsat',
    desc: 'EUMETSAT geostationary + polar-orbit satellite product index',
    example: "SELECT product_type, COUNT(*) n FROM `bigquery-public-data.eumetsat.products` GROUP BY 1 ORDER BY n DESC LIMIT 10" }, // TODO: confirm table name
  { category: 'Earth / Climate', id: 'ecmwf_open_data',
    desc: 'ECMWF Open Data — global numerical weather forecasts (HRES + ENS)',
    example: "SELECT param, COUNT(*) n FROM `bigquery-public-data.ecmwf_open_data.metadata` GROUP BY 1 ORDER BY n DESC LIMIT 20" }, // TODO: confirm table name
  { category: 'Earth / Climate', id: 'era5',
    desc: 'ECMWF ERA5 reanalysis — 80+ years of global hourly atmospheric data',
    example: "SELECT date, AVG(t2m) avg_t FROM `bigquery-public-data.era5.surface` WHERE date >= '2020-01-01' GROUP BY date ORDER BY date LIMIT 30" }, // TODO: confirm table name
  { category: 'Earth / Climate', id: 'noaa_gfs_anl_0p25',
    desc: 'NOAA GFS analysis 0.25-degree — global numerical weather analysis',
    example: "SELECT MAX(time) latest_run FROM `bigquery-public-data.noaa_gfs_anl_0p25.gfs_anl_0p25`" }, // TODO: confirm table name
  { category: 'Earth / Climate', id: 'esa_planck_mission',
    desc: 'ESA Planck mission cosmic microwave background catalogue + maps metadata',
    example: "SELECT COUNT(*) FROM `bigquery-public-data.esa_planck_mission.catalogue`" }, // TODO: confirm table name

  // Demographics / Reference (7)
  { category: 'Demographics / Reference', id: 'census_bureau_acs',
    desc: 'US Census ACS — population, income, housing, demographics by geography',
    example: "SELECT geo_id, total_pop FROM `bigquery-public-data.census_bureau_acs.county_2021_5yr` ORDER BY total_pop DESC LIMIT 10" }, // TODO: top-level project also exposes `census_utility`, `geo_us_boundaries`
  { category: 'Demographics / Reference', id: 'country_codes',
    desc: 'ISO country / region / currency / language reference codes',
    example: "SELECT alpha_2_code, country_name, region_name FROM `bigquery-public-data.country_codes.country_codes` LIMIT 25" },
  { category: 'Demographics / Reference', id: 'overture_maps',
    desc: 'Overture Maps Foundation — global places, buildings, transportation, admin boundaries',
    example: "SELECT names.primary, addresses[OFFSET(0)].country FROM `bigquery-public-data.overture_maps.place` WHERE addresses[OFFSET(0)].country = 'US' LIMIT 10" }, // TODO: schema slightly varies between releases
  { category: 'Demographics / Reference', id: 'mlcommons_multilingual_spoken_words_corpus',
    desc: 'MLCommons Multilingual Spoken Words Corpus — keywords + audio metadata across 50 languages',
    example: "SELECT language, COUNT(*) n FROM `bigquery-public-data.mlcommons_multilingual_spoken_words_corpus.words` GROUP BY 1 ORDER BY n DESC LIMIT 10" }, // TODO: confirm table name
  { category: 'Demographics / Reference', id: 'google_books_ngrams_2020',
    desc: 'Google Books Ngrams 2020 — n-gram counts across the Books corpus by year + language',
    example: "SELECT term, sum(term_frequency) f FROM `bigquery-public-data.google_books_ngrams_2020.eng_us_1` WHERE term IN ('AI','ML') GROUP BY term" }, // TODO: per-language sharded table names (eng_us_1, fre_all_1, ...)
  { category: 'Demographics / Reference', id: 'thelook_ecommerce',
    desc: 'TheLook synthetic e-commerce dataset (orders, products, users, web events) — useful for SQL tutorials',
    example: "SELECT category, COUNT(*) n FROM `bigquery-public-data.thelook_ecommerce.products` GROUP BY 1 ORDER BY n DESC LIMIT 10" },
  { category: 'Demographics / Reference', id: 'usa_names',
    desc: 'US Social Security Administration — first-name counts by state and year (1910–present)',
    example: "SELECT name, SUM(number) total FROM `bigquery-public-data.usa_names.usa_1910_current` WHERE gender='F' GROUP BY name ORDER BY total DESC LIMIT 10" },
];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSetup() {
  ensureDir(DATA_DIR);
  console.log('# bigquery setup\n');
  let project, token;
  if (process.env.BIGQUERY_GCP_PROJECT) {
    project = process.env.BIGQUERY_GCP_PROJECT.trim();
    console.log(`  project (from env): ${project}`);
  }
  if (process.env.BIGQUERY_ACCESS_TOKEN) {
    token = process.env.BIGQUERY_ACCESS_TOKEN.trim();
    console.log(`  token   (from env): ${maskToken(token)}`);
  }
  if (!project) {
    try {
      const out = execFileSync('gcloud', ['config','get-value','project'], { stdio:['ignore','pipe','pipe'] });
      project = String(out).trim();
      if (project && !/^\(unset\)/i.test(project)) console.log(`  project (gcloud): ${project}`);
      else { project = null; console.log('  project (gcloud): (unset) — run `gcloud config set project <id>`'); }
    } catch (e) {
      console.log(`  project: gcloud not found — install Google Cloud SDK first.`);
      console.log(`           https://cloud.google.com/sdk/docs/install`);
    }
  }
  if (!token) {
    try {
      const out = execFileSync('gcloud', ['auth','application-default','print-access-token'], { stdio:['ignore','pipe','pipe'] });
      token = String(out).trim();
      console.log(`  token   (gcloud): ${maskToken(token)}`);
    } catch (e) {
      const msg = (e.stderr ? String(e.stderr) : e.message).split('\n')[0];
      console.log(`  token: could not fetch — ${msg}`);
      console.log(`         run: gcloud auth application-default login`);
    }
  }
  const expires_at = token ? new Date(Date.now() + 55*60*1000).toISOString() : null;
  if (project || token) {
    saveJson(AUTH_FILE, { project: project || null, token: token || null, token_expires_at: expires_at });
    console.log(`\n  wrote: ${AUTH_FILE}`);
    if (expires_at) console.log(`  token expires_at (estimated): ${expires_at}`);
  }
  if (!project || !token) {
    console.log(`\n  Onboarding (3 steps):`);
    console.log(`    1) gcloud init`);
    console.log(`    2) gcloud auth application-default login`);
    console.log(`    3) gcloud config set project <PROJECT_ID>`);
    console.log(`    then re-run: bigquery.mjs setup`);
    process.exit(1);
  }
  console.log(`\n  ok — try: bigquery.mjs query "SELECT 1 AS ok"`);
}

async function cmdQuery(sql, opts={}) {
  if (!sql) throw new Error('Usage: query "<SQL>" [--limit=100] [--location=US] [--dry-run] [--format=table|json|csv]');
  const limit = opts.limit ?? 100;
  const fmt = (opts.format || 'table').toLowerCase();
  // Auto-append LIMIT if user didn't supply one (and not dry-run)
  let q = sql;
  if (!opts.dryRun && !/\blimit\b/i.test(q)) q = `${q.replace(/;\s*$/,'')} LIMIT ${limit}`;
  console.log(`# bigquery query  (limit=${limit}${opts.dryRun ? ', dry-run' : ''})\n`);
  const json = await bqQuery(q, { maxResults: limit, location: opts.location, dryRun: !!opts.dryRun, timeoutMs: 60_000 });
  const cachedAt = nowIso();
  const cacheFile = resolve(CACHE_DIR, `query-${slug(q).slice(0,40)}-${Date.now()}.json`);
  saveJson(cacheFile, { _meta: { cached_at: cachedAt, sql: q }, ...json });

  if (opts.dryRun) {
    const bytes = json.totalBytesProcessed ?? json.statistics?.totalBytesProcessed ?? json.statistics?.query?.totalBytesProcessed;
    console.log(`  Dry run — query is valid.`);
    console.log(`  Bytes processed (estimate): ${fmtBytes(bytes)}`);
    console.log(`  Cached: ${cacheFile}`);
    return;
  }

  const { fields, rows } = rowsFromBQResult(json);
  const bytes = json.totalBytesProcessed;
  const cacheHit = json.cacheHit === true ? 'yes' : (json.cacheHit === false ? 'no' : '?');
  console.log(`  Rows: ${rows.length}  (totalRows=${json.totalRows ?? '?'})`);
  console.log(`  Bytes processed: ${fmtBytes(bytes)}`);
  console.log(`  Cache hit: ${cacheHit}`);
  console.log(`  Cached at: ${cachedAt}`);
  console.log(`  Cached: ${cacheFile}\n`);

  if (fmt === 'json') console.log(JSON.stringify(rows, null, 2));
  else if (fmt === 'csv') console.log(renderCSV(fields, rows));
  else console.log(renderTable(fields, rows));
}

async function cmdDatasets(opts={}) {
  const project = opts.project || PUBLIC_PROJECT;
  console.log(`# bigquery datasets — project=${project}\n`);
  const all = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams();
    qs.set('maxResults', '1000');
    if (pageToken) qs.set('pageToken', pageToken);
    const json = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets?${qs}`);
    for (const d of (json.datasets || [])) all.push(d);
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  saveJson(resolve(CACHE_DIR, `datasets-${slug(project)}.json`), { project, datasets: all, fetched_at: nowIso() });
  console.log(`  ${all.length} datasets\n`);
  const fields = ['datasetId', 'location', 'kind'];
  const rows = all.map(d => ({
    datasetId: d.datasetReference?.datasetId,
    location: d.location || '',
    kind: d.kind || '',
  }));
  console.log(renderTable(fields, rows));
}

function parseQualified(qn, expected) {
  // Accept project.dataset[.table] OR (for dataset commands) just `dataset` (defaulting to public-data project).
  if (!qn) throw new Error(`Usage: provide a qualified name like \`project.dataset${expected==='table'?'.table':''}\``);
  const parts = qn.split('.');
  if (expected === 'dataset') {
    if (parts.length === 1) return { project: PUBLIC_PROJECT, datasetId: parts[0] };
    if (parts.length === 2) return { project: parts[0], datasetId: parts[1] };
  }
  if (expected === 'table') {
    if (parts.length === 2) return { project: PUBLIC_PROJECT, datasetId: parts[0], tableId: parts[1] };
    if (parts.length === 3) return { project: parts[0], datasetId: parts[1], tableId: parts[2] };
  }
  throw new Error(`Bad qualified name '${qn}' — expected ${expected==='dataset' ? 'project.dataset' : 'project.dataset.table'} (or shorthand without project, defaults to ${PUBLIC_PROJECT}).`);
}

async function cmdDataset(qn) {
  const { project, datasetId } = parseQualified(qn, 'dataset');
  console.log(`# bigquery dataset — ${project}.${datasetId}\n`);
  const meta = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}`);
  // List tables (paginate) for count + total size
  const tables = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams();
    qs.set('maxResults', '1000');
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables?${qs}`);
    for (const t of (j.tables || [])) tables.push(t);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  saveJson(resolve(CACHE_DIR, `dataset-${slug(project)}.${slug(datasetId)}.json`), { meta, tables, fetched_at: nowIso() });

  console.log(`  description: ${meta.description || '(none)'}`);
  console.log(`  location:    ${meta.location || ''}`);
  console.log(`  created:     ${meta.creationTime ? new Date(Number(meta.creationTime)).toISOString() : ''}`);
  console.log(`  modified:    ${meta.lastModifiedTime ? new Date(Number(meta.lastModifiedTime)).toISOString() : ''}`);
  console.log(`  labels:      ${meta.labels ? JSON.stringify(meta.labels) : '(none)'}`);
  console.log(`  tables:      ${tables.length}`);
  // tables list endpoint has no size — we'd need per-table calls. Skip total size to keep one round-trip.
  console.log(`\n  (use \`bigquery.mjs tables ${project}.${datasetId}\` to list tables with size + row counts)`);
}

async function cmdTables(qn, opts={}) {
  const { project, datasetId } = parseQualified(qn, 'dataset');
  const limit = opts.limit ?? 50;
  console.log(`# bigquery tables — ${project}.${datasetId}  (limit=${limit})\n`);
  // List tables, then enrich up to `limit` of them with detail (size + numRows).
  const all = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams();
    qs.set('maxResults', '1000');
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables?${qs}`);
    for (const t of (j.tables || [])) all.push(t);
    pageToken = j.nextPageToken || '';
  } while (pageToken);

  const subset = all.slice(0, limit);
  const detailed = await Promise.all(subset.map(async (t) => {
    const tid = t.tableReference?.tableId;
    try {
      const meta = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tid)}`);
      return { tableId: tid, type: meta.type || t.type, numRows: meta.numRows, numBytes: meta.numBytes, partitioning: meta.timePartitioning?.field || meta.rangePartitioning?.field || '' };
    } catch (e) {
      return { tableId: tid, type: t.type || '', numRows: '', numBytes: '', partitioning: '', error: e.message.slice(0,80) };
    }
  }));
  saveJson(resolve(CACHE_DIR, `tables-${slug(project)}.${slug(datasetId)}.json`), { project, datasetId, tables: detailed, total: all.length, fetched_at: nowIso() });

  console.log(`  ${detailed.length} of ${all.length} tables shown\n`);
  const fields = ['tableId','type','rows','size','partition'];
  const rows = detailed.map(d => ({
    tableId: d.tableId,
    type: d.type || '',
    rows: d.numRows ? fmtNum(d.numRows) : '',
    size: d.numBytes ? fmtBytes(d.numBytes) : '',
    partition: d.partitioning || '',
  }));
  console.log(renderTable(fields, rows));
}

async function cmdSchema(qn) {
  const { project, datasetId, tableId } = parseQualified(qn, 'table');
  console.log(`# bigquery schema — ${project}.${datasetId}.${tableId}\n`);
  const meta = await bqFetch(`/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`);
  saveJson(resolve(CACHE_DIR, `schema-${slug(project)}.${slug(datasetId)}.${slug(tableId)}.json`), { meta, fetched_at: nowIso() });
  console.log(`  description: ${meta.description || '(none)'}`);
  console.log(`  type:        ${meta.type || ''}`);
  console.log(`  rows:        ${meta.numRows ? fmtNum(meta.numRows) : '?'}`);
  console.log(`  size:        ${meta.numBytes ? fmtBytes(meta.numBytes) : '?'}`);
  if (meta.timePartitioning) console.log(`  partitioning: time on ${meta.timePartitioning.field || '_PARTITIONTIME'} (${meta.timePartitioning.type || 'DAY'})`);
  if (meta.rangePartitioning) console.log(`  partitioning: range on ${meta.rangePartitioning.field}`);
  if (meta.clustering)        console.log(`  clustered on: ${(meta.clustering.fields || []).join(', ')}`);
  console.log(`\n  fields:`);
  const fields = meta.schema?.fields || [];
  function printField(f, indent='    ') {
    const desc = f.description ? ` — ${f.description}` : '';
    console.log(`${indent}${f.name} (${f.type}, ${f.mode || 'NULLABLE'})${desc}`);
    if (f.fields) for (const sub of f.fields) printField(sub, indent + '  ');
  }
  for (const f of fields) printField(f);
  if (!fields.length) console.log(`    (no fields — view or external?)`);
}

async function cmdSample(qn, opts={}) {
  const { project, datasetId, tableId } = parseQualified(qn, 'table');
  const n = Number(opts.n || 5);
  const sql = `SELECT * FROM \`${project}.${datasetId}.${tableId}\` LIMIT ${n}`;
  console.log(`# bigquery sample — ${project}.${datasetId}.${tableId}  (n=${n})\n  SQL: ${sql}\n`);
  const json = await bqQuery(sql, { maxResults: n });
  const cacheFile = resolve(CACHE_DIR, `sample-${slug(project)}.${slug(datasetId)}.${slug(tableId)}-n${n}.json`);
  saveJson(cacheFile, { _meta: { cached_at: nowIso(), sql }, ...json });
  const { fields, rows } = rowsFromBQResult(json);
  console.log(`  Rows: ${rows.length}`);
  console.log(`  Bytes processed: ${fmtBytes(json.totalBytesProcessed)}`);
  console.log(`  Cache hit: ${json.cacheHit ? 'yes' : 'no'}`);
  console.log(`  Cached: ${cacheFile}\n`);
  console.log(renderTable(fields, rows));
}

function cmdPublicDatasets() {
  console.log(`# BigQuery Public Datasets — curated catalogue (${PUBLIC_DATASETS.length} entries)\n`);
  console.log(`  All datasets live in project \`${PUBLIC_PROJECT}\`.`);
  console.log(`  Qualified-name pattern: \`${PUBLIC_PROJECT}.<dataset>.<table>\``);
  console.log(`  Querying any of these still uses your *billing* project (set via \`gcloud config set project\`).\n`);
  const cats = [...new Set(PUBLIC_DATASETS.map(d => d.category))];
  for (const c of cats) {
    const entries = PUBLIC_DATASETS.filter(d => d.category === c);
    console.log(`## ${c}  (${entries.length})\n`);
    for (const e of entries) {
      console.log(`  - ${e.id}`);
      console.log(`      ${e.desc}`);
      console.log(`      example:`);
      console.log(`        ${e.example}`);
      console.log('');
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const out = { positional: [] };
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.replace(/-/g, '');
      out[key] = v ?? true;
    } else out.positional.push(a);
  }
  if (out.limit) out.limit = parseInt(out.limit, 10);
  if (out.n)     out.n     = parseInt(out.n, 10);
  return out;
}

function usage() {
  console.log(`Usage:
  bigquery.mjs setup
  bigquery.mjs query "<SQL>" [--limit=100] [--location=US] [--dry-run] [--format=table|json|csv]
  bigquery.mjs datasets [--project=bigquery-public-data]
  bigquery.mjs dataset <project>.<dataset>                 # or just <dataset> (defaults to bigquery-public-data)
  bigquery.mjs tables  <project>.<dataset> [--limit=50]
  bigquery.mjs schema  <project>.<dataset>.<table>
  bigquery.mjs sample  <project>.<dataset>.<table> [--n=5]
  bigquery.mjs public-datasets
  bigquery.mjs help

Auth (one-time):
  gcloud init
  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>
  bigquery.mjs setup

Env overrides:
  BIGQUERY_GCP_PROJECT       — billing project id (else gcloud config)
  BIGQUERY_ACCESS_TOKEN      — bearer token (else gcloud ADC)

Public-data project: ${PUBLIC_PROJECT}
Data dir:            ${DATA_DIR}
`);
}

async function main() {
  ensureDir(CACHE_DIR);
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'setup':            await cmdSetup(); break;
      case 'query':            await cmdQuery(flags.positional[0], flags); break;
      case 'datasets':         await cmdDatasets(flags); break;
      case 'dataset':          await cmdDataset(flags.positional[0]); break;
      case 'tables':           await cmdTables(flags.positional[0], flags); break;
      case 'schema':           await cmdSchema(flags.positional[0]); break;
      case 'sample':           await cmdSample(flags.positional[0], flags); break;
      case 'public-datasets':  cmdPublicDatasets(); break;
      case undefined:
      case 'help':
      case '-h':
      case '--help':           usage(); break;
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
