---
name: twitter-followers
description: "Twitter/X follower and following operations: list followers, following, verified followers, mutuals, and bulk-fetch with pagination."
---

# twitter-followers

Twitter/X follower and following operations: list followers, following, verified followers, mutuals, and bulk-fetch with pagination.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with x.com logged in (for `auth` command)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication -- requires an active x.com session in Chrome:

    node scripts/twitter-followers.mjs auth

## Usage

### Following (who a user follows)

    node scripts/twitter-followers.mjs following <handle|id> [--count=20] [--cursor=X]

Returns full user profiles of accounts the target user follows.

### Followers (full profiles)

    node scripts/twitter-followers.mjs followers <handle|id> [--count=20] [--cursor=X] [--txn=X] [--hash=X]

Returns full user profiles of followers. Requires `--txn` (transaction ID from Chrome DevTools). Without `--txn`, falls back to `followers-ids` (numeric IDs only).

### Follower IDs

    node scripts/twitter-followers.mjs followers-ids <handle|id> [--count=5000] [--cursor=X]

Returns numeric follower IDs only. Uses v1.1 REST API -- no transaction ID needed. Up to 5000 IDs per page.

### Following IDs

    node scripts/twitter-followers.mjs following-ids <handle|id> [--count=5000] [--cursor=X]

Returns numeric IDs of accounts the user follows. Up to 5000 IDs per page.

### Verified followers

    node scripts/twitter-followers.mjs verified <handle|id> [--count=20] [--cursor=X]

Returns blue-verified followers only.

### Mutuals (followers you know)

    node scripts/twitter-followers.mjs mutuals <handle|id> [--count=20] [--cursor=X]

Returns followers of the target that you also follow.

### Fetch all (paginate through everything)

    node scripts/twitter-followers.mjs fetch-all <handle|id> [--type=following] [--max-pages=50] [--cursor=X]

Automatically paginates through all pages with a 1-second delay between requests. Saves all results to a single cache file.

Valid `--type` values: `following`, `followers-ids`, `following-ids`, `verified`, `mutuals`.

Note: `--type=followers` (full profiles) is not supported in fetch-all without `--txn`. Use `--type=followers-ids` instead.

## Rate limits

All limits reset every 15 minutes.

| Command | Endpoint | Limit/15min |
|---|---|---|
| `following` | GraphQL Following | ~50 |
| `followers` | GraphQL Followers | ~50 |
| `followers-ids` | v1.1 followers/ids | ~15 |
| `following-ids` | v1.1 friends/ids | ~15 |
| `verified` | GraphQL BlueVerifiedFollowers | ~50 |
| `mutuals` | GraphQL FollowersYouKnow | ~50 |

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an x.com tab, extracts `auth_token` and `ct0` cookies using `Network.getCookies`, reads the logged-in user ID from the `twid` cookie. Saves session to disk.

2. **`following`** -- Calls the `Following` GraphQL endpoint. Parses user entries from timeline response.

3. **`followers`** -- Calls the `Followers` GraphQL endpoint with an `x-client-transaction-id` header (provided via `--txn`). Without `--txn`, falls back to `followers-ids`.

4. **`followers-ids` / `following-ids`** -- Call the v1.1 REST endpoints `followers/ids.json` and `friends/ids.json`. Return up to 5000 numeric IDs per page with cursor-based pagination.

5. **`verified`** -- Calls the `BlueVerifiedFollowers` GraphQL endpoint.

6. **`mutuals`** -- Calls the `FollowersYouKnow` GraphQL endpoint. Returns users who follow the target and whom you also follow.

7. **`fetch-all`** -- Wraps any of the above commands in an auto-pagination loop. Fetches pages with a 1-second delay, stopping when there are no more pages or `--max-pages` is reached. Saves all accumulated results to a single cache file.

## Data storage

    ~/.local/share/showrun/data/twitter/
    ├── session.json                           # Auth cookies (shared across twitter skills)
    └── cache/
        ├── following-<userId>-<ts>.json       # Following list (single page)
        ├── followers-<userId>-<ts>.json       # Followers list (single page)
        ├── follower-ids-<userId>-<ts>.json    # Follower numeric IDs
        ├── following-ids-<userId>-<ts>.json   # Following numeric IDs
        ├── verified-followers-<userId>-<ts>.json
        ├── mutuals-<userId>-<ts>.json
        └── <type>-all-<userId>-<ts>.json      # fetch-all results

## Session expiry

Twitter sessions typically last several weeks. If you get 401/403 errors, re-run `auth`.

## Transaction ID note

The `Followers` GraphQL endpoint requires an `x-client-transaction-id` header. To obtain one:

1. Open x.com in Chrome and navigate to any user's followers page
2. Open DevTools > Network tab
3. Find the `Followers` GraphQL request
4. Copy the `x-client-transaction-id` header value
5. Pass it as `--txn=<value>`

Without a transaction ID, the `followers` command falls back to `followers-ids` which returns numeric IDs only (no profile data).
