# pitchbook-valuations

Fetch recent deal multiples and valuation data from Pitchbook.

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
node scripts/pitchbook-valuations.mjs auth
```

## Usage

### Fetch deal multiples

```bash
node scripts/pitchbook-valuations.mjs multiples [--days=365] [--verticals=X] [--deal-types=X] [--locations=X]
```

**Examples:**
```bash
node scripts/pitchbook-valuations.mjs multiples
node scripts/pitchbook-valuations.mjs multiples --days=730
node scripts/pitchbook-valuations.mjs multiples --verticals=SaaS --deal-types=Buyout
node scripts/pitchbook-valuations.mjs multiples --locations=US,Europe
```

### Show help

```bash
node scripts/pitchbook-valuations.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`multiples`** — POSTs to `web-api/dashboard-platform-service/v2/private/valuations/recent-deal-multiples` via curl. Returns a `data` array with yearly deal multiples. Each entry includes:
   - `year` — calendar year
   - `dealCount` — number of deals
   - `capitalInvestedMedian` — median capital invested
   - `preMoneyValuationMedian` — median pre-money valuation
   - `postValuationMedian` — median post-money valuation
   - `valuationEbitdaMedian` — median EV/EBITDA multiple
   - `valuationRevenueMedian` — median EV/Revenue multiple

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── valuations-<timestamp>.json # Cached valuation results
```

## Output handling (important for agents)

Results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-valuations.mjs multiples > /tmp/pb-valuations.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/valuations-*.json
```

The console summary (printed to stderr) shows a table of year, deal count, EV/EBITDA median, and EV/Revenue median. For the full response, read the cache file — but only the lines you need. **Never dump full results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
