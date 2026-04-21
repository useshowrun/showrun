# crunchbase-people

Fetch detailed people profiles from Crunchbase including job history, investments, founded organizations, and social links.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-people.mjs auth
```

## Usage

```bash
# View person by permalink (from Crunchbase URL)
node crunchbase-people.mjs view mark-zuckerberg
node crunchbase-people.mjs view elon-musk

# View by UUID
node crunchbase-people.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# Section commands (all support --count=N --after-id=UUID,
# except `education` — Crunchbase's education card rejects a limit,
# so the script always returns the full education list)
node crunchbase-people.mjs investments marc-andreessen --count=50
node crunchbase-people.mjs exits elon-musk
node crunchbase-people.mjs education mark-zuckerberg
node crunchbase-people.mjs news elon-musk --count=20
```

## Commands

| Command | Description |
|---------|-------------|
| `auth` | Authenticate via Chrome (one-time) |
| `view <permalink\|uuid>` | Fetch full person details with all cards |
| `investments <permalink\|uuid>` | Personal investments (org, round, amount, lead) |
| `exits <permalink\|uuid>` | IPO and acquisition exits |
| `education <permalink\|uuid>` | Education history (degree, school, year) |
| `news <permalink\|uuid>` | Press and news articles |

## Account tier

Works on free with one silent-paywall caveat:

- **Section commands cap at `--count=10`** (HTTP 400 `"could not override limit"`/`MD101` above 10). Default is 50, which always fails on free. Pass `--count=10` and paginate with `--after-id` for full coverage. `education` is unaffected (the card rejects a limit on any tier, so the script already returns the full list).

The cross-entity `advanced-search search` is documented separately (also has free-tier caveats).

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/people/{uuid}`
3. Section commands — Use the overrides endpoint `POST /v4/data/entities/people/{permalink}/overrides?field_ids=[...]&section_ids=[...]` to fetch paginated section data

Available cards: overview_fields

Available fields: identifier, first_name, last_name, primary_job_title, primary_organization, location_identifiers, short_description, description, gender, linkedin, twitter, facebook, num_founded_organizations, num_investments_funding_rounds, num_exits, num_current_jobs, num_past_jobs, born_on, died_on, rank_person, current_organizations, attended_schools, featured_job

## Data storage

```
~/.local/share/showrun/data/crunchbase-people/
├── session.json     Auth cookies
└── cache/           People detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
