# ShowRun

A TypeScript + Playwright framework for deterministic, versioned browser automation **Task Packs**: define flows in JSON or code, run them via CLI or MCP, and edit them with an AI-assisted dashboard (Teach Mode).

## What is a Task Pack?

A **Task Pack** is a self-contained, versioned automation module that:

- Defines its own metadata (id, name, version, description)
- Declares input schema (what parameters it accepts)
- Declares collectibles schema (what data it extracts)
- Implements a deterministic `run()` function that executes browser automation using Playwright
- Can be versioned and upgraded independently

Task Packs are designed to be:
- **Deterministic**: No AI at runtime, pure code execution
- **Versioned**: Each pack has its own version in metadata
- **Portable**: Can be packaged and distributed independently
- **Testable**: Structured logging and artifact collection on errors

## Project Structure

```
/showrun
  /packages
    /core               # Types, loader, validator, runner, DSL interpreter, auth resilience
    /harness            # CLI to load + execute a task pack
    /mcp-server         # MCP server exposing Task Packs as tools (HTTP/SSE)
    /dashboard         # Web UI: run packs, view runs, Teach Mode (AI-assisted flow editing)
    /browser-inspector-mcp  # MCP for browser inspection (screenshots, DOM, network)
    /taskpack-editor-mcp   # MCP for editing task pack flows (apply patches, run pack)
    /showrun            # Unified CLI (dashboard, MCP, etc.)
  /taskpacks
    /example            # TypeScript task pack
    /example-json       # JSON-only task pack (no build step)
    /ycombinator.get.batch  # Example with network steps + run-once
```

## Quick Start

### Using npx (Simplest)

```bash
# Start dashboard instantly (no installation needed)
npx showrun dashboard --packs ./my-taskpacks

# Run a task pack directly
npx showrun run ./my-pack --inputs '{}'

# Install camoufox browser (required on first run)
npx camoufox-js fetch
```

### Development Setup

```bash
# Install dependencies (using pnpm)
pnpm install

# Install camoufox browser
npx camoufox-js fetch

# Build all packages and task packs
pnpm build
```

### Run Example Task Packs

```bash
# Run TypeScript example (requires build)
pnpm test:example

# Run JSON-only example (no build needed!)
pnpm test:example-json

# Or manually:
node packages/harness/dist/cli.js run --pack ./taskpacks/example --inputs '{}'
node packages/harness/dist/cli.js run --pack ./taskpacks/example-json --inputs '{}'
```

## Creating a New Task Pack

Task Packs support **two styles**:

1. **JSON-only** - Single `taskpack.json` file, no build step (simple flows)
2. **TypeScript** - `taskpack.json` + TypeScript module with builders (complex flows)

### Style 1: JSON-Only Task Pack (Simple)

Perfect for simple automation flows - no build step required!

#### 1. Create Task Pack Directory

```bash
mkdir -p taskpacks/my-pack
```

#### 2. Create `taskpack.json` with flow

```json
{
  "id": "my.pack.id",
  "name": "My Task Pack",
  "version": "0.1.0",
  "description": "What this pack does",
  "inputs": {
    "url": {
      "type": "string",
      "required": true,
      "description": "URL to navigate to"
    }
  },
  "collectibles": [
    {
      "name": "title",
      "type": "string",
      "description": "Page title"
    }
  ],
  "flow": [
    {
      "id": "navigate",
      "type": "navigate",
      "params": {
        "url": "https://example.com",
        "waitUntil": "networkidle"
      }
    },
    {
      "id": "extract_title",
      "type": "extract_title",
      "params": {
        "out": "title"
      }
    }
  ]
}
```

That's it! No build step needed. See `taskpacks/example-json/` for a complete example.

### Style 2: TypeScript Task Pack (Complex)

Better for complex flows with full IDE support and type checking.

#### 1. Create Task Pack Directory

```bash
mkdir -p taskpacks/my-pack/src
```

#### 2. Create `taskpack.json`

```json
{
  "id": "my.pack.id",
  "name": "My Task Pack",
  "version": "0.1.0",
  "description": "What this pack does",
  "main": "dist/index.js"
}
```

### 3. Create `package.json`

```json
{
  "name": "@showrun/my-pack",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "@showrun/core": "workspace:*",
    "@types/node": "^20.11.0",
    "typescript": "^5.3.3"
  }
}
```

### 4. Create `tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 5. Implement `src/index.ts` (DSL Flow)

```typescript
import type { TaskPack } from '@showrun/core';
import { navigate, extractTitle } from '@showrun/core';

const taskPack: TaskPack = {
  metadata: {
    id: 'my.pack.id',
    name: 'My Task Pack',
    version: '0.1.0',
  },
  inputs: {
    url: {
      type: 'string',
      required: true,
      description: 'URL to navigate to',
    },
  },
  collectibles: [
    {
      name: 'title',
      type: 'string',
      description: 'Page title',
    },
  ],
  // Declarative DSL flow - deterministic, AI-free at runtime
  flow: [
    navigate('navigate', {
      url: 'https://example.com',
      waitUntil: 'networkidle',
    }),
    extractTitle('extract_title', {
      out: 'title',
    }),
  ],
};

export default taskPack;
```

**Alternative: Imperative style** (legacy, still supported):

