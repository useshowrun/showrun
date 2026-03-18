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
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}`

Available cards: overview_fields_extended, overview_company_fields, funding_rounds_list, investments_list, acquisitions_list, investors_list, current_employees_featured_order_field, overview_timeline, semrush_summary, technology_highlights

## Data storage

```
~/.local/share/showrun/data/crunchbase-companies/
├── session.json     Auth cookies
└── cache/           Company detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
