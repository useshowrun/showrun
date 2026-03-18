# crunchbase-acquisition

Fetch detailed acquisition data from Crunchbase including acquirer/acquiree details, price, terms, and deal status.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-acquisition.mjs auth
```

## Usage

```bash
# View acquisition by permalink (from Crunchbase URL)
node crunchbase-acquisition.mjs view google-acquires-fitbit

# View by UUID
node crunchbase-acquisition.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/acquisitions/{uuid}`

Available cards: overview_fields

Available fields: identifier, acquiree_identifier, acquirer_identifier, announced_on, price, acquisition_type, status, terms, disposition_of_acquired, completed_on, acquiree_categories, acquirer_categories, acquiree_short_description, acquirer_short_description, acquiree_locations, acquirer_locations, short_description, acquiree_funding_total, acquirer_funding_total, acquiree_num_funding_rounds, acquirer_num_funding_rounds

## Data storage

```
~/.local/share/showrun/data/crunchbase-acquisition/
├── session.json     Auth cookies
└── cache/           Acquisition detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
