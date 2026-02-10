# ShowRun Product Roadmap

## Current State Assessment

### What's Working Well
- **Core DSL**: 19 fully implemented step types (navigate, click, fill, extract_*, wait_for, assert, set_var, network_*, select_option, press_key, upload_file, frame, new_tab, switch_tab)
- **Unified CLI**: Single `showrun` command for all operations (run, serve, dashboard, pack, mcp)
- **Teach Mode**: AI-assisted flow creation with Anthropic/OpenAI streaming, two-agent architecture (Exploration Agent + Editor Agent)
- **Network Capture**: Advanced request replay with JSONPath extraction and transforms
- **Auth Resilience**: Run-once caching, 401/403 recovery, session persistence
- **MCP Servers**: Browser Inspector (20+ tools), TaskPack Editor (5 tools), TaskPack Runner
- **Flow Versioning**: Auto-snapshot on ready, manual snapshots, restore with auto-backup, CLI + dashboard UI
- **System-Wide Config**: Layered `config.json` with platform-aware directory discovery (`showrun config init/show/path`)

### Unified CLI Structure
The `showrun` CLI consolidates all functionality:
- `showrun run <pack>` - Run a task pack
- `showrun serve` - Start MCP server for AI agents
- `showrun dashboard` - Start web dashboard with Teach Mode
- `showrun pack create/validate/set-flow/set-meta` - Pack management
- `showrun pack snapshot/history/restore` - Version management
- `showrun mcp browser-inspector/taskpack-editor` - MCP utilities

---

## Gap Analysis

### Missing DSL Step Types (Blocks Common Workflows)
| Step | Use Case | Effort | Status |
|------|----------|--------|--------|
| `select_option` | Dropdown/select fields | Small | **Implemented** |
| `upload_file` | File input forms | Medium | **Implemented** |
| `scroll` | Infinite scroll, lazy load | Small | Pending |
| `hover` | Tooltips, dropdown menus | Small | Pending |
| `press_key` | Tab, Enter, Escape, shortcuts | Small | **Implemented** |
| `frame` | Iframe content interaction | Medium | **Implemented** |
| `new_tab` / `switch_tab` | Multi-tab workflows | Medium | **Implemented** |
| `evaluate` | Execute JavaScript | Medium | Pending |
| `drag_drop` | Drag and drop UI | Medium | Pending |

### Production Readiness Gaps
| Gap | Impact | Effort | Status |
|-----|--------|--------|--------|
| User authentication | Critical for teams | Medium | Pending |
| RBAC/permissions | Required for shared use | Medium | Pending |
| Docker/K8s deployment | Required for production | Small-Medium | Pending |
| HTTPS/TLS | Security baseline | Small | Pending |
| Rate limiting | DoS protection | Small | Pending |
| Secrets management | Secure credential handling | Medium | **Implemented** |
| System-wide config | Layered config.json with platform-aware discovery | Medium | **Implemented** |
| Monitoring/metrics | Operational visibility | Medium | Pending |

### Developer Experience Gaps
| Gap | Impact | Effort |
|-----|--------|--------|
| Test infrastructure | Zero tests exist | Medium |
| Pack templates | Only "basic" exists | Small |
| Visual flow builder | Teach Mode enhancement | Large |
| Step recording | Auto-generate from actions | Large |
| Element picker overlay | Click-to-select targets | Large |
| Debugging/breakpoints | Step-through execution | Large |

---

## Prioritized Roadmap (Open Source Focus)

### P0: Critical (Week 1-2)
**Goal: Complete the DSL for real-world automation**

1. **Form Interaction Steps** (High Priority)
   - `select_option` - Dropdown/select handling
   - `upload_file` - File input fields
   - `press_key` - Keyboard shortcuts (Tab, Enter, Escape)

2. **Multi-Context Steps** (High Priority)
   - `frame` - Switch to/from iframes
   - `new_tab` / `switch_tab` - Multi-tab workflows

3. **Test Infrastructure**
   - Setup vitest
   - Core DSL unit tests
   - Integration tests for example packs

