# Pitchbook Skills

Collect financial data from Pitchbook — company profiles, deals, investors, valuations, and more.

## Setup

### Connecting to Chrome

1. Run `node pitchbook-login/scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, follow the chrome-cdp agent guidance — launch Chrome yourself with PitchBook as the target URL: `... --no-first-run "https://my.pitchbook.com" &`
3. If CDP is connected but no PitchBook tab is open, open one: `node skills/chrome-cdp/scripts/cdp.mjs open https://my.pitchbook.com`
4. If the user is not logged in to PitchBook, ask them to log in in the Chrome window, then re-run the interactive command

### Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in to Pitchbook.

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

- On auth failure: re-run `interactive`. If CDP is unreachable, follow chrome-cdp agent guidance — launch Chrome with `https://my.pitchbook.com` as the target URL, or `cdp.mjs open https://my.pitchbook.com` if Chrome is already running.
- Redirect script output to files — responses can be large (500KB+). Read cached results from `~/.local/share/showrun/data/pitchbook/cache/` with truncation.
- Wait at least 8 seconds between API calls to avoid rate limiting.
- Summarize findings in your own words. Never dump full JSON into the conversation.
