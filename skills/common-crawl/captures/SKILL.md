---
name: common-crawl-captures
description: "Common Crawl data — index lookup of any URL across the public web crawl corpus, capture counts as a coverage / freshness signal, distinct-URL counts per domain, raw WARC record retrieval. Free, no auth, public CDX-style index API at `index.commoncrawl.org`. Useful for SEO research, dataset building, and tracking how / whether the open web has indexed a given URL or domain."
---

# common-crawl-captures

Common Crawl data — index lookup of any URL across the public web crawl corpus, capture counts as a coverage / freshness signal, distinct-URL counts per domain, raw WARC record retrieval. Free, no auth, public CDX-style index API at `index.commoncrawl.org`. Useful for SEO research, dataset building, and tracking how / whether the open web has indexed a given URL or domain.

Common Crawl publishes a new web crawl every few weeks (named `CC-MAIN-YYYY-WW`); each crawl has its own CDX-style index server. A query returns NDJSON capture records — one per (URL, snapshot) pair — which can be turned into per-crawl capture counts (coverage signal), distinct URL counts per domain (rough site-size proxy), and per-record WARC offsets (so you can fetch the raw HTML for any captured page).

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. The Common Crawl index and `data.commoncrawl.org` WARC store are fully public. The script self-throttles to 1.5 s between requests and retries 3 times with exponential backoff (3 / 6 / 12 s) on 429 / 503 / 504.

## Usage

```bash
# List the latest N crawls (default 10), newest first
node scripts/common-crawl.mjs crawls 5

# Search a URL inside a single crawl (defaults to the latest crawl)
node scripts/common-crawl.mjs search https://itch.io/games --match=prefix --limit=50
node scripts/common-crawl.mjs search itch.io --crawl=CC-MAIN-2025-30 --match=domain
node scripts/common-crawl.mjs search https://kay-yu.itch.io/holocure --match=exact

# Latest-crawl summary for a URL (page-count + approx capture count + 5 sample rows)
node scripts/common-crawl.mjs latest itch.io --match=domain
node scripts/common-crawl.mjs latest https://kay-yu.itch.io/holocure

# Captures across the last N crawls (growth / coverage timeline, ASCII bars)
node scripts/common-crawl.mjs history kay-yu.itch.io/holocure --limit-crawls=10
node scripts/common-crawl.mjs history itch.io --match=domain --limit-crawls=10

# Approximate distinct-URL count for *.<domain> in the latest crawl
node scripts/common-crawl.mjs domain-count itch.io

# Fetch a raw WARC record (gzipped) by its index pointer; output is base64
node scripts/common-crawl.mjs fetch CC-MAIN-2025-30 \
  crawl-data/CC-MAIN-2025-30/segments/.../warc/CC-MAIN-…warc.gz \
  123456789 23456
```

## Match modes (`--match=`)

| Mode | What it matches |
|---|---|
| `exact` (default) | exactly the URL |
| `prefix` | URL prefix — `itch.io/games` matches `itch.io/games/free`, `itch.io/games/top` |
| `host` | same host (any path) |
| `domain` | same registered domain + all subdomains |

For `host` / `domain`, pass a bare hostname (`itch.io`); the script strips any scheme.

## Output format

```
# Common Crawl — latest 5 crawls
  id                    approx-date   name
  ------------------------------------------------------------------------------
  CC-MAIN-2026-13       2026-04-02    Common Crawl, March/April 2026
  CC-MAIN-2026-09       2026-02-26    Common Crawl, February 2026
  ...

# Common Crawl latest — itch.io  (crawl=CC-MAIN-2026-13, match=domain)
   pages: 4  (pageSize=5)
   approx captures: 18

# Common Crawl history — kay-yu.itch.io/holocure  (match=exact, last 10 crawls)
   CC-MAIN-2025-26  (2025-06-25)         3  ###############
   CC-MAIN-2025-30  (2025-07-23)         5  ##########################
   CC-MAIN-2025-38  (2025-09-17)         8  ########################################
   ...
```

## Data layout

All state under `~/.local/share/showrun/data/common-crawl/cache/`:

- `collinfo.json` — last `collinfo.json` fetch (1 h TTL)
- `crawls-<N>.json` — last `crawls` invocation
- `search-<crawlId>-<url-slug>-<match>-<limit>.json`
- `latest-<crawlId>-<url-slug>-<match>.json`
- `history-<url-slug>-<match>-<N>.json`
- `domain-count-<domain-slug>-<crawlId>.json`
- `warc-<crawlId>-<filename-slug>-<offset>-<length>.gz` — raw gzipped WARC slice from `fetch`

## API notes

- **Crawl list**: `GET https://index.commoncrawl.org/collinfo.json` returns `[{id, name, timegate, "cdx-api"}, ...]` newest-first. Each `id` looks like `CC-MAIN-2026-13`.
- **Per-crawl index**: `GET https://index.commoncrawl.org/<id>-index?url=<url>&output=json` returns **NDJSON** (one JSON object per line). Fields: `urlkey, timestamp, url, mime, mime-detected, status, digest, length, offset, filename, languages, encoding`.
- **Pagination**: `&pageSize=N&page=K` and `&showNumPages=true` (returns `{pages, pageSize, blocks}`).
- **Match types**: `&matchType=exact|prefix|host|domain`.
- **Date range**: `&from=YYYYMMDDHHMMSS&to=YYYYMMDDHHMMSS` (14-digit UTC).
- **WARC fetch**: records point into `s3://commoncrawl/<filename>`, mirrored at `https://data.commoncrawl.org/<filename>`. Use `Range: bytes=<offset>-<offset+length-1>`. The `fetch` command returns base64 of the gzipped bytes.
- **Reference**: <https://index.commoncrawl.org/> · <https://commoncrawl.org/get-started>

## Known pitfalls

- **`index.commoncrawl.org` 503s.** Especially the larger / older crawls during peak hours. Throttled 1.5 s between calls, retries 3× with backoff (3 / 6 / 12 s). Long scans will be slow on purpose.
- **NDJSON, not JSON array.** Each line is a record.
- **`showNumPages=true` returns a single JSON object** (`{pages, pageSize, blocks}`), not NDJSON.
- **Approximate counts.** The script estimates total captures as `(pages-1)*pageSize + last_page_rows`.
- **Capture density ≠ traffic.** Counts reflect URL-discoverability within the crawl's frontier, not visit volume.
- **WARC records are gzipped.** Each `fetch` slice decompresses to one WARC record.
- **Distinct URL count is approximate.** `domain-count` reports total per-crawl capture count.
