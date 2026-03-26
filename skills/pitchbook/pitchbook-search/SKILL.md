# pitchbook-search

Search Pitchbook for companies by domain, name, or any search term.

## Prerequisites

- Node.js 22+ (uses built-in `WebSocket`)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Valid session (run login first)

## Setup

One-time authentication — see [pitchbook-login](../pitchbook-login/SKILL.md) for all methods. Quickest:

```bash
# Copy any my.pitchbook.com request as cURL from browser DevTools, save to file
node ../pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
```

Or via CDP:

```bash
node scripts/pitchbook-search.mjs auth
```

## Usage

### Search companies

```bash
node scripts/pitchbook-search.mjs search <query> [--limit=5]
```

**Examples:**
```bash
node scripts/pitchbook-search.mjs search openai.com
node scripts/pitchbook-search.mjs search "Stripe Inc" --limit=10
node scripts/pitchbook-search.mjs search anthropic
```

### Show help

```bash
node scripts/pitchbook-search.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`search`** — POSTs to `web-api/general-search/search/mixed` via curl with the query. Returns an `items` array with company matches. Each item includes:
   - `value.profileResult.id` — Pitchbook company ID (use with `pitchbook-company`)
   - `value.profileResult.name` — company name
   - `matchParams.matchType` — e.g. `EXACT`, `PARTIAL`
   - `matchParams.nameType` — e.g. `WEBSITE`, `LEGAL_NAME`

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── search-<query>.json         # Cached search results
```

## Output handling (important for agents)

Search results can be large. **Always redirect output to a file** and read the cached result from disk with truncation:

```bash
node scripts/pitchbook-search.mjs search openai.com > /tmp/pb-search.json 2>&1
head -50 ~/.local/share/showrun/data/pitchbook/cache/search-openai_com.json
```

The console summary (printed to stderr) shows a brief list of matches. For the full response, read the cache file — but only the lines you need. **Never dump full search results into the conversation.**

## Session expiry

If you see `Session expired`, re-authenticate. Quickest: copy a fresh request as cURL from the browser. See [pitchbook-login](../pitchbook-login/SKILL.md).
