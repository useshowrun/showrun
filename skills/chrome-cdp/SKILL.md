---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path
- For remote/cloud CDP, set `CDP_URL` to a direct `ws://`/`wss://` browser endpoint. `CHROME_CDP_URL` and `BROWSER_CDP_URL` are accepted aliases. `http://`/`https://` endpoints are also accepted when `/json/version` exposes `webSocketDebuggerUrl`.

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (each triggers Allow prompt)
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.

## Agent guidance — CDP connection

When a skill requires Chrome CDP and connection fails:

1. **If `CDP_URL` is provided**, use it first. This is the expected path for Browser Use Cloud or other remote persistent browser profiles. Example shape: `CDP_URL='wss://connect.browser-use.com?apiKey=...&profileId=...' scripts/cdp.mjs list`. Do not print secrets in logs.
2. **Otherwise try the command first** — `scripts/cdp.mjs list` will auto-discover Chrome via DevToolsActivePort
3. **If connection fails** — launch a dedicated Chrome instance yourself, **passing the skill's target URL as an argument** so Chrome opens directly on the login page. A fresh profile has no tabs, so skills that look for a specific site will fail without this. The binary name varies by system:
   - **macOS:** `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=$HOME/Library/Application\ Support/showrun/chrome-profile --no-first-run "<target-url>" &`
   - **Linux:** try `google-chrome-stable`, `google-chrome`, or `chromium` — whichever is available:
     ```bash
     google-chrome-stable --remote-debugging-port=9222 --user-data-dir=$HOME/.local/share/showrun/chrome-profile --no-first-run "<target-url>" &
     ```
   Replace `<target-url>` with the skill's login page (e.g. `https://my.pitchbook.com` for PitchBook, `https://www.crunchbase.com` for Crunchbase, `https://www.linkedin.com` for LinkedIn). Wait a few seconds, then retry. This profile persists across sessions — users only need to log in once.
4. **If Chrome is already running via CDP but the target site isn't open**, open it via `scripts/cdp.mjs open <target-url>` instead of asking the user.
5. **If the user is not logged in** to the required platform — ask them to log in in the Chrome window you just opened, then retry.
