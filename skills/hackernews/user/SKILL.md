---
name: hackernews-user
description: "Fetch Hacker News user profiles, stories, comments, and authenticated views (threads, favorites, upvoted, hidden) from the terminal. Uses Firebase and Algolia public APIs for profile/search, and HN Web with cookie auth for private views."
---

# hackernews-user

Fetch Hacker News user profiles, stories, comments, and authenticated views (threads, favorites, upvoted, hidden) from the terminal. Uses Firebase and Algolia public APIs for profile/search, and HN Web with cookie auth for private views.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](../../_shared) skill (only for `auth` step)

## Setup

One-time authentication -- extracts `user` session cookie from an open Hacker News tab in Chrome:

```bash
node scripts/hackernews-user.mjs auth
```

This saves your HN session cookies to disk. After auth, Chrome is no longer needed. Public commands (`about`, `posts`, `comments`) work without auth.

## Usage

### View a user profile

```bash
node scripts/hackernews-user.mjs about pg
node scripts/hackernews-user.mjs about dang
```

Returns: username, karma, account creation date, submitted item count, bio text. Uses the Firebase API (no auth needed).

### Fetch user's stories

```bash
node scripts/hackernews-user.mjs posts pg
node scripts/hackernews-user.mjs posts pg --sort=relevance --limit=10 --page=0
node scripts/hackernews-user.mjs posts pg --points=100
```

Flags: `--sort=date|relevance` (default: date), `--limit=N` (default: 20), `--page=N` (0-indexed), `--points=N` (min points filter).

Returns: title, url, points, comment count, date, item ID. Uses the Algolia search API (no auth needed).

### Fetch user's comments

```bash
node scripts/hackernews-user.mjs comments pg
node scripts/hackernews-user.mjs comments dang --sort=date --limit=50 --page=1
node scripts/hackernews-user.mjs comments pg --points=10
```

Same flags as posts. Returns: comment text preview, parent story title and ID, date. Uses the Algolia search API (no auth needed).

### View your comment threads

```bash
node scripts/hackernews-user.mjs threads
```

Requires auth. Returns: your comments with the story they are on, sorted by recency.

### View your favorites

```bash
node scripts/hackernews-user.mjs favorites
```

Requires auth. Returns: list of stories you favorited, with title, score, author, and comment count.

### View your upvoted items

```bash
node scripts/hackernews-user.mjs upvoted
```

Requires auth. Returns: items you upvoted. Only visible to the authenticated user themselves.

### View your hidden items

```bash
node scripts/hackernews-user.mjs hidden
```

Requires auth. Returns: items you have hidden from your feed.

### Show help

```bash
node scripts/hackernews-user.mjs
```

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an open HN tab, extracts all ycombinator.com cookies using `Network.getCookies`, parses the `user` cookie to get the username. Saves cookies and username to disk.

2. **`about`** -- Calls `GET /v0/user/{name}.json` on the Firebase API. Returns the user object with karma, created (Unix timestamp, formatted as date), about (HTML stripped), and submitted array (count shown, not fetched).

3. **`posts`** -- Calls Algolia `search_by_date` (or `search` for relevance sort) with `tags=story,author_{name}`. Supports pagination, limit, and minimum points filter via `numericFilters`.

4. **`comments`** -- Calls Algolia `search_by_date` (or `search` for relevance sort) with `tags=comment,author_{name}`. Same flags as posts. Shows comment text preview and parent story info.

5. **`threads`** -- Calls `GET /threads?id={username}` on HN Web with cookie auth. Parses HTML to extract comments (class `athing comtr`) with author, age, text preview, and parent story link.

6. **`favorites`** -- Calls `GET /favorites?id={username}` on HN Web with cookie auth. Parses HTML to extract submission items (class `athing submission`) with title, url, score, author, and comments.

7. **`upvoted`** -- Calls `GET /upvoted?id={username}` on HN Web with cookie auth. Only visible to the user themselves. Same HTML parsing as favorites.

8. **`hidden`** -- Calls `GET /hidden` on HN Web with cookie auth (no username param needed). Same HTML parsing as favorites.

## API details

Three API layers are used:

- **Firebase** (public): `https://hacker-news.firebaseio.com/v0/` -- user profiles, no rate limit
- **Algolia** (public): `https://hn.algolia.com/api/v1/` -- full-text search, 10K req/hr
- **HN Web** (cookie): `https://news.ycombinator.com/` -- authenticated HTML views

## Data storage

```
~/.local/share/showrun/data/hackernews-user/
├── session.json                          # Auth cookies + username
└── cache/
    ├── about-{name}.json                 # User profile (Firebase)
    ├── posts-{name}-{page}-{ts}.json     # User's stories (Algolia)
    ├── comments-{name}-{page}-{ts}.json  # User's comments (Algolia)
    ├── threads-{ts}.json                 # Comment threads (HN Web)
    ├── favorites-{ts}.json               # Favorited items (HN Web)
    ├── upvoted-{ts}.json                 # Upvoted items (HN Web)
    └── hidden-{ts}.json                  # Hidden items (HN Web)
```

## Session expiry

HN session cookies can expire. If authenticated commands fail, re-run auth:

```bash
node scripts/hackernews-user.mjs auth
```

Public commands (`about`, `posts`, `comments`) never need auth and always work.
