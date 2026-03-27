# Pitchbook Agent Browser Skills

Scrape financial data from Pitchbook (company profiles, deal history, team members) using captured browser sessions.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../chrome-cdp) skill (for CDP auto-login)
- Chrome with remote debugging: `google-chrome --remote-debugging-port=9222`
- `curl` with HTTP/2 support (used for all API requests)

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

One-time authentication — three methods available (in order of preference):

### Method 1: CDP auto-login (preferred)

Requires Chrome with CDP and env vars set. Fully automated — types credentials and handles TOTP:

```bash
google-chrome --remote-debugging-port=9222
node pitchbook-login/scripts/pitchbook-login.mjs auth
```

### Method 2: Camoufox (if CAPTCHA blocks CDP)

Anti-detect browser that can bypass bot detection. Use when `auth` fails due to CAPTCHA:

```bash
node pitchbook-login/scripts/pitchbook-login.mjs camoufox
```

Requires npm packages: `cd ~/.local/share/showrun/data/pitchbook && npm init -y && npm install camoufox-js otpauth`

### Method 3: Copy as cURL (manual fallback)

When both automated methods fail, ask the user to copy a request from their browser:

1. Open `https://my.pitchbook.com` in Chrome and log in
2. Open DevTools (F12) → Network tab
3. Right-click any request to `my.pitchbook.com` → **Copy** → **Copy as cURL**
4. Save to a file and run:
   ```bash
   node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
   ```
   Or pipe directly:
   ```bash
   pbpaste | node pitchbook-login/scripts/pitchbook-login.mjs curl -    # macOS
   xclip -o | node pitchbook-login/scripts/pitchbook-login.mjs curl -   # Linux
   ```

**Agent guidance:** When the user needs to authenticate, try `auth` first. If it fails due to CAPTCHA, try `camoufox`. If that also fails, ask the user to paste a curl string from their browser DevTools.

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

## Session expiry

Captured headers expire after ~30 minutes. If you see `Session expired`, re-authenticate. CDP `auth` is fastest for refresh.
