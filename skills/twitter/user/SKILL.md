---
name: twitter-user
description: "Twitter/X user profile lookup, timeline browsing, and relationship actions (follow, mute, block)."
---

# twitter-user

Twitter/X user profile lookup, timeline browsing, and relationship actions (follow, mute, block).

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with x.com logged in (for `auth` command)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication -- requires an active x.com session in Chrome:

    node scripts/twitter-user.mjs auth

## Usage

### Lookup user by handle

    node scripts/twitter-user.mjs lookup <handle>

Returns: id, name, screen_name, description, location, url, created_at, followers/following/statuses counts, verified status, profile images.

### Lookup user by numeric ID

    node scripts/twitter-user.mjs lookup-id <id>

Same output as `lookup`, but takes a numeric user ID.

### User tweets

    node scripts/twitter-user.mjs tweets <handle|id> [--count=20] [--cursor=X]

Fetches a user's original tweets (no replies). Returns tweet objects with text, metrics, media, and a `nextCursor` for pagination.

### User tweets and replies

    node scripts/twitter-user.mjs replies <handle|id> [--count=20] [--cursor=X] [--via-cdp] [--hash=X]

Fetches tweets and replies. This endpoint requires an `x-client-transaction-id` header, so it may need Chrome CDP. Use `--via-cdp` to route through Chrome, or provide `--hash=X` if the default endpoint hash is stale.

### User media

    node scripts/twitter-user.mjs media <handle|id> [--count=20] [--cursor=X]

Fetches tweets containing media (images/videos).

### User likes

    node scripts/twitter-user.mjs likes <handle|id> [--count=20] [--cursor=X]

Fetches tweets the user has liked.

### User highlights

    node scripts/twitter-user.mjs highlights <handle|id> [--count=20]

Fetches the user's highlighted/pinned tweets.

### Follow / unfollow

    node scripts/twitter-user.mjs follow <handle|id>
    node scripts/twitter-user.mjs unfollow <handle|id>

### Mute / unmute

    node scripts/twitter-user.mjs mute <handle|id>
    node scripts/twitter-user.mjs unmute <handle|id>

### Block / unblock

    node scripts/twitter-user.mjs block <handle|id>
    node scripts/twitter-user.mjs unblock <handle|id>

## Rate limits

All limits reset every 15 minutes.

| Command | Endpoint | Limit/15min |
|---|---|---|
| `lookup` | GraphQL UserByScreenName | ~95 |
| `lookup-id` | GraphQL UserByRestId | ~95 |
| `tweets` | GraphQL UserTweets | ~50 |
| `replies` | GraphQL UserTweetsAndReplies | ~50 |
| `media` | GraphQL UserMedia | ~50 |
| `likes` | GraphQL Likes | ~75 |
| `highlights` | GraphQL UserHighlightsTweets | ~50 |
| `follow` | v1.1 friendships/create | ~15 |
| `unfollow` | v1.1 friendships/destroy | ~15 |
| `mute` | v1.1 mutes/users/create | ~50 |
| `block` | v1.1 blocks/create | ~50 |

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an x.com tab, extracts `auth_token` and `ct0` cookies using `Network.getCookies`, and reads the logged-in user's ID from the `twid` cookie. Saves session to disk.

2. **`lookup` / `lookup-id`** -- Calls the GraphQL `UserByScreenName` or `UserByRestId` endpoint. Parses the nested result to extract a clean user profile object.

3. **`tweets` / `replies` / `media` / `likes` / `highlights`** -- Calls the corresponding GraphQL timeline endpoint (`UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `Likes`, `UserHighlightsTweets`). Parses timeline entries and extracts formatted tweet objects with pagination cursors.

4. **`replies`** -- Special case: the `UserTweetsAndReplies` endpoint often requires an `x-client-transaction-id` header. When `--via-cdp` is set, the request is routed through Chrome's fetch (which automatically includes the header). Falls back to direct fetch otherwise.

5. **`follow` / `unfollow` / `mute` / `unmute` / `block` / `unblock`** -- Uses Twitter v1.1 REST POST endpoints (`friendships/create`, `friendships/destroy`, `mutes/users/create`, etc.) with form-encoded payloads.

## Data storage

    ~/.local/share/showrun/data/twitter/
    ├── session.json                  # Auth cookies (shared across twitter skills)
    └── cache/
        ├── user-<handle>.json        # Cached user profile by handle
        ├── user-id-<id>.json         # Cached user profile by ID
        ├── tweets-<userId>-<ts>.json
        ├── replies-<userId>-<ts>.json
        ├── media-<userId>-<ts>.json
        ├── likes-<userId>-<ts>.json
        └── highlights-<userId>-<ts>.json

## Session expiry

Twitter sessions typically last several weeks. If you get 401/403 errors, re-run `auth`.

## Transaction ID note

The `replies` command targets the `UserTweetsAndReplies` endpoint, which may require an `x-client-transaction-id` header. Use the `--via-cdp` flag to route through Chrome (which adds this header automatically), or provide a fresh `--hash=X` if the default endpoint hash has changed.
