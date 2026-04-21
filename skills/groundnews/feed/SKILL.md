# groundnews-feed

Fetch Ground News feeds, stories, bias breakdowns, and source articles from the terminal. All API-based — no browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/nichochar/cdp-taskpacks/tree/main/skills/chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication — extracts `GROUND_LOGIN_TOKEN` cookie from an open Ground News tab in Chrome:

```bash
node scripts/groundnews-feed.mjs auth
```

This saves your token to disk. After auth, Chrome is no longer needed.

## Usage

### Top news feed

```bash
node scripts/groundnews-feed.mjs top-feed
node scripts/groundnews-feed.mjs top-feed --edition=eu --limit=10
node scripts/groundnews-feed.mjs top-feed --edition=us --offset=20 --limit=10
```

Shows: top story [TOP], breaking stories [BREAKING], then regular feed — matching the homepage order. Includes title, source count, bias breakdown (left/center/right %), blindspot info.

Available editions: `us` (default), `eu`, `uk`, `ca`, `international`.

### Daily briefing

```bash
node scripts/groundnews-feed.mjs daily-briefing
```

AI-curated daily news digest with 8-10 stories. Each story includes:
- **Title** and tagline
- **AI summary #1** ("What happened" / "The discovery" / "The details")
- **AI summary #2** ("Why it matters")
- Event ID for deeper drill-down with `story` or `story-full`

### Blindspot feed

```bash
node scripts/groundnews-feed.mjs blindspot-feed
node scripts/groundnews-feed.mjs blindspot-feed --side=left --limit=10
node scripts/groundnews-feed.mjs blindspot-feed --side=right
```

Stories that are blindspots for left or right media. No auth required.

### Local news

```bash
node scripts/groundnews-feed.mjs local-news "Istanbul,Istanbul,TR" --limit=10
node scripts/groundnews-feed.mjs local-news US --limit=5
node scripts/groundnews-feed.mjs local-news "London,GreaterLondon,GB"
```

Local news for any place. Resolves the place to a Ground News interest and fetches its stories.

### Story summary

```bash
node scripts/groundnews-feed.mjs story <event-id>
```

Returns: title, description, source count, bias distribution, blindspot data, factuality breakdown, ownership, topics.

### Full story with AI summaries

```bash
node scripts/groundnews-feed.mjs story-full <event-id>
```

Returns: everything from `story` plus AI-generated summaries from left/right/center perspectives, coverage analysis, and related story IDs.

### Source articles

```bash
node scripts/groundnews-feed.mjs sources <event-id>
node scripts/groundnews-feed.mjs sources <event-id> --bias=left --limit=10
node scripts/groundnews-feed.mjs sources <event-id> --bias=right
```

Returns: source name, bias, factuality, headline, summary, URL, paywall status, location.

### Interest/topic feed

```bash
node scripts/groundnews-feed.mjs interest-feed <interest-uuid> --limit=10
node scripts/groundnews-feed.mjs interest-feed <interest-uuid> --offset=20 --sort=time
```

Note: You must use the interest UUID, not the slug. UUIDs are shown in the `interests` field of story responses.

### List editions

```bash
node scripts/groundnews-feed.mjs editions
```

### Show help

```bash
node scripts/groundnews-feed.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts `GROUND_LOGIN_TOKEN` cookie, saves to disk.

2. **`top-feed`** — Fetches event IDs via `/v06/story/feed/top/:edition/ids` (auth). Response contains `topStoryId`, `breakingStoryIds`, and `eventIds`. Composes them in homepage order (top → breaking → regular), then fetches summaries in parallel via `/public/event/:id/summary`.

3. **`daily-briefing`** — Fetches the `/daily-briefing` page with RSC header and parses the embedded AI digest data. No direct API endpoint exists — the briefing is rendered server-side only.

4. **`blindspot-feed`** — Fetches blindspot event IDs via `/v06/story/feed/blindspot/ids` (public), then fetches summaries.

5. **`local-news`** — Resolves place to interest UUID via `/public/place/:id/interest`, then fetches events via `/public/interest/:id/events` and summaries.

6. **`story`** — Fetches `/public/event/:id/summary` (public, ~5KB).

7. **`story-full`** — Fetches `/public/event/:id` (public, ~300-400KB) with AI summaries, ownership, all source data.

8. **`sources`** — Fetches `/v06/story/:id/sources` (auth). Flat array with headline, summary, bias, factuality, URL, paywall, location. Client-side `--bias` filtering.

9. **`interest-feed`** — Fetches `/v06/story/feed/interest/:id/ids` (auth), then summaries. Supports `--offset` and `--sort=time`.

10. **`editions`** — Fetches `/v04/customFeed/topFeedEditions` (public).

## Data storage

```
~/.local/share/showrun/data/groundnews-feed/
├── session.json                     # Auth token
└── cache/
    ├── top-feed-{edition}.json      # Top feed results
    ├── daily-briefing.json          # Daily briefing digest
    ├── blindspot-feed.json          # Blindspot feed results
    ├── local-news-{place}.json      # Local news results
    ├── story-{id}.json              # Story summaries
    ├── story-full-{id}.json         # Full story data
    ├── sources-{id}.json            # Source articles
    ├── interest-feed-{id}.json      # Interest feed results
    └── editions.json                # Available editions
```

## Account tier

All commands work on the free tier. One silent paywall:

- **`sources <event-id>` silently strips per-source factuality on free.** Every item in `sources[]` carries `hasLockedFactualityData: true` and the `factuality` key is omitted from the object (not null — entirely absent). Per-source `bias`, `originalBias`, `detailedBias`, `paywall`, `headline`, `summary`, and `location` are all populated. Matches the `factualityData` flag in `user policies`.
  - Detection: `any(src.get('hasLockedFactualityData') for src in response['sources'])`.
  - To get publisher-level factuality, call `interests source <sourceId>` instead — that endpoint returns `factuality` and `factualityRatings[]` populated even on free.

**Not paywalled:** `story-full` aggregate `factuality` / `ownership` / `blindspotData` rollups are populated normally. The `policies` flags like `factualityData` / `ownershipData` gate UI features (per-source filtering and customization), not raw aggregate data. AI perspective summaries in `story-full` also come through.

For the authoritative free-tier feature matrix, call `user policies` (separate skill).

## Auth endpoints vs public endpoints

- **Auth required**: `top-feed`, `daily-briefing`, `interest-feed`, `sources`
- **Public (no auth)**: `story`, `story-full`, `blindspot-feed`, `local-news`, `editions`

Public endpoints must NOT receive the Authorization header — an invalid/expired token causes 401 even on public endpoints.

## Session expiry

If you see `Auth failed (HTTP 401)`, your session has expired. Open Ground News in Chrome and re-run:

```bash
node scripts/groundnews-feed.mjs auth
```
