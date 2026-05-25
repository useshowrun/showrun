# ShowRun — Browser Superpowers for AI Agents

Pre-built CLI skills that let your coding agent drive real, authenticated web platforms — LinkedIn, Crunchbase, PitchBook, Yahoo Finance, SimilarWeb, SeekingAlpha, Reddit, GitHub, and more — from the terminal.

No flaky browser bots. No scraping APIs. No SDK to learn. Skills are plain `SKILL.md` docs and Node scripts that your agent reads and runs itself.

> **Built for the agentic web.** One line in `AGENTS.md` (or `CLAUDE.md` / `CODEX.md`) is enough. Your agent picks up every skill from there.

Website: [showrun.co](https://showrun.co)

## Why ShowRun

- **CLI skills, not browser bots.** Each skill is a deterministic script. No LLM inference at every click, no Playwright flakiness.
- **Real auth, not scraped APIs.** Skills drive your real Chrome session over CDP. Log in once in your browser — work forever, including on gated platforms with no public API.
- **Works with any agent.** Just `SKILL.md` files and scripts on disk. Claude Code, Codex, OpenClaw, or anything that reads `AGENTS.md`.
- **Local & private.** Skills run on your machine against your authenticated session. Cookies and data never leave your laptop.
- **Auto-synced.** Skills refresh every 24h. New platforms and fixes show up in your project with no manual upgrades.

## Prerequisites

- **Node.js 22+** (uses built-in `fetch` and `WebSocket`)
- A Chromium-based browser (Chrome, Brave, Edge, Vivaldi…) with remote debugging enabled — open `chrome://inspect/#remote-debugging` and toggle the switch

## Quick start

From your project root:

```bash
# 1. Download the CLI
curl -sO https://showrun.co/showrun.mjs

# 2. Log in (sends a magic link + OTP to your email)
node showrun.mjs login you@example.com
# → Paste OTP from email

# 3. Pull skills into ./skills/
node showrun.mjs sync
```

Then add one line to your `AGENTS.md` (or `CLAUDE.md` / `CODEX.md`):

```markdown
For web platform automation (LinkedIn, Crunchbase, Yahoo Finance, etc.), read `skills/showrun/SKILL.md`.
```

That's it. Your agent now knows every skill in `skills/`.

### Or just tell your agent

Paste this into any coding agent's chat — it'll do the whole setup for you:

```
Read https://showrun.co/SKILL.md and set up ShowRun in this workspace.
```

## What's included

```
skills/
  chrome-cdp/       Chrome DevTools Protocol CLI (foundation for all browser skills)
  crunchbase/       companies, people, investors, funding rounds, acquisitions, events, schools, advanced search
  github/           user repos (more coming)
  groundnews/       feed, interests, user
  hackernews/       stories, comments
  linkedin/         legacy (profile, company, jobs, posts, messaging)
                    salesnav (account/lead search & profiles, lists, saved searches, messaging)
  pitchbook/        company, investors, deal feed, valuations, M&A comps, market maps, search, advanced search
  raisingfi/        fundraising intel
  reddit/           search, subreddit, user, posts, messaging
  seekingalpha/     symbol, news, analysis, screener, portfolio, market, alerts, comparison, search
  similarweb/       website analysis, keywords, backlinks, rank tracker, compare, market, search
  twitter/          search, profile, posts
  yahoofinance/     quotes, financials, historical, screener, options, markets, sectors, ETFs, calendar, search
```

Each platform is a folder of skills. Each skill is a `SKILL.md` plus a Node script under `scripts/`. List what you have:

```bash
ls skills/
cat skills/crunchbase/companies/SKILL.md
```

## Using a skill

Skills are self-documenting. Your agent reads the `SKILL.md` and runs the script. You can run them directly too:

```bash
# Authenticate the skill against your real Chrome session (one-time per platform)
node skills/crunchbase/companies/scripts/crunchbase-companies.mjs auth

# Then query real data
node skills/crunchbase/companies/scripts/crunchbase-companies.mjs view anthropic
node skills/crunchbase/companies/scripts/crunchbase-companies.mjs funding_rounds anthropic
node skills/crunchbase/companies/scripts/crunchbase-companies.mjs acquisitions google
```

Returns clean JSON straight from the platform — backed by your authenticated session, not a scraping middleman.

## CLI reference

```
showrun.mjs login <email>           Request access (sends magic link + OTP)
showrun.mjs verify <email> <code>   Verify with OTP code or magic link token
showrun.mjs sync [path]             Download/update skills (filter by path prefix)
showrun.mjs sync-agents             Download agents into ./agents/ (run installers to deploy)
showrun.mjs check                   Show available updates
showrun.mjs whoami                  Show current user info
showrun.mjs config [key] [value]    View or set configuration
```

The CLI **self-updates** on every authenticated call, and re-syncs skills automatically every 24 hours. To change the interval:

```bash
node showrun.mjs config check_interval_hours 6   # check every 6h
node showrun.mjs config check_interval_hours 0   # disable auto-update
```

Config lives at `$XDG_CONFIG_HOME/showrun/config.json` (or `~/.config/showrun/config.json`). The per-project skills manifest is `.showrun-lock.json` next to `showrun.mjs`.

## Agents (optional)

ShowRun also ships pre-built subagents for Claude Code and OpenClaw — `showrun-browser-setup`, `showrun-local-collector-setup`, `showrun-vc-research`:

```bash
node showrun.mjs sync-agents
bash agents/install-claude.sh        # → ~/.claude/agents/
bash agents/install-openclaw.sh      # → OpenClaw agents dir
```

## How it works

1. **`showrun.mjs`** is a single-file Node CLI. It talks to `api.showrun.co` to authenticate and fetch skills.
2. **Skills** are downloaded as plain files under `skills/<platform>/<skill>/` — a `SKILL.md` describing usage and a `scripts/` directory.
3. **`chrome-cdp/`** is the foundation: a lightweight Chrome DevTools Protocol client (no Puppeteer) that connects to your running browser over WebSocket. Other skills use it to drive real, logged-in sessions.
4. **Your agent** reads `SKILL.md`, calls the script, and gets structured data back. No MCP server, no daemon.

## FAQ

**Is my session data safe?**
Yes. Everything runs on your machine. Skills connect to your local Chrome over CDP — cookies, sessions, and scraped data never leave your laptop. Only the skill manifest is fetched from the ShowRun API.

**Can I use this without an account?**
Login is required to download skills. The CLI and the skills themselves are open source — auth gates the registry, not the runtime.

**Does it work with the platform I need?**
If it's in the list above, yes. If not, [talk to us](https://showrun.co/#contact) — adding a platform is usually a day of work.

**What about rate limits?**
Skills are bound by whatever the underlying platform enforces on your account. There's no extra middleman.

## Contributing

ShowRun is built in public. Issues and PRs welcome at [github.com/useshowrun](https://github.com/useshowrun). To propose a new platform or skill, open an issue describing the workflow you want automated.

## Links

- Website: [showrun.co](https://showrun.co)
- GitHub: [github.com/useshowrun](https://github.com/useshowrun)
- Talk to an engineer: [showrun.co/#contact](https://showrun.co/#contact)
