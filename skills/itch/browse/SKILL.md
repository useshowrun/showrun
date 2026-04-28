# itch-browse

Public itch.io scraping — directory listings, search, game / dev / comments / devlog / jam / topic / board pages. Works without login; uses the cached session if available.

## Prerequisites

- Node.js 22+
- Optional: `itch-auth` once if you want session-aware browsing (some Cloudflare-challenged paths need cookies)

## Usage

```bash
node scripts/itch-browse.mjs browse                                     # /games?format=json (top)
node scripts/itch-browse.mjs browse --filter=free --page=2
node scripts/itch-browse.mjs browse --filter=top-rated
node scripts/itch-browse.mjs browse --filter=newest
node scripts/itch-browse.mjs browse --filter=genre-puzzle
node scripts/itch-browse.mjs browse --filter=tag-2d
node scripts/itch-browse.mjs browse --filter=platform-web
node scripts/itch-browse.mjs search "platformer"
node scripts/itch-browse.mjs search "zombies" --classification=games --page=2
node scripts/itch-browse.mjs game hopefullight/time-traveler
node scripts/itch-browse.mjs game https://hopefullight.itch.io/time-traveler
node scripts/itch-browse.mjs dev hopefullight
node scripts/itch-browse.mjs comments hopefullight/time-traveler
node scripts/itch-browse.mjs comments hopefullight/time-traveler --before=123456
node scripts/itch-browse.mjs devlog hopefullight/time-traveler
node scripts/itch-browse.mjs jam gmtk-2024
node scripts/itch-browse.mjs jam-entries gmtk-2024
node scripts/itch-browse.mjs topic 1234567 --slug=general
node scripts/itch-browse.mjs board 23456 --slug=general
```

`browse` returns `{source, page, filter, num_items, games[]}` where each game has `{id, title, url, author, price, cover, description}`.
`game` returns `{dev, slug, data, extras}` where `data` is the canonical `data.json` body and `extras` includes `{title, description, rating, rating_count, author, uploads:[{upload_id, name, size}], topic_id, devlog_count}`.

## Tor proxy routing (optional)

Pass `--tor` on any command, or set `ITCH_USE_TOR=1`, to route through a local tor-proxy executor (per-request circuit isolation, fresh exit IP per request). Override the executor endpoint with `ITCH_TOR_WS` (default `ws://localhost:8080/ws`).

```bash
ITCH_USE_TOR=1 node scripts/itch-browse.mjs browse
node scripts/itch-browse.mjs search "platformer" --tor
```

## Known pitfalls

- **Multi-facet browse paths** (e.g. `/games/free/platform-web`) trigger Cloudflare challenges. If they 403 / 503, fetch from a logged-in Chrome tab first to refresh `cf_clearance` / `__cf_bm`.
- **Long pagination needs throttling.** itch.io will start serving 429s if you hit `browse --page=N` in a tight loop.
