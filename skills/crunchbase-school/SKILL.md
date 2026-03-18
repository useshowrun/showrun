# crunchbase-school

Fetch detailed school profiles from Crunchbase including type, program, enrollment, alumni, and founder alumni stats.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-school.mjs auth
```

## Usage

```bash
# View school by permalink (from Crunchbase URL)
node crunchbase-school.mjs view stanford-university
node crunchbase-school.mjs view massachusetts-institute-of-technology

# View by UUID
node crunchbase-school.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}`

Available cards: overview_fields_extended, overview_company_fields

Available fields: identifier, short_description, description, operating_status, school_type, school_method, school_program, location_identifiers, categories, num_enrollments, founded_on, website_url, num_alumni, num_founder_alumni, rank_org_school

## Data storage

```
~/.local/share/showrun/data/crunchbase-school/
├── session.json     Auth cookies
└── cache/           School detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
