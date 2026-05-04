---
name: linkedin-salesnav-saved-lead-search
description: "Query LinkedIn Sales Navigator saved searches and fetch full profile data from the terminal. No browser needed after initial auth."
---

# linkedin-salesnav-saved-lead-search

Query LinkedIn Sales Navigator saved searches and fetch full profile data from the terminal. No browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch` and `crypto`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill/tree/main/skills/chrome-cdp) skill (only for `auth` step)
- LinkedIn Sales Navigator subscription

## Setup

One-time authentication — extracts session cookies from an open Sales Navigator tab:

```bash
node scripts/linkedin-salesnav-saved-lead-search.mjs auth
```

## Usage

### Run a saved search

```bash
# Get the savedSearchId from the Sales Navigator URL:
# https://www.linkedin.com/sales/search/people?savedSearchId=1965805545
node scripts/linkedin-salesnav-saved-lead-search.mjs search 1965805545

# With pagination
node scripts/linkedin-salesnav-saved-lead-search.mjs search 1965805545 --count=50 --start=0
```

### Fetch full profiles by ID or URN

Accepts any LinkedIn URN format — not limited to Sales Navigator IDs.

```bash
# By Sales Nav / LinkedIn ID
node scripts/linkedin-salesnav-saved-lead-search.mjs profiles ACwAABJVBJEB...,ACwAABNcdPMB...

# By LinkedIn profile URN
node scripts/linkedin-salesnav-saved-lead-search.mjs profiles urn:li:fsd_profile:ACoAABJVBJEB...

# By Sales Nav URN
node scripts/linkedin-salesnav-saved-lead-search.mjs profiles "urn:li:fs_salesProfile:(ACwAABJVBJEB...,NAME_SEARCH,P3ii)"
```

### Search + fetch profiles in one step

```bash
node scripts/linkedin-salesnav-saved-lead-search.mjs search-profiles 1965805545
```

This runs the saved search, extracts all profile IDs, then batch-fetches full profile data including contact info, positions, education, and skills.

### Show help

```bash
node scripts/linkedin-salesnav-saved-lead-search.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts all LinkedIn cookies (including httpOnly `li_at`) using `Network.getCookies`, saves to disk.

2. **`search`** — Calls `salesApiLeadSearch` with the saved search ID. Returns lead names, current positions, and profile IDs.

3. **`profiles`** — Calls `salesApiProfiles` in batches of 25. Accepts any LinkedIn URN format (Sales Nav IDs, `fsd_profile` URNs, `fs_salesProfile` URNs) and normalizes them automatically. Fetches:
   - Contact info (email, phone, social handles, websites)
   - All positions with company, title, dates, location
   - Education with school, degree, fields of study
   - Skills and languages
   - LinkedIn profile URL
   - Connection count

4. **`search-profiles`** — Combines search + profiles in one command.

## Data storage

All data is stored in:

```
~/.local/share/showrun/data/linkedin-salesnav-saved-lead-search/
├── session.json                          # Auth cookies & CSRF token
└── cache/
    ├── search-<id>.json                  # Search results (lead list + profile IDs)
    └── search-profiles-<id>.json         # Full profile data from search
```

- `session.json` — LinkedIn session cookies. Re-run `auth` if you get 401/403 errors.
- `cache/` — Search results and fetched profiles. Each run overwrites the previous result for the same search ID.

## Session expiry

If you see `Session expired`, open Sales Navigator in Chrome and re-run:

```bash
node scripts/linkedin-salesnav-saved-lead-search.mjs auth
```
