# Changelog

All notable changes are logged here. New entries go at the top of the `Unreleased` section.
When a version is released, rename `Unreleased` to the version number and date, then add a fresh `Unreleased` heading.

Entry format: `- [tag] Description of change`
Tags: `added`, `fixed`, `changed`, `removed`

---

## Unreleased

- [changed] System prompt now assembled dynamically from Techniques DB when available; falls back to built-in generic prompt when DB is unavailable
- [removed] `EXPLORATION_AGENT_SYSTEM_PROMPT.md` — content migrated to `system_prompt` category seed techniques in the Techniques DB
- [changed] `seedIfEmpty()` now supports incremental seeding — new seed techniques are added to existing DBs without skipping
- [added] `TechniqueManager.listByCategory()` method for filtering techniques by category
- [added] `system_prompt` category for TechniqueCategory — separates agent workflow instructions from knowledge techniques
- [added] Dual vectorization modes: Weaviate-managed (text2vec-transformers, no API key) or bring-your-own-vectors (external embedding API)
- [added] Techniques DB — vector-indexed knowledge store (`@showrun/techniques` package) using Weaviate for reusable agent learnings across sessions
- [added] `showrun techniques` CLI subcommand with `setup`, `list`, `import`, and `export` operations
- [added] Three new agent tools: `techniques_load`, `techniques_search`, `techniques_propose` for hypothesis-first flow creation
- [added] REST API for techniques CRUD, batch review, and health check (`/api/techniques/*`)
- [added] Phase 0 (LOAD KNOWLEDGE) and Phase 6b (CAPTURE LEARNINGS) in exploration agent system prompt
- [added] Pre-session technique injection — P1 techniques auto-loaded into agent context
- [added] Pluggable `VectorStore` interface for alternative vector DB backends
- [changed] `ShowRunConfig` extended with `techniques` section (vectorStore, embedding, collectionName)
- [fixed] Auto-detect existing `.browser-profile/` in pack directory and use it even when `persistence` is not explicitly configured
- [fixed] MCP server (stdio and HTTP) now passes `packPath` so Camoufox uses the pack's browser profile
- [fixed] `editor_run_pack` now passes `profileId` and `packPath` so Camoufox reuses the pack's persistent browser profile instead of launching an ephemeral instance
- [fixed] HTTP-only snapshot replay now uses Nunjucks for template resolution (supports filters like `| urlencode`)
- [fixed] HTTP replay hangs due to stale `content-length` header from snapshot (now auto-removed, Node `fetch()` sets it correctly)
- [fixed] HTTP replay requests have a 30s timeout via AbortController (prevents hanging on unresponsive servers)
- [fixed] Artifact save crash in HTTP mode when flow errors (`page` is null)
- [added] Request snapshots — HTTP-first execution for API-only flows (no browser needed)
- [added] Staleness detection for request snapshots (TTL + response validation)
- [added] Automatic snapshot capture after successful browser runs with `network_replay` steps

## 0.1.1a — 2026-02-12

- [fixed] `npx showrun` from git clone auto-builds if dist is missing (no more manual `pnpm build` required)

## 0.1.1 — 2026-02-11

- [changed] Updated package.json description to align with README
- [changed] Removed private flag from package.json to enable npm publishing
- [added] Full conversation transcript logging — saves agent messages, tool traces, and flow state to `conversation_transcripts` table (gated behind `--transcript-logging` / `SHOWRUN_TRANSCRIPT_LOGGING`)
- [added] `agent.transcriptLogging` config option with CLI flag `--transcript-logging` and env var `SHOWRUN_TRANSCRIPT_LOGGING`
- [fixed] Capture thinking output in saved conversation transcripts (was only streamed to client, not persisted)
- [removed] Legacy prompt files `AUTONOMOUS_EXPLORATION_SYSTEM_PROMPT.md`, `TEACH_MODE_SYSTEM_PROMPT.md`, and `output_debug.txt` — only `EXPLORATION_AGENT_SYSTEM_PROMPT.md` is used now
- [changed] Prompt config simplified: `EXPLORATION_AGENT_PROMPT_PATH` replaces `AUTONOMOUS_EXPLORATION_PROMPT_PATH` and `TEACH_MODE_SYSTEM_PROMPT_PATH`
- [added] Official brand logo (icon + "showrun" wordmark) in header and welcome screen, replacing text-only gradient
- [added] `agent.debug` config option (`SHOWRUN_DEBUG` env var) — debug flag can now be set via config.json in addition to `--debug` CLI flag
- [added] CHANGELOG.md and CLAUDE.md rule requiring changelog entries for every change
- [added] `--debug` flag for dashboard — gates failed tool call logging behind a flag instead of always writing to disk
- [changed] Dashboard UI restyled to match brand guidelines (colors, typography, CSS variables)
