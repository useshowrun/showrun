# ShowRun Skills

Terminal automation skills for web use. Each skill provides CLI commands that interact with platform APIs directly -- no browser needed for most after initial auth.

## Prerequisites

- Node.js 22+

## Setup

Check if already set up:

```bash
cat "${XDG_CONFIG_HOME:-$HOME/.config}/showrun/config.json" 2>/dev/null
```

If the file exists and contains `api_key`, skip to **Using a Skill**.

Otherwise, one-time setup -- download the helper script and authenticate:

```bash
curl -sO https://showrun.co/showrun.mjs
node showrun.mjs login your@email.com
```

Paste the OTP code from your email when prompted, then sync all skills:

```bash
node showrun.mjs sync
```

Skills are downloaded to the local `skills/` directory next to `showrun.mjs`.

## Platforms

```
skills/
  linkedin/legacy/      profiles, companies, jobs, messaging, posts
  linkedin/salesnav/    lead search, account search, lists, messaging
  groundnews/           feed, interests, user
  crunchbase/           companies, people, investors, funding rounds, events
  yahoofinance/         quotes, financials, screener, options, markets, sectors
  similarweb/           website analysis, keywords, backlinks, market research
  seekingalpha/         symbol data, news, analysis, screener, portfolio
```

## Using a Skill

Browse platforms, read a skill's docs, run its script:

```bash
ls skills/                                    # list platforms
ls skills/crunchbase/                         # list skills
cat skills/crunchbase/companies/SKILL.md      # read usage docs

node skills/crunchbase/companies/scripts/crunchbase-companies.mjs search "AI startups"
```

Each skill is self-contained:

```
skills/<platform>/<skill>/
  SKILL.md              usage docs, prerequisites, examples
  scripts/<name>.mjs    the executable script
```

## Updating

Check for and pull updates periodically:

```bash
node showrun.mjs check    # see what changed
node showrun.mjs sync     # pull updates
```
