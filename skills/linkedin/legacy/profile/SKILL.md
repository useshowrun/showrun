# linkedin-profile

Fetch LinkedIn profile data and perform profile actions (connect, follow, etc.) from the terminal. All API-based — no browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch` and `crypto`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill/tree/main/skills/chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from an open LinkedIn tab in Chrome:

```bash
node scripts/linkedin-profile.mjs auth
```

This saves your LinkedIn session to disk. After auth, Chrome is no longer needed.

## Usage

### View a profile

```bash
node scripts/linkedin-profile.mjs view kubilay-topcu-786159126
node scripts/linkedin-profile.mjs view https://linkedin.com/in/anilseyrek/
```

Returns: name, headline, location, connection status, follow status, follower count, experience, education, skills, certifications, languages, volunteering, honors, projects, publications, courses.

### Resolve a vanity name to profile URN

```bash
node scripts/linkedin-profile.mjs resolve emrahyalaz
```

### Fetch recent posts/activity

```bash
node scripts/linkedin-profile.mjs posts emrahyalaz
node scripts/linkedin-profile.mjs posts emrahyalaz --count=25
```

### Mutual connections

```bash
node scripts/linkedin-profile.mjs mutual bahad%C4%B1r-polat-480ab41b7
```

Shows the number of mutual connections, names of the top ones, and a link to view the full list on LinkedIn.

### List your connections

```bash
node scripts/linkedin-profile.mjs connections
node scripts/linkedin-profile.mjs connections --count=20 --start=10
```

### Follow / Unfollow

```bash
node scripts/linkedin-profile.mjs follow kubilay-topcu-786159126
node scripts/linkedin-profile.mjs unfollow kubilay-topcu-786159126
```

### Send a connection request

```bash
# Without a message
node scripts/linkedin-profile.mjs connect kubilay-topcu-786159126

# With a personalized message
node scripts/linkedin-profile.mjs connect kubilay-topcu-786159126 "Hi, we met at the conference!"
```

### Withdraw a pending invitation

```bash
node scripts/linkedin-profile.mjs withdraw kubilay-topcu-786159126
```

### Remove a connection

```bash
node scripts/linkedin-profile.mjs disconnect anilseyrek
```

### Show help

```bash
node scripts/linkedin-profile.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts LinkedIn cookies using `Network.getCookies`, saves session to disk.

2. **`view`** — Fetches profile via LinkedIn's GraphQL API (`voyagerIdentityDashProfiles`) using the vanity name directly (no intermediate resolution step). Includes relationship data (connection status, follow state, follower count). Then fetches profile cards (experience, education, skills, etc.) via the `voyagerIdentityDashProfileCards` REST API.

3. **`resolve`** — Same GraphQL endpoint as `view`, but only extracts the profile URN and basic info. Caches results.

4. **`posts`** — Calls `identity/profileUpdatesV2` with `q=memberShareFeed` to fetch posts with engagement metrics.

5. **`mutual`** — Extracts mutual connection data from the `Insight` entity in the main profile GraphQL response. Shows named connections, total count, and a search URL for the full list.

6. **`connections`** — Calls `relationships/dash/connections?q=search` to list your connections with names and headlines.

7. **`follow`/`unfollow`** — PATCHes `feed/dash/followingStates/<followingStateUrn>` to toggle the follow state.

8. **`connect`** — POSTs to `voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2` to send a connection invitation.

9. **`withdraw`** — Fetches the profile to find the pending invitation URN, then POSTs to `voyagerRelationshipsDashInvitations/<urn>?action=withdraw`.

10. **`disconnect`** — Fetches the profile to find the connection URN, then POSTs to `relationships/dash/memberRelationships?action=removeFromMyConnections`.

## Data storage

```
~/.local/share/showrun/data/linkedin-profile/
├── session.json                    # Auth cookies & CSRF token
├── profiles.json                   # Cached vanity name → URN mappings
└── cache/
    ├── profile-<vanityName>.json       # Profile data
    ├── profile-raw-<vanityName>.json   # Raw API response
    └── posts-<vanityName>.json         # Posts data
```

## Session expiry

If you see `Failed (HTTP 401)` or `Failed (HTTP 403)`, your session has expired. Open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-profile.mjs auth
```
