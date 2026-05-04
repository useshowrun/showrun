# wayback-cdx-snapshots

Internet Archive Wayback Machine data — historical snapshots of any URL, snapshot density as a traffic-proxy, first-seen / last-seen dates, content-change tracking. Free, no auth, public CDX (Capture inDeX) API. Useful for forensics, research, and as a Similarweb / Cloudflare-Radar alternative for site activity over time.

Wraps the public Internet Archive **CDX** API at `https://web.archive.org/cdx/search/cdx`. Each CDX record describes one Wayback snapshot — its timestamp, the original URL, the response status code, and the content digest. Snapshot density of a URL over time is a public, free, research-grade *activity-proxy* signal.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. Internet Archive asks heavy users to be polite (~1 req/s); the script enforces a 500 ms gap between calls.

## Usage

```bash
# Snapshot count for a URL or domain (uses showResumeKey/totals)
node scripts/wayback-cdx.mjs count itch.io
node scripts/wayback-cdx.mjs count itch.io/games --match=prefix
node scripts/wayback-cdx.mjs count itch.io/* --match=domain

# First / last snapshot dates
node scripts/wayback-cdx.mjs span itch.io
node scripts/wayback-cdx.mjs span https://kay-yu.itch.io/holocure

# Snapshot timeline — count by year/month, downsampled
node scripts/wayback-cdx.mjs timeline itch.io --bin=year
node scripts/wayback-cdx.mjs timeline itch.io --bin=month --from=2022-01 --to=2026-04

# List recent snapshots (most recent first)
node scripts/wayback-cdx.mjs list itch.io --limit=20
node scripts/wayback-cdx.mjs list itch.io --limit=50 --filter=statuscode:200

# Get a specific snapshot's content URL
node scripts/wayback-cdx.mjs snapshot https://itch.io --date=20230615
```

## Match modes (`--match=`)

| Mode | What it matches |
|---|---|
| `exact` (default) | exactly the URL |
| `prefix` | URL prefix — `itch.io/games` matches `itch.io/games/free`, `itch.io/games/top` |
| `host` | same host (any path) |
| `domain` | same domain + all subdomains (use `*.example.com` syntax) |

## Output format

```
# Wayback CDX — itch.io  (match=exact)
   total snapshots: 4,728
   first: 2013-08-12 22:14:38 UTC
   last:  2026-04-25 09:03:11 UTC
   span:  4,639 days

# Wayback timeline — itch.io  (bin=year)
   2013:    2 snapshots
   2014:   18
   2015:   89
   ...
   2025: 1,082
   2026:  287
```

## Data layout

All state under `~/.local/share/showrun/data/wayback-cdx/`:

- `cache/count-<slug>.json` — last `count` invocation
- `cache/span-<slug>.json` — last `span` invocation
- `cache/timeline-<slug>-<bin>.json` — last `timeline` invocation
- `cache/list-<slug>-<limit>.json` — last `list` invocation

## API notes

- **Base**: `https://web.archive.org/cdx/search/cdx`
- **Output formats**: `output=json` returns `[[header_row], [row], ...]`. The first row is column names (`urlkey,timestamp,original,mimetype,statuscode,digest,length`).
- **Timestamp format**: 14-digit `YYYYMMDDhhmmss` (UTC).
- **Pagination**: `&showResumeKey=true&resumeKey=<key>` for >150K-row responses. The script auto-paginates for `count` and `timeline`.
- **Collapse**: `&collapse=timestamp:6` collapses snapshots whose timestamp prefix matches (here: same year). `:8` collapses by day.
- **Filters**: `&filter=statuscode:200`, `&filter=mimetype:text/html`, etc. Multiple filters AND together.
- **Match types**: `&matchType=exact|prefix|host|domain`.
- **Date range**: `&from=YYYYMMDD&to=YYYYMMDD`.
- **Reference**: https://archive.org/developers/wayback-cdx-server.html

## Known pitfalls

- **CDX is rate-limited but quietly.** The script self-throttles to 500 ms between requests. Tight loops without throttling will start getting `503 Slow Down`.
- **`output=json` first row is the header.** Don't iterate it as a data row.
- **Match-mode `domain` requires `*.example.com` syntax** in the URL field, not just the bare domain. The script auto-converts when `--match=domain`.
- **Snapshot density is biased.** IA crawls popular sites more, so density correlates with popularity — but it's also boosted by manual `Save Page Now` requests. Treat as an *activity* proxy, not a *visit* proxy.
- **Snapshots can be large.** A `list` of 50K snapshots is ~5 MB. Prefer `timeline` for aggregate analysis.
- **CDX returns the *URL key* not the original URL** for sorting; the script converts back via the `original` column.
