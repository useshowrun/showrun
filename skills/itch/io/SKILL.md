# itch-io

Browse itch.io games, view game/developer pages, read comments and devlogs, manage feed/purchases/collections, follow studios, rate or comment on games, bump download counters, edit profile.

All scripts: Node.js 22+. Auth once: `node scripts/itch-auth.mjs` (needs Chrome with an itch.io tab open and logged in).

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- itch.io account (logged in via Chrome)

## Setup

```bash
node scripts/itch-auth.mjs
```

Re-run auth on 401/403 errors. **Mutations default to DRY-RUN** — add `--live` to actually execute (or set `ITCH_DRY_RUN=0`).

Session is stored at `~/.local/share/showrun/data/itch/session.json`. Scrape results are cached under `~/.local/share/showrun/data/itch/cache/`.

## Tor proxy routing (optional)

Route any request through the local tor-proxy executor (per-request circuit isolation, fresh exit IP per request) by either passing `--tor` on any command or setting `ITCH_USE_TOR=1`. Override the executor endpoint with `ITCH_TOR_WS` (default `ws://localhost:8080/ws`), and the per-request timeout with `ITCH_TOR_TIMEOUT` (default 60s).

```bash
ITCH_USE_TOR=1 node scripts/itch-browse.mjs browse
node scripts/itch-browse.mjs search "platformer" --tor
ITCH_TOR_WS=ws://tor-proxy.local:8080/ws node scripts/itch-feed.mjs feed --tor
```

Start the executor first: `cd ~/Projects/tor-proxy-project && docker compose up -d`. Works well for anonymous browse/search/game/dev endpoints. Authenticated endpoints generally still work (itchio cookies aren't IP-bound), but Cloudflare-challenged flows (login, some facet pages) will likely re-challenge because `cf_clearance`/`__cf_bm` are tied to the issuing IP.

## itch-browse — public scraping (cookie-less OK)

Browse directories, search, and scrape game / dev / comments / devlog / jam / topic / board pages. Works without login; uses session if available.

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

## itch-feed — authenticated reads

```bash
node scripts/itch-feed.mjs feed
node scripts/itch-feed.mjs feed --from-event=9999999999
node scripts/itch-feed.mjs purchases
node scripts/itch-feed.mjs collections
node scripts/itch-feed.mjs notifications
node scripts/itch-feed.mjs dashboard
```

`feed` returns `{num_items, events:[{id, type, title, summary}], next_cursor}`. Advance pagination by passing `next_cursor` back as `--from-event`.

## itch-actions — mutations (DRY-RUN by default)

Every mutation first prints the full request (URL, headers, body) as `[DRY-RUN]`. Add `--live` to actually send.

```bash
node scripts/itch-actions.mjs follow hopefullight                        # dry-run
node scripts/itch-actions.mjs follow hopefullight --live                 # for real
node scripts/itch-actions.mjs unfollow hopefullight --live
node scripts/itch-actions.mjs like-event 12345678
node scripts/itch-actions.mjs unlike-event 12345678
node scripts/itch-actions.mjs rate hopefullight/time-traveler --stars=5 --blurb="Great game"
node scripts/itch-actions.mjs comment 1234567 "Nice work!" --no-subscribe
node scripts/itch-actions.mjs vote 98765432 --dir=up
node scripts/itch-actions.mjs download hopefullight/time-traveler        # auto-discovers upload_id
node scripts/itch-actions.mjs download hopefullight/time-traveler --upload-id=1234567
node scripts/itch-actions.mjs add-to-collection hopefullight/time-traveler --collection=4567
node scripts/itch-actions.mjs add-to-collection hopefullight/time-traveler --new="My Faves" --private
```

Notes:

- `rate`, `add-to-collection`, `download` POST to the `<dev>.itch.io` subdomain (Origin / Referer set accordingly).
- `download` auto-scrapes `data-upload_id` from the game page when `--upload-id` is omitted. Posting to this endpoint bumps the download counter without fetching the file.
- `comment` expects a `topic_id`, not a game slug — use `itch-browse game <slug>` first to get `extras.topic_id`.

## itch-profile — profile & settings editing (DRY-RUN by default)

```bash
node scripts/itch-profile.mjs get                                        # current profile values
node scripts/itch-profile.mjs edit --summary="I make indie games"
node scripts/itch-profile.mjs edit --website=https://example.com --twitter=myhandle
node scripts/itch-profile.mjs edit --display-name="My Name" --bluesky=me.bsky.social
node scripts/itch-profile.mjs avatar /path/to/image.png
node scripts/itch-profile.mjs notifications --email-purchases=on --email-followers=off
node scripts/itch-profile.mjs privacy --enable-events=off
node scripts/itch-profile.mjs dark-mode toggle                           # dry-run
node scripts/itch-profile.mjs dark-mode toggle --live                    # reversible — safe to test
```

`edit` first GETs `/user/settings`, parses the current form (CSRF + every visible value), overlays only the flags you passed, and POSTs the full merged body back — so unspecified fields are preserved, not blanked. Field mapping (discovered from live form):

| Flag | Form field |
|---|---|
| `--summary` | `data[profile]` (the bio textarea) |
| `--website` | `data[website]` |
| `--twitter` | `data[twitter]` |
| `--mastodon` | `data[mastodon]` |
| `--bluesky` | `data[bluesky]` |
| `--threads` | `data[threads]` |
| `--display-name` | `user[display_name]` |

## Known limitations

- **`/login` and multi-facet browse** (`/games/free/platform-web`) trigger Cloudflare challenges. Use the already-logged-in Chrome tab for login; the taskpack does not attempt to solve CF from Node.
- **Avatar upload**: the form file-field name is inferred (`user[cover]`) — not verified end-to-end during discovery.
- **`/sudo`-gated settings** (api-keys, 2fa, delete-account, credit-cards, oauth-apps) require password re-auth and are intentionally unsupported.
- **Devlog authoring** is not supported — the discovery account had no published games.
- **Integrity ping** (`/<dev>.itch.io/<slug>/rp/<signed_token>`) is NOT replayed after mutations — itch.io may flag automation if you run many counter bumps without relaying this token. Proceed with caution on `download`.
- **CORS**: scripts call `<dev>.itch.io` subdomains directly via plain fetch, so no CORS issue, but you must have fresh `cf_clearance` / `__cf_bm` cookies if Cloudflare ever challenges those hosts.
