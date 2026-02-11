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

### CLI

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
showrun pack create --dir ./taskpacks --id my-pack --name "My Pack"
showrun pack validate --path ./taskpacks/my-pack
showrun pack set-flow --path ./taskpacks/my-pack --flow '{"flow":[...]}'
showrun pack set-meta --path ./taskpacks/my-pack --meta '{"description":"..."}'

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

### Task Pack Format

Task packs use the json-dsl format with two files:
```
taskpacks/my-pack/
├── taskpack.json   # metadata with "kind": "json-dsl"
└── flow.json       # inputs + collectibles + flow array
```

### DSL Step Types

All steps defined in `packages/core/src/dsl/types.ts`:

### Dashboard AI Agent

The dashboard includes an AI agent with browser and editor tools. Key features:

**Browser Usage / Exploration:**
- Automatically explore a given or inferred web page to check for API calls and DOM
structure.

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

## Development Considerations

### VERY IMPORTANT
**Always** use these rules in development:
- Whenever a new library is to be added to the project, always look up the latest version of the library.
- Always use context7 for up-to date documentations. Do not go by inferred rules. Always double check if your library usage is correct via context7.
- Consider new features as modules that can be plugged in and removed. Use structures that allow us to swap out different implementations.

### SOMEWHAT IMPORTANT
- This repository is not thoroughly tested, but that's not an excuse to not write any tests. For any significant feature, write at least a few tests so that we are sure we did not break core functionality.
- This repository is very young in development. Breaking changes are not that important for now. For now, it needs to work. Do not offer chances for backwards compatibility. No one else is using this right now.

## Changelog

**IMPORTANT: Every implemented change must be documented in `CHANGELOG.md`.**
- Add a one-line entry at the **top** of the `## Unreleased` section.
- Use the format: `- [tag] Description` where tag is one of: `added`, `fixed`, `changed`, `removed`.
- Keep entries concise — one line per change, written from a user/developer perspective.
- Do NOT bump version numbers. When we decide to release, we will rename `Unreleased` to a version heading manually.

