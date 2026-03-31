# pitchbook-login

Authenticate with Pitchbook and save session headers for API access.

## Prerequisites

- Node.js 22+
- Chrome browser
- `curl` with HTTP/2 support — verify with `curl --version` (look for `HTTP2`)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill) skill (auto-installed by `interactive` command)

### Installing curl with HTTP/2

If `curl --version` does not show `HTTP2`:

- **macOS:** `brew install curl` then `export CURL_BINARY=/opt/homebrew/opt/curl/bin/curl`
- **Debian/Ubuntu:** `sudo apt-get install -y curl`
- **Fedora/RHEL:** `sudo dnf install -y curl`
- **Arch:** `sudo pacman -S curl`

## Usage

### Interactive login (recommended)

```bash
node scripts/pitchbook-login.mjs interactive
```

Connects to your running Chrome browser via CDP, finds the Pitchbook tab, and captures session cookies. The user just needs to:

1. Enable Chrome remote debugging: open `chrome://inspect/#remote-debugging` and toggle the switch
2. Log in to `my.pitchbook.com` in Chrome
3. Run the command above

The [chrome-cdp](https://github.com/pasky/chrome-cdp-skill) skill is auto-installed on first use. If no Pitchbook tab is found, the script will wait up to 3 minutes for the user to open and log in.

### CDP auto-login

```bash
node scripts/pitchbook-login.mjs auth
```

Automates login via Chrome DevTools Protocol — navigates to Pitchbook, types email/password, handles TOTP, and captures session headers. Requires env vars and Chrome with CDP enabled.

### Copy as cURL (manual fallback)

```bash
node scripts/pitchbook-login.mjs curl <file>
node scripts/pitchbook-login.mjs curl -          # read from stdin
```

The user copies any request to `my.pitchbook.com` as cURL from browser DevTools. The script extracts headers and cookies from the curl string and saves the session.

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

1. **Try `interactive` first** — connects to the user's own Chrome, no credentials needed
2. **If Chrome not reachable** → ask user to enable remote debugging at `chrome://inspect/#remote-debugging`
3. **If all else fails** → ask user to paste a curl string from their browser

## How it works

1. **`interactive`** — Auto-installs chrome-cdp skill if needed. Connects to Chrome via CDP (reads `DevToolsActivePort` file), finds a Pitchbook tab, captures cookies via `Network.getCookies` and user-agent. Saves session to disk.

2. **`auth`** — Connects to Chrome via CDP, navigates to Pitchbook, fills login form via `Runtime.evaluate`, enters TOTP, then captures cookies. Saves session to disk.

3. **`curl`** — Parses a raw curl command string (from browser "Copy as cURL"). Extracts all `-H` headers and cookie values. Saves session to disk.

4. **`camoufox`** — Launches camoufox, performs automated login, triggers a search request to capture headers via Playwright's `request.allHeaders()`. Saves session to disk.

## Data storage

```
~/.local/share/showrun/data/pitchbook/
└── session.json    # Auth headers & cookies
```

## Session expiry

Sessions expire after ~30 min. If you see `Session expired` or `HTTP 401`, re-authenticate. `interactive` is fastest for refresh — just re-run the command (no re-login needed if Chrome is still logged in).

## Environment variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `PITCHBOOK_EMAIL` | auth, camoufox | Login email |
| `PITCHBOOK_PASSWORD` | auth, camoufox | Password |
| `PITCHBOOK_OTP_SECRET` | auth, camoufox | TOTP base32 secret |
| `PITCHBOOK_USERNAME` | auth, camoufox | Display name (for login verification) |
| `CDP_SCRIPT` | Optional | Path to chrome-cdp script (auto-detected) |
| `CURL_BINARY` | Optional | Path to curl binary |
