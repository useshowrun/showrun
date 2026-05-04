---
name: telegram-osint-channels
description: "Read public Telegram channels for OSINT (conflict tracking, Middle East / Ukraine / defense analysis, opposition media). Scrapes the public `t.me/s/` preview — no auth, no bot token, no API key. Supports subscribing to channels and fetching their latest messages."
---

# telegram-osint-channels

Read public Telegram channels for OSINT (conflict tracking, Middle East / Ukraine / defense analysis, opposition media). Scrapes the public `t.me/s/` preview — no auth, no bot token, no API key. Supports subscribing to channels and fetching their latest messages.

This skill is **not** a bot interface. The existing `telegram` plugin provides a bot for receiving DMs; this skill reads public broadcast channels.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)

## Setup

No authentication required.

## Usage

Manage channel subscriptions, fetch messages, and view the latest fetch.

```bash
# Subscription management (edits ~/.local/share/showrun/data/telegram-osint/channels.json)
node scripts/telegram-osint-channels.mjs list
node scripts/telegram-osint-channels.mjs subscribe <channel> "description"
node scripts/telegram-osint-channels.mjs unsubscribe <channel>

# Fetching
node scripts/telegram-osint-channels.mjs fetch <channel>           # one channel, even if unsubscribed
node scripts/telegram-osint-channels.mjs fetch-all                 # all subscribed, 2s between
node scripts/telegram-osint-channels.mjs fetch-all --parallel=4    # optional parallel mode

# Inspect the latest fetch
node scripts/telegram-osint-channels.mjs view <channel>            # last fetch for a channel

# Maintenance
node scripts/telegram-osint-channels.mjs verify <channel>          # HEAD-check without saving
```

`<channel>` is the Telegram username *without* the `@`, e.g. `clashreport`, `IntelSlava`, `IranIntl_En`. The skill **does not** follow the `t.me/s/<slug>` → `t.me/<slug>` redirect — a redirect means the channel has no public preview (private, broadcast-only, or wrong slug).

## Data layout

All state lives under `~/.local/share/showrun/data/telegram-osint/`:

- `channels.json` — subscribed channels + descriptions (seeded on first run with ~6 working Middle East / Russia OSINT channels)
- `cache/<channel>/latest.json` — most recent fetch for one channel

## Seeded channels (first run)

| Channel | Description | Language |
|---|---|---|
| `clashreport` | Clash Report — conflict news aggregator | English |
| `IntelSlava` | Intel Slava Z — Russian-leaning aggregator | English |
| `IranIntl_En` | Iran International — opposition media | English |
| `ASBMilitary` | ASB Military — Israeli defense analysis | English |
| `rybar_en` | Rybar — Russian military analysis | Russian |
| `abualiexpress` | Abu Ali Express — Israeli analysis | Hebrew |

Edit via `subscribe` / `unsubscribe` — do not edit the script.

## Output schema

`cache/<channel>/latest.json`:

```json
{
  "fetched_at": "2026-04-10T12:34:56Z",
  "channel": "clashreport",
  "channel_description": "...",
  "count": 20,
  "messages": [
    {
      "id": "clashreport/79149",
      "url": "https://t.me/clashreport/79149",
      "ts": "2026-04-10T08:12:00Z",
      "text": "plain text, HTML stripped",
      "links": ["https://..."],
      "image_url": "https://... or null",
      "views": "12.3K"
    }
  ]
}
```

Message `id` is stable (`<channel>/<numeric_id>`) so re-fetches overwrite `latest.json` cleanly.

## Finding new channels

Telegram has no public search API. To add a channel, you need its username (the `t.me/<slug>` path). Best sources:

- Citations in OSINT reporting (Bellingcat, ISW, NYT Visual Investigations) often link directly
- `clashreport` and `IntelSlava` frequently quote other channels by `@handle`
- Twitter/X profiles of analysts often list their Telegram in bio

Once you know the slug, `verify <channel>` HEAD-checks it without writing to the cache. If verify succeeds, `subscribe <channel> "description"`.

## Known pitfalls

- **Redirect trap**: a bogus slug returns HTTP 302 → the bare profile page. The script raises an error explicitly instead of silently returning empty. Don't "fix" this by following redirects.
- **Language**: slug suffixes like `_en` are not always honored (e.g. `rybar_en` serves Russian). Verify language after first fetch.
- **No history**: `t.me/s/` only exposes the most recent ~15-20 messages. Each `fetch` overwrites `latest.json` for that channel.
- **No rate limit docs**: Telegram doesn't publish limits for `t.me/s/` previews. The script sleeps 2s between channels in `fetch-all`. If you hit blocks, increase the delay — don't go parallel.
