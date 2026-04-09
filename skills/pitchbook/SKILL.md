# Pitchbook Skills

Collect financial data from Pitchbook — company profiles, deals, investors, valuations, and more.

## Setup

### 1. Connect to Chrome

Enable remote debugging in Chrome:
1. Open `chrome://inspect/#remote-debugging` in Chrome
2. Toggle the switch on

**If that doesn't work**, close Chrome and reopen it with:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-pb --no-first-run
```

### 2. Log in to Pitchbook

Open `my.pitchbook.com` in Chrome and log in normally.

### 3. Capture session

```bash
node pitchbook-login/scripts/pitchbook-login.mjs interactive
```

This captures your browser cookies for API access. Re-run if you see `Session expired` or `HTTP 401` (sessions last ~30 min).

## Available skills

| Skill | Command | Description |
|-------|---------|-------------|
| [Search](pitchbook-search/SKILL.md) | `search <query>` | Find companies by name or domain |
| [Hover](pitchbook-hover/SKILL.md) | `get <pbId>` | Quick company summary |
| [Company](pitchbook-company/SKILL.md) | `get <companyId>` | Full company profile |
| [Deal Feed](pitchbook-deal-feed/SKILL.md) | `feed` | Recent deals with filters |
| [Investors](pitchbook-investors/SKILL.md) | `active` | Active investors |
| [Valuations](pitchbook-valuations/SKILL.md) | `multiples` | Deal valuation multiples |
| [Market Maps](pitchbook-market-maps/SKILL.md) | `list` | Published market maps |
| [M&A Comps](pitchbook-mna-comps/SKILL.md) | `comps <pbId>` | Comparable M&A transactions |
| [Advanced Search](pitchbook-advanced-search/SKILL.md) | `search` | Screener with pagination |

## Typical workflow

```
1. Log in + capture session  →  node pitchbook-login/scripts/pitchbook-login.mjs interactive
2. Search for a company      →  node pitchbook-search/scripts/pitchbook-search.mjs search "openai"
3. Get company details       →  node pitchbook-company/scripts/pitchbook-company.mjs get 149504-14
```

## Agent guidance

- If session is missing or expired, run `interactive` login. If Chrome is not reachable, ask the user to enable remote debugging.
- Redirect script output to files — responses can be large (500KB+). Read cached results from `~/.local/share/showrun/data/pitchbook/cache/` with truncation.
- Wait at least 8 seconds between API calls to avoid rate limiting.
- Summarize findings in your own words. Never dump full JSON into the conversation.
