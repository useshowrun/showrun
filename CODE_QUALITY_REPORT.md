# Code Quality Assessment - ShowRun

**Date:** 2026-03-09
**Scope:** `packages/` directory, with extra focus on `playwright-js` code

---

## Executive Summary

The codebase is architecturally sound with clean package boundaries and no circular dependencies. Cross-package imports correctly go through entry points. The main issues are: **4 files over 1000 lines** that need splitting, **redaction logic duplicated across 4 files**, **3 copies of the `ElementFingerprint` interface**, and a **726-line builders module that's never imported** by any consumer.

---

## 1. Code Duplication

### 1.1 Redaction Utilities (4 copies)

Identical `redactHeaders()` / `redactPostData()` / `SENSITIVE_HEADER_NAMES` logic appears in:

| File | Lines |
|------|-------|
| `packages/core/src/networkCapture.ts` | ~24-31 |
| `packages/core/src/dsl/validation.ts` | (import check) |
| `packages/dashboard/src/browserInspector.ts` | ~42-58 |
| `packages/browser-inspector-mcp/src/server.ts` | ~23-39 |

The only differences are the truncation cap (`POST_DATA_CAP`: 500 vs 4000 vs 64KB).

**Suggested fix:** Extract to `packages/core/src/redaction.ts` with a configurable cap parameter. Re-export from core's index.

### 1.2 `ElementFingerprint` Interface (3 copies)

Identical interface defined in:
- `packages/browser-inspector-mcp/src/types.ts:10`
- `packages/dashboard/src/browserInspector.ts:14`
- `packages/dashboard/src/teachMode.ts:10`

**Suggested fix:** Define once in `@showrun/core` types (or a shared types package). Import everywhere else.

### 1.3 `isLikelyApi()` Function (2 copies)

- `packages/dashboard/src/browserInspector.ts:60-73`
- `packages/browser-inspector-mcp/src/server.ts:41-50`

Same regex patterns (`/\/api\//`, `/graphql/i`, `/\/v\d+\//`, etc.) with minor signature differences.

**Suggested fix:** Move to core utilities, export from index.

### 1.4 Winston Log Format (2 copies)

Both `packages/dashboard/src/logger.ts` and `packages/harness/src/logger.ts` implement identical `logEventFormat` custom Winston format (~20 lines each).

**Suggested fix:** Extract shared format function to core or a shared logging utility.

### 1.5 Timeout Error Handling Pattern

Repeated in `packages/core/src/dsl/stepHandlers.ts` (at least lines ~79-87 and ~1048-1054):
```typescript
} catch (err: any) {
  if (err?.name === 'TimeoutError' || err?.message?.includes('Timeout')) {
    return;
  }
  throw err;
}
```

**Suggested fix:** Extract `suppressPlaywrightTimeout(fn: () => Promise<void>)` wrapper.

---

## 2. Dead Code

### 2.1 `builders.ts` - Never Imported (726 lines)

`packages/core/src/dsl/builders.ts` exports ~20 builder functions (`targetCss`, `targetText`, `targetRole`, etc.) and a `conditions` object. Re-exported from `packages/core/src/index.ts:31`.

**Zero imports anywhere else in the codebase.** No test file. No usage in any package.

**Suggested fix:** Either add tests + documentation as the official programmatic API, or remove the file entirely. At 726 lines of dead weight, it's the largest dead code block in the repo.

### 2.2 Internal-Only Re-exports

These modules are re-exported from `packages/core/src/index.ts` as public API but only used internally by core's own stepHandlers/interpreter:
- `dsl/target.ts`
- `dsl/conditions.ts`

Not truly dead, but misleading as "public API" with no external consumers.

---

## 3. Large Files & Functions

### 3.1 Files Over 1000 Lines

| File | Lines | Recommendation |
|------|-------|----------------|
| `dashboard/src/browserInspector.ts` | **1839** | Split into domSnapshot, elementFinding, networkCapture modules |
| `dashboard/src/agentTools.ts` | **1762** | Extract tool handler functions into `tools/` directory |
| `core/src/dsl/stepHandlers.ts` | **1288** | Extract each step handler into `handlers/<stepType>.ts` |
| `dashboard/src/routes/teach.ts` | **1282** | Split into separate route handler modules |
| `core/src/dsl/validation.ts` | **1114** | Extract per-step-type validators |

### 3.2 Functions Over 100 Lines

