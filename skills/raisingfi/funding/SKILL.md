# raisingfi-funding

Fetch recent startup funding rounds from Raising.fi — a startup intelligence platform tracking global fundraising activity.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)

## Setup

No authentication required. The API is public but rate-limited (10 requests per hour, free tier shows last 20 raises).

## Usage

### List recent funding rounds

```bash
node scripts/raisingfi-funding.mjs list
node scripts/raisingfi-funding.mjs list --limit=5
node scripts/raisingfi-funding.mjs list --page=2
```

### Fetch all available rounds (paginated)

```bash
node scripts/raisingfi-funding.mjs fetch-all
```

Loops through all pages automatically with rate-limit-aware pacing. Saves results to cache.

### Search by company name

```bash
node scripts/raisingfi-funding.mjs search "Harvey"
node scripts/raisingfi-funding.mjs search "Anthropic"
```

Searches cached results. Run `fetch-all` first for complete data.

### Show help

```bash
node scripts/raisingfi-funding.mjs
```

## Account tier

All commands work on the free Raising.fi account (no login required) with two documented caps:
- **`list` / `fetch-all` return at most the last 20 raises** — upgrading to Pro unlocks the full historical dataset.
- **API rate limit is 10 requests per hour** on free (tracked via `x-ratelimit-remaining`). The script pauses automatically as it approaches the limit.

The `search` command filters whatever is currently cached, so its coverage is limited to the 20 rows free tier returns.

## How it works

1. **`list`** — GETs `https://raising.fi/api/funding?page=N&limit=N`. Returns funding rounds with company name, raise type, amount, lead investor, other investors, industry, website, and location.

2. **`fetch-all`** — Loops `list` across all pages until `pagination.hasNextPage` is false. Respects rate limits via `x-ratelimit-remaining` header. Saves combined results to cache.

3. **`search`** — Filters cached results by company name (case-insensitive substring match).

## Rate limits

- 10 requests per hour (tracked via `x-ratelimit-remaining` header)
- Free tier: last 20 raises only
- Script pauses automatically when approaching limit

## Data storage

```
~/.local/share/showrun/data/raisingfi-funding/
└── cache/
    └── funding.json    # All fetched funding rounds
```

## Data fields

Each funding round includes:
- `id` — unique ID
- `dateOfRaise` — date string (e.g. "3/25/2026")
- `companyName` — company name
- `raiseType` — Seed, Series A, Growth, etc.
- `amountRaised` — amount string (e.g. "$200 Million")
- `leadInvestor` — lead investor(s)
- `investors` — other participating investors
- `industry` — sector/industry
- `website` — company website
- `location` — city, state, country
- `sourceUrls` — comma-separated news source URLs
- `slug` — URL slug
