---
name: bigquery-sql
description: "Query Google BigQuery — generic SQL access to any project the user can read, with first-class shortcuts for the 42 BigQuery Public Datasets (project `bigquery-public-data`). Wraps the BigQuery REST API: queries, dataset / table / schema metadata, row sampling, dry-run cost estimates."
---

# bigquery-sql

Query Google BigQuery — generic SQL access to any project the user can read, with first-class shortcuts for the 42 BigQuery Public Datasets (project `bigquery-public-data`). Wraps the BigQuery REST API: queries, dataset / table / schema metadata, row sampling, dry-run cost estimates.

Covers Google Trends, Google Ads Transparency, Ethereum / Solana / Polygon / Optimism / Arbitrum / Aptos / NEAR / Avalanche / Cronos / Fantom / Tron / Sui / MultiversX, AlphaFold, Open Targets, IDC medical imaging, GBIF biodiversity, ERA5 / ECMWF / Himawari / NOAA GFS climate, US Census ACS, Overture Maps, Google Books Ngrams, USA names.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- `gcloud` CLI installed and a Google Cloud project (free; BigQuery sandbox grants 1 TB/month free queries + 10 GB free storage)

## Setup

BigQuery requires a Google Cloud project and an OAuth2 access token sent as `Authorization: Bearer <token>`.

One-time onboarding (3 steps):

```bash
gcloud init                                # pick or create a GCP project
gcloud auth application-default login      # browser OAuth — opens a tab
gcloud config set project <PROJECT_ID>     # set default billing project
```

Then:

```bash
node scripts/bigquery.mjs setup            # writes ~/.local/share/showrun/data/bigquery/auth.json
```

**Token lifetime.** gcloud ADC tokens expire after ~1 hour. Re-run `setup` when you hit `401`. The script stores `token_expires_at` in `auth.json`.

**Env override.** Set `BIGQUERY_GCP_PROJECT` and `BIGQUERY_ACCESS_TOKEN` to bypass the file (useful for CI / service accounts).

## Usage

```bash
# Auth bootstrap
node scripts/bigquery.mjs setup

# Arbitrary standard SQL — LIMIT auto-appended if missing
node scripts/bigquery.mjs query "SELECT 1 AS ok"
node scripts/bigquery.mjs query "SELECT term, score FROM \`bigquery-public-data.google_trends.top_terms\` WHERE refresh_date = (SELECT MAX(refresh_date) FROM \`bigquery-public-data.google_trends.top_terms\`) AND rank=1 LIMIT 1"
node scripts/bigquery.mjs query "SELECT 1" --dry-run                  # validate + bytes-processed estimate
node scripts/bigquery.mjs query "SELECT 1" --format=json              # rows-as-JSON instead of table
node scripts/bigquery.mjs query "SELECT 1" --format=csv               # rows-as-CSV
node scripts/bigquery.mjs query "..." --location=EU                   # for EU-region datasets

# Dataset / table introspection
node scripts/bigquery.mjs datasets                                    # list public datasets
node scripts/bigquery.mjs datasets --project=my-own-proj              # other project
node scripts/bigquery.mjs dataset bigquery-public-data.google_trends  # one dataset's metadata
node scripts/bigquery.mjs dataset google_trends                       # shorthand → public-data
node scripts/bigquery.mjs tables  bigquery-public-data.google_trends [--limit=50]
node scripts/bigquery.mjs schema  bigquery-public-data.google_trends.top_terms
node scripts/bigquery.mjs sample  bigquery-public-data.google_trends.top_terms [--n=5]

# Curated catalogue of every public dataset in the program (no auth needed)
node scripts/bigquery.mjs public-datasets

node scripts/bigquery.mjs help
```

`--limit=N` caps both the SQL `LIMIT` clause (if not present) and the `maxResults` REST page size.
`--dry-run` returns the bytes-processed estimate without executing — **always run a dry-run first against unfamiliar tables** to avoid blowing the 1 TB/month free tier.
`--location=US|EU|...` is required for some EU-region datasets (e.g. ECMWF / EUMETSAT public datasets live in EU).

## Public datasets — qualified-name pattern

Every public dataset lives under `bigquery-public-data`. Refer to a table as:

```
bigquery-public-data.<dataset>.<table>
```

Even when querying public data, **the billing project is the one in `auth.json`** (i.e. yours). It must have BigQuery API enabled and either sandbox mode active or a billing account attached.

The full catalogue (42 entries) is grouped into 6 categories. Run `bigquery.mjs public-datasets` for the canonical list with example queries; the categories are:

