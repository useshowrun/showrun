---
name: crunchbase-school
description: "Fetch detailed school profiles from Crunchbase including type, program, enrollment, alumni, and founder alumni stats."
---

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

# Section commands (all support --count=N --after-id=UUID)
node crunchbase-school.mjs alumni stanford-university --count=50
node crunchbase-school.mjs funding_rounds massachusetts-institute-of-technology
node crunchbase-school.mjs investments stanford-university
node crunchbase-school.mjs exits stanford-university
node crunchbase-school.mjs news stanford-university --count=20
node crunchbase-school.mjs current_employees stanford-university
node crunchbase-school.mjs advisors stanford-university
node crunchbase-school.mjs sub_organizations stanford-university
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/organizations/{uuid}`
3. Section commands — Use the overrides endpoint `POST /v4/data/entities/organizations/{permalink}/overrides?field_ids=[...]&section_ids=[...]` to fetch paginated section data

Available cards: overview_fields_extended, overview_company_fields

Available fields: identifier, short_description, description, operating_status, school_type, school_method, school_program, location_identifiers, categories, num_enrollments, founded_on, website_url, num_alumni, num_founder_alumni, rank_org_school

Available sections: alumni, funding_rounds, investments, exits, news, current_employees, advisors, sub_organizations

## Data storage

```
~/.local/share/showrun/data/crunchbase-school/
├── session.json     Auth cookies
└── cache/           School detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
