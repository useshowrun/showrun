# tranco-rankings

Research-grade web domain rankings (Tranco list) — daily-published rank for any domain in the global top-1M. Aggregates Alexa, Cisco Umbrella, Cloudflare Radar, and Majestic. Free, no auth required.

Tranco is the de-facto academic standard for "top web domains" (cited in IMC, NDSS, USENIX Security papers) because it averages four commercial lists and is published every day, dated and reproducible.

## Prerequisites

- Node.js 22+ (built-in fetch + zlib for gunzip, stdlib only)

## Setup

No authentication required. The maintainers ask academic users to cite the Le Pochat et al. NDSS 2019 paper (`https://tranco-list.eu/cite`).

## Usage

```bash
# Look up rank for one domain (uses the latest available list by default)
node scripts/tranco.mjs rank itch.io
node scripts/tranco.mjs rank store.steampowered.com
node scripts/tranco.mjs rank example.org --date=2026-04-01

# Compare a small set side-by-side
node scripts/tranco.mjs ranks itch.io store.steampowered.com gamejolt.com newgrounds.com

# Get the metadata of the latest published list (id, created date, num domains)
node scripts/tranco.mjs latest

# Get one specific list's metadata by ID
node scripts/tranco.mjs list <list-id>

# Download the top-N from the latest list as CSV
node scripts/tranco.mjs top --limit=1000 > top-1k.csv
node scripts/tranco.mjs top --limit=100000 > top-100k.csv

# Filter the cached top-1M by domain suffix (e.g. all .gov.uk in the top 1M)
node scripts/tranco.mjs filter "\\.gov\\.uk$"
node scripts/tranco.mjs filter "itch\\.io$"
```

## Output format

```
# Tranco rank — itch.io  (list 9KQX, 2026-04-25)
   rank: 12,489 / 1,000,000
   tranco subscore breakdown not exposed by the public API.

# Tranco ranks — multi
   rank=     489  store.steampowered.com
   rank=  12,489  itch.io
   rank=  84,221  gamejolt.com
   rank= 421,107  newgrounds.com
```

## Data layout

All state under `~/.local/share/showrun/data/tranco/`:

- `cache/latest.json` — last `latest` fetch
- `cache/list-<id>.json` — per `list` invocation
- `cache/rank-<domain>-<date>.json` — per `rank` invocation
- `cache/top-1m-<list-id>.csv` — full uncompressed daily top-1M (downloaded once per list-id, ~25MB)

## API notes

- **Per-domain rank**: `GET https://tranco-list.eu/api/ranks/domain/<domain>`. Returns `{ranks: [{date, rank, list}, ...]}` — one entry per day the domain has been on the list.
- **List metadata**: `GET https://tranco-list.eu/api/lists/date/<YYYY-MM-DD>` returns the list ID for that day (or the latest if no date). Use `latest` to skip the date.
- **CSV download**: `GET https://tranco-list.eu/download/<list-id>/<count>` where `count` ∈ `{full, 1000, 10000, 100000, 1000000}`. The `full` zip is ~9 MB compressed / ~25 MB uncompressed. The script gunzips inline.
- **Citation**: please cite Le Pochat et al., *Tranco: A Research-Oriented Top Sites Ranking Hardened Against Manipulation*, NDSS 2019.

## Known pitfalls

- **No subscore breakdown.** The public API only returns the aggregate rank — to see why a domain ranks where it does, you need the underlying Alexa/Umbrella/Cloudflare/Majestic rankings separately.
- **Lists are versioned.** A domain's rank changes daily. When comparing across time, always pin to a specific list-id rather than re-fetching latest.
- **CSV is large.** The full top-1M is ~25MB unzipped. The script caches per list-id; subsequent `filter` calls reuse the cache.
- **Domain canonicalisation.** Tranco normalises by stripping `www.`. `www.example.com` and `example.com` resolve to the same rank entry.
- **No subdomains.** Tranco ranks registered domains, not subdomains. `store.steampowered.com` may resolve via the parent `steampowered.com`.
