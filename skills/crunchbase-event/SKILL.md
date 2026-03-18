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

# View by UUID
node crunchbase-event.mjs view 6acfa7da-1dbd-936e-d985-cf07a1b27711
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP
2. `view` — Resolves permalink to UUID via search API, then fetches entity from `/v4/data/entities/events/{uuid}`

Available fields: identifier, starts_on, ends_on, location_identifiers, short_description, description, event_url, venue_name, categories, category_groups, num_speakers, num_sponsors, num_exhibitors, num_contestants, num_organizers, organizer_identifiers, registration_url, event_type, rank_event

## Data storage

```
~/.local/share/showrun/data/crunchbase-event/
├── session.json     Auth cookies
└── cache/           Event detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
