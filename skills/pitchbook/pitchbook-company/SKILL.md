# pitchbook-company

Fetch a full company profile from Pitchbook by company ID.

## Prerequisites

- Node.js 22+ (uses built-in `WebSocket`)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Valid session (run login first)
- Pitchbook company ID (obtain via `pitchbook-search`)

## Setup

One-time authentication — see [pitchbook-login](../pitchbook-login/SKILL.md) for all methods. Quickest:

```bash
# Copy any my.pitchbook.com request as cURL from browser DevTools, save to file
node ../pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
```

Or via CDP:

```bash
node scripts/pitchbook-company.mjs auth
```

## Usage

### Fetch full profile

```bash
node scripts/pitchbook-company.mjs get <companyId>
```

### Fetch specific sections

```bash
node scripts/pitchbook-company.mjs get <companyId> --sections=generalInfo,dealHistory
```

Available sections: `generalInfo`, `dealHistory`, `currentTeam`, `formerTeam`, `currentBoardMembers`, `formerBoardMembers`

### Show help

```bash
node scripts/pitchbook-company.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, captures Pitchbook session headers, saves to disk.

2. **`get`** — Sequentially fetches up to 6 API endpoints via curl with a 6-second delay between each (~36s for all). If a non-auth endpoint fails, its value is set to `{ error: "..." }` and the script continues.

| Section | Endpoint |
|---------|----------|
| `generalInfo` | `/web-api/profiles/{id}/company/general-info` |
| `dealHistory` | `/web-api/deal-debt-experience-bff/companies/{id}/deal-history` |
| `currentTeam` | `/web-api/profiles/{id}/company/executives/current?page=1&pageSize=100` |
| `formerTeam` | `/web-api/profiles/{id}/company/executives/former?page=1&pageSize=100` |
| `currentBoardMembers` | `/web-api/profiles/{id}/company/board-members/current?page=1&pageSize=100` |
| `formerBoardMembers` | `/web-api/profiles/{id}/company/board-members/former?page=1&pageSize=100` |

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json                    # Auth headers & cookies
└── cache/
    └── company-<id>.json           # Full company profile
```

## Output handling (important for agents)

Company profiles are **very large** (500KB+ across 6 endpoints). Dumping raw JSON into the conversation will exhaust the context window.

1. **Always redirect output to a file:**
   ```bash
   node scripts/pitchbook-company.mjs get 123456-78 > /tmp/pb-company.json 2>&1
   ```
2. **Read the cached result with truncation** — get an overview first, then drill into specific sections:
   ```bash
   head -100 ~/.local/share/showrun/data/pitchbook/cache/company-123456-78.json
   ```
3. **Use `--sections` to fetch only what you need.** If the user asks about funding, fetch only `dealHistory`. If they ask about leadership, fetch `currentTeam`:
   ```bash
   node scripts/pitchbook-company.mjs get 123456-78 --sections=dealHistory
   ```
4. **Summarize findings in your own words.** Reference the cache file path so the user can inspect raw data if needed. Never paste full endpoint responses.

## Session expiry

If you see `Session expired`, re-authenticate. Quickest: copy a fresh request as cURL from the browser. See [pitchbook-login](../pitchbook-login/SKILL.md).