**Files to modify:**
- `packages/core/src/dsl/types.ts` - Add step interfaces
- `packages/core/src/dsl/stepHandlers.ts` - Implement handlers
- `packages/core/src/dsl/validation.ts` - Add validation rules
- `packages/dashboard/src/agentTools.ts` - Update AI tool definitions

### P1: High Value (Week 3-6)
**Goal: Polish for open source adoption**

1. **Complete DSL Coverage**
   - `scroll` - Scroll to element/position
   - `hover` - Mouse hover actions
   - `evaluate` - JavaScript execution
   - `wait_for_js` - Wait for JS condition
   - `drag_drop` - Drag and drop (lower priority)

2. **Open Source Essentials**
   - CONTRIBUTING.md guide
   - More pack templates (login, scrape, form-fill)
   - Improved README with GIFs/screenshots
   - Pack export/import (zip bundles)
   - API documentation (OpenAPI)

3. **Teach Mode Enhancements**
   - Two-agent architecture (Exploration + Editor) — **Implemented**
   - Network request → step suggestions
   - Better error messages for new users

### P2: Community Growth (Week 7+)
**Goal: Make it easy to adopt and contribute**

1. **Developer Experience**
   - VS Code extension (syntax highlighting, validation)
   - Pack marketplace / registry
   - Live validation in dashboard editor
   - Debugging mode (step-through execution)

2. **Deployment (When Needed)**
   - Dockerfile
   - docker-compose.yml
   - Basic health check endpoint

3. **Control Flow Extensions**
   - `if/else` conditional steps
   - `for_each` looping
   - Sub-flow composition

### P3: Future Vision
**Goal: Advanced platform features**

1. **Visual Authoring**
   - Element picker overlay
   - Step recording mode
   - Drag-drop flow builder

2. **Production Features** (when demand exists)
   - User authentication
   - RBAC/permissions
   - Scheduled runs
   - Monitoring/metrics

---

## Quick Wins (Parallel Work)

These can be done alongside main priorities:
- [ ] CONTRIBUTING.md with development setup
- [ ] More example packs (login flow, API scraping)
- [ ] Pack templates (form-fill, scrape, network-capture)
- [ ] CLI help improvements (`showrun --help`)
- [ ] OpenAPI documentation for dashboard API
- [ ] README improvements (screenshots, demo GIF)

---

## The showrun CLI - Status

The CLI is now fully consolidated:

**Implemented Commands:**
- `showrun run <pack>` - Run a task pack directly
- `showrun serve` - Start MCP server for AI agents
- `showrun dashboard` - Start web dashboard with Teach Mode
- `showrun pack create/validate/set-flow/set-meta` - Pack management
- `showrun pack snapshot/history/restore` - Version management
- `showrun mcp browser-inspector/taskpack-editor` - MCP utilities
- `showrun config init/show/path` - Configuration management

**Potential Future Additions:**
- `showrun pack export` - Export as zip
- `showrun pack import` - Import from zip/URL
- `showrun init` - Interactive pack creation wizard

**Priority:** Low - current functionality covers all major use cases

---

## Verification Plan

After implementing P0:
1. Create test pack using each new step type
2. Run via CLI: `showrun run ./test-pack --inputs '{}'`
3. Run via dashboard: `showrun dashboard --packs ./test-packs`
4. Verify AI agent can propose/use new steps
5. Run test suite: `pnpm test`

---

## Summary

| Phase | Timeline | Focus | Key Deliverables |
|-------|----------|-------|------------------|
| P0 | Week 1-2 | Complete DSL | Form steps + iframe/tabs + tests |
| P1 | Week 3-6 | Open Source Polish | Templates, docs, remaining DSL |
| P2 | Week 7+ | Community | VS Code ext, marketplace, debugging |
| P3 | Future | Advanced | Visual builder, production features |

**Recommended Starting Point:**
1. `select_option` step - Small effort, high impact, unblocks most form automation
2. `frame` step - Enables iframe handling, required for embedded content
3. Test infrastructure - Critical for sustainable open source development

**First PR suggestion:** Add `select_option` + `press_key` steps (most commonly needed)
