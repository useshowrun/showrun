---
name: gdelt-articles
description: "Global news monitoring from the GDELT Project — full-text search across worldwide news in 65+ languages, daily mention-volume / tone / language timelines, theme-tagged events (PROTEST, KILL, ECON_BANKING…), per-domain article streams, and source-country breakdowns. Free, no auth, public DOC 2.0 API."
---

# gdelt-articles

Global news monitoring from the GDELT Project — full-text search across worldwide news in 65+ languages, daily mention-volume / tone / language timelines, theme-tagged events (PROTEST, KILL, ECON_BANKING…), per-domain article streams, and source-country breakdowns. Free, no auth, public DOC 2.0 API.

GDELT monitors broadcast, print, and web news in 65+ languages worldwide every 15 minutes, tagging each article with themes, tone, sentiment, locations, and entities. The DOC API exposes article search, time-series mention-volume / tone, language and country breakdowns, and tone histograms.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required. The maintainer asks researchers to keep volume to **≤ 1 request / 5 seconds**; the script self-throttles to 5500 ms and surfaces a clear error when it sees the rate-limit text response.

## Usage

```bash
# Top recent articles matching a query
node scripts/gdelt.mjs search "Anthropic Claude" --timespan=30d --max=10
node scripts/gdelt.mjs search "\"AI safety\" -hype" --timespan=24h --sort=HybridRel
node scripts/gdelt.mjs search 'tone<-5 (china OR taiwan)' --timespan=7d --max=20

# Daily mention-volume / tone / language / country timeline
node scripts/gdelt.mjs timeline "Cambridge bot army" --timespan=180d --mode=volume
node scripts/gdelt.mjs timeline "Anthropic" --timespan=30d --mode=tone
node scripts/gdelt.mjs timeline "Gaza ceasefire" --timespan=14d --mode=lang
node scripts/gdelt.mjs timeline "OpenAI" --timespan=30d --mode=country

# Top recent articles from a single news domain
node scripts/gdelt.mjs domain nytimes.com --timespan=7d
node scripts/gdelt.mjs domain reuters.com --timespan=24h --max=30

# All articles tagged with a GDELT theme
node scripts/gdelt.mjs theme KILL --timespan=24h
node scripts/gdelt.mjs theme PROTEST --timespan=7d --max=30
node scripts/gdelt.mjs theme ECON_BANKING --timespan=7d

# Geographic distribution of coverage (source-country volume over time)
node scripts/gdelt.mjs geo "Anthropic" --timespan=7d

# Raw passthrough — any mode, any query, JSON dumped
node scripts/gdelt.mjs raw ToneChart "Anthropic" --timespan=7d
node scripts/gdelt.mjs raw WordCloud "Anthropic Claude" --timespan=30d
node scripts/gdelt.mjs raw ArtListWithImage "SpaceX launch" --timespan=24h --max=10
```

## Modes

