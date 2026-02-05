# ShowRun Dashboard

A real-time dashboard for running and observing Task Packs. This dashboard provides a web UI to discover task packs, trigger runs, and stream live run events.

## Quick Start

### Via npx (when published)

```bash
npx showrun-dashboard
```

### Local Development

```bash
# Build the dashboard (from project root)
pnpm build

# Run it (choose one method):
# Method 1: Using pnpm filter (recommended)
pnpm --filter @showrun/dashboard start

# Method 2: Direct node execution
node packages/dashboard/dist/cli.js

# Method 3: From dashboard directory
cd packages/dashboard && pnpm start
```

**Note**: `pnpm exec showrun-dashboard` won't work for workspace packages. Use `pnpm --filter @showrun/dashboard start` instead.

## Usage

```bash
showrun-dashboard [options]

Options:
  --packs <dir1,dir2>    Comma-separated list of directories to search for task packs
                         (default: ./taskpacks if exists)
  --port <n>             Port to bind the server to (default: 3333)
  --host <hostname>      Hostname or IP to bind to (default: 127.0.0.1)
                         WARNING: Only use this if you understand the security implications
  --headful              Run browser in headful mode (default: false)
  --baseRunDir <path>    Base directory for run outputs (default: ./runs-dashboard)
  --help, -h             Show this help message
```

### Examples

```bash
# Basic usage (discovers packs from ./taskpacks)
showrun-dashboard

# Custom packs directory
showrun-dashboard --packs ./taskpacks,./custom-packs

# Custom port
showrun-dashboard --port 4000

# Headful mode (show browser)
showrun-dashboard --headful

# Custom run directory
showrun-dashboard --baseRunDir ./my-runs
```

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
- Events include: `run_started`, `step_started`, `step_finished`, `error`, `run_finished`
- Events are written to JSONL files and streamed to the UI simultaneously

## Security

The dashboard implements several security measures:

1. **Localhost-only binding**: By default, the server binds to `127.0.0.1` only
2. **Session token authentication**: A random token is generated on startup and required for:
   - Socket.IO connections
   - POST requests to `/api/runs`
3. **Strict pack allowlist**: Only packs from explicitly provided `--packs` directories can be run
4. **No arbitrary path execution**: Pack IDs must match discovered packs
5. **Input validation**: All inputs are validated against pack schemas

### Security Notes

- The dashboard is designed for **local development use only**
- Do not expose the dashboard to untrusted networks
- If you need to access from other machines, use `--host` carefully and ensure your network is secure
- The session token is displayed in the console on startup

## Architecture

- **Backend**: Express.js server with Socket.IO for real-time updates
- **Frontend**: React + Vite SPA
- **Runner**: Reuses `runTaskPack` from `@showrun/core`
- **Logger**: Custom `SocketLogger` that writes JSONL and emits socket events
- **Queue**: Concurrency-limited run queue (default: 1 concurrent run)

## Teach Mode Agent Tools

The dashboard includes an AI agent for assisted flow creation. The agent has access to the following tools:

### Editor Tools
| Tool | Description |
|------|-------------|
| `editor_list_packs` | List all JSON Task Packs (id, name, version, description) |
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
| `browser_get_dom_snapshot(sessionId)` | Get structured DOM snapshot with interactive elements, forms, headings, navigation |

### Network Tools
| Tool | Description |
|------|-------------|
| `browser_network_list(sessionId, filter)` | List captured requests (filter: all, api, xhr) |
| `browser_network_search(sessionId, query)` | Search requests by content |
| `browser_network_get(sessionId, requestId)` | Get request metadata |
| `browser_network_get_response(sessionId, requestId, full)` | Get response body |
| `browser_network_replay(sessionId, requestId, overrides)` | Replay request with overrides |
| `browser_network_clear(sessionId)` | Clear network buffer |

### System Prompts

The agent behavior is controlled by system prompts. Priority order:

1. **`AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md`** - Full autonomous exploration & roadmap system. Enables the AI to:
   - Understand complex goals from natural language
   - Explore websites autonomously
   - Create roadmaps before implementing
   - Consult users at decision points
   - Implement DSL steps incrementally

2. **`TEACH_MODE_SYSTEM_PROMPT.md`** - Original reactive step proposal system

Set custom prompt via environment variable:
```bash
AUTONOMOUS_EXPLORATION_PROMPT_PATH=/path/to/custom-prompt.md showrun-dashboard
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Development mode (watch)
pnpm dev
```

## Future Enhancements

- Teach Mode: DOM overlay for step labeling and recording
- Task Pack Creation UI
- User authentication
- Remote deployment support
