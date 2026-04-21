# crunchbase-event

Fetch detailed event profiles from Crunchbase including dates, venue, speakers, sponsors, and organizers.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Crunchbase account (logged in via Chrome)

## Setup

```bash
node crunchbase-event.mjs auth
```

## Usage

```bash
# View event by permalink (from Crunchbase URL)
node crunchbase-event.mjs view techcrunch-disrupt-2024
node crunchbase-event.mjs view web-summit-2024

# Pick layout: v3 (default), v2, or both. For events v2 and v3 return
# identical card sets — the flag exists for API consistency.
node crunchbase-event.mjs view techcrunch-disrupt-2024 --view=v2

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
2. `view` — Resolves permalink to UUID via search API, then fetches entity from `/v4/data/entities/events/{uuid}?layout_mode=view_v3` (or `view_v2` or both, per `--view` flag, default `v3`). `layout_mode` triggers the server's full profile-page card set (~17 cards for a mature event). Cards include: `overview_fields_v2`, `overview_description`, `overview_headline`, `speakers_*` (headline/image_list/summary), `sponsors_*`, `exhibitors_*`, `contestants_*`, `hubs_list`, `timeline`. Note: for events, v2 and v3 return identical card sets — `--view=both` provides no extra data (available for API consistency).
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
