# pitchbook-deal-feed

Fetch recent deals from Pitchbook's deal feed with optional filters for verticals, deal types, and locations.

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
node scripts/pitchbook-deal-feed.mjs auth
```

## Usage

### Fetch recent deals

```bash
node scripts/pitchbook-deal-feed.mjs feed [--limit=10] [--days=365] [--verticals=...] [--deal-types=...] [--locations=...]
```

**Examples:**
```bash
node scripts/pitchbook-deal-feed.mjs feed
node scripts/pitchbook-deal-feed.mjs feed --limit=5 --days=30
node scripts/pitchbook-deal-feed.mjs feed --limit=20 --verticals=VC,PE
node scripts/pitchbook-deal-feed.mjs feed --deal-types=SERIES_A --locations=US
```

### Show help

```bash
node scripts/pitchbook-deal-feed.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`feed`** — POSTs to `web-api/dashboard-platform-service/v3/private/data-sourcing/recent-deals` via curl with filter parameters. Returns an array of deal objects. Each deal includes:
   - `company.pbId` — Pitchbook company ID
   - `company.name` — company name
   - `dealSynopsis` — brief description of the deal
   - `lastFinancingDate` — date of last financing
   - `lastFinancingSize` — size of last financing round
   - `totalRaised` — total amount raised
   - `dealType` — e.g. `SERIES_A`, `SERIES_B`

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                         # Auth headers & cookies
└── cache/
    └── deal-feed-<timestamp>.json       # Cached deal feed results
```

## Output handling (important for agents)

Deal feed results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-deal-feed.mjs feed --limit=10 > /tmp/pb-deals.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/deal-feed-*.json | tail -1
```

The console summary (printed to stderr) shows a brief list of deals. For the full response, read the cache file — but only the lines you need. **Never dump full deal results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
