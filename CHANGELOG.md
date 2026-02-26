# Changelog

All notable changes are logged here. New entries go at the top of the `Unreleased` section.
When a version is released, rename `Unreleased` to the version number and date, then add a fresh `Unreleased` heading.

Entry format: `- [tag] Description of change`
Tags: `added`, `fixed`, `changed`, `removed`

---

## Unreleased

- [added] Registry client in `@showrun/core` — publish, search, and install task packs from a remote registry
- [added] OAuth Device Flow (RFC 8628) authentication — CLI and dashboard never handle passwords; users authorize in their browser
- [added] `showrun registry` CLI command group with `login`, `logout`, `whoami`, `publish`, `search`, and `install` subcommands
- [added] Dashboard registry integration — publish button in pack list and editor, device-flow login modal
- [added] Dashboard `/api/registry/*` proxy endpoints for registry operations
- [added] Token persistence in `~/.config/showrun/auth.json` with automatic access token refresh
- [added] `registry.url` config option and `SHOWRUN_REGISTRY_URL` env var for registry server URL

## 0.1.8 — 2026-02-22

- [changed] Dashboard browser launching consolidated to use core's unified `launchBrowser()`, ensuring auto-fetch and consistent engine behavior
- [added] Camoufox browser binary is auto-downloaded on first use; no manual `npx camoufox-js fetch` needed
- [fixed] Headful mode now works on macOS/Windows without DISPLAY env var; DISPLAY check is Linux-only
- [added] Setup wizard now asks for taskpacks directory location; seeds it with example-json pack; dashboard and serve commands use it as default
- [fixed] MCP Usage modal now generates correct `--packs` path from server-side pack directories instead of broken client-side derivation
- [fixed] Config loader `[Config] Loaded: ...` message no longer pollutes stdout, which broke stdio MCP transport

## 0.1.7 — 2026-02-21

- [added] First-run setup wizard — interactively prompts for API keys and config when running `showrun dashboard` without prior configuration
- [changed] Dashboard data (database, run logs, default taskpacks) now stored in system data directory (`~/.local/share/showrun/`) instead of polluting the current working directory
- [changed] Default taskpacks directory falls back to `~/.local/share/showrun/taskpacks/` when `--packs` is not specified and `./taskpacks` does not exist
- [added] `getGlobalDataDir()` and `updateGlobalConfig()` helpers in `@showrun/core` for system data directory and config writing
- [changed] `showrun uninstall` now also cleans up the data directory (`~/.local/share/showrun/`)

## 0.1.5 — 2026-02-21

- [changed] CLI package reverted from `@showrun/cli` back to `showrun` — use `npx showrun` again

## 0.1.4 — 2026-02-20

- [changed] CLI package renamed from `showrun` to `@showrun/cli`
- [changed] Root package.json marked `private: true` and renamed to `showrun-monorepo` to prevent accidental npm publishing

## 0.1.2 — 2026-02-19

