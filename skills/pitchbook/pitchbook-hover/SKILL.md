# pitchbook-hover

Fetch a quick company hover summary from Pitchbook by company ID. Much faster than a full company profile (1 endpoint vs 6).

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
node scripts/pitchbook-hover.mjs auth
```

## Usage

**Prerequisite:** You need a Pitchbook company ID (`pbId`). Use `pitchbook-search` to find it first:
```bash
node ../pitchbook-search/scripts/pitchbook-search.mjs search "company name"
```

### Fetch company hover card

```bash
node scripts/pitchbook-hover.mjs get <pbId>
```

**Examples:**
```bash
node scripts/pitchbook-hover.mjs get 12345-67
node scripts/pitchbook-hover.mjs get 54321-99
```

### Show help

```bash
node scripts/pitchbook-hover.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`get`** — GETs `web-api/entity-hover-platform-service/company/{pbId}` via curl. Returns a summary including:
   - `entityName.name` — company name (plus `symbol` / `stockExchange` if public)
   - `officialName` — legal name
   - `description` — short company description
   - `location` — headquarters
   - `website` — company URL
   - `primaryIndustry` / `gecsIndustry` — industry classification
   - `verticals[]` — vertical tags
   - `activeInvestors[]` / `formerInvestors[]` — investor lists with pbId, name, type
   - `businessStatus` / `financingStatus` / `ownershipStatus` — current status
   - `lastFinancingDate` — date of most recent financing
   - `countOfCompetitors` — number of known competitors

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── hover-<pbId>.json           # Cached hover result
```

## Output handling (important for agents)

The console prints a concise summary. For the full response, read the cache file:

```bash
node scripts/pitchbook-hover.mjs get 12345-67 > /tmp/pb-hover.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/hover-12345-67.json
```

## Session expiry

If you see `Session expired`, re-authenticate. Fastest: `node ../pitchbook-login/scripts/pitchbook-login.mjs auth`. See [pitchbook-login](../pitchbook-login/SKILL.md) for fallbacks.
