---
name: reddit-user
description: "Fetch Reddit user profiles, posts, comments, trophies, and manage account settings from the terminal. All API-based -- no browser needed after initial auth."
---

# reddit-user

Fetch Reddit user profiles, posts, comments, trophies, and manage account settings from the terminal. All API-based -- no browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](../../chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication -- extracts session cookies and obtains a bearer token from an open Reddit tab in Chrome:

```bash
node scripts/reddit-user.mjs auth
```

This saves cookies, CSRF token, and a 24h bearer token to disk. After auth, Chrome is no longer needed. Public commands (`about`, `posts`, `comments`, `trophies`) work without auth.

## Usage

### View a user profile

```bash
node scripts/reddit-user.mjs about spez
node scripts/reddit-user.mjs about some_username
```

Returns: name, total karma (link + comment breakdown), account creation date, verified status, gold status, mod status, icon image, bio.

### Fetch user's posts

```bash
node scripts/reddit-user.mjs posts spez
node scripts/reddit-user.mjs posts spez --sort=top --time=year --limit=10
node scripts/reddit-user.mjs posts spez --after=t3_abc123
```

Flags: `--sort=hot|new|top|controversial`, `--time=hour|day|week|month|year|all`, `--limit=N` (1-100), `--after=cursor`.

Returns: title, subreddit, score, comment count, date, permalink.

### Fetch user's comments

```bash
node scripts/reddit-user.mjs comments spez
node scripts/reddit-user.mjs comments spez --sort=top --time=month --limit=50
```

Same flags as posts. Returns: body preview (150 chars), subreddit, score, parent thread title, date.

### View trophies

```bash
node scripts/reddit-user.mjs trophies spez
```

Returns: trophy name, description, award ID, grant date.

### Current user info

```bash
node scripts/reddit-user.mjs me
```

Requires auth (cookies only, bearer not needed). Returns: name, total karma, inbox count, mail status, coins, gold status, creation date, verified status.

### Karma breakdown

```bash
node scripts/reddit-user.mjs karma
node scripts/reddit-user.mjs karma --limit=50
```

Requires auth with bearer token. Returns: table of subreddits sorted by total karma, showing link and comment karma. Default top 20.

### User preferences

```bash
node scripts/reddit-user.mjs prefs
```

Requires auth with bearer token. Returns: key preferences (over_18, email_messages, default_comment_sort, enable_followers, nightmode, language, etc.).

### Friends list

```bash
node scripts/reddit-user.mjs friends
```

Requires auth with bearer token. Returns: friend usernames with date added.

### Subscribed subreddits

```bash
node scripts/reddit-user.mjs subscriptions
node scripts/reddit-user.mjs subscriptions --limit=100 --after=t5_abc123
```

Requires auth with bearer token. Flags: `--limit=N` (1-100), `--after=cursor`. Returns: subreddit name, subscriber count, URL.

### Saved items

```bash
node scripts/reddit-user.mjs saved
node scripts/reddit-user.mjs saved --limit=50 --after=t3_abc123
```

Requires auth with bearer token. Flags: `--limit=N`, `--after=cursor`. Returns: type (post/comment), title or body preview, subreddit, score.

### Show help

```bash
node scripts/reddit-user.mjs
```

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds an open Reddit tab, extracts all reddit.com cookies using `Network.getCookies`, then POSTs the CSRF token to `/svc/shreddit/token` to obtain a 24h RS256 JWT bearer token. Saves everything to disk.

2. **`about`** -- Calls `GET /user/{name}/about.json?raw_json=1` (public, no auth). Returns `{ kind: "t2", data: {...} }` with the user's full profile.

3. **`posts`** -- Calls `GET /user/{name}/submitted.json` with sort, time, limit, and after parameters. Returns a standard Listing of t3 (post) objects.

4. **`comments`** -- Calls `GET /user/{name}/comments.json` with the same listing parameters. Returns a Listing of t1 (comment) objects.

5. **`trophies`** -- Calls `GET /user/{name}/trophies.json?raw_json=1`. Returns `{ kind: "TrophyList", data: { trophies: [...] } }`.

6. **`me`** -- Calls `GET https://oauth.reddit.com/api/v1/me?raw_json=1` with cookie auth. Returns the authenticated user's full profile.

7. **`karma`** -- Calls `GET https://oauth.reddit.com/api/v1/me/karma?raw_json=1` with bearer token. Returns `{ kind: "KarmaList", data: [...] }` with per-subreddit karma.

8. **`prefs`** -- Calls `GET https://oauth.reddit.com/api/v1/me/prefs?raw_json=1` with bearer token. Returns a flat object of all user preferences.

9. **`friends`** -- Calls `GET https://oauth.reddit.com/api/v1/me/friends?raw_json=1` with bearer token. Returns the friends list with usernames and dates.

10. **`subscriptions`** -- Calls `GET https://oauth.reddit.com/subreddits/mine/subscriber` with bearer token and pagination. Returns a Listing of t5 (subreddit) objects.

11. **`saved`** -- First calls `/api/v1/me` to get the current username, then calls `GET https://oauth.reddit.com/user/{me}/saved.json` with bearer token. Returns a mixed Listing of saved posts and comments.

## Data storage

```
~/.local/share/showrun/data/reddit-user/
├── session.json                        # Cookies, CSRF token, bearer token
└── cache/
    ├── about-{name}.json               # User profile
    ├── posts-{name}-{timestamp}.json   # User's posts
    ├── comments-{name}-{timestamp}.json # User's comments
    ├── trophies-{name}.json            # Trophy case
    ├── me-{timestamp}.json             # Current user info
    ├── karma-{timestamp}.json          # Karma breakdown
    ├── prefs-{timestamp}.json          # User preferences
    ├── friends-{timestamp}.json        # Friends list
    ├── subscriptions-{timestamp}.json  # Subscribed subreddits
    └── saved-{timestamp}.json          # Saved items
```

## Session expiry

The bearer token expires after 24 hours. Cookie sessions last longer but may also expire. If you see `Session expired`, re-run auth:

```bash
node scripts/reddit-user.mjs auth
```

Public commands (`about`, `posts`, `comments`, `trophies`) never need auth and always work.
