# crunchbase-event

Fetch detailed event profiles from Crunchbase including dates, venue, speakers, sponsors, and organizers.

## Prerequisites

- Node.js 22+
- If CDP connection fails during `auth`, launch Chrome yourself with `https://www.crunchbase.com` as the initial URL (see chrome-cdp agent guidance)
- If Chrome is already running via CDP but no Crunchbase tab is open: `node skills/chrome-cdp/scripts/cdp.mjs open https://www.crunchbase.com`
- If the user is not logged in to Crunchbase, ask them to log in in the Chrome window, then re-run `auth`

## Setup

```bash
node crunchbase-event.mjs auth
```

## Usage

```bash
# View event by permalink (from Crunchbase URL)
node crunchbase-event.mjs view techcrunch-disrupt-2024
node crunchbase-event.mjs view web-summit-2024

# View by UUID
node crunchbase-event.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711

# Section commands (speakers, sponsors, exhibitors, contestants, news)
node crunchbase-event.mjs speakers techcrunch-disrupt-2024
node crunchbase-event.mjs sponsors web-summit-2024 --count=50
node crunchbase-event.mjs exhibitors techcrunch-disrupt-2024
node crunchbase-event.mjs contestants techcrunch-disrupt-2024
node crunchbase-event.mjs news techcrunch-disrupt-2024 --count=20

# Pagination
node crunchbase-event.mjs speakers techcrunch-disrupt-2024 --after-id=<UUID>
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity from `/v4/data/entities/events/{uuid}`
3. Section commands — Use the overrides endpoint (`POST /v4/data/entities/events/{permalink}/overrides`) to fetch paginated section data (speakers, sponsors, exhibitors, contestants, news)

Available fields: identifier, starts_on, ends_on, location_identifiers, short_description, description, event_url, venue_name, categories, category_groups, num_speakers, num_sponsors, num_exhibitors, num_contestants, num_organizers, organizer_identifiers, registration_url, event_type, rank_event

## Data storage

```
~/.local/share/showrun/data/crunchbase-event/
├── session.json     Auth cookies
└── cache/           Event detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
