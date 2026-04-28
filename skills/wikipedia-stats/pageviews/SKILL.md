# wikipedia-stats-pageviews

Wikimedia Pageviews API wrapper — per-article view counts (daily/monthly), top-article rankings, whole-project aggregates, head-to-head article comparison, and OpenSearch title resolution. Free, no auth, no API key required. Goes back to 2015-07-01.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. Wikimedia **does require a descriptive `User-Agent` header** on every request, otherwise it serves `403`. The script sends `wikipedia-pageviews-skill/1.0 (researcher; node; eyup@showrun.co)`.

## Usage

```bash
# Per-article views over a window
node scripts/wikipedia-pageviews.mjs pageviews "Itch.io" --from=20240101 --to=20260101 --granularity=monthly
node scripts/wikipedia-pageviews.mjs pageviews "OpenAI" --from=20250101 --to=20260101 --granularity=daily --access=desktop --agent=user

# Top-N articles for a calendar month (or single day)
node scripts/wikipedia-pageviews.mjs top en.wikipedia.org 2025 12          # whole month (all-days)
node scripts/wikipedia-pageviews.mjs top en.wikipedia.org 2026 04 24       # specific day

# Whole-project aggregate pageviews
node scripts/wikipedia-pageviews.mjs aggregate en.wikipedia.org --from=20240101 --to=20260101 --granularity=monthly

# Compare a set of articles head-to-head over the same window
node scripts/wikipedia-pageviews.mjs compare "OpenAI" "Anthropic" "Mistral_AI" --from=20250101 --to=20260101 --granularity=monthly

# Resolve a free-text term to an article title (opensearch)
node scripts/wikipedia-pageviews.mjs search "Anthropic" --limit=5
```

## Output format

```
# Wikipedia pageviews — Itch.io  (en.wikipedia.org, all-access/user, monthly)
   range: 20240101 → 20260101  (24 buckets)
   total: 412,889   avg/bucket: 17,203   peak: 24,118

   2024-01      18,221  ##############################
   2024-02      17,003  ###########################
   ...
```

## Data layout

All state under `~/.local/share/showrun/data/wikipedia-stats/cache/`:

- `pageviews-<project>-<article>-<access>-<agent>-<granularity>-<from>-<to>.json`
- `top-<project>-<YYYY>-<MM>-<DD|all-days>.json`
- `aggregate-<project>-<access>-<agent>-<granularity>-<from>-<to>.json`
- `search-<lang>-<slug>-<limit>.json`
- `compare-<articles-slug>-<from>-<to>.json`

Cached responses are reused indefinitely. Delete the file to force a refresh.

## API notes

- **Pageviews per article**: `GET /metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}`
  - `project`: `en.wikipedia.org`, `de.wikipedia.org`, `commons.wikimedia.org`, etc.
  - `access`: `all-access` | `desktop` | `mobile-app` | `mobile-web`
  - `agent`: `all-agents` | `user` | `bot` | `spider` (use `user` to exclude bots)
  - `granularity`: `daily` | `monthly`
  - `start`/`end`: `YYYYMMDD` or `YYYYMMDDHH`
- **Top articles**: `GET /metrics/pageviews/top/{project}/{access}/{year}/{month}/{day}` — pass `all-days` as `day` for whole-month rankings.
- **Aggregate**: `GET /metrics/pageviews/aggregate/{project}/{access}/{agent}/{granularity}/{start}/{end}` — whole-project totals.
- **OpenSearch** (resolve term → article): `GET https://en.wikipedia.org/w/api.php?action=opensearch&search=...&format=json`.
- **Required `User-Agent`**: Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) rejects clients with no UA or generic `python-requests/...`.

## Known pitfalls

- **Article titles must use underscores, not spaces.** "Mistral AI" → `Mistral_AI`. The script accepts either form.
- **Case-sensitive after the first character.** `iPhone` ≠ `IPhone`. When in doubt, run `search` first.
- **Redirects are not followed.** `Itchio` returns zero views; the canonical title is `Itch.io`.
- **Pageviews start 2015-07-01.** Anything earlier 404s.
- **Top endpoint excludes Special: pages from rankings only above rank 1000** — so `Main_Page` and `Special:Search` dominate.
- **Bot vs. user traffic.** `agent=user` excludes self-identified crawlers. `agent=all-agents` includes bots and inflates the numbers significantly.
