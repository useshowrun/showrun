# Pitchbook Agent Browser Skills

Scrape financial data from Pitchbook (company profiles, deal history, team members) using captured browser sessions.

## Prerequisites

### curl
Must support HTTP/2 and TLS v1.3. Verify with:
```bash
curl --version
```
Look for `HTTP2` and `TLSv1.3` in features/protocols. On macOS, the system curl may lack HTTP/2 — use Homebrew curl (`/opt/homebrew/opt/curl/bin/curl`). Set `CURL_BINARY` env var if curl is not at the default path.

### Node.js 22+
Required for built-in `WebSocket` (used by CDP scripts). Check with `node --version`.

### Chrome/Chromium
Required for CDP header capture (preferred login method). Launch with:
```bash
google-chrome --remote-debugging-port=9222
# or on macOS:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `PITCHBOOK_EMAIL` | Automated login | Login email |
| `PITCHBOOK_PASSWORD` | Automated login | Password |
| `PITCHBOOK_OTP_SECRET` | Automated login | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | Automated login | Display name (for verification) |
| `CURL_BINARY` | Optional | Path to curl binary (default: `curl`) |
| `CHROME_CDP_URL` | Optional | CDP endpoint (default: `http://localhost:9222`) |

### Install Dependencies
```bash
cd pitchbook && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Login — CDP Capture](pitchbook-login/SKILL.md) | `pitchbook-login/scripts/pitchbook-capture-headers.mjs` | Capture headers from running Chrome (preferred, ~10s) |
| [Login — Automated](pitchbook-login/SKILL.md) | `pitchbook-login/scripts/pitchbook-login.mjs` | Full automated login via camoufox (~60-90s) |
| [Search](pitchbook-search/SKILL.md) | `pitchbook-search/scripts/pitchbook-search.mjs` | Search companies by domain/name |
| [Company](pitchbook-company/SKILL.md) | `pitchbook-company/scripts/pitchbook-company.mjs` | Fetch full company profile (6 endpoints) |

## Typical Workflow

```
1. Capture headers    →  node pitchbook-login/scripts/pitchbook-capture-headers.mjs
2. Search company     →  node pitchbook-search/scripts/pitchbook-search.mjs openai.com
3. Fetch profile      →  node pitchbook-company/scripts/pitchbook-company.mjs <companyId>
```

## Session Management & Logout Handling

Pitchbook aggressively manages sessions and may log users out at any time. Captured headers expire after ~30 minutes.

**If any script returns `SESSION_EXPIRED`:**
1. First try `pitchbook-capture-headers.mjs` — re-capture from running Chrome (fast, ~10s)
2. If the browser session is also dead, fall back to `pitchbook-login.mjs` (automated re-login, ~90s)
3. Max 2 re-login attempts per workflow

**Rate limiting:** Wait 6 seconds between API requests (enforced automatically in company script).

## Chrome CDP Setup

The preferred way to maintain a Pitchbook session:

1. Launch Chrome with CDP enabled:
   ```bash
   google-chrome --remote-debugging-port=9222
   ```
2. Log into Pitchbook manually at `https://my.pitchbook.com`
3. Keep Chrome open — the capture script will grab headers from the live session
4. On session expiry, re-login in Chrome and re-run the capture script

## MongoDB Storage (Recommendation)

For persisting scraped data, save to a `pitchbook.companies` collection with this schema:

```json
{
  "name": "Company Name",
  "domain": "company.com",
  "pb_id": "123456-78",
  "search_result": { },
  "general_info": { },
  "deal_history": { "content": [], "total": 0 },
  "current_team": { },
  "former_team": { },
  "current_board_members": { },
  "former_board_members": { },
  "last_updated": "2026-03-18T12:00:00.000Z"
}
```

Use a 24-hour cache TTL: skip re-fetching if `last_updated` is less than 24 hours ago. This is a recommendation — the agent should implement the save logic as needed.

## Output Format

All scripts write structured output to stdout as `RESULT:{json}`. Logs go to stderr. Parse results by reading lines starting with `RESULT:` from stdout.
