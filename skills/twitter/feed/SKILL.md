# twitter-feed

Twitter/X home timeline, notifications, direct messages, lists, communities, and geo lookup.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with x.com logged in (for `auth` command)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication -- requires an active x.com session in Chrome:

    node scripts/twitter-feed.mjs auth

## Usage

### Home timeline (algorithmic)

    node scripts/twitter-feed.mjs timeline [--count=20] [--cursor=X]

Returns the algorithmic "For You" home timeline.

### Latest timeline (chronological)

    node scripts/twitter-feed.mjs latest [--count=20] [--cursor=X]

Returns the chronological "Following" timeline.

### Notifications

    node scripts/twitter-feed.mjs notifications [--type=all|mentions|verified] [--count=20] [--cursor=X]

Fetches notifications. Types: `all` (default), `mentions`, `verified`. Returns parsed notification objects with associated users and tweets.

### DM inbox

    node scripts/twitter-feed.mjs dm-inbox [--count=50]

Returns an overview of DM conversations: participants, last message, type, and unread status.

### DM conversation history

    node scripts/twitter-feed.mjs dm-history <conversation_id> [--count=50] [--cursor=X]

Returns messages in a conversation. Each message includes sender info, text, and media attachments.

### Send a DM

    node scripts/twitter-feed.mjs dm-send <user_id> <text>

Sends a direct message to a user by their numeric user ID. Requires `userId` in the session (set during auth).

### Your lists

    node scripts/twitter-feed.mjs lists [--count=20] [--cursor=X]

Returns lists you own or are subscribed to.

### List details

    node scripts/twitter-feed.mjs list <list_id>

Returns info about a specific list: name, description, member/subscriber counts, mode, owner.

### List tweets

    node scripts/twitter-feed.mjs list-tweets <list_id> [--count=20] [--cursor=X]

Returns the latest tweets from a list's timeline.

### List members

    node scripts/twitter-feed.mjs list-members <list_id> [--count=20] [--cursor=X]

Returns user profiles of a list's members.

### Browse/search communities

    node scripts/twitter-feed.mjs communities [--query=X]

Without `--query`, returns your communities. With `--query`, searches for communities by name.

### Community details

    node scripts/twitter-feed.mjs community <community_id>

Returns community info: name, description, member/moderator counts, rules, admin info.

### Community tweets

    node scripts/twitter-feed.mjs community-tweets <community_id> [--count=20] [--cursor=X]

Returns recent tweets from a community, sorted by recency.

### Geo search

    node scripts/twitter-feed.mjs geo <query>

Searches for places by name. Returns: id, name, full_name, country, place_type, centroid, bounding_box.

## Rate limits

All limits reset every 15 minutes.

| Command | Endpoint | Limit/15min |
|---|---|---|
| `timeline` | GraphQL HomeTimeline | ~50 |
| `latest` | GraphQL HomeLatestTimeline | ~50 |
| `notifications` | v2 notifications/all (or mentions/verified) | ~75 |
| `dm-inbox` | v1.1 dm/inbox_initial_state | ~15 |
| `dm-history` | v1.1 dm/conversation/{id} | ~15 |
| `dm-send` | v1.1 dm/new2 | ~50 |
| `lists` | GraphQL ListsManagementPageTimeline | ~50 |
| `list` | GraphQL ListByRestId | ~75 |
| `list-tweets` | GraphQL ListLatestTweetsTimeline | ~50 |
| `list-members` | GraphQL ListMembers | ~50 |
| `communities` | GraphQL CommunitiesSearchQuery / CommunitiesMainPageTimeline | ~50 |
| `community` | GraphQL CommunityQuery | ~75 |
| `community-tweets` | GraphQL CommunityTweetsTimeline | ~50 |
| `geo` | v1.1 geo/search | ~75 |

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an x.com tab, extracts `auth_token` and `ct0` cookies using `Network.getCookies`, reads the logged-in user ID from the `twid` cookie. Saves session to disk.

2. **`timeline` / `latest`** -- Call `HomeTimeline` / `HomeLatestTimeline` GraphQL mutations (POST). Parse timeline entries for tweets and pagination cursors.

3. **`notifications`** -- Calls the v2 notifications REST endpoint (`2/notifications/all.json`, `mentions.json`, or `verified.json`). Parses `globalObjects` for tweets, users, and notification objects. Extracts pagination cursors from timeline instructions.

4. **`dm-inbox`** -- Calls `GET /1.1/dm/inbox_initial_state.json`. Parses conversations, participants, and last messages from the inbox state.

5. **`dm-history`** -- Calls `GET /1.1/dm/conversation/{id}.json`. Returns messages with sender info and media. Supports pagination via `--cursor` (maps to `max_id`).

6. **`dm-send`** -- Calls `POST /1.1/dm/new2.json`. Constructs a conversation ID from the two user IDs (sorted lower-higher) and sends the message.

7. **`lists`** -- Calls `ListsManagementPageTimeline` GraphQL endpoint. Parses list entries.

8. **`list`** -- Calls `ListByRestId` GraphQL endpoint. Returns list metadata and owner info.

9. **`list-tweets` / `list-members`** -- Call `ListLatestTweetsTimeline` / `ListMembers` GraphQL endpoints.

10. **`communities`** -- Calls `CommunitiesSearchQuery` (with `--query`) or `CommunitiesMainPageTimeline` (without). Parses community result objects.

11. **`community`** -- Calls `CommunityQuery` GraphQL endpoint. Returns full community details including rules and admin.

12. **`community-tweets`** -- Calls `CommunityTweetsTimeline` GraphQL endpoint with `rankingMode: 'Recency'`.

13. **`geo`** -- Calls `GET /1.1/geo/search.json?granularity=city`. Returns matching places.

## Data storage

    ~/.local/share/showrun/data/twitter/
    ├── session.json                              # Auth cookies (shared across twitter skills)
    └── cache/
        ├── timeline-<ts>.json                    # Home timeline
        ├── latest-<ts>.json                      # Latest timeline
        ├── notifications-<type>-<ts>.json        # Notifications
        ├── dm-inbox-<ts>.json                    # DM inbox
        ├── dm-history-<convId>-<ts>.json         # DM conversation
        ├── lists-<ts>.json                       # Your lists
        ├── list-<listId>.json                    # List details
        ├── list-tweets-<listId>-<ts>.json        # List tweets
        ├── list-members-<listId>-<ts>.json       # List members
        ├── communities-<ts>.json                 # Communities
        ├── community-<communityId>.json          # Community details
        └── community-tweets-<communityId>-<ts>.json

## Session expiry

Twitter sessions typically last several weeks. If you get 401/403 errors, re-run `auth`.
