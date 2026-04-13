# Agent-First CDP Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite PitchBook and chrome-cdp SKILL.md files so the agent runs Chrome launch commands itself instead of asking the user to do it.

**Architecture:** Documentation-only changes. Add global agent CDP guidance to `chrome-cdp/SKILL.md`, then rewrite PitchBook setup sections to be agent-first instructions.

**Tech Stack:** Markdown (SKILL.md files)

---

### Task 1: Add agent CDP guidance to chrome-cdp SKILL.md

**Files:**
- Modify: `skills/chrome-cdp/SKILL.md` (append after line 78)

- [ ] **Step 1: Append the agent guidance section**

Add this section at the end of `skills/chrome-cdp/SKILL.md`:

```markdown
## Agent guidance — CDP connection

When a skill requires Chrome CDP and connection fails:

1. **Try the command first** — `scripts/cdp.mjs list` will auto-discover Chrome via DevToolsActivePort
2. **If no Chrome found** — launch it yourself:
   ```bash
   google-chrome --remote-debugging-port=9222 &
   ```
   Wait a few seconds, then retry.
3. **If Chrome is running but CDP unavailable** — ask the user to enable remote debugging:
   > Open `chrome://inspect/#remote-debugging` in Chrome and toggle the switch on.

Never ask the user to run terminal commands that you can run yourself.
```

- [ ] **Step 2: Verify the file reads correctly**

Run: `cat skills/chrome-cdp/SKILL.md`
Expected: Original content intact, new `## Agent guidance — CDP connection` section appended.

- [ ] **Step 3: Commit**

```bash
git add skills/chrome-cdp/SKILL.md
git commit -m "docs: add agent CDP connection guidance to chrome-cdp skill"
```

---

### Task 2: Rewrite pitchbook/SKILL.md as agent-first instructions

**Files:**
- Modify: `skills/pitchbook/SKILL.md`

- [ ] **Step 1: Replace the Setup section (lines 6–28)**

Replace everything from `## Setup` through the end of `### 3. Capture session` (lines 6–28) with:

```markdown
## Setup

### Connecting to Chrome

1. Run `node pitchbook-login/scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, follow the chrome-cdp agent guidance (launch Chrome yourself or ask user to enable remote debugging)
3. If the user is not logged in to PitchBook, ask them to open `my.pitchbook.com` and log in, then re-run the interactive command

### Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in to Pitchbook.
```

- [ ] **Step 2: Replace the Agent guidance section (lines 53–57)**

Replace the current `## Agent guidance` section with:

```markdown
## Agent guidance

- On auth failure: re-run `interactive`. If CDP is unreachable, follow chrome-cdp agent guidance — launch Chrome yourself, or ask user to enable remote debugging if Chrome is already open.
- Redirect script output to files — responses can be large (500KB+). Read cached results from `~/.local/share/showrun/data/pitchbook/cache/` with truncation.
- Wait at least 8 seconds between API calls to avoid rate limiting.
- Summarize findings in your own words. Never dump full JSON into the conversation.
```

- [ ] **Step 3: Verify the file reads correctly**

Run: `cat skills/pitchbook/SKILL.md`
Expected: Setup is agent-first, agent guidance references chrome-cdp, available skills table and typical workflow unchanged.

- [ ] **Step 4: Commit**

```bash
git add skills/pitchbook/SKILL.md
git commit -m "docs: rewrite pitchbook setup as agent-first instructions"
```

---

### Task 3: Rewrite pitchbook-login/SKILL.md as agent-first instructions

**Files:**
- Modify: `skills/pitchbook/pitchbook-login/SKILL.md`

- [ ] **Step 1: Replace entire content after title**

Replace everything after line 1 (`# pitchbook-login`) with:

```markdown
Authenticate with Pitchbook and save session for API access.

## Setup

1. Run `node scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, follow the chrome-cdp agent guidance (launch Chrome yourself or ask user to enable remote debugging)
3. If the user is not logged in, ask them to open `my.pitchbook.com` in Chrome and log in, then retry

## Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in.

## Agent guidance

1. Try `interactive` first
2. If Chrome not reachable, launch it yourself: `google-chrome --remote-debugging-port=9222 &`
3. If Chrome is running but CDP unavailable, ask user to enable remote debugging at `chrome://inspect/#remote-debugging`
```

- [ ] **Step 2: Verify the file reads correctly**

Run: `cat skills/pitchbook/pitchbook-login/SKILL.md`
Expected: Title preserved, agent-first setup, agent guidance with inline decision tree.

- [ ] **Step 3: Commit**

```bash
git add skills/pitchbook/pitchbook-login/SKILL.md
git commit -m "docs: rewrite pitchbook-login setup as agent-first instructions"
```
