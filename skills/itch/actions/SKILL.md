---
name: itch-actions
description: "Mutations on itch.io — follow / unfollow, like / unlike events, rate, comment, vote, download (counter bump), add-to-collection. **DRY-RUN by default** — every mutation prints the full request as `[DRY-RUN]` and only sends when `--live` is passed (or `ITCH_DRY_RUN=0` is set)."
---

# itch-actions

Mutations on itch.io — follow / unfollow, like / unlike events, rate, comment, vote, download (counter bump), add-to-collection. **DRY-RUN by default** — every mutation prints the full request as `[DRY-RUN]` and only sends when `--live` is passed (or `ITCH_DRY_RUN=0` is set).

## Prerequisites

- Node.js 22+
- Run `itch-auth` once to populate `~/.local/share/showrun/data/itch/session.json`

## Usage

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

## Known pitfalls

- **Integrity ping** (`/<dev>.itch.io/<slug>/rp/<signed_token>`) is NOT replayed after mutations — itch.io may flag automation if you run many counter bumps without it. Proceed with caution on `download`.
- **`/sudo`-gated mutations** (settings under api-keys, 2fa, etc.) require password re-auth and are intentionally unsupported.
