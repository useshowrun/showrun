# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ShowRun is a TypeScript + Playwright framework for deterministic, versioned browser automation. It implements a **Task Pack** system - self-contained automation modules that define flows in JSON or TypeScript and run via CLI, MCP server, or web dashboard.

## Quick Start (npx)

```bash
# Start dashboard instantly (after publishing to npm)
npx showrun dashboard --packs ./my-taskpacks

# Or run a task pack directly
npx showrun run ./my-pack --inputs '{}'
```

## Build & Run Commands (Development)

```bash
# Install dependencies
pnpm install
npx camoufox-js fetch  # Download camoufox browser

# Build all packages and task packs
pnpm build

# Run example task packs
pnpm test:example           # TypeScript example
pnpm test:example-json      # JSON-only example
```

### Unified CLI

All commands are accessible through the unified `showrun` CLI:

```bash
# Run a task pack
showrun run ./taskpacks/example --inputs '{}'
showrun run ./taskpacks/example --headful

# Start dashboard (web UI with Teach Mode)
showrun dashboard --packs ./taskpacks
showrun dashboard --packs ./taskpacks --headful --port 3333

# Start MCP server for AI agents
showrun serve --packs ./taskpacks
showrun serve --packs ./taskpacks --http --port 3001

# Pack management
showrun pack create --dir ./taskpacks --id my.pack --name "My Pack"
showrun pack validate --path ./taskpacks/my_pack
showrun pack set-flow --path ./taskpacks/my_pack --flow '{"flow":[...]}'
showrun pack set-meta --path ./taskpacks/my_pack --meta '{"description":"..."}'

# MCP server utilities
showrun mcp browser-inspector
showrun mcp taskpack-editor --packs ./taskpacks
```

Run `showrun --help` or `showrun <command> --help` for detailed usage.

## Architecture

```
packages/
├── core/           # Types, DSL, loader, runner, validator
├── harness/        # Task pack execution library
├── mcp-server/     # MCP server exposing packs as tools
├── dashboard/      # Web UI + Express + Socket.IO (React frontend)
├── browser-inspector-mcp/   # MCP for browser inspection
├── taskpack-editor-mcp/     # MCP for editing flows
└── showrun/        # Unified CLI (showrun command)

taskpacks/          # Task pack definitions
```

### Core Flow

1. **Loader** (`packages/core/src/loader.ts`) loads a TaskPack from directory
2. **Validator** (`packages/core/src/validator.ts`) validates inputs against pack schema
3. **Runner** (`packages/core/src/runner.ts`) executes the pack with Playwright
4. **DSL Interpreter** (`packages/core/src/dsl/interpreter.ts`) executes declarative steps

### Task Pack Format (json-dsl)

Task packs use the json-dsl format with two files:
```
taskpacks/my-pack/
├── taskpack.json   # metadata with "kind": "json-dsl"
└── flow.json       # inputs + collectibles + flow array
```

### DSL Step Types

All steps defined in `packages/core/src/dsl/types.ts`:
- `navigate` - Go to URL
- `click`, `fill` - Interact with elements
- `wait_for` - Wait for element/URL/load state
- `extract_title`, `extract_text`, `extract_attribute` - Extract data
- `assert` - Validate conditions
- `set_var` - Set template variable
- `network_find`, `network_replay`, `network_extract` - Network capture/replay
- `select_option` - Select dropdown options (by value, label, or index)
- `press_key` - Press keyboard keys (Enter, Tab, Escape, shortcuts)
- `upload_file` - Upload files to file input elements
- `frame` - Switch into/out of iframes
- `new_tab`, `switch_tab` - Multi-tab browser workflows

### Extraction Steps: Single vs Multiple Elements

`extract_text` and `extract_attribute` extract from **all matching elements by default** (returns array):

```json
{ "type": "extract_text", "params": { "target": { "kind": "css", "selector": ".item" }, "out": "items" } }
// Returns: ["Item 1", "Item 2", "Item 3"]
```

To extract only the first element, set `first: true`:

```json
{ "type": "extract_text", "params": { "target": { "kind": "css", "selector": ".item" }, "out": "firstItem", "first": true } }
// Returns: "Item 1"
```

### Target Selection

Steps use `target` for element selection (prefer over deprecated `selector`):
```typescript
{ kind: 'css', selector: '...' }
{ kind: 'text', text: '...' }
{ kind: 'role', role: 'button', name: '...' }
{ kind: 'label', text: '...' }
{ kind: 'placeholder', text: '...' }
{ kind: 'testId', id: '...' }
{ anyOf: [...] }  // fallback chain
```

### Template Variables

Steps support `{{inputs.xxx}}`, `{{vars.xxx}}`, and `{{secret.xxx}}` substitution (Nunjucks).

**Available filters:**
- Built-in Nunjucks filters: `urlencode`, `upper`, `lower`, `trim`, etc.
- `totp` - Generate TOTP code from base32 secret: `{{secret.TOTP_KEY | totp}}`

### JMESPath for Data Extraction

The `network_extract` and `network_replay` steps use **JMESPath** for extracting data from JSON responses.

**Common patterns:**
```json
{
  "type": "network_extract",
  "params": {
    "fromVar": "apiResponse",
    "as": "json",
    "path": "results[*].{id: id, name: name, url: website}",
    "out": "companies"
  }
}
```

**JMESPath examples:**
- `results[0].name` - First item's name
- `results[*].name` - All names as array
- `results[*].{id: id, name: name}` - Project to new objects
- `results[?status == 'active']` - Filter by condition
- `results | [0]` - Pipe to get first
- `length(results)` - Get count

**Backward compatibility:** Paths starting with `$.` (JSONPath-style) are automatically converted by stripping the prefix. E.g., `$.results[0]` becomes `results[0]`.