| Mode | What it returns |
|---|---|
| `ArtList` (default for search/domain/theme) | List of matching articles with `url, title, seendate, domain, language, sourcecountry, socialimage` |
| `ArtListWithImage` | Same, but only articles whose lead image GDELT could resolve |
| `TimelineVol` | Daily *volume intensity* (articles matching / total articles monitored, as a percentage) |
| `TimelineTone` | Daily *average tone* on the GDELT scale (-10 negative … 0 neutral … +10 positive) |
| `TimelineLang` | One series per language, daily volume |
| `TimelineSourceCountry` | One series per source country, daily volume |
| `ToneChart` | Histogram across 21 tone bins, with sample articles per bin |
| `WordCloud` | Top words/phrases (filtered against GDELT's stoplist) |
| `ImageCollage` | Mosaic of top social-share images |

## Query syntax (combine freely with implicit AND)

| Operator | Example | Effect |
|---|---|---|
| `"phrase"` | `"AI safety"` | Exact-phrase match |
| `wordA wordB` | `claude opus` | Implicit AND |
| `(a OR b)` | `(china OR taiwan)` | Boolean OR |
| `-word` | `claude -monet` | Exclude term |
| `near10:"a b"` | `near10:"musk twitter"` | Words within N tokens |
| `repeat3:"x"` | `repeat3:"genocide"` | Term must appear ≥ N times in article |
| `domain:host` | `domain:nytimes.com` | Restrict to one source domain |
| `sourcecountry:CC` | `sourcecountry:US` | ISO source-country code (US, GB, IN, CN…) |
| `theme:CODE` | `theme:KILL` | One of GDELT's ~10K themes (uppercase) |
| `tone>N` / `tone<N` | `tone<-5` | Article tone above / below threshold |
| `imagewebcount>0` | | Article's lead image already known on the web |

Useful theme codes: `KILL`, `PROTEST`, `TERROR`, `ELECTION`, `ECON_BANKING`, `ECON_STOCKMARKET`, `ENV_CLIMATE`, `MILITARY`, `SECURITY_SERVICES`, `RELIGION`, `WB_*` (World Bank topics).

## Timespan format

`15min`, `60min`, `24h`, `3d`, `7d`, `14d`, `30d`, `1m`, `3m`, `6m`, `1y`, `2y`. Default in this skill: `7d` for article queries, `30d` for timelines.

## Output format

```
# GDELT search — "Anthropic Claude"  (timespan=30d, sort=DateDesc)
   10 articles:

   • [2026-04-26] finance.yahoo.com  (United States, English)
     Anthropic Targets EU Data Center Market With A Six-Figure …
     https://finance.yahoo.com/sectors/technology/articles/...

   Top countries: United States(4), India(2), United Kingdom(1), …
   Top domains:   yahoo.com(2), businesstoday.in(2), …

# GDELT timeline — "Anthropic"  (mode=TimelineVol, timespan=30d)
   series: Volume Intensity  (30 points)
     2026-03-28  0.0628  ████
     2026-03-29  0.0452  ███
     2026-03-30  0.0709  █████
     ...
```

## Data layout

All state under `~/.local/share/showrun/data/gdelt/`:

- `cache/search-<slug>-<timespan>-<max>.json`
- `cache/timeline-<slug>-<which>-<timespan>.json`
- `cache/domain-<slug>-<timespan>.json`
- `cache/theme-<slug>-<timespan>.json`
- `cache/geo-<slug>-<timespan>.json`
- `cache/raw-<mode>-<slug>-<timespan>.json`

## API notes

- **Base**: `https://api.gdeltproject.org/api/v2/doc/doc`. The single endpoint multiplexes every mode via `&mode=...`.
- **Format**: `&format=json`. Other supported formats: `csv`, `html`, `rss` — the script always asks for JSON.
- **Sort**: `&sort=DateDesc|DateAsc|ToneDesc|ToneAsc|HybridRel`. `HybridRel` is GDELT's relevance + recency mix; `DateDesc` is the practical default.
- **Maxrecords**: hard cap at **250 per request** for `ArtList` modes.
- **Date format in responses**: `YYYYMMDDTHHMMSSZ` (UTC, no separators). The script normalises to `YYYY-MM-DD HH:MM UTC`.
- **Reference**: `https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/` and `https://api.gdeltproject.org/api/v2/doc/doc?mode=help`.

## Known pitfalls

- **5-second rate limit, but it's a body, not a status code.** GDELT replies with HTTP 200 and a plain-text body `"Please limit requests to one every 5 seconds…"`.
- **`/api/v2/geo/geo` returns 404.** The `geo` command in this skill emulates it via `mode=TimelineSourceCountry`. Lat/lon point data needs the (paid) GDELT Geographic Mention Dataset.
- **Themes are case-sensitive.** `theme:KILL` works; the script auto-uppercases.
- **Empty `{}` means "no matches", not an error.** Try widening `--timespan`.
- **Tone scale is -10 … +10 but typical news lives in -3 … +3.**
- **Volume Intensity is normalised against ALL monitored articles**, not just English.
- **`maxrecords` caps at 250.** For larger pulls, page by `&startdatetime` / `&enddatetime`.
- **No back-pagination by offset.** GDELT only supports time-window slicing.
