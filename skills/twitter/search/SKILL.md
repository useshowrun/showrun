# twitter-search

Twitter/X search and discovery: search tweets, search users, trending topics, and typeahead suggestions.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with x.com logged in (for `auth` command and tweet search via CDP)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication -- requires an active x.com session in Chrome:

    node scripts/twitter-search.mjs auth

## Usage

### Search tweets

    node scripts/twitter-search.mjs tweets <query> [--type=Latest|Top|Media] [--count=20] [--cursor=X] [--hash=X] [--txn=X]

Searches tweets matching the query. Supports Twitter search operators (e.g. `from:elonmusk`, `filter:media`, `min_faves:100`).

Flags:
- `--type=Latest|Top|Media` -- Search mode (default: Latest)
- `--count=N` -- Results per page, 1-50 (default: 20)
- `--cursor=X` -- Pagination cursor from previous results
- `--hash=X` -- Override the GraphQL endpoint hash
- `--txn=X` -- Provide an `x-client-transaction-id` from Chrome DevTools

This endpoint requires a transaction ID. If `--txn` is provided, it is used directly. Otherwise the request is routed through Chrome CDP (which adds the header automatically). If neither is available, the command will fail with instructions on how to obtain a transaction ID.

### Search users

    node scripts/twitter-search.mjs users <query> [--count=10]

Searches users by name or handle. Uses the v1.1 typeahead API -- no Chrome or transaction ID needed. Returns: screen_name, name, verified status, followers_count, bio.

### Trending topics

    node scripts/twitter-search.mjs trends [--woeid=1]

Fetches trending topics. Common WOEIDs: 1=Worldwide, 23424977=US, 23424969=Turkey, 23424975=UK.

### Typeahead suggestions

    node scripts/twitter-search.mjs typeahead <query> [--types=users,topics,events,lists]

Returns autocomplete suggestions across users, topics, events, and lists.

## Rate limits

All limits reset every 15 minutes.

| Command | Endpoint | Limit/15min |
|---|---|---|
| `tweets` | GraphQL SearchTimeline | ~50 |
| `users` | v1.1 search/typeahead (users) | ~75 |
| `trends` | v1.1 trends/place | ~75 |
| `typeahead` | v1.1 search/typeahead | ~75 |

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an x.com tab, extracts `auth_token` and `ct0` cookies using `Network.getCookies`. Saves session to disk.

2. **`tweets`** -- Calls the `SearchTimeline` GraphQL endpoint. This endpoint requires an `x-client-transaction-id` header. If `--txn` is provided, it is sent as a direct fetch. Otherwise, the script finds an x.com tab and routes the request through Chrome's `fetch()` (which auto-includes the transaction ID). Parses timeline entries and returns formatted tweet objects with pagination cursors.

3. **`users`** -- Calls `GET /1.1/search/typeahead.json?result_type=users`. Returns matching user profiles.

4. **`trends`** -- Calls `GET /1.1/trends/place.json?id={woeid}`. Returns an ordered list of trending topics with tweet volumes.

5. **`typeahead`** -- Calls `GET /1.1/search/typeahead.json` with configurable result types. Returns mixed suggestions across users, topics, events, and lists.

## Data storage

    ~/.local/share/showrun/data/twitter/
    ├── session.json                        # Auth cookies (shared across twitter skills)
    └── cache/
        ├── search-<slug>-<ts>.json         # Tweet search results
        └── trends-<woeid>-<ts>.json        # Trending topics

## Session expiry

Twitter sessions typically last several weeks. If you get 401/403 errors, re-run `auth`.

## Transaction ID note

The `SearchTimeline` endpoint requires an `x-client-transaction-id` header that Twitter generates client-side. Two ways to provide it:

1. **Chrome CDP (automatic)** -- Have x.com open in Chrome. The script routes the request through the browser's `fetch()`, which includes the header automatically.
2. **Manual** -- Open Chrome DevTools on x.com, perform a search, find the `SearchTimeline` request in the Network tab, copy the `x-client-transaction-id` header value, and pass it with `--txn=<value>`.
