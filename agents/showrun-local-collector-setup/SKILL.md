---
name: showrun-local-collector-setup
description: Set up or troubleshoot a local ShowRun Collector for OpenClaw sub-agent use, including what ShowRun is, where local skills live, how to run skill scripts, browser/profile auth, and source-access readiness.
---

# ShowRun Local Collector Setup

Use this when acting as, installing, checking, or fixing a local ShowRun Collector.

## What ShowRun is

ShowRun is a local library of source-specific research skills. A ShowRun skill is usually a directory with:

```text
skills/<platform>/<skill>/SKILL.md
skills/<platform>/<skill>/scripts/*.mjs
```

Some platforms also have shared files, for example:

```text
skills/pitchbook/lib/utils.mjs
skills/pitchbook/*/filter-codes.json
skills/chrome-cdp/scripts/cdp.mjs
```

The Collector's job is to use those local skill instructions/scripts to collect evidence from real sources, then return sourced facts and gaps. The Collector does **not** make the final investment judgment.

## Local ShowRun roots

Prefer the first existing root:

```bash
/home/showrun-test/workspace/cdp_taskpacks
/srv/openclaw/workspace/repos/cdp_taskpacks
$PWD
```

Inside the root:

- `showrun.mjs` is the ShowRun sync/install CLI.
- `skills/` contains the actual source skills.
- `skills/chrome-cdp/` contains the browser/CDP helper.
- `agents/` contains OpenClaw agent skills, not source data skills.

When unsure, discover skills with:

```bash
find "$SHOWRUN_ROOT/skills" -maxdepth 3 -name SKILL.md | sort
find "$SHOWRUN_ROOT/skills" -maxdepth 4 -path '*/scripts/*.mjs' | sort
```

## How to run a ShowRun source skill

1. Set or infer `SHOWRUN_ROOT`.
2. Find the relevant source skill under `skills/`.
3. Read that skill's `SKILL.md`.
4. Inspect its `scripts/` directory.
5. Run the smallest command that answers the question.
6. Cache/record source URLs and command outputs.

Run scripts from the skill directory unless the skill says otherwise:

```bash
cd "$SHOWRUN_ROOT/skills/github/user-repos"
node scripts/github-user-repos.mjs search "Guillermo Rauch"
node scripts/github-user-repos.mjs top-repos rauchg --min-stars=10000
```

If a `SKILL.md` example says `node foo.mjs` but the file is actually under `scripts/foo.mjs`, adapt to the real local path instead of failing blindly.

## Common source mapping

- GitHub OSS stars / founder repos → `skills/github/user-repos`
- Crunchbase company profile, funding, investors, people → `skills/crunchbase/companies` plus other Crunchbase skills
- LinkedIn people/company search → `skills/linkedin/legacy/search`
- PitchBook company search/profile/investors → `skills/pitchbook/*`
- Browser/CDP utilities → `skills/chrome-cdp`

For a VC request like “dev tools startups, pre-Series B, CTO shipped 10k+ star OSS”:

1. Use GitHub to verify the OSS project and star threshold.
2. Use Crunchbase/PitchBook for company funding stage, last round, and investors.
3. Use LinkedIn/Sales Navigator for current role, team, recent hires, and headcount signal.
4. Return unresolved source gaps if any of those sources are unavailable.

## Browser/profile auth

The main VC Research Lead should establish browser access before delegating when gated sources matter, but the Collector must still verify that the configured browser/profile is actually reachable before declaring gated sources unavailable.

As Collector:

- Use existing browser/CDP/profile environment when provided.
- Never ask for raw passwords.
- If the user has an active Browser Use live browser URL like `https://live.browser-use.com/?wss=https%3A%2F%2F<session>.free-cdp*.browser-use.com`, connect CDP to that exact live session first. Decode the `wss=` value and use its HTTPS origin as `CDP_URL`; verify with `cdp.mjs list`.
- Do not rerun the Browser Use profile helper while checking a just-completed human login. Reconnecting through `connect.browser-use.com?profileId=...` can attach to or create a different browser session and miss cookies the user just set.
- If Browser Use is configured, open or reuse the configured Browser Use live browser/profile yourself and verify CDP before running gated source skills.
- Do not conclude “Crunchbase/PitchBook/LinkedIn unavailable” from `about:blank`, `No DevToolsActivePort`, missing local Chrome, or a relative-path/helper failure. Those are Collector environment/setup failures until the Browser Use profile/CDP path has been tested.
- If auth is missing after Browser Use/CDP is reachable and the source login page was actually opened, state the exact source and what it would answer.
- If a skill says to run `auth`, do it only when browser/CDP is already available.
- Re-run `auth` on 401/403/session expiry if safe.