See https://jmespath.org for full syntax reference.

### Secrets Management

Task packs can define secrets (credentials, API keys) in `taskpack.json`:
```json
{
  "secrets": [
    { "name": "API_KEY", "description": "External API key", "required": true },
    { "name": "PASSWORD", "description": "Login password" }
  ]
}
```

Secret values are stored in `.secrets.json` (gitignored) and referenced via `{{secret.NAME}}`:
```json
{
  "type": "fill",
  "params": {
    "target": { "kind": "label", "text": "Password" },
    "value": "{{secret.PASSWORD}}"
  }
}
```

**TOTP/2FA support:** Store base32 TOTP key as a secret and use the `totp` filter:
```json
{
  "type": "fill",
  "params": {
    "target": { "kind": "label", "text": "2FA Code" },
    "value": "{{secret.TOTP_KEY | totp}}"
  }
}
```

**Security features:**
- Values stored per-pack in `.secrets.json` (never committed)
- AI agents only see secret names, never values
- Values are write-only via API (cannot retrieve after setting)
- Secret values are redacted in logs

### Run-Once & Auth Resilience

Steps can have `"once": "session"` or `"once": "profile"` to run only once. On 401/403, runner can clear once-cache, re-run setup steps, and retry.

### Browser Settings

Task packs can configure browser engine and persistence in `taskpack.json`:
```json
{
  "browser": {
    "engine": "chromium",
    "persistence": "profile"
  }
}
```

**Engine options:**
- `camoufox` (default) - Firefox-based anti-detection browser (run `npx camoufox-js fetch` to install)
- `chromium` - Standard Playwright Chromium

**Persistence modes:**
- `none` (default) - Fresh browser each run, no data persisted
- `session` - Data persisted in temp directory, cleared after 30min inactivity
- `profile` - Data persisted in pack's `.browser-profile/` directory (gitignored)

### Conditional Step Execution (skip_if)

Steps can be conditionally skipped using `skip_if`:
```json
{
  "id": "login_email",
  "type": "fill",
  "skip_if": { "url_includes": "/dashboard" },
  "params": { "target": { "kind": "label", "text": "Email" }, "value": "..." }
}
```

**Supported conditions:**
- `url_includes` - URL contains string: `{ "url_includes": "/dashboard" }`
- `url_matches` - URL matches regex: `{ "url_matches": "^https://.*\\.example\\.com" }`
- `element_visible` - Element is visible: `{ "element_visible": { "kind": "text", "text": "Logout" } }`
- `element_exists` - Element exists in DOM: `{ "element_exists": { "kind": "css", "selector": ".user-menu" } }`
- `var_equals` - Variable equals value: `{ "var_equals": { "name": "loggedIn", "value": true } }`
- `var_truthy` - Variable is truthy: `{ "var_truthy": "authToken" }`
- `var_falsy` - Variable is falsy: `{ "var_falsy": "needsLogin" }`
- `all` - All conditions true (AND): `{ "all": [...conditions] }`
- `any` - Any condition true (OR): `{ "any": [...conditions] }`

**Common pattern - skip login if already authenticated:**
```json
{
  "flow": [
    { "id": "nav", "type": "navigate", "params": { "url": "https://example.com" } },
    { "id": "fill_email", "type": "fill", "skip_if": { "url_includes": "/dashboard" }, "params": { ... } },
    { "id": "fill_pass", "type": "fill", "skip_if": { "url_includes": "/dashboard" }, "params": { ... } },
    { "id": "submit", "type": "click", "skip_if": { "url_includes": "/dashboard" }, "params": { ... } }
  ]
}
```

Combined with `"persistence": "profile"`, this enables packs to skip login on subsequent runs when cookies persist.

### Dashboard AI Agent

The dashboard includes an AI agent (Teach Mode) with browser and editor tools. Key features:

**Browser Engine Selection:**
The AI can start browser sessions with either engine:
- `browser_start_session` with `engine: "camoufox"` (default) - Anti-detection Firefox
- `browser_start_session` with `engine: "chromium"` - Standard Playwright Chromium

Use chromium only when camoufox causes compatibility issues.

**Context Management:**
- Automatic summarization when context exceeds ~100k tokens
- `agent_save_plan` / `agent_get_plan` tools for persisting plans across summarization
- Tool output truncation (8k char limit) to prevent context bloat

**Tool Output Truncation:**
Large tool outputs are automatically truncated with metadata:
```json
{
  "_truncated": true,
  "_totalChars": 50000,
  "_shownChars": 8000,
  "_message": "Output truncated... The operation completed successfully.",
  "partialOutput": "..."
}
```

## Key Patterns

- All packages extend root `tsconfig.json` (ES2022, Node16, strict)
- Workspace deps use `workspace:*` protocol
- CLI tools defined via `bin` in package.json
- JSONL logging for structured events (`./runs/<timestamp>/events.jsonl`)
- Socket.IO for real-time UI updates in dashboard
- Artifacts on error: `error.png`, `error.html`

## Exit Codes

- `0` - Success
- `1` - Execution failure
- `2` - Validation error

## Product Roadmap

The project roadmap is maintained in `docs/ROADMAP.md`. This document tracks:
- Current state assessment (what's working)
- Gap analysis (missing features, production readiness, developer experience)
- Prioritized roadmap with P0/P1/P2/P3 phases
- Implementation status of planned features

**IMPORTANT: After implementing new features, always update the roadmap:**
1. Mark completed items with **Implemented** status
2. Update the "What's Working Well" section if significant features were added
3. Update step counts or feature lists to reflect current state
4. Move items between priority phases if scope changes

This ensures the roadmap stays accurate and useful for planning future work.
