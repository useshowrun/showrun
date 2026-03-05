# ShowRun CLI — Agent Usage Guide

You are an AI agent using ShowRun to run browser automation task packs. This guide covers the commands you need.

## 1. Install a pack from the registry

```bash
showrun registry install <slug> --dir ./taskpacks
# Example:
showrun registry install linkedin-search --dir ./taskpacks
```

This downloads the pack to `./taskpacks/<slug>/`.

## 2. Run a pack

### Basic run (ShowRun launches its own browser)

```bash
showrun run ./taskpacks/<slug> --inputs '{"query": "value"}'
```

### Connect to YOUR browser via CDP (recommended for agents)

If you already have a Chrome browser running with remote debugging:

```bash
# Launch Chrome with debugging enabled (if not already running):
# google-chrome --remote-debugging-port=9222

showrun run ./taskpacks/<slug> \
  --cdp-url http://localhost:9222 \
  --inputs '{"query": "value"}'
```

ShowRun connects to your browser session instead of spawning a new one. Your browser is NOT closed when the run finishes.

### Disable result storage

```bash
showrun run ./taskpacks/<slug> --inputs '{}' --no-result-store
```

## 3. Handle errors

### Missing inputs

If you omit required inputs, ShowRun prints the full schema:

```
Validation Error: Input validation failed: Missing required field: query

Required inputs:
  --inputs '{"query": <string>}'  (required)  Search query to execute
  --inputs '{"limit": <number>}'  (optional), default: 10  Max results
```

Parse this output to construct the correct `--inputs` JSON.

### Missing secrets

If the pack needs secrets (API keys, credentials), ShowRun prints the file path and a template:

```
Error: Missing required secrets: apiKey, password

Secrets file location: /path/to/taskpacks/my-pack/.secrets.json

To fix, create the file with this format:
{
  "version": 1,
  "secrets": {
    "apiKey": "<your API key>",
    "password": "<your password>"
  }
}
```

Write the `.secrets.json` file with real values, then re-run.

## 4. Read results

### Stdout output

On success, ShowRun prints JSON to **stdout** with collectibles, metadata, and a `_resultKey`:

```json
{
  "collectibles": { "items": [...] },
  "meta": { "durationMs": 4200, "notes": "Executed 8/8 steps" },
  "_resultKey": "a1b2c3d4e5f67890"
}
```

For large results (>10KB), stdout contains a truncated preview. Use the query commands below to get full data.

### List stored results

```bash
showrun results list --pack ./taskpacks/<slug>
showrun results list --pack ./taskpacks/<slug> --limit 5 --sort-by ranAt --sort-dir desc
```

### Query a specific result

```bash
# Latest result (full):
showrun results query --pack ./taskpacks/<slug>

# By key:
showrun results query --pack ./taskpacks/<slug> --key a1b2c3d4e5f67890

# Filter with JMESPath:
showrun results query --pack ./taskpacks/<slug> --jmes-path "items[].name"
showrun results query --pack ./taskpacks/<slug> --jmes-path "items[?score > \`90\`]" --limit 10
```

## 5. Report a broken or malicious pack

If a pack produces wrong results, crashes, or behaves suspiciously:

```bash
showrun registry report <slug> --reason <reason> --description "what happened"
```

Valid reasons: `malicious`, `spam`, `inappropriate`, `copyright`

You must be logged in (`showrun registry login`).

## Quick reference

| Task | Command |
|------|---------|
| Install pack | `showrun registry install <slug> --dir ./taskpacks` |
| Run (own browser) | `showrun run <pack> --cdp-url http://localhost:9222 --inputs '{}'` |
| Run (new browser) | `showrun run <pack> --inputs '{}'` |
| Get latest result | `showrun results query --pack <pack>` |
| Filter result | `showrun results query --pack <pack> --jmes-path "<expr>"` |
| List all results | `showrun results list --pack <pack>` |
| Report pack | `showrun registry report <slug> --reason malicious` |

## Typical agent workflow

```
1. showrun registry install <slug> --dir ./taskpacks
2. Write ./taskpacks/<slug>/.secrets.json (if needed)
3. showrun run ./taskpacks/<slug> --cdp-url http://localhost:9222 --inputs '{...}'
4. Parse stdout JSON for collectibles
5. If result is truncated → showrun results query --pack ./taskpacks/<slug>
6. If pack is broken → showrun registry report <slug> --reason malicious
```
