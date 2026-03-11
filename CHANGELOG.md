# Changelog

All notable changes are logged here. New entries go at the top of the `Unreleased` section.
When a version is released, rename `Unreleased` to the version number and date, then add a fresh `Unreleased` heading.

Entry format: `- [tag] Description of change`
Tags: `added`, `fixed`, `changed`, `removed`

---

## Unreleased

- [fixed] Dashboard chat now preserves per-conversation live state when switching conversations — returning to a conversation restores its messages, thinking output, and in-flight stream instead of reusing the currently visible chat view
- [changed] Packs and conversations are no longer treated as 1:1 — multiple conversations can link to the same pack, deleting a conversation no longer deletes its pack, and deleting a pack now unlinks dependent conversations instead of removing them
- [added] Packs view can start a new chat conversation for an existing pack, including downloaded registry packs
- [changed] Editor Agent now selects tools and prompts by pack kind — `json-dsl` packs use patch/validate editing, while `playwright-js` packs use JS source editing
- [added] Explicit `Convert to Playwright JS` action in the dashboard for `json-dsl` packs — preserves inputs/collectibles, replaces `flow.json` with a generated `flow.playwright.js` scaffold, and switches the pack to `playwright-js`
- [fixed] Converted packs now refresh immediately in the dashboard packs list and detail view without requiring a full page reload
- [added] `browser_solve_turnstile` tool for exploration agent — detect and click Cloudflare Turnstile checkbox using image-based detection
- [added] Auto-detection of Cloudflare Turnstile after `browser_goto` — adds `_turnstileDetected` and `_hint` to response when found
- [added] `util.solveCloudflareTurnstile()` and `util.detectCloudflareTurnstile()` exposed to playwright-js flows for CAPTCHA solving
- [added] `timeoutMs` field in taskpack.json — set per-pack execution timeout (default 5 minutes)
- [added] `--timeout <seconds>` CLI flag for `showrun run` — override flow timeout from command line
- [fixed] CLI runs now use pack's `.browser-profile/` directory for persistent browser sessions
- [fixed] Registry publish now correctly handles playwright-js packs (reads `flow.playwright.js` instead of `flow.json`)
- [changed] Editor Agent now builds playwright-js flows via `editor_write_js` tool instead of json-dsl step patching; auto-converts existing json-dsl packs on first write
- [added] `showrun.network` context object exposed to playwright-js flows — access `list()`, `find()`, `get()`, `replay()` for full network capture interaction
- [added] Console output capture in playwright-js flows — `console.log()` output returned in `_logs` field of `editor_run_pack` results
- [added] New `playwright-js` pack kind — write raw Playwright JavaScript flows (`flow.playwright.js`) with full API access, best-effort sandboxing, and frozen inputs/secrets
- [added] `replay` function exposed to playwright-js scope — enables network replay from user code

## 0.1.10 - 2026-03-06

- [fixed] Result store not initialized for task packs created at runtime (e.g. via teach mode); now lazily created on first run
- [added] Swappable replay transport: configure `impit` as alternative to Playwright for `network_replay` steps — browser-grade TLS fingerprint impersonation bypasses Cloudflare bot detection without depending on the browser's networking stack
- [changed] Task Packs page uses a master-detail split layout — list on the left, PackEditor inline on the right (no more full-page navigation)
- [fixed] SecretsEditor and TeachMode components now use dark theme CSS variables — previously had unreadable light-colored backgrounds
- [changed] Dashboard nav rail is now expandable — click collapse/expand to toggle icon-only vs icon+label mode
- [changed] Runs page uses a master-detail split layout — list on the left, detail on the right (no more scrolling past the list to see results)
- [changed] PackEditor buttons and styling updated to match dashboard dark theme
- [fixed] Sidebar no longer shows a duplicate logo; shows "Conversations" label instead
- [added] Dashboard favicon and theme-color meta tag, matching the landing page
- [changed] Dashboard redesign: left icon nav rail (Chat/Runs/MCP/Packs) replaces bottom nav, logo moved to upper-left, color palette aligned with landing page, conversations sidebar and chat right panel are now resizable via drag handles
- [fixed] Release script rollback now uses in-memory snapshots instead of `git checkout`, preventing multi-version revert when git working tree has prior uncommitted changes
- [changed] Registry client, CLI, and dashboard now use scoped `@username/slug` pack identifiers — install and report commands require the full ref; search results display the scoped format; publish keeps using the short slug (server infers username)
- [changed] `resolveDefaultPacksDir()` extracted to `@showrun/core` — shared fallback chain (env → local `./taskpacks` → system data dir) used by dashboard, registry install, and serve commands
- [changed] Default registry URL set to `https://registry.showrun.co` — registry commands work out of the box without configuration
- [added] `scripts/release.js` — monorepo release script with RC workflow (`rc`, `stable`, `--dry-run`), publishes all 8 packages in dependency order
- [added] `--cdp-url` flag for `showrun run` — connect to an existing browser via Chrome DevTools Protocol instead of launching a new one
- [added] Actionable error messages for missing inputs (prints schema) and missing secrets (prints file location + JSON template for `.secrets.json`)
- [added] Post-execution reminder message about reporting non-functioning or malicious task packs
- [added] CLI run results auto-stored to per-pack SQLite database (same as MCP server), disable with `--no-result-store`
- [added] `showrun results` CLI command group with `list` and `query` subcommands for querying stored results with JMESPath filtering
- [added] `showrun registry report` command — report packs for policy violations (malicious, spam, inappropriate, copyright) with dashboard proxy route
- [added] Registry client in `@showrun/core` — publish, search, and install task packs from a remote registry
- [added] OAuth Device Flow (RFC 8628) authentication — CLI and dashboard never handle passwords; users authorize in their browser
- [added] `showrun registry` CLI command group with `login`, `logout`, `whoami`, `publish`, `search`, and `install` subcommands
- [added] Dashboard registry integration — publish button in pack list and editor, device-flow login modal
- [added] Dashboard `/api/registry/*` proxy endpoints for registry operations
- [added] Token persistence in `~/.config/showrun/auth.json` with automatic access token refresh
- [added] `registry.url` config option and `SHOWRUN_REGISTRY_URL` env var for registry server URL