### Required Browser Use preflight

Before any gated-source collection attempt, run this preflight from the deployed VPS/demo environment when Browser Use config may exist:

```bash
set -a
test -f ~/.config/showrun/.env && . ~/.config/showrun/.env
test -f ~/.config/showrun/browser-use.env && . ~/.config/showrun/browser-use.env
set +a

test -n "${BROWSER_USE_API_KEY:-}" && test -n "${BROWSER_USE_PROFILE_ID:-}" && echo browser-use-configured
```

If the user is actively looking at a Browser Use live URL from a login handoff, prefer that exact session over the profile helper:

```bash
# Example: decode the live URL's wss= value and use that HTTPS origin.
export CDP_URL="https://abc.free-cdp0.browser-use.com"
export CHROME_CDP_URL="$CDP_URL"
export BROWSER_CDP_URL="$CDP_URL"

cd "$SHOWRUN_ROOT/skills/chrome-cdp"
node scripts/cdp.mjs list
```

Use the profile helper only when there is no active user live-session URL, or when intentionally starting/reusing a persistent profile outside an active login handoff.

Then find and use the Browser Use helper. In the VPS demo the canonical helper path is absolute:

```bash
BROWSER_USE_HELPER="/home/showrun/showrun-vps-demo/scripts/lib/browser-use.mjs"
test -f "$BROWSER_USE_HELPER" || BROWSER_USE_HELPER="$PWD/scripts/lib/browser-use.mjs"
node "$BROWSER_USE_HELPER" browser --profile-id "$BROWSER_USE_PROFILE_ID"
```

The helper reuses the last active Browser Use browser when possible and stores live browser metadata in:

```text
~/.config/showrun/browser-use-browser.json
```

After helper success, ensure source skills can use CDP. If `CDP_URL` is not already set, derive it from the configured Browser Use profile:

```bash
export CDP_URL="${CDP_URL:-wss://connect.browser-use.com?apiKey=${BROWSER_USE_API_KEY}&profileId=${BROWSER_USE_PROFILE_ID}&timeout=15}"
export CHROME_CDP_URL="${CHROME_CDP_URL:-$CDP_URL}"
export BROWSER_CDP_URL="${BROWSER_CDP_URL:-$CDP_URL}"
```

For local CDP diagnostics:

```bash
cd "$SHOWRUN_ROOT/skills/chrome-cdp"
node scripts/cdp.mjs list
```

If the list only shows `about:blank`, open the specific gated source in the configured Browser Use/CDP browser and then check login state:

```bash
node scripts/cdp.mjs open https://www.crunchbase.com/
node scripts/cdp.mjs open https://www.linkedin.com/
node scripts/cdp.mjs open https://my.pitchbook.com/
node scripts/cdp.mjs list
```

Only after the relevant page is opened and CDP is reachable may the Collector report whether that source appears logged in, expired, or unavailable. If these commands fail because the helper path, env propagation, or CDP URL is wrong, report “Collector could not access the configured Browser Use session” and include the failing command/error; do not report that the gated source itself is unavailable.

If Browser Use Cloud is configured, the main Lead should provide or establish the CDP URL/profile, but the Collector is still responsible for opening/reusing that configured profile and checking login state before making source-availability claims. Do not silently fall back to model memory when browser-backed sources are required.

## Collector output

Return evidence, not unsupported conclusions:

- candidate/company/person names,
- source names and URLs when available,
- commands/tools used,
- concise findings,
- confidence per finding,
- unresolved gaps,
- source access needed and why.

Do not invent facts when sources are missing. Do not claim a source was checked unless you actually used it.

Core invariant: human login handoff → exact live browser CDP endpoint. Background collection without an active human live tab → profile connector/helper.
