---
name: polymarket-markets
description: "Current prediction market prices from Polymarket — who's favored for political outcomes, geopolitical events, AI milestones, or any binary/multi-outcome question. Uses the free public Gamma API at `https://gamma-api.polymarket.com/`. Supports top-by-volume, keyword search across all active markets, events browsing, and per-market detail."
---

# polymarket-markets

Current prediction market prices from Polymarket — who's favored for political outcomes, geopolitical events, AI milestones, or any binary/multi-outcome question. Uses the free public Gamma API at `https://gamma-api.polymarket.com/`. Supports top-by-volume, keyword search across all active markets, events browsing, and per-market detail.

Markets have a `question`, a list of `outcomes` (usually `["Yes", "No"]` but sometimes multi-outcome), and live `outcomePrices` expressed as probabilities in `[0, 1]`.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required.

## Usage

```bash
# Top markets
node scripts/polymarket-markets.mjs top [N]                    # default N=20

# Keyword search across ALL active markets (paginated, 30-min cached)
node scripts/polymarket-markets.mjs search <keyword>

# Tag browsing
node scripts/polymarket-markets.mjs tags                       # list tags matching built-in filter
node scripts/polymarket-markets.mjs tag <tag-id> [N]           # markets for one tag

# Events (groups of related markets — e.g. an election with one child market per candidate)
node scripts/polymarket-markets.mjs events <keyword>

# Single-market detail
node scripts/polymarket-markets.mjs market <market-id>
```

No subscription list — Polymarket is a single service, not a set of user-editable sources. The built-in tag filter (`iran`, `middle`, `trump`, `ai`, `artif`, `turkey`, `israel`, `tech`, `job`, `geopol`) is hard-coded to match the common queries in this workspace; edit the script if you need a different cut.

## Data layout

All state lives under `~/.local/share/showrun/data/polymarket/`:

- `cache/all-active.json` — full snapshot of every active market (paginated `offset=0,500,...,3000`), 30-minute TTL. Reused by `search` to avoid re-paginating.
- `cache/top-by-volume.json` — output of the last `top` command.
- `cache/search-<slug>.json` — one file per search query (slug is the lowercased keyword).
- `cache/tags.json` — output of the last `tags` command (unfiltered, full list).
- `cache/tag-<id>.json` — output of `tag <id>`.
- `cache/events-<slug>.json` — output of `events <keyword>`.
- `cache/market-<id>.json` — output of `market <id>`.

Every snapshot is wrapped as `{ fetched_at, count, data }`.

## Output schema

Market rows (from both `top` and `search`) print as:

```
- <question truncated to ~85 chars>
    vol=$<volume>  end=<YYYY-MM-DD>  active=<bool> closed=<bool>
    Yes=65% | No=35%
```

`outcomes` and `outcomePrices` come back from the API as **JSON-encoded strings** (not arrays), e.g. `"[\"Yes\", \"No\"]"` and `"[\"0.65\", \"0.35\"]"`. The script parses these before rendering.

Raw snapshot wrapper:

```json
{
  "fetched_at": "2026-04-10T12:34:56Z",
  "count": 1523,
  "data": [ { "question": "...", "volumeNum": "...", "outcomes": "[\"Yes\",\"No\"]", "outcomePrices": "[\"0.2\",\"0.8\"]", "endDate": "...", "active": true, "closed": false }, ... ]
}
```

## Known pitfalls

- **User-Agent is mandatory.** Omitting it returns `HTTP 403` from CloudFront. The script sends `polymarket-skill/1.0`.
- **`outcomes` / `outcomePrices` are JSON-encoded strings**, not arrays. Parse with `JSON.parse` before zipping.
- **Server-side sort is unreliable.** `order=volumeNum&ascending=false` sometimes returns results out of order; `top` refetches a batch of 500 and sorts client-side.
- **Volume comes in two fields.** Prefer `volumeNum` (number-ish string), fall back to `volume`.
- **Pagination cap at offset 3000.** Deeper tails are low-liquidity noise.
- **30-min `all-active.json` TTL.** Subsequent `search` calls within the window are instant. Delete `cache/all-active.json` to force a refresh.
- **`tag_id` query param is not documented**, but works. Always sanity-check `tag <id>` results against a known tag.
- **Events vs. markets.** Use `events` when the user asks "what's the overall market on X" and `search` when they ask about a specific binary outcome.
