# arxiv-papers

Search arXiv for papers (by title, author, abstract, category, or free text), fetch full metadata for a specific arXiv ID or URL, list newest papers in a category (cs.CL, cs.LG, stat.ML, etc.), and read arXiv's own site-wide usage stats (monthly submissions, monthly downloads, hourly usage).

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. arXiv asks for a 3-second gap between API calls — this script enforces that automatically.

Two fully public, no-auth surfaces:

1. **Query API** (documented) — `https://export.arxiv.org/api/query` returning Atom 1.0 XML. See https://info.arxiv.org/help/api/user-manual.html for the spec; this skill wraps the three use-cases that cover ~95% of real work (search, fetch-by-id, newest-in-category).
2. **Stats CSVs** (undocumented) — the three charts at `https://arxiv.org/stats/*` are powered by CSV endpoints at `/stats/get_monthly_submissions`, `/stats/get_monthly_downloads`, and `/stats/get_hourly?date=YYYYMMDD`.

## Usage

### Search & metadata

```bash
# Keyword search (all fields)
node scripts/arxiv.mjs search "state space model"
node scripts/arxiv.mjs search "retrieval augmented" --limit=30

# Field-restricted search
node scripts/arxiv.mjs search "mamba" --field=ti
node scripts/arxiv.mjs search "LeCun" --field=au
node scripts/arxiv.mjs search "transformer" --field=abs

# Sort + pagination (sort: relevance | submittedDate | lastUpdatedDate)
node scripts/arxiv.mjs search "diffusion" --sort=submittedDate --order=descending --limit=50
node scripts/arxiv.mjs search "diffusion" --start=50 --limit=50   # next page

# Fetch one or more papers by ID (accepts ID, URL, or comma-separated list)
node scripts/arxiv.mjs paper 1706.03762
node scripts/arxiv.mjs paper https://arxiv.org/abs/2312.00752
node scripts/arxiv.mjs paper 2312.00752,1810.04805 --json

# Newest in a category (cs.CL, cs.LG, stat.ML, cs.AI, cs.CV, math.OC, ...)
node scripts/arxiv.mjs category cs.LG --limit=15
node scripts/arxiv.mjs category stat.ML --limit=10

# All papers by an author, newest first
node scripts/arxiv.mjs author "Yann LeCun" --limit=10
node scripts/arxiv.mjs author "Geoffrey Hinton"
```

### Search field prefixes (for raw `--field=`)

| Prefix | Searches |
|--------|----------|
| `ti`   | Title |
| `au`   | Author |
| `abs`  | Abstract |
| `co`   | Comment |
| `jr`   | Journal reference |
| `cat`  | Subject category |
| `rn`   | Report number |
| `id`   | arXiv ID |
| `all`  | All fields |

For Boolean queries (AND / OR / ANDNOT) or grouped expressions, pass the full string to `search` without `--field`:

```bash
node scripts/arxiv.mjs search 'ti:"attention" AND cat:cs.CL' --limit=10
```

### ID formats accepted

- `1706.03762` or `1706.03762v5` (post-2007)
- `cs.CL/0601121` (pre-2007)
- `https://arxiv.org/abs/<id>` or `https://arxiv.org/pdf/<id>[.pdf]` (URL → ID auto-extraction)

### Stats

```bash
# Monthly submission totals (1991-08 onward)
node scripts/arxiv.mjs stats-submissions
node scripts/arxiv.mjs stats-submissions --json

# Monthly downloads (1994-01 onward)
node scripts/arxiv.mjs stats-downloads

# Hourly usage for a given day (default: today)
node scripts/arxiv.mjs stats-today
node scripts/arxiv.mjs stats-today --date=20260410
```

Pretty output includes YoY comparisons for submissions. `--json` returns the raw `[{month,submissions,historical_delta}, ...]` or `[{month,downloads}, ...]` arrays.

### Offline

```bash
node scripts/arxiv.mjs view-cache 1706.03762         # print cached paper JSON
node scripts/arxiv.mjs search-cache "attention"      # grep local index
```

## Output format — search

```
# arXiv search: <query>   (<total> total, showing <N> starting at <start>, sort=<sortBy>/<order>)

- <title>
    <author1>, <author2>, <author3> +N · YYYY-MM-DD · <primary_category>
    arXiv:<id>  <abs_url>  pdf=<pdf_url>
    doi:<doi>                    # if present
    journal: <journal_ref>       # if present
    comment: <comment truncated> # if present
```

## Data layout

All state under `~/.local/share/showrun/data/arxiv/`:

- `cache/paper-<id>.json`   — per-paper full metadata
- `cache/search-<slug>.json` — per-search result batch
- `cache/stats-submissions.json`, `stats-downloads.json`, `stats-hourly-YYYYMMDD.json`
- `cache/index.jsonl`       — append-only log for `search-cache`

## API notes

- **Base**: `https://export.arxiv.org/api/query` — the plain `http://` also works but always 301s to https.
- **Pagination**: `start` and `max_results`. `max_results` caps at 2000 per call; total across all calls caps at 30 000 for one query.
- **Sort**: `sortBy` in `{relevance, lastUpdatedDate, submittedDate}`, `sortOrder` in `{ascending, descending}`. `relevance` + `descending` is the default.
- **Rate limit**: arXiv asks for a 3s gap between requests. Script enforces this automatically across a single process.
- **Response namespaces**: default Atom + `opensearch:*` (totals, pagination) + `arxiv:*` (primary_category, doi, journal_ref, comment).

### Stats endpoints (reverse-engineered)

Each `/stats/*` HTML page uses `d3.csv("…")` to pull data. The three data URLs:

| URL | Format |
|---|---|
| `/stats/get_monthly_submissions` | `month,submissions,historical_delta` |
| `/stats/get_monthly_downloads`   | `month,downloads` |
| `/stats/get_hourly?date=YYYYMMDD` | hourly breakdown for one day |

Plain CSV with a header row and one row per period. Not advertised as an API; verified stable but subject to change.

## Known pitfalls

- **"No matches" for oddly-worded queries**: the Atom API is strict about tokenization. `"attention is all you need"` returns nothing, but `ti:"attention is all you need"` or just `attention+is+all+you+need` as separate terms works.
- **Case-sensitive category codes**: `cs.CL`, `stat.ML`, `math.OC` — uppercase section after the dot. `cs.cl` returns zero.
- **No full-text search**: `abs:` searches abstracts, not the PDF body.
- **Rate limit silently slows**: the 3s gap is client-side. A 20-page pagination takes ≥60 s.
- **Stats API is undocumented.** If `/stats/get_monthly_submissions` ever returns HTML instead of CSV, the chart JS on `/stats/monthly_submissions` is the source of truth.
- **Hourly stats format is unstable**: columns differ from day to day. Use `--json` for programmatic consumption.
