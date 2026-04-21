# crunchbase-investor

Fetch detailed investor profiles from Crunchbase including portfolio, investments, funds, and exits.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-investor.mjs auth
```

## Usage

```bash
# View investor by permalink (from Crunchbase URL)
node crunchbase-investor.mjs view sequoia-capital
node crunchbase-investor.mjs view andreessen-horowitz

# Pick layout: v3 (default), v2, or both. Investors benefit most from
# `--view=both` — v2 has investor-specific fields, v3 has activity/prediction
# cards. Merged: ~112 unique cards for a mature firm (vs 91 for v3 alone).
node crunchbase-investor.mjs view sequoia-capital --view=both

# View by UUID
node crunchbase-investor.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# List investments (paginated)
node crunchbase-investor.mjs investments y-combinator --count=50
node crunchbase-investor.mjs investments y-combinator --after-id=<uuid>
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}?layout_mode=view_v3` (or `view_v2` or both, per `--view` flag, default `v3`). The `layout_mode` parameter triggers the server's full profile-page card set (~91 cards on v3 alone, ~98 on v2 alone, ~112 unique on `both`) regardless of `card_ids`. v2 adds investor-specific fields (investor_about_fields, investments_highlights, investor_financials_highlights, event_appearances_list); v3 adds activity cards and predictions. See crunchbase-companies SKILL.md for full card categories.
3. `investments` — Fetches paginated investments via POST to `/v4/data/entities/organizations/{permalink}/overrides` with `card_lookups: [{card_id: "investments_list", limit, after_id}]`

Available fields: identifier, short_description, investor_type, investor_stage, num_investments_funding_rounds, num_exits, num_portfolio_organizations, num_lead_investments, funding_total, location_identifiers, categories, num_funds, funds_total, num_exits_ipo

## Data storage

```
~/.local/share/showrun/data/crunchbase-investor/
├── session.json     Auth cookies
└── cache/           Investor detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
