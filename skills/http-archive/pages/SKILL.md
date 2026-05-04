---
name: http-archive-pages
description: "HTTP Archive (httparchive.org) data — monthly crawl of ~12M sites covering page weight, request counts, JS/CSS bytes, Lighthouse scores, Wappalyzer-detected tech stacks, and Web Almanac analysis. Wraps BigQuery's public `httparchive.*` dataset (per-page metrics, per-request metrics, technologies, Lighthouse) plus the public dashboard JSON endpoints."
---

# http-archive-pages

HTTP Archive (httparchive.org) data — monthly crawl of ~12M sites covering page weight, request counts, JS/CSS bytes, Lighthouse scores, Wappalyzer-detected tech stacks, and Web Almanac analysis. Wraps BigQuery's public `httparchive.*` dataset (per-page metrics, per-request metrics, technologies, Lighthouse) plus the public dashboard JSON endpoints.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- `gcloud` CLI installed and a Google Cloud project (BigQuery sandbox: 1 TB/month free queries + 10 GB free storage)

## Setup

HTTP Archive lives in BigQuery. Querying it needs a Google Cloud project and an OAuth2 access token sent as `Authorization: Bearer <token>`.

One-time onboarding:

```bash
gcloud init                                # pick or create a GCP project
gcloud auth application-default login      # browser OAuth
gcloud config set project <PROJECT_ID>     # set default project
```

Then:

```bash
node scripts/http-archive.mjs setup        # populates ~/.local/share/showrun/data/http-archive/auth.json
```

**Token lifetime.** `gcloud` access tokens expire after ~1 hour. Re-run `setup` when you hit `401`. The script stores an estimated `token_expires_at` in `auth.json`.

**Env override:** set `HTTP_ARCHIVE_GCP_PROJECT` and `HTTP_ARCHIVE_ACCESS_TOKEN` to bypass the file (useful for CI / service accounts).

## Usage

```bash
# Auth bootstrap
node scripts/http-archive.mjs setup

# Arbitrary BigQuery SQL (LIMIT auto-appended if missing)
node scripts/http-archive.mjs query "SELECT 1 AS ok"
node scripts/http-archive.mjs query "SELECT date, COUNT(*) AS pages FROM \`httparchive.crawl.pages\` WHERE date = DATE '2026-03-01' AND client = 'mobile' GROUP BY date" --limit=10

# Per-URL summary (latest crawl)
node scripts/http-archive.mjs page https://itch.io
node scripts/http-archive.mjs page https://store.steampowered.com --device=desktop --month=2026-03

# Wappalyzer tech stack for one site
node scripts/http-archive.mjs tech https://itch.io
node scripts/http-archive.mjs tech https://newgrounds.com --month=2026-03

# Most-adopted technologies in a category
node scripts/http-archive.mjs top-tech --category=Analytics --limit=20
node scripts/http-archive.mjs top-tech --category="Tag managers" --month=2026-03
node scripts/http-archive.mjs top-tech                    # all categories, top 50

# Multi-month time series — give a SELECT clause + WHERE filter
node scripts/http-archive.mjs trend "AVG(SAFE_CAST(JSON_VALUE(summary,'$.bytesTotal') AS INT64)) AS avg_bytes" "client = 'mobile'" --months=12

# Public pre-aggregated dashboard JSON (no auth required)
node scripts/http-archive.mjs report bytesTotal           # global p10/p25/p50/p75/p90 timeseries
node scripts/http-archive.mjs report top1k/bytesJs        # lens-prefixed: top-1k sites only
node scripts/http-archive.mjs report fcp                  # Web Vitals: First Contentful Paint
node scripts/http-archive.mjs report wordpress/bytesTotal # CMS-lens: WordPress sites only

node scripts/http-archive.mjs help
```

`--device` accepts `mobile` or `desktop` (default mobile — the larger crawl).
`--month` is `YYYY-MM` or `YYYY-MM-DD`; the crawl runs on the 1st of each month.
`--category` accepts any Wappalyzer category: `Analytics`, `Tag managers`, `JavaScript frameworks`, `CMS`, `CDN`, `Ecommerce`, `Hosting`, etc.

## Output format

