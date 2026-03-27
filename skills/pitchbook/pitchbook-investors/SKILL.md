# pitchbook-investors

Fetch active investors from Pitchbook with optional filters for verticals, deal types, locations, and trailing range.

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
node scripts/pitchbook-investors.mjs auth
```

## Usage

### Fetch active investors

```bash
node scripts/pitchbook-investors.mjs active [options]
```

**Options:**
- `--days=365` — Trailing range in days (default: 365)
- `--verticals=VC,PE` — Filter by verticals (comma-separated)
- `--deal-types=X` — Filter by deal types (comma-separated)
- `--locations=US` — Filter by locations (comma-separated)

**Examples:**
```bash
node scripts/pitchbook-investors.mjs active
node scripts/pitchbook-investors.mjs active --days=30
node scripts/pitchbook-investors.mjs active --verticals=VC,PE --locations=US
```

### Show help

```bash
node scripts/pitchbook-investors.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`active`** — POSTs to `web-api/dashboard-platform-service/v2/private/investors-and-acquirers/ACTIVE_INVESTORS` via curl with filter options. Returns a `data` array with active investor entries. Each item includes:
   - `type` — investor category type
   - `investor.pbId` — Pitchbook investor ID
   - `investor.name` — investor name
   - `investor.type` — investor type classification
   - `investmentsCount` — number of investments in the trailing range
   - `lastInvestmentDate` — date of most recent investment

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                              # Auth headers & cookies
└── cache/
    └── active-investors-<timestamp>.json     # Cached investor results
```

## Output handling (important for agents)

Investor results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-investors.mjs active > /tmp/pb-investors.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/active-investors-*.json
```

The console summary (printed to stderr) shows a brief list of investors. For the full response, read the cache file — but only the lines you need. **Never dump full results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
