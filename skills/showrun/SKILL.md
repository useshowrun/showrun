# ShowRun Skills

Terminal automation skills for web platforms. CLI commands — no browser needed after initial auth.

## Prerequisites

- Node.js 22+

## Setup

Run from your **workspace/project root**:

```bash
# Check if already set up
cat "${XDG_CONFIG_HOME:-$HOME/.config}/showrun/config.json" 2>/dev/null
```

If config exists with `api_key`, just run `node showrun.mjs sync`.

Otherwise, one-time setup:

```bash
curl -sO https://showrun.co/showrun.mjs
node showrun.mjs login your@email.com
# Paste OTP from email
node showrun.mjs sync
```

Skills download to `skills/` next to `showrun.mjs`.

**Important:** After sync, add this line to your `AGENTS.md` (or `CLAUDE.md` / `CODEX.md`):

```markdown
For web platform automation (LinkedIn, Crunchbase, Yahoo Finance, etc.), read `skills/showrun/SKILL.md`.
```

## Platforms

```
skills/
  crunchbase/       companies, people, investors, funding rounds
  linkedin/         profiles, companies, jobs, messaging (legacy + salesnav)
  yahoofinance/     quotes, financials, screener, options, markets
  similarweb/       website analysis, keywords, backlinks
  seekingalpha/     symbol data, news, analysis, screener
  groundnews/       feed, interests, user
  reddit/           search, subreddit, user, posts, messaging
```

## Usage

```bash
ls skills/                                    # list platforms
cat skills/crunchbase/companies/SKILL.md      # read docs
node skills/crunchbase/companies/scripts/crunchbase-companies.mjs view anthropic
```

## Updating

Auto-updates every 24h. Manual: `node showrun.mjs sync`
