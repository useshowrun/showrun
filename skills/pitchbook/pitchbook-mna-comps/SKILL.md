# pitchbook-mna-comps

Fetch M&A comparable transactions for a company from Pitchbook.

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
node scripts/pitchbook-mna-comps.mjs auth
```

## Usage

### Fetch M&A comps

```bash
node scripts/pitchbook-mna-comps.mjs comps <pbId>
```

**Parameters:**
- `pbId` (required) — Pitchbook company ID (e.g. `46488-07`)

**Examples:**
```bash
node scripts/pitchbook-mna-comps.mjs comps 46488-07
node scripts/pitchbook-mna-comps.mjs comps 434438-06
```

### Show help

```bash
node scripts/pitchbook-mna-comps.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`comps`** — GETs from `web-api/dashboard-platform-service/v2/private/mergers-and-acquisitions/comps?pbId={pbId}` via curl. Returns a `data` array of comparable M&A transactions (~5 results). Each item includes:
   - `company.pbId` — Pitchbook entity ID
   - `company.name` — company name
   - `company.type` — entity type

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── mna-comps-<pbId>.json       # Cached M&A comps results
```

## Output handling (important for agents)

M&A comps results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-mna-comps.mjs comps 46488-07 > /tmp/pb-comps.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/mna-comps-46488-07.json
```

The console summary (printed to stderr) shows a brief list of comparable companies. For the full response, read the cache file — but only the lines you need. **Never dump full results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
