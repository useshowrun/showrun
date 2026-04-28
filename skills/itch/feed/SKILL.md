# itch-feed

Authenticated reads against the logged-in user's itch.io account — feed events, purchases, collections, notifications, dashboard.

## Prerequisites

- Node.js 22+
- Run `itch-auth` once to populate `~/.local/share/showrun/data/itch/session.json`

## Usage

```bash
node scripts/itch-feed.mjs feed
node scripts/itch-feed.mjs feed --from-event=9999999999
node scripts/itch-feed.mjs purchases
node scripts/itch-feed.mjs collections
node scripts/itch-feed.mjs notifications
node scripts/itch-feed.mjs dashboard
```

`feed` returns `{num_items, events:[{id, type, title, summary}], next_cursor}`. Advance pagination by passing `next_cursor` back as `--from-event`.

## Known pitfalls

- **Re-run `itch-auth` on 401 / 403** — the session cookies expire and Cloudflare's `cf_clearance` is IP-bound, so a long absence will require a re-auth from the same machine.
- **Tor proxy works** for most authenticated reads (cookies aren't IP-bound on itch.io's app servers), but Cloudflare-challenged flows will re-challenge through Tor.