- **Advertising / Marketing** (2) — `google_ads_transparency_center`, `google_trends`
- **Web / Open Source** (2) — `libraries_io` (deps.dev), `sigstore_rekor`
- **Blockchain** (15) — `crypto_bitcoin`, `crypto_ethereum`, `crypto_solana_mainnet_us`, `goog_blockchain_polygon_mainnet_us`, `goog_blockchain_fantom_mainnet_us`, `goog_blockchain_optimism_mainnet_us`, `goog_blockchain_tron_mainnet_us`, `crypto_ethereum_goerli`, `crypto_sui_mainnet_us`, `goog_blockchain_arbitrum_one_mainnet_us`, `crypto_multiversx_mainnet_eu`, `goog_blockchain_aptos_mainnet_us`, `crypto_near_mainnet`, `goog_blockchain_cronos_mainnet_us`, `goog_blockchain_avalanche_contract_chain_us`
- **Science / Bio** (10) — `deepmind_alphafold`, `ebi_mgnify_protein`, `open_targets_platform`, `open_targets_genetics`, `idc_current`, `ncbi_pubmed_central`, `human_variant_annotation`, `gbif`, `modis_terra_net_primary_production`, `arc_virtual_cell_atlas`
- **Earth / Climate** (6) — `himawari_8_9`, `eumetsat`, `ecmwf_open_data`, `era5`, `noaa_gfs_anl_0p25`, `esa_planck_mission`
- **Demographics / Reference** (7) — `census_bureau_acs`, `country_codes`, `overture_maps`, `mlcommons_multilingual_spoken_words_corpus`, `google_books_ngrams_2020`, `thelook_ecommerce`, `usa_names`

A handful of dataset IDs above are best-guess (Google's docs occasionally drift between e.g. `crypto_solana` and `crypto_solana_mainnet_us`). Use `bigquery.mjs datasets` against `bigquery-public-data` to discover the canonical ID if a query 404s.

## Output format

```
# bigquery query  (limit=100)

  Rows: 1  (totalRows=1)
  Bytes processed: 0 B
  Cache hit: yes
  Cached at: 2026-04-26T22:31:00.123Z
  Cached: ~/.local/share/showrun/data/bigquery/cache/query-select-1-as-ok-1745700000000.json

| ok |
| -- |
| 1  |
```

`schema` renders fields as `name (type, mode) — description` lines (recurses into RECORDs). `tables` shows tableId / type / row count / size / partition column. `public-datasets` groups all 42 entries under their category headings with id + one-liner + ready-to-paste example query.

## Data layout

All state under `~/.local/share/showrun/data/bigquery/`:

- `auth.json` — `{project, token, token_expires_at}` (token redacted in prints)
- `cache/query-<sql-slug>-<ts>.json` — every `query` invocation (full BQ response + `_meta.cached_at`)
- `cache/datasets-<project>.json` — per `datasets` invocation
- `cache/dataset-<project>.<dataset>.json` — per `dataset` invocation
- `cache/tables-<project>.<dataset>.json` — per `tables` invocation
- `cache/schema-<project>.<dataset>.<table>.json` — per `schema` invocation
- `cache/sample-<project>.<dataset>.<table>-n<N>.json` — per `sample` invocation

## API notes

- **Base URL:** `https://bigquery.googleapis.com/bigquery/v2`
- **Submit query:** `POST /projects/{billingProject}/queries` with `{"query": "...", "useLegacySql": false, "timeoutMs": 60000, "maxResults": N, "location": "US"}`.
- **Long queries:** if `jobComplete: false`, the script polls `GET /projects/{p}/jobs/{jobId}/queryResults?location=...` every 2s for up to 60s before giving up.
- **Pagination:** `nextPageToken` on the same `queryResults` endpoint. The current script returns only the first page.
- **Metadata:** `GET /projects/{p}/datasets`, `/datasets/{id}`, `/datasets/{id}/tables`, `/datasets/{id}/tables/{tid}`.
- **`useLegacySql: false` is REQUIRED** — standard SQL only.
- **Numeric types as strings.** BigQuery returns INT64 / NUMERIC as strings to preserve precision.

## Known pitfalls

- **Billing required even for public data.** Public datasets are free to *read* but BigQuery still charges your project for *bytes scanned*. Your project must have either a billing account attached or BigQuery sandbox mode enabled.
- **Bytes-processed is the #1 cost footgun.** A naive `SELECT * FROM bigquery-public-data.crypto_ethereum.transactions` scans hundreds of GB. **Always:**
  1. `bigquery.mjs schema <table>` first to read partition info.
  2. `bigquery.mjs query "..." --dry-run` to see the byte estimate.
  3. Then run for real with the partition column in `WHERE` and only the columns you need.
- **Cache hit = $0.** Re-running an identical query within the past 24h returns instantly with `cacheHit: true` and zero billed bytes.
- **Token expiry.** gcloud ADC tokens last ~1 hour. Re-run `setup` if you see `401`.
- **Long queries.** `timeoutMs` is capped server-side at 60s. For multi-minute queries, narrow the partition predicate or add `LIMIT`.
- **EU-region datasets.** Pass `--location=EU` for ECMWF / EUMETSAT / MultiversX EU; otherwise queries 404 with `Not found: Dataset ... in location US`.
- **Dataset ID drift.** Some blockchain / science datasets have been renamed (e.g. `crypto_solana` → `crypto_solana_mainnet_us`).
- **`bigquery-public-data` is read-only** — materialise intermediate results into your own project.
- **Pagination cap.** Current script returns the first `--limit` rows only.
