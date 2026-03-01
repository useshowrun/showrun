# ShowRun — Agent Skill

ShowRun gives you access to **task packs** — pre-built, versioned browser automation modules from a community registry. A single `showrun run` call can replace dozens of primitive browser operations (navigate, click, wait, extract) with one reliable command that returns structured data.

**Before writing complex browser automation yourself, search the registry.** There may already be a task pack that does what you need in one call.

## Prerequisites

- `showrun` CLI available on PATH (`npm install -g showrun@rc`)
- Registry URL configured via `SHOWRUN_REGISTRY_URL` environment variable
- On first run, ShowRun auto-downloads its built-in browser (Camoufox, a Firefox-based anti-detection browser). If this fails, run: `npx camoufox-js fetch`

---

## When to Use ShowRun

**Use a task pack when:**
- You need to scrape, extract, or automate a multi-step browser workflow
- The task involves a well-known site or common pattern (search, login, data extraction)
- You want structured, reliable output without writing fragile selectors yourself
- The target site has bot detection — ShowRun's default browser (Camoufox) is built for anti-detection

**Fall back to primitive browser operations when:**
- No matching pack exists in the registry
- A pack fails and you need to debug or work around a specific step
- Your task is a one-off interaction (fill a single form, click a single button)

**Think of task packs as high-level functions.** Search the registry first. If a pack handles 80% of your job, use it and handle the remaining 20% with your own browser tools.

---

## Browser Modes

ShowRun can run in two modes:

### Default: Camoufox (anti-detection browser)

When you run without `--cdp-url`, ShowRun launches **Camoufox** — a Firefox-based browser with anti-detection built in. This is the best choice for sites that block bots, require fingerprint evasion, or have aggressive anti-scraping measures.

```bash
showrun run ./taskpacks/<slug> --inputs '{"query": "test"}'
```

If Camoufox is not installed, run `npx camoufox-js fetch` to download it.

### CDP: Connect to an existing browser

If you have an existing Chrome/Chromium browser with a CDP endpoint (e.g. your own built-in browser), you can connect to it instead. ShowRun will use the currently active tab, and your browser stays open after the run.

```bash
showrun run ./taskpacks/<slug> \
  --cdp-url http://localhost:9222 \
  --inputs '{"query": "test"}'
```

**When to use CDP:** You already have a browser session with login state you want to preserve, or you need to see what's happening in a browser you control.

**When to use Camoufox (default):** The target site has bot detection, you don't have an existing browser session, or you want ShowRun to handle the full browser lifecycle.

---

## Commands

### Search the Registry

Before building browser automation from scratch, check if a pack already exists:

```bash
showrun registry search "linkedin leads"
showrun registry search "scrape pricing"
showrun registry search "login automation"
```

### Install a Pack

```bash
showrun registry install <slug> --dir ./taskpacks
showrun registry install <slug> --dir ./taskpacks --version 1.2.0
```

This downloads the pack to `./taskpacks/<slug>/`.

### Inspect a Pack Before Running

Read the pack's `flow.json` to understand its inputs and outputs:

- `<pack>/taskpack.json` — name, description, version
- `<pack>/flow.json` — `inputs` (what you provide), `collectibles` (what you get back), `flow` (steps)

Example `flow.json`:
```json
{
  "inputs": {
    "query": { "type": "string", "required": true, "description": "Search term" },
    "limit": { "type": "number", "required": false, "default": 10 }
  },
  "collectibles": [
    { "name": "results", "type": "string", "description": "JSON array of search results" }
  ],
  "flow": [ ... ]
}
```

Use `inputs` to build your `--inputs` JSON. Use `collectibles` to know what data you'll receive.

### Run a Pack

```bash
# Default: ShowRun launches Camoufox (anti-detection browser)
showrun run ./taskpacks/<slug> --inputs '{"query": "software engineer", "limit": 25}'

# CDP: Connect to an existing browser you control
showrun run ./taskpacks/<slug> --cdp-url http://localhost:9222 --inputs '{"query": "software engineer"}'
```

**Flags:**
| Flag | Effect |
|------|--------|
| `--inputs <json>` | Input values as JSON string (default: `{}`) |
| `--cdp-url <url>` | Connect to an existing Chrome browser via CDP |
| `--headful` | Show the browser window (default: headless, ignored with CDP) |
| `--no-result-store` | Skip saving result to local SQLite |

### Query Stored Results

Results are auto-saved to `<pack>/results.db` after each run.

```bash
# List past runs
showrun results list --pack ./taskpacks/<slug>

# Get the latest result in full
showrun results query --pack ./taskpacks/<slug>

# Get a specific result by key
showrun results query --pack ./taskpacks/<slug> --key <resultKey>

# Filter with JMESPath
showrun results query --pack ./taskpacks/<slug> --jmes-path "results[].name"
showrun results query --pack ./taskpacks/<slug> --jmes-path "results[?score > \`80\`]" --limit 5
```