- [added] LinkedIn Sales Navigator `pctEncode` seed technique — domain-specific knowledge for correct URL encoding with `()` delimiters in Sales Navigator query syntax
- [fixed] `urlReplace`/`bodyReplace` array values now pass flow validation (runtime already supported arrays, but `validation.ts` rejected them)
- [changed] Editor Agent prompt: added complete flow.json example, consolidated override strategies (A/B/C), added common mistakes for missing `id`/`type`/`params` and one-at-a-time appends
- [changed] Knowledge techniques "Anti-Bot Detection Awareness" and "Login & Authentication with Iframes and TOTP" downgraded from P1 to P2 — still loaded early via `techniques_load(maxPriority: 2)` but no longer in always-present system prompt
- [fixed] `seedIfEmpty()` now detects priority changes in seed techniques (previously only triggered on content changes)
- [added] `GET /api/browser/screenshot/:conversationId` endpoint — returns raw PNG screenshot of the agent's browser, works regardless of window state (headless, minimized, etc.)
- [fixed] `browser_type` now falls back to keyboard-based typing (`page.keyboard.type()`) when Playwright's `fill()` silently fails — fixes TOTP and other iframe input fields where programmatic value setting doesn't trigger input handlers
- [added] `pctEncode` template filter — like `urlencode` but also encodes parentheses and other RFC 3986 unreserved chars that `encodeURIComponent` leaves raw, fixing 400 errors on APIs that use `()` as structural delimiters (e.g. LinkedIn Sales Navigator)
- [fixed] HTTP-only mode now applies flow-level `overrides` (bodyReplace, urlReplace, setQuery, etc.) from `network_replay` steps — previously only snapshot-level overrides were used, causing cached replays to ignore step overrides
- [changed] Editor Agent Strategy 0 corrected: dynamic URL now paired with bodyReplace for HTTP-only cached mode compatibility (was incorrectly claiming "no overrides needed")
- [changed] Exploration Agent seed techniques updated to recommend bodyReplace alongside dynamic URL for HTTP-only mode support
- [changed] Editor Agent now verifies collectible data content after test runs — checks for correct filtering, non-empty results, and data structure
- [changed] Phase 4 (roadmap approval) explicitly marked as MANDATORY — cannot be skipped even for hypothesis-based flows
- [changed] Exploration Completeness Checklist now requires explicit URL-based filtering test before proceeding to roadmap
- [removed] 4 redundant knowledge seed techniques that overlapped with system_prompt seeds: API-First Data Extraction, Never Hardcode Credentials, Prefer Role-Based Element Targets, Network Replay Override Patterns
- [changed] `seedIfEmpty()` now updates existing seed techniques whose content has changed AND removes stale seeds no longer in the seed list
- [changed] Exploration Agent seed technique Phase 5 now includes dynamic URL recommendation and raw POST body guidance
- [changed] Exploration Agent seed technique Phase 2 now includes URL-based filtering detection step in exploration strategy
- [added] Editor Agent Strategy 0 (Dynamic URL) — navigate with Nunjucks-templated URL so API requests automatically have correct filters, eliminating need for bodyReplace
- [changed] Exploration Agent Phase 5 now explicitly instructs to recommend dynamic URL approach over bodyReplace when URL-based filtering is supported
- [added] Editor Agent FAST PATH guide — teaches agent to build API flows in 5 calls using `batch_append`, `saveAs`/`fromVar` pattern, reducing wasted iterations
- [changed] Editor Agent overrides documentation rewritten with 5-strategy decision guide — "dynamic URL with no overrides" is now the preferred strategy when URL filtering works
- [changed] Exploration Agent now instructed to report URL-based filtering support and recommend dynamic URL templates for Editor Agent
- [added] Comprehensive `overrides` documentation in Editor Agent prompt — covers `bodyReplace`, `urlReplace`, `setQuery`, `setHeaders`, `body` with examples for JSON and URL-encoded bodies
- [changed] Exploration Agent fallback prompt adds Phase 0 (LOAD KNOWLEDGE) and Phase 6b (CAPTURE LEARNINGS) for Techniques DB integration
- [changed] Exploration Agent now instructed to include raw POST body in `agent_build_flow` exploration context for reliable Editor Agent body overrides
- [changed] `techniques_search` tool description clarifies that matching techniques can replace exploration for known domains
- [added] Provider-based token counting — `LlmProvider.countTokens()` replaces heuristic char/4 estimation for accurate context management
- [added] `@anthropic-ai/tokenizer` for precise Anthropic token counts; OpenAI uses char/4 heuristic
- [fixed] Token estimation for images now uses fixed ~1600 tokens instead of broken `url.length / 25` formula
- [fixed] Template resolution errors now surfaced to agent instead of silently returning raw `{{secret.X}}` syntax
- [fixed] Summarization fallback now correctly reports `wasSummarized: false` when truncation is used instead of summarization
- [fixed] `nonEditorRounds` counter now resets when non-browser tools are called, preventing false "max iterations" errors
- [fixed] Streaming `res.write()` errors now caught and set `aborted = true` instead of crashing the agent loop
- [fixed] Pack initializer now retries up to 3 times with fallback IDs before aborting
- [fixed] Stale browser screenshots no longer re-injected across tool iterations in agent loop
- [fixed] Result store operations now awaited instead of fire-and-forget, preventing silent data loss
- [fixed] `skip_if` condition errors now logged to structured logger and surfaced in `_hints` for agent visibility
- [fixed] JMESPath empty-result hints now include actual top-level keys to help agents debug path issues
- [fixed] Sensitive info (tokens, passwords, credentials) redacted from error messages returned to agents
- [fixed] Browser session creation race condition prevented with per-conversation locking
- [fixed] Secrets timeout race condition prevented with settled flag for double-resolution guard
- [fixed] `batch_append` validation errors now provide per-step type hints from the failing step
- [changed] Prompt assembly uses token-based truncation (12k tokens) via provider tokenizer when available
- [fixed] Editor Agent success heuristic now requires a passing `editor_run_pack` call — step creation alone no longer counts as success
- [fixed] Truncated `editor_run_pack` output no longer silently loses test result info — extracts success/error via regex when JSON is truncated
- [fixed] `urlReplace`/`bodyReplace` overrides now accept both single object and array in DSL types, browser inspector, and core network capture
- [added] Template resolution (Nunjucks) for `browser_network_replay` overrides — `{{secret.X}}` and other templates now work in override values
- [added] `batch_append` op for `editor_apply_flow_patch` — add multiple steps in a single call to save context and turns
- [changed] `isLikelyApi` heuristic now detects `application/json` Content-Type, `.json` URLs, `/rest/`, `/data/` patterns
- [changed] Network capture limits increased: `POST_DATA_CAP` 500→4000, `RESPONSE_BODY_CAPTURE_MAX` 2000→8000
- [changed] Network buffer eviction now preserves API entries — non-API static resources are evicted first when buffer is full
- [added] Step-level failure info surfaced on flow errors — `failedStepId`, partial collectibles, and enriched error messages now returned to AI agents
- [changed] Consolidated duplicated MCP server tool registration into shared `toolRegistration.ts` module
- [added] Pluggable result store for persisting MCP run outputs — per-pack `results.db` with SQLite backend
- [added] `showrun_query_results` MCP tool for querying/filtering stored results with JMESPath
- [added] `showrun_list_results` MCP tool for listing stored results across packs
- [added] Auto-store after successful task pack runs; large results are summarized with a key for follow-up queries
- [added] `--no-result-store` flag for `showrun serve` to disable result storage
- [added] `InMemoryResultStore` for testing and ephemeral usage
- [fixed] Close Exploration Agent's browser session before Editor Agent starts — prevents `.browser-profile` lock conflict when `editor_run_pack` tries to launch a browser
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
- [added] `install.sh` bootstrap script for `curl | bash` one-line install (platform checks, Node.js/nvm detection, npm install, Camoufox fetch, config init)
- [changed] `bin/showrun.js` wrapper auto-builds on first run — ensures pnpm, runs `pnpm install && pnpm build` if dist is missing (works for both git clone and npm install -g)
- [added] `showrun uninstall` command to clean up Camoufox data and config directory

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