```
# http-archive page — https://itch.io  (device=mobile, month=latest)

  date:           2026-03-01
  client:         mobile
  page:           https://itch.io/
  bytes_total:    1.2 MB
  req_total:      42
  bytes_img:      812 KB (18 reqs)
  bytes_js:       290 KB (8 reqs)
  bytes_css:      48 KB (3 reqs)
  ...

# http-archive top-tech  (month=latest, category=Analytics, limit=20)

  bytesProcessed: 4.3 GB

| technology       | categories  | sites    |
| ---------------- | ----------- | -------- |
| Google Analytics | Analytics   | 6,841,002 |
| Hotjar           | Analytics   |   421,107 |
| ...
```

For `tech`, output is grouped by client → Wappalyzer category → technology name.

## Data layout

All state under `~/.local/share/showrun/data/http-archive/`:

- `auth.json` — `{project, token, token_expires_at}` (token redacted from prints)
- `cache/query-<slug>-<ts>.json` — every `query` invocation (full BQ response)
- `cache/page-<url-slug>-<device>-<month>.json` — per `page`
- `cache/tech-<url-slug>-<month>.json` — per `tech`
- `cache/top-tech-<category>-<month>.json` — per `top-tech`
- `cache/trend-<select-slug>-<n>mo.json` — per `trend`
- `cache/report-<id>.json` — per `report` (public dashboard JSON)

## Key tables

| Table | Description | Partition |
|---|---|---|
| `httparchive.crawl.pages` | Newer schema, one row per page-crawl. `summary` is JSON. | `date` (DATE) |
| `httparchive.crawl.requests` | Newer schema, one row per HTTP request. | `date` (DATE) |
| `httparchive.summary_pages.YYYY_MM_DD_(mobile\|desktop)` | Legacy per-month tables, flat columns | none — sharded |
| `httparchive.summary_requests.YYYY_MM_DD_*` | Legacy per-request | none — sharded |
| `httparchive.lighthouse.YYYY_MM_DD_*` | Lighthouse audit JSON per page | sharded |
| `httparchive.technologies.technologies` | Wappalyzer detections per (date, url, app) | `date` (DATE) |
| `httparchive.almanac.*` | Web Almanac annual analysis tables | varies |

**Prefer `crawl.*` over `summary_*` for new queries** — it's partitioned (cheaper) and unified across mobile/desktop. The `summary` field is JSON; access fields with `JSON_VALUE(summary, '$.bytesTotal')` and cast.

## API notes

- **BigQuery REST endpoint:** `POST https://bigquery.googleapis.com/bigquery/v2/projects/<your-project>/queries`
- Body: `{"query": "SELECT ...", "useLegacySql": false, "timeoutMs": 30000, "maxResults": 1000}`
- Response shape: `{rows: [{f: [{v: "..."}, ...]}], schema: {fields: [{name,type}, ...]}, totalBytesProcessed: "...", totalRows: "..."}`.
- **`useLegacySql: false` is required** — standard SQL only.
- **`timeoutMs: 30000`** is the default. Heavy queries can hit the timeout — narrow the date range or add `LIMIT`.
- **Public dashboard JSON:** `GET https://cdn.httparchive.org/v1/static/reports/[<lens>/]<metric>.json` — pre-aggregated p10/p25/p50/p75/p90 timeseries. **No auth required.** Pattern is **camelCase metric IDs** (`bytesTotal`, `bytesJs`, `fcp`, `lcp`, `inp`, `cls`, `ttfb`...). Optional lens prefix: `top1k`, `top10k`, `top100k`, `top1m`, `wordpress`, `drupal`, `magento`.

## Known pitfalls

- **Billing required.** Even though the data is public, BigQuery returns `billing not enabled` until your project has either a billing account attached or sandbox mode enabled. Enable sandbox by visiting [console.cloud.google.com/bigquery](https://console.cloud.google.com/bigquery) once with the project selected.
- **Query cost.** A naive `SELECT * FROM crawl.pages` scans ~3 TB. Always include `WHERE date = ...` and project only the columns you need.
- **Token expiry.** gcloud ADC tokens last ~1 hour. Re-run `setup` if you see `401`.
- **Sharded vs partitioned tables.** `summary_pages.YYYY_MM_DD_*` are *table shards* — the `*` in the name is a wildcard, not a partition column.
- **`summary` JSON format varies.** Keys inside `crawl.pages.summary` come from WebPageTest output and have changed historically.
- **URL canonicalisation.** HTTP Archive stores the page URL exactly as crawled — usually with a trailing slash and `https://` prefix.
- **Public reports = aggregates only.** For per-URL drilldown you must query BigQuery.
