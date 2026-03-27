# pitchbook-login

Authenticate with Pitchbook and save session headers for API access.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill (for `auth` command)
- Chrome with remote debugging enabled: `google-chrome --remote-debugging-port=9222`
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- For `camoufox`: `camoufox-js` and `otpauth` npm packages installed in `~/.local/share/showrun/data/pitchbook/`

### Installing curl with HTTP/2

If `curl --version` does not show `HTTP2`:

- **macOS:** `brew install curl` then `export CURL_BINARY=/opt/homebrew/opt/curl/bin/curl`
- **Debian/Ubuntu:** `sudo apt-get install -y curl`
- **Fedora/RHEL:** `sudo dnf install -y curl`
- **Arch:** `sudo pacman -S curl`

## Usage

### CDP auto-login (preferred)

```bash
node scripts/pitchbook-login.mjs auth
```

Automates login via Chrome DevTools Protocol — navigates to Pitchbook, types email/password, handles TOTP, and captures session headers. Requires env vars and Chrome with CDP enabled.

If a CAPTCHA is detected, the script exits with a message suggesting `camoufox` or `curl` fallback.

### Copy as cURL (manual fallback)

```bash
node scripts/pitchbook-login.mjs curl <file>
node scripts/pitchbook-login.mjs curl -          # read from stdin
```

The user copies any request to `my.pitchbook.com` as cURL from browser DevTools. The script extracts headers and cookies from the curl string and saves the session.

**Agent guidance:** When CDP login fails (CAPTCHA, bot detection), ask the user to:
1. Open `my.pitchbook.com` in Chrome and log in manually
2. Open DevTools (F12) → Network tab
3. Right-click any request to `my.pitchbook.com` → Copy → Copy as cURL
4. Paste it — the agent saves the string to a temp file and runs `curl <file>`

### Camoufox fallback (anti-detect browser)

```bash
node scripts/pitchbook-login.mjs camoufox
```

Uses camoufox (anti-detect Firefox) to bypass bot detection. Use when `auth` fails due to CAPTCHA.

### Show help

```bash
node scripts/pitchbook-login.mjs
```

## Auth priority for agents

1. **Try `auth` first** — CDP auto-login is fastest and requires no user interaction
2. **If CAPTCHA** → try `camoufox` (if npm deps installed and display available)
3. **If camoufox fails** → ask user to paste a curl string from their browser

## How it works

1. **`auth`** — Connects to Chrome via CDP ([chrome-cdp](../../chrome-cdp) skill), navigates to Pitchbook, fills login form via `Runtime.evaluate`, enters TOTP, then captures cookies via `Network.getCookies`. Saves session to disk.

2. **`curl`** — Parses a raw curl command string (from browser "Copy as cURL"). Extracts all `-H` headers and cookie values. Saves session to disk.

3. **`camoufox`** — Launches camoufox, performs automated login, triggers a search request to capture headers via Playwright's `request.allHeaders()`. Saves session to disk.

## Data storage

```
~/.local/share/showrun/data/pitchbook/
└── session.json    # Auth headers & cookies
```

## Session expiry

Sessions expire after ~30 min. If you see `Session expired` or `HTTP 401`, re-authenticate. CDP `auth` is fastest for refresh.

## Environment variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `PITCHBOOK_EMAIL` | auth, camoufox | Login email |
| `PITCHBOOK_PASSWORD` | auth, camoufox | Password |
| `PITCHBOOK_OTP_SECRET` | auth, camoufox | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | auth, camoufox | Display name (for login verification) |
| `CDP_SCRIPT` | Optional | Path to chrome-cdp script |
| `CURL_BINARY` | Optional | Path to curl binary |
