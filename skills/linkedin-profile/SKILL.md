# linkedin-profile

Fetch LinkedIn profile data (experience, education, skills, contact info) from regular LinkedIn. Supports both a lightweight API-only mode and a full CDP-based mode that captures all data LinkedIn loads.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (for `auth` and `view` commands)
- [chrome-cdp](https://github.com/anthropics/claude-code) skill (for `auth` and `view` commands)

## Setup

One-time authentication — extracts session cookies from an open LinkedIn tab:

```bash
node scripts/linkedin-profile.mjs auth
```

## Usage

### Resolve a vanity name to profile URN

```bash
# By LinkedIn URL
node scripts/linkedin-profile.mjs resolve https://linkedin.com/in/emrahyalaz

# By vanity name
node scripts/linkedin-profile.mjs resolve emrahyalaz
```

### Fetch basic profile via API (no browser needed after auth)

```bash
node scripts/linkedin-profile.mjs view-api emrahyalaz
```

Returns: name, headline, location, current positions, education. Fast but limited fields.

### Fetch full profile via CDP (needs Chrome)

```bash
node scripts/linkedin-profile.mjs view emrahyalaz
```

Navigates to the profile in Chrome, intercepts all API responses, and compiles a comprehensive profile with experience, education, skills, languages, certifications, and contact info.

### Fetch recent posts/activity

```bash
# Default: 10 most recent posts
node scripts/linkedin-profile.mjs posts emrahyalaz

# Fetch more
node scripts/linkedin-profile.mjs posts emrahyalaz --count=25
```

Returns post text, engagement metrics (likes, comments, shares), timestamps, and activity URNs.

### Show help

```bash
node scripts/linkedin-profile.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts LinkedIn cookies using `Network.getCookies`, saves session to disk.

2. **`resolve`** — Calls `voyagerIdentityDashProfiles?q=memberIdentity` to resolve a vanity name to an `fsd_profile` URN. Caches results for repeated lookups.

3. **`view-api`** — Same API call as resolve, but extracts and formats all available profile fields from the response's `included` entities. No browser needed after auth.

4. **`posts`** — Calls `identity/profileUpdatesV2` with `q=memberShareFeed` to fetch the member's posts. Returns post text, engagement counts (likes, comments, shares), timestamps, linked articles, and activity URNs. Supports pagination via `--count`.

5. **`view`** — Full profile capture:
   - Injects a fetch interceptor into a LinkedIn tab
   - Navigates to the profile page
   - Scrolls to trigger lazy-loaded sections
   - Captures all Voyager API responses (GraphQL queries for profile components, experience, education, skills)
   - Compiles all captured entities into a structured profile JSON

## Data storage

```
~/.local/share/showrun/data/linkedin-profile/
├── session.json                    # Auth cookies & CSRF token
├── profiles.json                   # Cached vanity name -> URN mappings
└── cache/
    ├── api-<vanityName>.json       # API-fetched profile (basic)
    ├── api-raw-<vanityName>.json   # Raw API response
    └── profile-<vanityName>.json   # Full CDP-captured profile
```

## Session expiry

If you see `Failed (HTTP 401)` or `Failed (HTTP 403)`, your session has expired. Open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-profile.mjs auth
```
