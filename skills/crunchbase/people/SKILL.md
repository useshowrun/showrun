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

# Pick layout: v3 (default), v2, or both. For people, v2 and v3 return
# identical card sets — flag is provided for API consistency only.
node crunchbase-people.mjs view mark-zuckerberg --view=v2

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

All commands work on the free Crunchbase account. Only the cross-entity `advanced-search search` (separate skill) requires Crunchbase Pro.

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity with cards from `/v4/data/entities/people/{uuid}?layout_mode=view_v3` (or `view_v2` or both, per `--view` flag, default `v3`). The `layout_mode` parameter triggers the server's full profile-page card set (~31 cards for a well-known person) regardless of which `card_ids` you pass. Note: for people, `view_v2` and `view_v3` return identical card sets — `--view=both` provides no extra data (it's available for API consistency with the other skills).
3. Section commands — Use the overrides endpoint `POST /v4/data/entities/people/{permalink}/overrides?field_ids=[...]&section_ids=[...]` to fetch paginated section data

Cards returned by `view` (~31 for a well-known person): overview, bio, education, investments/exits summaries, news, social fields, prediction cards, contact fields, and FAQ cards. List cards (e.g. education, investments, news) still cap at ~10 items — use the section commands for paginated full lists.

Available fields: identifier, first_name, last_name, primary_job_title, primary_organization, location_identifiers, short_description, description, gender, linkedin, twitter, facebook, num_founded_organizations, num_investments_funding_rounds, num_exits, num_current_jobs, num_past_jobs, born_on, died_on, rank_person, current_organizations, attended_schools, featured_job

## Data storage

```
~/.local/share/showrun/data/crunchbase-people/
├── session.json     Auth cookies
└── cache/           People detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
