# Pitchbook Agent Browser Skills

Scrape financial data from Pitchbook (company profiles, deal history, team members) using captured browser sessions.

## Prerequisites

- Node.js 22+
- `curl` with HTTP/2 support (used for all API requests)
- A browser with an active Pitchbook session (for automatic cookie extraction)
- Optional: [chrome-cdp](../chrome-cdp) skill, camoufox (for power-user auth methods)

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

### Recommended: Browser cookies (zero setup)

Just log in to [my.pitchbook.com](https://my.pitchbook.com) in your browser. The skills automatically extract your session cookies. No configuration needed.

If a skill reports that no session was found, ask the user to log in to Pitchbook in their browser and try again.

**One-time dependency install:**
```bash
cd ~/.local/share/showrun/data/pitchbook && npm install @mherod/get-cookie
```

### Alternative: Power-user authentication

For headless environments or when browser cookie extraction isn't available:

#### Browser cookie extraction (explicit)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs browser
```

#### CDP auto-login
Requires Chrome with CDP and env vars set:
```bash
google-chrome --remote-debugging-port=9222
node pitchbook-login/scripts/pitchbook-login.mjs auth
```

#### Camoufox (if CAPTCHA blocks CDP)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs camoufox
```

**Headless Linux:** Prefix with `xvfb-run`:
```bash
xvfb-run node pitchbook-login/scripts/pitchbook-login.mjs camoufox
```

#### Copy as cURL (manual fallback)
```bash
node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
```

**Agent guidance:** Skills automatically extract browser cookies — no auth commands needed in normal use. If auto-extraction fails, ask the user to log in to my.pitchbook.com in their browser and let you know when they're done, then retry. Only use explicit auth commands as fallbacks.

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
| `CDP_SCRIPT` | Optional | Path to chrome-cdp script |
| `PITCHBOOK_EMAIL` | auth, camoufox | Login email |
| `PITCHBOOK_PASSWORD` | auth, camoufox | Password |
| `PITCHBOOK_OTP_SECRET` | auth, camoufox | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | auth, camoufox | Display name (for verification) |

## Available skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Login](pitchbook-login/SKILL.md) | `pitchbook-login/scripts/pitchbook-login.mjs` | Authenticate via CDP, camoufox, or curl import |
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
1. Authenticate       →  node pitchbook-login/scripts/pitchbook-login.mjs auth
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

Captured headers expire after ~30 minutes. If you see `Session expired`, re-authenticate. CDP `auth` is fastest for refresh.
