---
name: camoufox-shared-lib
description: Shared Camoufox websocket server/client library for scraper skills. Use when a scraper should stop importing camoufox-js directly and instead connect to a reusable Camoufox server from Node.js.
---

# Camoufox Shared Library

Use this library when a scraper needs Camoufox without bundling `camoufox-js` inside every skill package.

Files:
- `server.py`: starts Camoufox as a websocket server
- `client.mjs`: connects from Node.js with `playwright-core`
- `package.json`: local dependency boundary for `playwright-core`

## Usage patterns

### 1. Manual server start + client connect

Start the server explicitly:

```bash
/home/karacasoft/.openclaw/.venv/bin/python3 lib/camoufox/server.py \
  --port 19222 \
  --ws-path camoufox \
  --profile-dir ~/.camoufox-profile \
  --headless true
```

Then connect from a scraper:

```js
import { connectCamoufox } from "../../lib/camoufox/client.mjs";

const client = await connectCamoufox("ws://127.0.0.1:19222/camoufox");
const { context, page } = await client.newPage({
  locale: "en-US",
  timezoneId: "America/New_York",
});
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
await context.close();
await client.close();
```

### 2. Auto-managed mode

Use the default export when the scraper should reuse an existing Camoufox server if available, otherwise start one automatically:

```js
import createManagedCamoufox from "../../lib/camoufox/client.mjs";

const camoufox = await createManagedCamoufox({
  port: 19222,
  wsPath: "camoufox",
  profileDir: process.env.CAMOUFOX_PROFILE_DIR,
  proxy: process.env.CAMOUFOX_PROXY,
});

const { context, page } = await camoufox.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
await context.close();
await camoufox.close();
```

Managed mode tries `firefox.connect()` first. If the socket is unavailable, it starts `server.py`, connects, and can reconnect after the server disappears.

## Migration from `camoufox-js`

Current direct pattern:

```js
import { Camoufox } from "camoufox-js";

const browser = await Camoufox({
  headless: "virtual",
  humanize: 1,
});
const context = await browser.newContext({
  locale: "en-US",
  timezoneId: "America/New_York",
});
```

Shared-library replacement:

```js
import createManagedCamoufox, { createContext } from "../../lib/camoufox/client.mjs";

const camoufox = await createManagedCamoufox({
  headless: true,
  profileDir: process.env.CAMOUFOX_PROFILE_DIR,
});

const browser = await camoufox.ensureBrowser();
const context = await createContext(browser, {
  locale: "en-US",
  timezoneId: "America/New_York",
});
```

Migration notes:
- Replace `Camoufox({...})` with `createManagedCamoufox({...})` plus `ensureBrowser()`
- Replace direct `browser.newContext(...)` calls with `createContext(browser, options)` when you want repo-wide locale/timezone defaults
- For one-off page work, `camoufox.newPage()` is shorter and returns `{ context, page }`
- Keep persistent sessions by pointing `profileDir` at the existing browser profile

## Environment variables

Supported by `client.mjs`:
- `CAMOUFOX_WS_URL`: full websocket URL override
- `CAMOUFOX_PORT`: websocket port, default `19222`
- `CAMOUFOX_WS_PATH`: websocket path, default `camoufox`
- `CAMOUFOX_PROFILE_DIR`: profile directory, default `~/.camoufox-profile`
- `CAMOUFOX_HEADLESS`: `true` or `false`, default `true`
- `CAMOUFOX_PROXY`: proxy URL passed to `server.py`
- `SOCKS5_PROXY`: fallback proxy URL when `CAMOUFOX_PROXY` is unset
- `CAMOUFOX_PYTHON`: Python interpreter used to start `server.py`
- `CAMOUFOX_LOCALE`: default browser context locale, default `en-US`
- `CAMOUFOX_TIMEZONE`: default browser context timezone, default `America/New_York`

## Implementation guidance

- Prefer auto-managed mode for scraper scripts; it reduces setup friction and makes retries easier.
- Prefer manual mode in debugging sessions when you want to keep one Camoufox server alive across multiple Node runs.
- When migrating a skill, update the skill’s `SKILL.md` examples so they no longer tell users to install or import `camoufox-js` directly.
