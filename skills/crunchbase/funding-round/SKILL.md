# crunchbase-funding-round

Fetch detailed funding round profiles from Crunchbase including investors, valuations, and deal terms.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-funding-round.mjs auth
```

## Usage

```bash
# View funding round by permalink (from Crunchbase URL)
node crunchbase-funding-round.mjs view series-a--abc-company

# View by UUID
node crunchbase-funding-round.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# Section commands (all support --count=N --after-id=UUID for pagination)
node crunchbase-funding-round.mjs investors series-a--abc-company
node crunchbase-funding-round.mjs news series-a--abc-company --count=20
node crunchbase-funding-round.mjs timeline series-a--abc-company
```

## Account tier

All commands work on the free Crunchbase account. Only the cross-entity `advanced-search search` (separate skill) requires Crunchbase Pro.

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/funding_rounds/{uuid}`
3. `investors`, `news` — POST `/v4/data/entities/funding_rounds/{permalink}/overrides?field_ids=[...]&section_ids=[...]` with paginated `card_lookups`.
4. `timeline` — GETs the direct entity endpoint with `card_ids=["timeline"]`. The overrides endpoint rejects `timeline` as a section; it's only exposed as a card.

Available cards: investors_list, news_list, timeline

Available fields: identifier, funded_organization_identifier, money_raised, investment_type, announced_on, investor_identifiers, num_investors, lead_investor_identifiers, pre_money_valuation, post_money_valuation, short_description, closed_on, target_money_raised, is_equity

## Data storage

```
~/.local/share/showrun/data/crunchbase-funding-round/
├── session.json     Auth cookies
└── cache/           Funding round detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
