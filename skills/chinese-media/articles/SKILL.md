# chinese-media-articles

Read Chinese English-language media — Xinhua, Global Times, People's Daily, CGTN, South China Morning Post, China MOFA — to get Beijing's or Hong Kong's own framing on world events. Tries RSS first, falls back to per-source HTML listing scraping when feeds are dead or stale. Supports keyword search over the full cached corpus and lets users add custom sources.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. First run seeds defaults to `~/.local/share/showrun/data/chinese-media/sources.json`.

## Usage

```bash
# Listing and status
node scripts/chinese-media-fetch.mjs list
node scripts/chinese-media-fetch.mjs sources                  # alias for list, with feed URLs

# Fetching
node scripts/chinese-media-fetch.mjs latest <source> [N]       # default N=15
node scripts/chinese-media-fetch.mjs latest-all [N]            # every source, 1s between
node scripts/chinese-media-fetch.mjs view <source>             # print cached latest without re-fetching

# Searching cached corpus
node scripts/chinese-media-fetch.mjs search <keyword>          # all sources
node scripts/chinese-media-fetch.mjs search <keyword> --source=xinhua

# Source management (persists to sources.json)
node scripts/chinese-media-fetch.mjs add-rss <slug> "<name>" <rss-url>
node scripts/chinese-media-fetch.mjs remove-source <slug>
node scripts/chinese-media-fetch.mjs reset-sources             # restore defaults
```

`<source>` is a slug: `xinhua`, `globaltimes`, `peoplesdaily`, `cgtn`, `scmp`, `mofa`.

## Seeded sources (first run)

| Slug | Source | Transport |
|---|---|---|
| `xinhua` | Xinhua News Agency (English) | RSS + HTML fallback |
| `globaltimes` | Global Times | RSS + HTML fallback |
| `peoplesdaily` | People's Daily (English) | RSS + HTML fallback |
| `cgtn` | CGTN | RSS + HTML fallback |
| `scmp` | South China Morning Post | RSS (`/rss/91/feed`, `/rss/2/feed`, `/rss/318198/feed`) |
| `mofa` | China MOFA (Ministry of Foreign Affairs) | HTML listing at `fmprc.gov.cn/eng/xw/zyxw/` |

Defaults live in the script; first run copies them to `~/.local/share/showrun/data/chinese-media/sources.json`. Edit that file directly or use `add-rss` / `remove-source` — never edit the script.

## Data layout

All state lives under `~/.local/share/showrun/data/chinese-media/`:

- `sources.json` — source config (RSS URLs, HTML fallback URLs, URL patterns)
- `cache/<source>/latest.json` — most recent fetch for one source
- `cache/index.jsonl` — append-only log of every unique story seen, deduped by SHA1-of-URL `id`. Used by `search`.

## Output schema

`cache/<source>/latest.json`:

```json
{
  "fetched_at": "2026-04-10T12:34:56Z",
  "source": "xinhua",
  "source_name": "Xinhua News Agency (English)",
  "count": 15,
  "data": [
    {
      "id": "sha1-hash-of-url",
      "url": "https://english.news.cn/...",
      "title": "...",
      "published": "2026-04-10T...",
      "summary": "first ~400 chars if available",
      "categories": ["world", "china"]
    }
  ]
}
```

## Known pitfalls

- **People's Daily RSS is stale upstream** — as of April 2026, its feeds advertise items dated June 2025. That's an en.people.cn bug, not the scraper.
- **Xinhua and Global Times RSS URLs 404** — the scraper silently falls back to HTML parsing.
- **MOFA server returns malformed chunked encoding intermittently** — the fetcher catches `IncompleteRead` and keeps the partial body. If `latest mofa` ever returns 0 stories, just re-run.
- **SCMP is paywalled** — RSS gives headline + teaser only.
- **HTML-fallback sources don't populate `published` or `summary`** — only RSS sources do. Affects `xinhua`, `globaltimes`, `mofa`.
- **Index grows unbounded.** Safe to `rm` and rebuild via any fresh `latest-all` run.
- **`search` is local-only** — it greps the jsonl index, so coverage grows as you run `latest` / `latest-all`. Schedule `latest-all` periodically if you want a searchable backlog.

## Custom sources

`add-rss` only supports simple RSS feeds — pattern-based HTML fallback requires editing `sources.json` directly:

```json
{
  "my-custom": {
    "name": "My Custom Source",
    "feeds": [
      {"kind": "rss", "url": "https://example.com/feed.xml"}
    ],
    "fallback": {
      "kind": "html",
      "url": "https://example.com/china/",
      "pattern": "/news/\\d{4}/\\d{2}/[a-z0-9-]+"
    }
  }
}
```

The `pattern` is a regex (JS flavor) applied to candidate `<a href>` URLs on the fallback page. Links shorter than 15 chars of link-text are rejected as nav/chrome.
