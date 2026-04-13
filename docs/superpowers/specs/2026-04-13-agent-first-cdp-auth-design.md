# Agent-First CDP Authentication UX

**Date:** 2026-04-13
**Problem:** SKILL.md files instruct Claude Code to ask the user to run terminal commands (like `google-chrome --remote-debugging-port=9222`) that Claude Code can execute itself via Bash. This creates a poor experience for non-developer users (VC investors) who shouldn't need to touch the terminal.

**Root cause:** The SKILL.md docs are written for a human audience. Since Claude Code reads these docs to decide what to do, it parrots the manual setup steps back to the user instead of running them itself.

**Fix:** Rewrite the relevant SKILL.md files so the primary audience is the agent. The agent should try commands itself first, launch Chrome itself if needed, and only ask the user for actions that genuinely require their input (logging into a website, toggling a browser UI setting).

## Decision tree

```
Agent needs CDP connection
  → Run cdp.mjs list (auto-discovers Chrome via DevToolsActivePort)
    → Success? Proceed.
    → No Chrome found?
      → Agent runs: google-chrome --remote-debugging-port=9222 &
      → Wait a few seconds, retry.
    → Chrome running but CDP unavailable?
      → Ask user: "Open chrome://inspect/#remote-debugging and toggle the switch on"
      → Retry after user confirms.
```

## Files to change

### 1. `skills/chrome-cdp/SKILL.md` — Add global agent guidance

Add a new `## Agent guidance — CDP connection` section with the decision tree above. This becomes the canonical reference that all platform skills can point to.

**New section to append:**

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

### 2. `skills/pitchbook/SKILL.md` — Rewrite Setup as agent instructions

Replace current Setup sections (steps 1-3) and Agent guidance with agent-first instructions.

**Replace Setup with:**

```markdown
## Setup

### Connecting to Chrome

1. Run `node pitchbook-login/scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, follow the chrome-cdp agent guidance (launch Chrome yourself or ask user to enable remote debugging)
3. If the user is not logged in to PitchBook, ask them to open `my.pitchbook.com` and log in, then re-run the interactive command

### Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in to Pitchbook.
```

**Replace Agent guidance with:**

```markdown
## Agent guidance

- On auth failure: re-run `interactive`. If CDP is unreachable, follow chrome-cdp agent guidance — launch Chrome yourself, or ask user to enable remote debugging if Chrome is already open.
- Redirect script output to files — responses can be large (500KB+). Read cached results from `~/.local/share/showrun/data/pitchbook/cache/` with truncation.
- Wait at least 8 seconds between API calls to avoid rate limiting.
- Summarize findings in your own words. Never dump full JSON into the conversation.
```

### 3. `skills/pitchbook/pitchbook-login/SKILL.md` — Same treatment

**Replace entire content after title with:**

```markdown
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

## Out of scope

- Other platform SKILL.md files (Crunchbase, LinkedIn, etc.) — same pattern applies but not changing them in this pass
- The browser cookie extraction design (separate spec, complementary approach)
- Changes to the scripts themselves — only documentation changes
