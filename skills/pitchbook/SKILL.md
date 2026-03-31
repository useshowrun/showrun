# Pitchbook Agent Browser Skills

Scrape financial data from Pitchbook (company profiles, deal history, team members) using captured browser sessions.

## Prerequisites

- Node.js 22+
- `curl` with HTTP/2 support (used for all API requests)
- Chrome with remote debugging enabled (for session capture)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill) skill (auto-installed on first use)

### curl with HTTP/2

All API requests use `curl` with `--http2` and `--tlsv1.3` for TLS fingerprint compatibility. Verify your curl supports HTTP/2:

```bash
curl --version   # look for "HTTP2" in the features list
```

If HTTP/2 is missing, install an updated curl:

- **macOS (Homebrew):** `brew install curl` — then `export CURL_BINARY=/opt/homebrew/opt/curl/bin/curl`
- **Debian/Ubuntu:** `sudo apt-get install -y curl`
- **Fedora/RHEL:** `sudo dnf install -y curl`
- **Arch:** `sudo pacman -S curl`

Set `CURL_BINARY` env var if the correct curl is not at the default path. The scripts will check for HTTP/2 support at startup and print install instructions if missing. If running without sudo, the agent should attempt to install curl using the appropriate package manager. On macOS, Homebrew does not require sudo.

## Setup

### Recommended: Interactive login

1. Enable Chrome remote debugging: open `chrome://inspect/#remote-debugging` and toggle the switch
2. Log in to [my.pitchbook.com](https://my.pitchbook.com) in Chrome
3. Run:
```bash
node pitchbook-login/scripts/pitchbook-login.mjs interactive
```

The `interactive` command auto-installs the [chrome-cdp](https://github.com/pasky/chrome-cdp-skill) skill, connects to your Chrome browser, and captures the session cookies. No credentials or env vars needed.

**Agent guidance:** If no session is found, run `interactive` login. If Chrome remote debugging is not enabled, instruct the user to open `chrome://inspect/#remote-debugging` and toggle the switch. This is the only step requiring user action.

### Alternative: Power-user authentication

For headless environments or automated setups:

#### CDP auto-login (requires env vars)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs auth
```

#### Copy as cURL (manual fallback)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
```

#### Camoufox (anti-detect browser)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs camoufox
```

### Loading environment variables

Environment variables are only needed for power-user auth methods (auth, camoufox):

```bash
export $(cat skills/pitchbook/.env | xargs)    # from repo root
# or
export $(cat .env | xargs)                     # from skills/pitchbook/
```

### Environment variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `CURL_BINARY` | Optional | Path to curl binary (default: `curl`) |
| `CDP_SCRIPT` | Optional | Path to chrome-cdp script (auto-detected) |
| `PITCHBOOK_EMAIL` | auth, camoufox | Login email |
| `PITCHBOOK_PASSWORD` | auth, camoufox | Password |
| `PITCHBOOK_OTP_SECRET` | auth, camoufox | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | auth, camoufox | Display name (for verification) |

## Available skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Login](pitchbook-login/SKILL.md) | `pitchbook-login/scripts/pitchbook-login.mjs` | Authenticate via interactive login, CDP, or curl import |
| [Search](pitchbook-search/SKILL.md) | `pitchbook-search/scripts/pitchbook-search.mjs` | Search companies by domain/name |
| [Company](pitchbook-company/SKILL.md) | `pitchbook-company/scripts/pitchbook-company.mjs` | Fetch full company profile (6 endpoints) |
| [Deal Feed](pitchbook-deal-feed/SKILL.md) | `pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs` | Fetch recent deal flow with filters |
| [M&A Comps](pitchbook-mna-comps/SKILL.md) | `pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs` | Fetch comparable M&A transactions |
| [Investors](pitchbook-investors/SKILL.md) | `pitchbook-investors/scripts/pitchbook-investors.mjs` | Discover active investors |
| [Valuations](pitchbook-valuations/SKILL.md) | `pitchbook-valuations/scripts/pitchbook-valuations.mjs` | Deal valuation multiples by year |
| [Hover](pitchbook-hover/SKILL.md) | `pitchbook-hover/scripts/pitchbook-hover.mjs` | Fast company summary (single endpoint) |
| [Market Maps](pitchbook-market-maps/SKILL.md) | `pitchbook-market-maps/scripts/pitchbook-market-maps.mjs` | Published market map listings |
| [Advanced Search](pitchbook-advanced-search/SKILL.md) | `pitchbook-advanced-search/scripts/pitchbook-advanced-search.mjs` | Screener: create, run, and paginate search results |

## Typical workflow

```
1. Authenticate       →  node pitchbook-login/scripts/pitchbook-login.mjs interactive
2. Search company     →  node pitchbook-search/scripts/pitchbook-search.mjs search openai.com
3. Fetch profile      →  node pitchbook-company/scripts/pitchbook-company.mjs get <companyId>
```

## Data storage

```
~/.local/share/showrun/data/pitchbook/
├── session.json              # Auth headers & cookies
└── cache/
    ├── search-<query>.json   # Search results
    └── company-<id>.json     # Full company profiles
```

## Output handling (important for agents)

**Pitchbook API responses are large.** A single company profile can be 500KB+ of JSON across 6 endpoints. To preserve context window space:

1. **Always redirect script output to a file** — never let raw JSON fill the conversation:
   ```bash
   node pitchbook-search/scripts/pitchbook-search.mjs search openai.com > /tmp/pb-search.json 2>&1
   node pitchbook-company/scripts/pitchbook-company.mjs get 123456-78 > /tmp/pb-company.json 2>&1
   ```
2. **Read cached results from disk with truncation** — scripts automatically save structured output to `~/.local/share/showrun/data/pitchbook/cache/`. Read only the first ~100 lines to get an overview, then target specific keys:
   ```bash
   head -100 ~/.local/share/showrun/data/pitchbook/cache/company-123456-78.json
   ```
3. **Use `--sections` to limit what you fetch** — only request the sections you actually need:
   ```bash
   node pitchbook-company/scripts/pitchbook-company.mjs get 123456-78 --sections=generalInfo
   ```
4. **Never dump full API responses into the conversation.** Summarize findings in your own words and reference the cache file path so the user can inspect the raw data if needed.

## Rate limiting

Pitchbook does not publish rate limits, but aggressive scraping triggers session invalidation or account warnings.

- **Wait at least 8 seconds** between API calls
- **Use `--limit` flags** to request only the data you need
- **Advanced search** has built-in 6-second delays between its 6 API steps (~36s total)
- If you get a 401, the session likely expired — re-authenticate, don't retry rapidly

## Session expiry

Captured headers expire after ~30 minutes. If you see `Session expired`, re-authenticate. `interactive` is fastest for refresh (just re-run — no re-login needed if Chrome is still logged in).
