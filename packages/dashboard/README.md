# ShowRun Dashboard

A real-time web dashboard for running and observing Task Packs, with **Teach Mode** — an AI-assisted flow editor that lets you describe browser actions in natural language and have them converted to DSL steps.

## Quick Start

```bash
# Via the unified CLI (recommended)
showrun dashboard --packs ./taskpacks

# Or via npx
npx showrun dashboard --packs ./taskpacks

# With visible browser window
showrun dashboard --packs ./taskpacks --headful
```

## CLI Options

```
showrun dashboard [options]

Options:
  --packs <dir1,dir2>    Comma-separated pack directories (default: ./taskpacks if exists)
  --port <n>             Server port (default: 3333)
  --host <hostname>      Bind address (default: 127.0.0.1)
  --headful              Show the browser window during automation
  --baseRunDir <path>    Run output directory (default: ./runs-dashboard)
  --workspace <path>     Writable directory for pack creation/editing
  --data-dir <path>      Database directory (default: ./data)
  --help, -h             Show help
```

## Configuration

The dashboard reads configuration from two sources: **environment variables** and **config.json** files. Config values are applied as environment variable defaults — real env vars and `.env` files always take precedence.

### Setting up config.json

```bash
# Create a local .showrun/config.json in your project
showrun config init

# Or create a global config (shared across all projects)
showrun config init --global
```

See the [top-level README](../../README.md#configuration) for full details on the config system.

### Environment Variables

All variables below can be set via `.env`, real environment variables, or `config.json`. See the table for the corresponding config.json path.

#### LLM Provider (required for Teach Mode)

| Variable | Description | Default | config.json path |
|----------|-------------|---------|------------------|
| `LLM_PROVIDER` | LLM provider to use: `anthropic` or `openai` | Auto-detect from available API keys | `llm.provider` |
| `ANTHROPIC_API_KEY` | Anthropic API key | — | `llm.anthropic.apiKey` |
| `ANTHROPIC_MODEL` | Anthropic model ID | `claude-sonnet-4-20250514` | `llm.anthropic.model` |
| `ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` | `llm.anthropic.baseUrl` |
| `OPENAI_API_KEY` | OpenAI API key | — | `llm.openai.apiKey` |
| `OPENAI_MODEL` | OpenAI model ID | `gpt-4o-2024-08-06` | `llm.openai.model` |
| `OPENAI_BASE_URL` | OpenAI API base URL | `https://api.openai.com/v1` | `llm.openai.baseUrl` |

You need at least one API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) for Teach Mode to work. If both are set, Anthropic is preferred unless `LLM_PROVIDER` is explicitly set to `openai`.

#### Agent Behavior

| Variable | Description | Default | config.json path |
|----------|-------------|---------|------------------|
| `AGENT_MAX_BROWSER_ROUNDS` | Max consecutive browser-only iterations (0 = unlimited) | `0` | `agent.maxBrowserRounds` |

#### System Prompts

| Variable | Description | config.json path |
|----------|-------------|------------------|
| `TEACH_CHAT_SYSTEM_PROMPT` | Inline system prompt text (highest priority) | `prompts.teachChatSystemPrompt` |
| `AUTONOMOUS_EXPLORATION_PROMPT_PATH` | Path to custom exploration prompt file | `prompts.autonomousExplorationPromptPath` |
| `TEACH_MODE_SYSTEM_PROMPT_PATH` | Path to custom teach mode prompt file | `prompts.teachModeSystemPromptPath` |

System prompt resolution order:
1. `TEACH_CHAT_SYSTEM_PROMPT` env var (inline text)
2. `AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md` found via config dirs, cwd, or ancestors
3. `TEACH_MODE_SYSTEM_PROMPT.md` (fallback)

When running `showrun config init`, the exploration prompt is automatically copied into your config directory so it's available from any working directory.

## Features

### Task Pack Discovery
- Automatically discovers task packs from specified directories
- Validates packs and shows metadata (id, name, version, description)
- Displays input schema and collectibles schema

### Run Management
- Queue and execute task packs with JSON inputs
- View run history with status (queued/running/success/failed)
- See run details including duration, collectibles, and paths

### Real-time Event Streaming
- Live event stream via Socket.IO
- Events: `run_started`, `step_started`, `step_finished`, `error`, `run_finished`
- Events are written to JSONL files and streamed to the UI simultaneously

### Teach Mode

An AI agent that assists with flow creation. Describe what you want in natural language and the agent will:
- Explore websites autonomously
- Propose DSL steps based on what it finds
- Apply flow patches to your task pack
- Run and validate flows interactively

## Teach Mode Agent Tools

### Editor Tools
| Tool | Description |
|------|-------------|
| `editor_read_pack(packId)` | Read pack contents (taskpack.json + flow.json) |
| `editor_validate_flow(flowJsonText)` | Validate flow JSON syntax and schema |
| `editor_apply_flow_patch(packId, op, ...)` | Apply patch to flow (append, insert, replace, delete) |
| `editor_run_pack(packId, inputs)` | Run pack in harness (not in browser session) |

### Browser Tools
| Tool | Description |
|------|-------------|
| `browser_start_session(headful)` | Start browser session |
| `browser_goto(sessionId, url)` | Navigate to URL |
| `browser_go_back(sessionId)` | Go back in history |
| `browser_click(sessionId, linkText, role, selector)` | Click element |
| `browser_type(sessionId, text, label, selector)` | Type into input |
| `browser_screenshot(sessionId)` | Take screenshot (vision analysis) |
| `browser_get_links(sessionId)` | Get all page links |
| `browser_get_dom_snapshot(sessionId)` | Get structured DOM snapshot |

### Network Tools
| Tool | Description |
|------|-------------|
| `browser_network_list(sessionId, filter)` | List captured requests (filter: all, api, xhr) |
| `browser_network_search(sessionId, query)` | Search requests by content |
| `browser_network_get(sessionId, requestId)` | Get request metadata |
| `browser_network_get_response(sessionId, requestId, full)` | Get response body |
| `browser_network_replay(sessionId, requestId, overrides)` | Replay request with overrides |
| `browser_network_clear(sessionId)` | Clear network buffer |

## Security

The dashboard implements several security measures:

1. **Localhost-only binding**: By default, the server binds to `127.0.0.1` only
2. **Session token authentication**: A random token is generated on startup and required for Socket.IO connections and POST requests
3. **Strict pack allowlist**: Only packs from explicitly provided `--packs` directories can be run
4. **Input validation**: All inputs are validated against pack schemas

**The dashboard is designed for local development use only.** Do not expose it to untrusted networks. If you need to access from other machines, use `--host` carefully and ensure your network is secure.

## Architecture

- **Backend**: Express.js + Socket.IO for real-time updates
- **Frontend**: React + Vite SPA
- **Runner**: Reuses `runTaskPack` from `@showrun/core`
- **Logger**: Custom `SocketLogger` that writes JSONL and emits socket events
- **Queue**: Concurrency-limited run queue (default: 1 concurrent run)
- **LLM**: Pluggable provider system (Anthropic / OpenAI) for Teach Mode

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Development mode (watch)
pnpm dev
```
