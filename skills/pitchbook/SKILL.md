# Pitchbook Agent Browser Skills

Scrape financial data from Pitchbook (company profiles, deal history, team members) using captured browser sessions.

## Prerequisites

- Node.js 22+ (uses built-in `WebSocket`)
- `curl` with HTTP/2 support (used for all API requests)
- Chrome (for `auth` and `curl` session capture methods)

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

One-time authentication — three methods available (fastest first):

### Method 1: Copy as cURL (easiest)

1. Open `https://my.pitchbook.com` in Chrome and log in
2. Open DevTools (F12) → Network tab
3. Right-click any request to `my.pitchbook.com` → **Copy** → **Copy as cURL**
4. Save to a file and run:
   ```bash
   pbpaste > /tmp/pb-curl.txt                                    # macOS
   node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
   ```
   Or pipe directly:
   ```bash
   pbpaste | node pitchbook-login/scripts/pitchbook-login.mjs curl -    # macOS
   xclip -o | node pitchbook-login/scripts/pitchbook-login.mjs curl -   # Linux
   ```

**Agent guidance:** When the user needs to authenticate, suggest this method first. Ask the user to copy a request as cURL from their browser DevTools and paste it. The agent can save the pasted string to a temp file and run the `curl` subcommand.

### Method 2: CDP capture (~10s)

1. Launch Chrome with CDP:
   ```bash
   google-chrome --remote-debugging-port=9222
   ```
2. Log into Pitchbook manually at `https://my.pitchbook.com`
3. Run:
   ```bash
   node pitchbook-login/scripts/pitchbook-login.mjs auth
   ```

### Method 3: Automated login (~60-90s)

Requires npm packages installed in the data directory and env vars set. See [pitchbook-login/SKILL.md](pitchbook-login/SKILL.md) for details.

### Environment variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `CURL_BINARY` | Optional | Path to curl binary (default: `curl`) |
| `CHROME_CDP_URL` | Optional | CDP endpoint (default: `http://localhost:9222`) |
| `PITCHBOOK_EMAIL` | Automated login | Login email |
| `PITCHBOOK_PASSWORD` | Automated login | Password |
| `PITCHBOOK_OTP_SECRET` | Automated login | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | Automated login | Display name (for verification) |

## Available skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Login](pitchbook-login/SKILL.md) | `pitchbook-login/scripts/pitchbook-login.mjs` | Authenticate via cURL import, CDP, or automated login |
| [Search](pitchbook-search/SKILL.md) | `pitchbook-search/scripts/pitchbook-search.mjs` | Search companies by domain/name |
| [Company](pitchbook-company/SKILL.md) | `pitchbook-company/scripts/pitchbook-company.mjs` | Fetch full company profile (6 endpoints) |

## Typical workflow

```
1. Capture session   →  node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
2. Search company    →  node pitchbook-search/scripts/pitchbook-search.mjs search openai.com
3. Fetch profile     →  node pitchbook-company/scripts/pitchbook-company.mjs get <companyId>
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

## Session expiry

Captured headers expire after ~30 minutes. If you see `Session expired`, re-authenticate using any method above. The `curl` import method is the fastest way to refresh — just copy a fresh request from the browser.
