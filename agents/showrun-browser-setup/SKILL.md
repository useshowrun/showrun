---
name: showrun-browser-setup
description: Help users connect a browser profile for ShowRun skills, using local Chrome CDP or Browser Use Cloud persistent profiles/CDP, including login readiness checks and troubleshooting.
---

# ShowRun Browser Setup

Use this when a user needs to set up, verify, or troubleshoot browser access for ShowRun skills.

ShowRun skills often need an authenticated browser session for sources such as PitchBook, Crunchbase, LinkedIn, GovTribe, or similar products. The goal is simple: give ShowRun a usable browser/profile, then verify the target source works.

## Choose the connection mode

Prefer the simplest working option:

1. **Browser Use Cloud persistent profile** — preferred whenever `~/.config/showrun/browser-use.env` has `BROWSER_USE_API_KEY` and `BROWSER_USE_PROFILE_ID`, especially when local Chrome is headless.
2. **Local Chrome/Chromium with CDP** — good only when a visible local browser is available or login is already complete.

Do not ask for raw passwords.
Core invariant: human login handoff → exact live browser CDP endpoint. Background collection without an active human live tab → profile connector/helper.
 The user should log in inside the browser/profile.

## Browser Use Cloud setup

Use this when the user provides a Browser Use API key and profile ID, or when local visible browser login is unavailable.

Before accepting local CDP, always check for Browser Use credentials:

```bash
set -a; source ~/.config/showrun/browser-use.env; set +a
test -n "${BROWSER_USE_API_KEY:-}" && test -n "${BROWSER_USE_PROFILE_ID:-}" && echo browser-use-ready
```

Expected local config for this clean ShowRun install:

```bash
~/.config/showrun/browser-use.env
```

with:

```bash
BROWSER_USE_API_KEY=bu_...
BROWSER_USE_PROFILE_ID=...
```

Browser Use supports connecting raw automation through CDP:

```text
wss://connect.browser-use.com?apiKey=<key>&profileId=<profile-id>&timeout=15
```

Useful query params:

- `apiKey` — required.
- `profileId` — loads saved browser cookies/localStorage.
- `timeout` — minutes; default 15, max 240.
- `proxyCountryCode` — optional.
- `browserScreenWidth` / `browserScreenHeight` — optional.


### Clean ShowRun helper

In the clean `showrun-test` install, use this helper before touching local CDP:

```bash
~/bin/showrun-browser-use-cdp
~/bin/showrun-browser-use-cdp https://www.linkedin.com/sales/
~/bin/showrun-browser-use-cdp https://www.crunchbase.com/
```

If this succeeds, export `CDP_URL` before using ShowRun source skills so their `chrome-cdp` calls use Browser Use instead of local `127.0.0.1:9222`:

```bash
set -a; source ~/.config/showrun/browser-use.env; set +a
export CDP_URL="wss://connect.browser-use.com?apiKey=${BROWSER_USE_API_KEY}&profileId=${BROWSER_USE_PROFILE_ID}&timeout=15"
```

`skills/chrome-cdp/scripts/cdp.mjs` supports `CDP_URL`, `CHROME_CDP_URL`, and `BROWSER_CDP_URL`; with explicit remote CDP it keeps a browser-level daemon alive so separate CLI calls share the same Browser Use session. If a source skill still fails, report the concrete source-level error. Do not fall back to public web search for gated-source requirements without labeling this as a blocker.

### Login flow

1. Start/open a Browser Use browser session with the persistent `profileId`.
2. Navigate to the target URL, for example LinkedIn Sales Navigator or Crunchbase.
3. Give the user the live browser URL if available, or otherwise tell them where to log in.
4. Wait for the user to finish login.
5. Verify logged-in state with CDP or the relevant ShowRun skill.
6. Stop/close the Browser Use session cleanly when done so profile state persists.

Important: Browser Use profile state is saved when the session is stopped. Do not leave sessions dangling after login/work if the new cookies should persist.

During verification after a human login handoff, if the user is looking at a Browser Use live URL, connect automation to that exact live session, not the profile connector. A live URL usually looks like:

```text
https://live.browser-use.com/?wss=https%3A%2F%2F<session>.free-cdp*.browser-use.com
```

Decode the `wss=` parameter and use its HTTPS origin as CDP:

```bash
export CDP_URL="https://abc.free-cdp0.browser-use.com"
export CHROME_CDP_URL="$CDP_URL"
export BROWSER_CDP_URL="$CDP_URL"
cd "$SHOWRUN_ROOT/skills/chrome-cdp"
node scripts/cdp.mjs list
```

Do not rerun the Browser Use profile helper while checking a just-completed login unless intentionally attaching to/recreating the persistent profile session. Reconnecting through `connect.browser-use.com?profileId=...` can attach to or create a different browser and falsely miss cookies from the live session.

For LinkedIn/Sales Nav, verify browser-wide cookies before running Sales Nav scripts. Use `Storage.getCookies` and confirm at least `li_at` and `JSESSIONID` exist, then confirm the Sales Nav tab is not on `/sales/login`.

### CDP support requirement

If the ShowRun `chrome-cdp` helper cannot use direct `wss://...` CDP URLs yet, report that as the blocker and add/ask for `CDP_URL` support. Do not build source-specific hacks.

## Local Chrome CDP setup

Use a dedicated persistent profile so ShowRun auth does not interfere with the user's normal browser.

### macOS

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/showrun/chrome-profile" \
  --no-first-run \
  "<target-url>" &
```

### Linux

Try whichever browser binary exists: `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `brave`, or `microsoft-edge`.

```bash
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/showrun/chrome-profile" \
  --no-first-run \
  "<target-url>" &
```

Replace `<target-url>` with the source login/home page, for example:

- PitchBook: `https://my.pitchbook.com`
- Crunchbase: `https://www.crunchbase.com`
- LinkedIn: `https://www.linkedin.com`
- LinkedIn Sales Navigator: `https://www.linkedin.com/sales/`

After launch, ask the user to log in if needed, then verify with the relevant ShowRun skill.

## Readiness checks

A browser setup is ready when:

- CDP is reachable.
- The target source opens in a tab.
- The user is logged in, or the login page is visible and awaiting user action.
- The relevant ShowRun skill can list/read enough page state to proceed.

For local CDP, a quick check is usually:

```bash
curl -s http://127.0.0.1:9222/json/version
curl -s http://127.0.0.1:9222/json/list
```

For ShowRun's `chrome-cdp` skill, read its `SKILL.md` and use its `scripts/cdp.mjs list` command when available.

## Troubleshooting

- **CDP port unreachable:** browser is not running with `--remote-debugging-port`, wrong port, or blocked by environment.
- **No useful tabs:** open the target URL in the CDP browser/profile.
- **Not logged in:** ask the user to log in inside the browser window, then retry.
- **Wrong profile:** confirm local `--user-data-dir` or Browser Use `profileId` points to the intended persistent ShowRun profile.
- **Browser Use changes not persisting:** ensure the Browser Use session is stopped cleanly after login/work.
- **Remote/cloud CDP unsupported:** add direct `CDP_URL=wss://...` support to the CDP helper or use a Playwright/Puppeteer bridge temporarily.
- **Source skill still fails:** read the source skill's `SKILL.md`, check required helper files, and run the smallest diagnostic command.

## Output to caller

Report concisely:

- connection mode used,
- browser/profile location or CDP endpoint type, without secrets,
- live browser URL if the user needs to log in,
- target source tested,
- whether login is complete,
- verification command/result,
- remaining blocker if not ready.
