# pitchbook-market-maps

Fetch published market maps from Pitchbook.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill (for `auth`)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Valid session (run login first)

## Setup

One-time authentication — see [pitchbook-login](../pitchbook-login/SKILL.md) for all methods. Preferred:

```bash
node ../pitchbook-login/scripts/pitchbook-login.mjs auth    # CDP auto-login
```

Or capture via CDP from an already-logged-in tab:

```bash
node scripts/pitchbook-market-maps.mjs auth
```

## Usage

### List published market maps

```bash
node scripts/pitchbook-market-maps.mjs list [--verticals=X] [--deal-types=X] [--locations=X]
```

**Examples:**
```bash
node scripts/pitchbook-market-maps.mjs list
node scripts/pitchbook-market-maps.mjs list --verticals=AI
node scripts/pitchbook-market-maps.mjs list --deal-types=VC --locations=US
```

### Show help

```bash
node scripts/pitchbook-market-maps.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`list`** — POSTs to `web-api/market-map-bff/api/v1/market-map-dashboard/published` via curl with optional filters (`dealTypes`, `locations`, `verticals`). Returns published market maps. The console summary prints:
   - If the response is an array: count and names/titles of each map.
   - If the response is an object: top-level keys with array lengths and item previews.

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                              # Auth headers & cookies
└── cache/
    └── market-maps-<timestamp>.json          # Cached market map results
```

## Output handling (important for agents)

Market map results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-market-maps.mjs list > /tmp/pb-market-maps.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/market-maps-*.json
```

The console summary (printed to stderr) shows a brief overview. For the full response, read the cache file — but only the lines you need. **Never dump full results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