```typescript
import type { TaskPack, RunContext, RunResult } from '@showrun/core';

const taskPack: TaskPack = {
  // ... metadata, inputs, collectibles ...
  async run(ctx: RunContext, inputs: Record<string, unknown>): Promise<RunResult> {
    // Imperative code here
  },
};
```

**Network steps (API-first):** Flows can use `network_find`, `network_replay`, and `network_extract` to search captured traffic and replay requests using the browser context (cookies apply). Capture is enabled automatically when a flow runs. Steps: `network_find` (where: urlIncludes/urlRegex/method/status/contentTypeIncludes/responseContains, pick: first|last, saveAs) → `network_replay` (requestId from vars, overrides: url/setQuery/setHeaders/body support `{{vars.xxx}}`/`{{inputs.xxx}}`; optional urlReplace/bodyReplace regex find/replace, replace can use $1,$2 and templates; auth: browser_context, out, response.as + optional jsonPath) → optional `network_extract` (fromVar, as, jsonPath, out). Sensitive headers are never logged or returned.

**Run-once steps & auth resilience:** Steps can include `"once": "session"` or `"once": "profile"` so they run only once per session or per pack (e.g. login/setup). The runner persists this state on disk when `profileId`/`sessionId` are passed. On 401/403 (configurable), the runner can clear the once-cache, re-run once steps, and retry the failed step.

### 6. Build and Run

```bash
# Build the pack
cd taskpacks/my-pack
pnpm build

# Run it
cd ../..
pnpm --filter harness run tp run --pack ./taskpacks/my-pack --inputs '{"url":"https://example.com"}'
```

## Running Task Packs

The harness CLI (`tp`) loads and executes task packs:

```bash
tp run --pack <path> --inputs <json>
```

### Arguments

- `--pack <path>`: Path to task pack directory (required)
- `--inputs <json>`: JSON object with input values (defaults to `{}`)

### Exit Codes

- `0`: Success
- `1`: Execution failure
- `2`: Validation error (invalid inputs or pack structure)

## Logs and Artifacts

When a task pack runs, the harness creates a timestamped run directory:

```
./runs/<timestamp>/
  events.jsonl          # Structured log events (JSONL format)
  artifacts/            # Screenshots and HTML snapshots (on error)
    error.png
    error.html
```

### Log Events

Events are written as JSONL (one JSON object per line):

- `run_started`: Pack execution begins
- `step_started`: A step begins
- `step_finished`: A step completes
- `run_finished`: Pack execution completes
- `error`: An error occurred

Each event includes:
- `timestamp`: ISO 8601 timestamp
- `type`: Event type
- `data`: Event-specific data

### Artifacts

On error, the harness automatically saves:
- Full-page screenshot (`error.png`)
- Page HTML snapshot (`error.html`)

These are saved to `./runs/<timestamp>/artifacts/`.

## Task Pack API

### Input Schema

Define inputs as a record of field definitions:

```typescript
inputs: {
  fieldName: {
    type: 'string' | 'number' | 'boolean',
    required?: boolean,
    description?: string,
  }
}
```

### Collectibles Schema

Define collectibles as an array:

```typescript
collectibles: [
  {
    name: 'fieldName',
    type: 'string' | 'number' | 'boolean',
    description?: string,
  }
]
```

### Run Function

```typescript
async run(ctx: RunContext, inputs: Record<string, unknown>): Promise<RunResult>
```

**RunContext** provides:
- `page`: Playwright Page object
- `browser`: Playwright Browser object
- `logger`: Structured logger (log events)
- `artifacts`: Artifact manager (save screenshots/HTML)

**RunResult** must return:
- `collectibles`: Record of extracted data
- `meta`: Metadata (url, durationMs, optional notes)

## Development

### Build

```bash
pnpm build
```

Builds all packages and task packs using TypeScript compiler.

### Dev Mode

```bash
pnpm dev
```

Runs the harness in dev mode (requires building first or using ts-node).

## Dashboard & Teach Mode

The dashboard is a web UI to run Task Packs, view runs and events, and edit flows with **Teach Mode** (AI-assisted step proposal using an LLM and browser MCP).

```bash
# Build everything first
pnpm build

# Start the dashboard (serves UI + API; MCP servers are started on demand)
pnpm --filter @showrun/dashboard start --packs ./taskpacks

# With headful browser for runs (optional)
pnpm --filter @showrun/dashboard start --packs ./taskpacks --headful
```

Then open the URL shown in the terminal (e.g. `http://localhost:5173`). You can run packs, inspect run events, and use Teach Mode to add steps to a flow by describing actions in the browser (the AI proposes DSL steps and applies patches via the editor MCP).

See `packages/dashboard/README.md` for environment variables (e.g. LLM API key for Teach Mode).

## MCP Server

The framework includes an MCP (Model Context Protocol) server that exposes Task Packs as MCP tools over HTTP/SSE.

```bash
pnpm build
pnpm --filter @showrun/mcp-server run tp-mcp --packs ./taskpacks
```

- **Automatic discovery**: Finds Task Packs from specified directories
- **Tool mapping**: Each pack is a callable MCP tool
- **Concurrency**: Configurable concurrent execution
- **Output**: Returns collectibles, metadata, and run paths

See `packages/mcp-server/README.md` for details.

## Requirements

- Node.js 20+
- pnpm (or npm with workspaces)
- Playwright Chromium browser (`pnpm exec playwright install chromium`)

## License

MIT
