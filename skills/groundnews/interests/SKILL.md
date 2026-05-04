---
name: groundnews-interests
description: "Fetch Ground News interests (topics, people, sources), stories, blindspot analysis, and edition data from the terminal. All data endpoints are public — no authentication needed for API calls."
---

# groundnews-interests

Fetch Ground News interests (topics, people, sources), stories, blindspot analysis, and edition data from the terminal. All data endpoints are public — no authentication needed for API calls.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](../../chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication — extracts `GROUND_LOGIN_TOKEN` cookie from an open Ground News tab in Chrome:

```bash
node scripts/groundnews-interests.mjs auth
```

This saves the session token to disk (shared with other ground-news taskpacks). Auth is not required for any data commands — all endpoints are public.

## Usage

### Interest/topic detail

```bash
node scripts/groundnews-interests.mjs detail politics
node scripts/groundnews-interests.mjs detail donald-trump
node scripts/groundnews-interests.mjs detail climate-change
```

Returns: name, type, slug, UUID, story count, 90-day bias breakdown, top covering sources, Wikipedia link. Works with both slugs and UUIDs.

### Story IDs for an interest

```bash
node scripts/groundnews-interests.mjs events <uuid>
node scripts/groundnews-interests.mjs events <uuid> --limit=50 --offset=20
```

Returns event IDs, breaking story IDs, and top story ID. **UUID required** — slugs return empty arrays.

### Stories with full summaries

```bash
node scripts/groundnews-interests.mjs events-detail <uuid>
node scripts/groundnews-interests.mjs events-detail <uuid> --limit=10
```

Same as `events` but fetches summaries for each story (title, source count, bias breakdown). Fetches up to 5 summaries concurrently. **UUID required**.

### Blindspot stories

```bash
node scripts/groundnews-interests.mjs blindspots <uuid>
node scripts/groundnews-interests.mjs blindspots <uuid> --side=left --limit=10
```

Returns stories that one political side is underreporting. Shows left blindspots (stories the left is missing) and right blindspots separately, with summaries. **UUID required**.

### Popular related interests

```bash
node scripts/groundnews-interests.mjs popular politics
```

Returns related interests by popularity (name, type, slug).

### Trending sub-interests

```bash
node scripts/groundnews-interests.mjs trending politics
```

Returns trending sub-interests (may be empty).

### Source/publisher detail

```bash
node scripts/groundnews-interests.mjs source <uuid>
```

Returns: name, domain, bias, factuality, satire, paywall, ownership, story count, reviewer ratings (MBFC, etc). **UUID only** — slugs return 404.

### Feed editions

```bash
node scripts/groundnews-interests.mjs editions
```

Lists available feed editions (US, International, UK, Canada, Europe).

### Place detail

```bash
node scripts/groundnews-interests.mjs place US
node scripts/groundnews-interests.mjs place TR
node scripts/groundnews-interests.mjs place Istanbul,Istanbul,TR
```

Returns: name, type, timezone, coordinates.

### Place interest mapping

```bash
node scripts/groundnews-interests.mjs place-interest US
```

Returns the interest UUID that maps to a given place.

### Show help

```bash
node scripts/groundnews-interests.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts `GROUND_LOGIN_TOKEN` cookie from a ground.news tab, saves session to disk for sharing with other ground-news taskpacks.

2. **`detail`** — Fetches `GET /public/interest/:id` which accepts both slugs and UUIDs. Returns the interest entity with metadata and bias breakdown.

3. **`events`** — Fetches `GET /public/interest/:id/events` to get story/event IDs for an interest. Supports pagination with `limit`, `offset`, and `sort` parameters.

4. **`events-detail`** — Same as `events`, then fetches `GET /public/event/:id/summary` for each event in parallel (max 5 concurrent) to get titles, source counts, and bias breakdowns.

5. **`blindspots`** — Fetches `GET /public/interest/:id/blindspots` with `customLimit` parameter. Returns left and right blindspot event IDs, then fetches summaries for each.

6. **`popular`** — Fetches `GET /public/interest/:id/popular` for related interests by popularity.

7. **`trending`** — Fetches `GET /public/interest/:id/trending` for trending sub-interests.

8. **`source`** — Fetches `GET /public/source/:id` for publisher details including bias/factuality ratings from multiple reviewers.

9. **`editions`** — Fetches `GET /v04/customFeed/topFeedEditions` for the list of available feed editions.

10. **`place`** — Fetches `GET /public/place/:id` for geographic location data.

11. **`place-interest`** — Fetches `GET /public/place/:id/interest` to map a place to its corresponding interest entity.

## Data storage

```
~/.local/share/showrun/data/groundnews-interests/
├── session.json                    # Auth token (shared with other ground-news taskpacks)
└── cache/
    ├── interest-<id>.json          # Interest/topic detail
    ├── events-<id>.json            # Event IDs
    ├── events-detail-<id>.json     # Events with summaries
    ├── blindspots-<id>.json        # Blindspot analysis
    ├── popular-<id>.json           # Popular related interests
    ├── trending-<id>.json          # Trending sub-interests
    ├── source-<id>.json            # Source/publisher detail
    ├── editions.json               # Feed editions
    ├── place-<id>.json             # Place detail
    └── place-interest-<id>.json    # Place-interest mapping
```

## API notes

- **Base URL**: `https://web-api-cdn.ground.news/api`
- **All data endpoints are public** — no Authorization header is sent (expired tokens cause 401 even on public endpoints)
- Only the `x-gn-v: web` header is required for API calls
- Pagination: max limit 500; blindspots use `customLimit`, everything else uses `limit`
- `events`, `events-detail`, and `blindspots` require UUIDs (slugs return empty arrays)
- `source` requires UUID (slugs return 404)
- `detail`, `popular`, and `trending` accept both slugs and UUIDs