| File | Function | ~Lines | Issue |
|------|----------|--------|-------|
| `dashboard/src/routes/teach.ts` | `createTeachRouter()` | ~1015 | Entire router in one function |
| `dashboard/src/agentTools.ts` | `executeAgentTool()` | ~534 | Giant switch statement |
| `dashboard/src/browserInspector.ts` | `getDomSnapshot()` | ~422 | Complex DOM traversal |
| `core/src/runner.ts` | `runTaskPack()` | ~340 | Main orchestrator (partially justified) |
| `core/src/dsl/validation.ts` | `validateStep()` | ~798 | Repetitive per-type validation switch |
| `dashboard/src/browserInspector.ts` | `getElementFingerprint()` | ~167 | Complex element analysis |

---

## 4. Tight Coupling

### 4.1 Cross-Package Boundaries: Clean

No cross-package violations found. All imports go through package entry points (`@showrun/core`, etc.). No circular dependencies.

### 4.2 Dashboard Internal Coupling

`packages/dashboard/src/` is monolithic internally. `agentTools.ts` directly reaches into `browserInspector.ts`, `mcpWrappers.ts`, `contextManager.ts`, `secretsUtils.ts`, and `routes/teach.ts` orchestrates everything. This is manageable now but will scale poorly.

### 4.3 Executor Injection Pattern (playwright-js)

The `playwrightJsExecutor` is passed as an option through 3 layers:
- `packages/harness/src/runner.ts` → `runTaskPack()`
- `packages/mcp-server/src/toolRegistration.ts` → `runTaskPack()`
- `packages/dashboard/src/runManager.ts` → `runTaskPack()`

This is correct (dependency injection), not tight coupling. But the repeated `playwrightJsExecutor: executePlaywrightJs` boilerplate could be simplified with a default in the runner options.

---

## 5. Playwright-JS Specific Findings

### 5.1 Overall Assessment: Well-Structured

The playwright-js implementation (`playwrightJsExecutor.ts`, 171 lines) is clean and focused. Good test coverage (203 lines, 13 test cases). The sandboxing approach (blocked globals, frozen inputs) is appropriate given registry-level trust.

### 5.2 Minor Issues

**No centralized filename constant:** The string `'flow.playwright.js'` appears in:
- `packages/core/src/loader.ts`
- `packages/dashboard/src/mcpWrappers.ts`
- `packages/dashboard/src/routes/packs.ts` (likely)

**Suggested fix:** Add `const PLAYWRIGHT_JS_FLOW_FILE = 'flow.playwright.js'` to core constants.

**Scattered kind checks:** `manifest.kind === 'playwright-js'` appears across 5+ files. A helper like `isPlaywrightJsPack(pack)` would reduce string literals.

### 5.3 Security Note

The `BLOCKED_GLOBALS` array (24 items) in `playwrightJsExecutor.ts:19-25` uses parameter shadowing, not a true sandbox. This is acknowledged in comments and acceptable for the trust model, but worth documenting more explicitly for contributors.

---

## 6. Other Code Smells

### 6.1 Repeated JSON File I/O Pattern

5+ files use the same try/catch-readFileSync-JSON.parse pattern:
- `core/src/authResilience.ts`
- `core/src/requestSnapshot.ts`
- `dashboard/src/agentTools.ts`
- Various test files

**Suggested fix:** `safeReadJson<T>(path: string, fallback?: T): T` utility.

### 6.2 Magic Numbers (Well-Managed)

Most constants are named and documented. Notable ones:
- `browserInspector.ts`: 200 (network buffer), 4000 (post data cap), 8000 (response body)
- `contextManager.ts`: 100_000 / 180_000 (token limits)
- `browserPersistence.ts`: 30*60*1000 (session timeout)

These are acceptable as-is.

### 6.3 Deprecated DSL Fields Still Present

`packages/core/src/dsl/types.ts` has `@deprecated` annotations on:
- Selector-based fields (prefer `target`)
- `delay` step (prefer `wait_for`)
- `jsonPath` (prefer `path`)

Per CLAUDE.md, backwards compatibility isn't a priority. These could be removed.

---

## Priority Summary

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| **High** | Remove/document `builders.ts` (726 lines dead code) | Reduces confusion | Low |
| **High** | Extract redaction utils (4 copies) | Prevents drift | Low |
| **High** | Unify `ElementFingerprint` (3 copies) | Single source of truth | Low |
| **Medium** | Split `browserInspector.ts` (1839 lines) | Maintainability | Medium |
| **Medium** | Split `agentTools.ts` / `executeAgentTool()` | Readability | Medium |
| **Medium** | Split `teach.ts` router (1282 lines) | Testability | Medium |
| **Medium** | Extract step handlers/validators to modules | Maintainability | Medium |
| **Low** | Centralize playwright-js constants | Consistency | Low |
| **Low** | Add `isPlaywrightJsPack()` helper | Reduce string literals | Low |
| **Low** | Remove deprecated DSL fields | Simplification | Low |
