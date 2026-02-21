# ShowRun

> **Experimental** — This project is in early development. APIs, file formats, and CLI interfaces may change without notice. Use at your own risk.

A TypeScript + Playwright framework for deterministic, versioned browser automation **Task Packs**: define flows in JSON or code, run them via CLI or MCP, and edit them with an AI-assisted dashboard (Teach Mode).

## When to Use ShowRun

- **Works without an API** — automate sites with no public or documented API (e.g. legacy platforms), though it works just as well alongside existing APIs
- **Browser agents are too slow or flaky** — you need production-grade reliability, not best-effort prompting
- **Automation needs memory, iteration and speed** — workflows evolve, and you want versioned, repeatable runs
- **AI discovers the workflow, humans own it** — use Teach Mode to let AI propose steps, then lock them into deterministic and exportable flows

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

### Using npx

```bash
# 1. Create a directory for your project
mkdir my-showrun-project && cd my-showrun-project

# 2. Create a .env file with your LLM API key (needed for Teach Mode)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Download the Camoufox browser (anti-detection Firefox)
npx camoufox-js fetch

# 4. Launch the dashboard
npx showrun dashboard --packs ./taskpacks_local

# Add --headful to see the browser window during automation
npx showrun dashboard --packs ./taskpacks_local --headful
```

### From Git Clone

```bash
# Clone the repository
git clone https://github.com/useshowrun/showrun
cd showrun

# Install dependencies (requires pnpm)
pnpm install

# Approve native module builds if prompted
pnpm approve-builds

# Install camoufox browser (anti-detection Firefox)
cd packages/dashboard && npx camoufox-js fetch && cd ../..

# Build all packages
pnpm build

# Start the dashboard
pnpm dashboard --packs ./taskpacks_local --headful
```

### Environment Setup

At minimum, you need an LLM API key for Teach Mode (AI-assisted flow editing). You can configure this via a `.env` file or the config system (see [Configuration](#configuration) below):

```bash
# Option A: .env file in project root
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Option B: config.json (persists across projects)
showrun config init --global
# Then edit ~/.config/showrun/config.json (Linux/macOS) or %APPDATA%\showrun\config.json (Windows)
```

See `packages/dashboard/README.md` for the full list of supported environment variables and their config.json equivalents.

### Development Setup

```bash
# Install dependencies (using pnpm)
pnpm install

# Approve native module builds if prompted
pnpm approve-builds

# Install camoufox browser
npx camoufox-js fetch

# Build all packages and task packs
pnpm build
```

### Run Example Task Pack

```bash
# Run example
pnpm test:example

# Or use the unified CLI directly:
node packages/showrun/dist/cli.js run ./taskpacks/example-json --inputs '{}'
```

## Creating a New Task Pack

Task Packs use the **json-dsl** format with two files:
- `taskpack.json` - metadata (id, name, version, description)
- `flow.json` - inputs, collectibles, and flow steps

No build step required!

### 1. Create Task Pack Directory

```bash
mkdir -p taskpacks/my-pack
```

### 2. Create `taskpack.json`

```json
{
  "id": "my.pack.id",
  "name": "My Task Pack",
  "version": "0.1.0",
  "description": "What this pack does",
  "kind": "json-dsl"
}
```

### 3. Create `flow.json`

```json
{
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
        "url": "{{inputs.url}}",
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

That's it! See `taskpacks/example-json/` for a complete example.

### 4. Run Your Pack

```bash
node packages/showrun/dist/cli.js run ./taskpacks/my-pack --inputs '{"url":"https://example.com"}'
```

## Running Task Packs

Use the unified `showrun` CLI to run task packs:

```bash
showrun run <pack-path> --inputs <json>
```

### Arguments

- `<pack-path>`: Path to task pack directory (required)
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

## Configuration

ShowRun uses a layered configuration system. Values are resolved in this order (highest priority wins):

```
Real env vars > .env file > project config.json > global config.json > built-in defaults
```

### Quick Setup

```bash
# Create a project-local config
showrun config init

# Or create a global config (shared across all projects)
showrun config init --global

# See what ShowRun resolved
showrun config show

# See which directories are searched
showrun config path
```

### Config File Format

Config files are stored as `.showrun/config.json` (project-local) or in a platform-specific global directory:

| Platform | Global config directory |
|----------|----------------------|
| Linux | `$XDG_CONFIG_HOME/showrun/` (default: `~/.config/showrun/`) |
| macOS | `$XDG_CONFIG_HOME/showrun/` (default: `~/.config/showrun/`) |
| Windows | `%APPDATA%\showrun\` |

```json
{
  "llm": {
    "provider": "anthropic",
    "anthropic": { "apiKey": "sk-ant-...", "model": "", "baseUrl": "" },
    "openai": { "apiKey": "", "model": "", "baseUrl": "" }
  },
  "agent": {
    "maxBrowserRounds": 0
  },
  "prompts": {
    "teachChatSystemPrompt": "",
    "autonomousExplorationPromptPath": "",
    "teachModeSystemPromptPath": ""
  }
}
```

Each key maps to an environment variable. Values from `config.json` are only applied when the corresponding env var is **not already set**, so `.env` and real env vars always win.

| config.json path | Environment variable |
|------------------|---------------------|
| `llm.provider` | `LLM_PROVIDER` |
| `llm.anthropic.apiKey` | `ANTHROPIC_API_KEY` |
| `llm.anthropic.model` | `ANTHROPIC_MODEL` |
| `llm.anthropic.baseUrl` | `ANTHROPIC_BASE_URL` |
| `llm.openai.apiKey` | `OPENAI_API_KEY` |
| `llm.openai.model` | `OPENAI_MODEL` |
| `llm.openai.baseUrl` | `OPENAI_BASE_URL` |
| `agent.maxBrowserRounds` | `MAX_BROWSER_ROUNDS` |
| `prompts.teachChatSystemPrompt` | `TEACH_CHAT_SYSTEM_PROMPT` |
| `prompts.explorationAgentPromptPath` | `EXPLORATION_AGENT_PROMPT_PATH` |

### Directory Search Order

ShowRun searches for `.showrun/config.json` in multiple locations (lowest to highest priority):

1. Global config directory (platform-specific, see table above)
2. `$HOME/.showrun/` (Linux/macOS only)
3. Ancestor directories walking up from cwd (e.g. `../../.showrun/`)
4. `<cwd>/.showrun/`

When multiple config files are found, they are deep-merged with higher-priority values winning.

### System Prompts

The exploration agent's system prompt is assembled dynamically from the Techniques DB when available. When the DB is unavailable, a built-in fallback prompt is used. You can override the prompt via the `TEACH_CHAT_SYSTEM_PROMPT` env var (inline text) or `EXPLORATION_AGENT_PROMPT_PATH` env var (file path).

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
- Camoufox browser — anti-detection Firefox (`npx camoufox-js fetch`)

## Contributing

There are no formal contribution guidelines yet. That said, all contributions are welcome — feel free to open issues, submit pull requests, or start discussions.

## License

MIT
