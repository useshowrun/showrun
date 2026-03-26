# pitchbook-login

Authenticate with Pitchbook and save session headers for API access.

## Prerequisites

- Node.js 22+ (uses built-in `WebSocket`)
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- Chrome (for `auth` and `curl` methods)
- For `auto`: `camoufox` and `otpauth` npm packages installed in `~/.local/share/showrun/data/pitchbook/` + env vars set

### Installing curl with HTTP/2

If `curl --version` does not show `HTTP2`:

- **macOS:** `brew install curl` then `export CURL_BINARY=/opt/homebrew/opt/curl/bin/curl`
- **Debian/Ubuntu:** `sudo apt-get install -y curl`
- **Fedora/RHEL:** `sudo dnf install -y curl`
- **Arch:** `sudo pacman -S curl`

## Usage

### Copy as cURL (easiest, instant)

```bash
node scripts/pitchbook-login.mjs curl <file>
node scripts/pitchbook-login.mjs curl -          # read from stdin
```

The user copies any request to `my.pitchbook.com` as cURL from browser DevTools. The script extracts headers and cookies from the curl string and saves the session.

**How to get the curl string:**
1. Open `my.pitchbook.com` in Chrome, log in
2. Open DevTools (F12) → Network tab
3. Right-click any request to `my.pitchbook.com` → Copy → Copy as cURL
4. Save to a file or pipe to stdin

**Agent guidance:** This is the recommended auth method. When a user needs to authenticate, suggest they copy a request as cURL from their browser and either paste it for the agent to save to a temp file, or save it themselves. The agent should write the pasted string to a temp file and run `node pitchbook-login.mjs curl /tmp/pb-curl.txt`.

### CDP capture (~10s)

```bash
node scripts/pitchbook-login.mjs auth
node scripts/pitchbook-login.mjs auth --cdp-url=http://localhost:9222
```

Connects to Chrome via CDP, finds a Pitchbook tab, triggers a search API request, and captures the request headers and cookies.

### Automated login (~60-90s)

```bash
node scripts/pitchbook-login.mjs auto
```

Launches camoufox (anti-detect Firefox), logs in with email/password/TOTP, and captures headers.

### Show help

```bash
node scripts/pitchbook-login.mjs
```

## How it works

1. **`curl`** — Parses a raw curl command string (from browser "Copy as cURL"). Extracts all `-H` headers and `-b`/`--cookie` values. Cleans up non-replayable headers (`accept-encoding`, `content-length`). Saves session to disk.

2. **`auth`** — Connects to Chrome via CDP, enables Network domain, types into the Pitchbook search bar to trigger an API request, captures the request headers and cookies via `Network.requestWillBeSent`, saves session to disk.

3. **`auto`** — Launches camoufox, navigates to Pitchbook login, fills email/password/TOTP fields, verifies login, triggers a search to capture headers, saves session to disk.

## Data storage

```
~/.local/share/showrun/data/pitchbook/
└── session.json    # Auth headers & cookies
```

## Session expiry

If you see `Session expired` or `Failed (HTTP 401)`, your session has expired (~30 min). Re-authenticate using any method. The `curl` import is fastest — just copy a fresh request from the browser.