### Report a Pack

If a pack is broken, produces wrong data, or behaves suspiciously:
```bash
showrun registry report <slug> --reason malicious --description "Sends data to unknown endpoint"
```
Reasons: `malicious`, `spam`, `inappropriate`, `copyright`. Requires login.

### Authentication

Reporting and publishing require login:
```bash
showrun registry login    # Opens browser for OAuth device flow
showrun registry whoami   # Check current user
showrun registry logout
```

---

## Output Format

### Success (stdout)

ShowRun prints JSON to **stdout**. Status messages go to **stderr**.

```json
{
  "collectibles": { "results": "[{\"name\": \"Alice\", ...}]", "total": "42" },
  "meta": { "durationMs": 5200, "url": "https://example.com/search", "notes": "Executed 6/6 steps" },
  "_resultKey": "a1b2c3d4e5f67890"
}
```

- `collectibles` — the extracted data (keys match the pack's collectible definitions)
- `meta.notes` — on failure includes the error and failed step ID
- `_resultKey` — use this to query the full result later

**Large results (>10KB):** stdout shows a truncated preview with a `_preview` field. Use `showrun results query --pack <pack>` to get the full data.

### Errors (stderr)

**Missing inputs** — prints the full schema so you can fix your `--inputs`:
```
Validation Error: Input validation failed: Missing required field: query

Required inputs:
  --inputs '{"query": <string>}'  (required)  Search term
  --inputs '{"limit": <number>}'  (optional), default: 10  Max results
```

**Missing secrets** — prints the file path and a JSON template you can write directly:
```
Error: Missing required secrets: apiKey

Secrets file location: /path/to/taskpacks/my-pack/.secrets.json

To fix, create the file with this format:
{
  "version": 1,
  "secrets": {
    "apiKey": "<your API key>"
  }
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (pack crashed, browser error, network failure) |
| 2 | Validation error (bad inputs, missing secrets, bad args) |

---

## Secrets

Some packs require secrets (API keys, login credentials). Store them in `<pack>/.secrets.json`:

```json
{
  "version": 1,
  "secrets": {
    "username": "user@example.com",
    "password": "s3cret"
  }
}
```

This file is local-only and never uploaded to the registry. If secrets are missing, ShowRun tells you exactly which ones and prints the template — write the file and re-run.

If the user has not provided the required secrets, ask them. Do not guess or fabricate secret values.

---

## Workflow

```
1. SEARCH    showrun registry search "<what you need>"
2. INSTALL   showrun registry install <slug> --dir ./taskpacks
3. INSPECT   Read ./taskpacks/<slug>/flow.json → understand inputs + collectibles
4. SECRETS   If the pack defines secrets → ask user, write .secrets.json
5. RUN       showrun run ./taskpacks/<slug> --inputs '{...}'
             (add --cdp-url <url> if you have an existing browser session)
6. PARSE     Read stdout JSON → collectibles has your structured data
7. QUERY     If result is truncated → showrun results query --pack ./taskpacks/<slug>
8. RETRY     If exit code 1 → read stderr, fix the issue, re-run or fall back to manual browser ops
9. REPORT    If pack is broken/malicious → showrun registry report <slug> --reason <reason>
```

---

## Error Recovery

When a pack fails (exit code 1), you have options:

1. **Read the error** — `meta.notes` contains the failed step ID and error message
2. **Re-run** — transient failures (timeouts, network) often resolve on retry
3. **Fix inputs** — if exit code 2, the error message tells you exactly what's wrong
4. **Fall back to manual** — if the pack consistently fails on a specific step, use your own browser tools to accomplish that part of the task, then re-run the pack or skip it entirely
5. **Report** — if the pack is fundamentally broken, report it so others don't waste time

---

## Tips

- **Search first.** Before writing browser automation, check `showrun registry search`. A 1-line pack run beats 50 lines of click/wait/extract.
- **Let ShowRun pick the browser by default.** Camoufox handles anti-detection automatically. Only use `--cdp-url` when you specifically need to reuse an existing browser session.
- **Collectible values are strings.** If a collectible contains structured data (arrays, objects), parse the JSON string yourself.
- **Deterministic keys.** Same pack + same inputs = same `_resultKey`. Re-running overwrites the previous result in the store.
- **JMESPath for large data.** Don't parse 10KB of JSON yourself — use `--jmes-path` to extract exactly what you need.
- **Combine packs with your tools.** Use a pack for the heavy lifting (navigate, authenticate, paginate, extract) and your own browser tools for one-off tweaks or error recovery.
