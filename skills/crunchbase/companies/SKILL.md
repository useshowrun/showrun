# crunchbase-companies

Fetch detailed company profiles from Crunchbase including funding rounds, acquisitions, investors, employees, and tech stack.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-companies.mjs auth
```

## Usage

```bash
# View company by permalink (from Crunchbase URL)
node crunchbase-companies.mjs view google
node crunchbase-companies.mjs view anthropic

# View by UUID
node crunchbase-companies.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# Section commands (all support --count=N --after-id=UUID for pagination)
node crunchbase-companies.mjs investments <permalink|uuid>
node crunchbase-companies.mjs exits <permalink|uuid>
node crunchbase-companies.mjs funding_rounds <permalink|uuid>
node crunchbase-companies.mjs acquisitions <permalink|uuid>
node crunchbase-companies.mjs employees <permalink|uuid>
node crunchbase-companies.mjs advisors <permalink|uuid>
node crunchbase-companies.mjs news <permalink|uuid>
node crunchbase-companies.mjs sub_organizations <permalink|uuid>
node crunchbase-companies.mjs alumni <permalink|uuid>
node crunchbase-companies.mjs funds <permalink|uuid>
node crunchbase-companies.mjs products <permalink|uuid>

# Examples with options
node crunchbase-companies.mjs funding_rounds anthropic --count=20
node crunchbase-companies.mjs acquisitions google --count=50
node crunchbase-companies.mjs employees openai
node crunchbase-companies.mjs news google --count=20
node crunchbase-companies.mjs exits berkshire-hathaway
```

## Account tier

All commands work on the free Crunchbase account — `view` and every section command. Only the cross-entity `advanced-search search` (separate skill) requires Pro.

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}`
3. Section commands — Use the overrides endpoint `POST /v4/data/entities/organizations/{permalink}/overrides?field_ids=[...]&section_ids=[...]` to fetch paginated section data

Available cards: overview_fields_extended, overview_company_fields, funding_rounds_list, investments_list, acquisitions_list, investors_list, current_employees_featured_order_field, overview_timeline, semrush_summary, technology_highlights

Available sections: investments, exits, funding_rounds, acquisitions, current_employees, advisors, news, sub_organizations, alumni, funds, products

## Data storage

```
~/.local/share/showrun/data/crunchbase-companies/
├── session.json     Auth cookies
└── cache/           Company detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
