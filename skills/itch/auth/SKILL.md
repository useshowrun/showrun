---
name: itch-auth
description: "Extract itch.io session cookies from a logged-in Chrome tab via the chrome-cdp skill, and persist them to `~/.local/share/showrun/data/itch/session.json` for the other itch endpoints (browse, feed, actions, profile) to reuse."
---

# itch-auth

Extract itch.io session cookies from a logged-in Chrome tab via the chrome-cdp skill, and persist them to `~/.local/share/showrun/data/itch/session.json` for the other itch endpoints (browse, feed, actions, profile) to reuse.

## Prerequisites

- Node.js 22+
- Chrome started with remote debugging (`--remote-debugging-port=9222`)
- chrome-cdp skill (script reads `../../chrome-cdp/scripts/cdp.mjs`)
- An itch.io tab already logged in

## Usage

```bash
node scripts/itch-auth.mjs
```

Re-run on `401`/`403` errors. Session is stored at `~/.local/share/showrun/data/itch/session.json`.

## How it works

The script asks chrome-cdp for the cookies on the active itch.io tab, filters to the ones the API accepts (`itchio`, `itchio_token`, `cf_clearance`, `__cf_bm`, etc.), and writes them as `Cookie:` header material plus the CSRF token harvested from `<meta name="csrf-token">` on the home page.
