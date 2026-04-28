# wikipedia-stats

Wikipedia or Wikidata statistics — Wikimedia Pageviews API (per-article views, top articles, project aggregates) and the Wikidata SPARQL endpoint (entity lookup, structured queries, sitelinks). Free, no auth, no API key required. Useful for popularity proxies, trend tracking, and structured-knowledge lookups (founders, inception dates, websites).

Wraps two free, public Wikimedia services in a single CLI:

1. **Wikimedia Pageviews API** at `https://wikimedia.org/api/rest_v1/metrics/pageviews/...` — per-article view counts (daily/monthly), top-article rankings, and whole-project aggregates. Goes back to 2015-07-01.
2. **Wikidata** — both the SPARQL endpoint at `https://query.wikidata.org/sparql` and the per-entity JSON dump at `https://www.wikidata.org/wiki/Special:EntityData/{Q-id}.json`. Plus `opensearch` against `en.wikipedia.org/w/api.php` for resolving "Itch.io" → article title and `wbsearchentities` for resolving free-text → Q-ids.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. Wikimedia **does require a descriptive `User-Agent` header** on every request, otherwise it serves `403`. The script sends `wikipedia-stats-skill/1.0 (researcher; node; eyup@showrun.co)`.

## Usage

```bash
# --- Pageviews ---

# Per-article views over a window
node scripts/wikipedia-stats.mjs pageviews "Itch.io" --from=20240101 --to=20260101 --granularity=monthly
node scripts/wikipedia-stats.mjs pageviews "OpenAI" --from=20250101 --to=20260101 --granularity=daily --access=desktop --agent=user

# Top-N articles for a calendar month (or single day)
node scripts/wikipedia-stats.mjs top en.wikipedia.org 2025 12          # whole month (all-days)
node scripts/wikipedia-stats.mjs top en.wikipedia.org 2026 04 24       # specific day

# Whole-project aggregate pageviews
node scripts/wikipedia-stats.mjs aggregate en.wikipedia.org --from=20240101 --to=20260101 --granularity=monthly

# Compare a set of articles head-to-head over the same window
node scripts/wikipedia-stats.mjs compare "OpenAI" "Anthropic" "Mistral_AI" --from=20250101 --to=20260101 --granularity=monthly

# --- Wikidata / search ---

# Resolve a free-text term to an article title (opensearch)
node scripts/wikipedia-stats.mjs search "Anthropic" --limit=5

# Fetch a Wikidata entity by Q-id (or by search term — first hit is fetched)
node scripts/wikipedia-stats.mjs entity Q117178637          # Anthropic
node scripts/wikipedia-stats.mjs entity "Mistral AI"        # search → fetch first hit

# Run an arbitrary SPARQL query
node scripts/wikipedia-stats.mjs sparql "SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q4830453 ; wdt:P571 ?inc . FILTER(YEAR(?inc) = 2021) . SERVICE wikibase:label { bd:serviceParam wikibase:language 'en' } } LIMIT 10"

# Or load it from a file (more readable for multi-line queries)
node scripts/wikipedia-stats.mjs sparql-file ./query.rq
```

## Output format

```
# Wikipedia pageviews — Itch.io  (en.wikipedia.org, all-access/user, monthly)
   range: 20240101 → 20260101  (24 buckets)
   total: 412,889   avg/bucket: 17,203   peak: 24,118

   2024-01      18,221  ##############################
   2024-02      17,003  ###########################
   ...

# Wikipedia top articles — en.wikipedia.org  (2025-12, access=all-access)
     1.   8,121,003  Special:Search                          ##############################
     2.   2,007,991  Main_Page                               ########
   ...

# Wikidata entity — Q117178637  Anthropic
   description: American AI safety and research company
   claims: 31 properties
   sitelinks: 27 (...)
   notable claims:
     P31 (instance of): Q6881511
     P571 (inception): +2021-01-01T00:00:00Z
     P856 (website): https://www.anthropic.com/
```

## Data layout

All state under `~/.local/share/showrun/data/wikipedia-stats/cache/`:

- `pageviews-<project>-<article>-<access>-<agent>-<granularity>-<from>-<to>.json`
- `top-<project>-<YYYY>-<MM>-<DD|all-days>.json`
- `aggregate-<project>-<access>-<agent>-<granularity>-<from>-<to>.json`
- `search-<lang>-<slug>-<limit>.json`
- `entity-<Q-id>.json`
- `sparql-<slug>-<base64-prefix>.json`
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
- **Wikidata SPARQL**: `GET https://query.wikidata.org/sparql?query=<urlencoded>&format=json`. Hard 60-second query timeout server-side.
- **Wikidata entity JSON**: `GET https://www.wikidata.org/wiki/Special:EntityData/{Q-id}.json` — full entity dump.
- **Required `User-Agent`**: Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) rejects clients with no UA or generic `python-requests/...`.

## Known pitfalls

- **Article titles must use underscores, not spaces.** "Mistral AI" → `Mistral_AI`. The script accepts either form.
- **Case-sensitive after the first character.** `iPhone` ≠ `IPhone`. When in doubt, run `search` first.
- **Redirects are not followed.** `Itchio` returns zero views; the canonical title is `Itch.io`.
- **Pageviews start 2015-07-01.** Anything earlier 404s.
- **Top endpoint excludes Special: pages from rankings only above rank 1000** — so `Main_Page` and `Special:Search` dominate.
- **SPARQL has a 60-second server-side timeout.** Always add `LIMIT N` and the `wikibase:label` SERVICE block for human-readable labels.
- **Wikidata Q-ids are not stable across renames** but are stable across label edits — once assigned, the Q-id never changes.
- **Bot vs. user traffic.** `agent=user` excludes self-identified crawlers. `agent=all-agents` includes bots and inflates the numbers significantly.
