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

# View by UUID
node crunchbase-investor.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# List investments (paginated)
node crunchbase-investor.mjs investments y-combinator --count=50
node crunchbase-investor.mjs investments y-combinator --after-id=<uuid>
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}?layout_mode=view_v3`. `layout_mode=view_v3` triggers the server's full profile-page card set (~91 cards for a mature investor firm) regardless of `card_ids`. See crunchbase-companies SKILL.md for the full list of card categories.
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
