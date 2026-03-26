# reddit-search

Search Reddit posts, comments, subreddits, and users from the terminal.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)

## Setup
Auth is optional. All search endpoints work anonymously. To enable personalized results:
```bash
node reddit-search.mjs auth
```
Extracts session cookies from an open Reddit tab in Chrome.

## Usage

### Search posts
```bash
# Basic post search
node reddit-search.mjs posts javascript

# Top posts from this week
node reddit-search.mjs posts "machine learning" --sort=top --time=week

# Search within a subreddit
node reddit-search.mjs posts rust --sub=programming --limit=10

# Paginate results
node reddit-search.mjs posts python --after=t3_abc123
```

### Search comments
```bash
# Search comment text
node reddit-search.mjs comments "best framework"

# Top comments from the past month
node reddit-search.mjs comments "type system" --sort=top --time=month

# Comments within a specific subreddit
node reddit-search.mjs comments "recommend" --sub=books --limit=15
```

### Search subreddits
```bash
# Find subreddits by topic
node reddit-search.mjs subreddits cooking

# More results
node reddit-search.mjs subreddits finance --limit=50
```

### Search users
```bash
# Find users by name
node reddit-search.mjs users spez

# Paginate user results
node reddit-search.mjs users admin --limit=10 --after=t2_xyz
```

### Search everything
```bash
# Combined search across posts, comments, subreddits, and users (5 per type)
node reddit-search.mjs all "climate change"
```

### Subreddit autocomplete
```bash
# Quick subreddit name completion
node reddit-search.mjs autocomplete prog
```

## How it works

1. **auth** -- Uses CDP to extract cookies from a Reddit browser tab. Saves session cookie and CSRF token to disk. Optional; all searches work without auth.
2. **posts** -- Calls `GET /search.json?type=link` with query, sort, time range, and limit. Returns title, author, subreddit, score, comment count, date, permalink, URL, and selftext preview. Supports `--sub` to restrict to a subreddit.
3. **comments** -- Calls `GET /search.json?type=comment` with query, sort, time range, and limit. Returns body preview, author, subreddit, score, parent post title, and date.
4. **subreddits** -- Calls `GET /search.json?type=sr` with query and limit. Returns subreddit name, subscriber count, description, and creation date.
5. **users** -- Calls `GET /search.json?type=user` with query and limit. Returns username, link karma, comment karma, and creation date.
6. **all** -- Runs posts, comments, subreddits, and users searches sequentially with limit=5 each. Shows a combined summary.
7. **autocomplete** -- Calls `GET /api/subreddit_autocomplete_v2.json` for quick subreddit name completion.

## Data storage
```
~/.local/share/showrun/data/reddit-search/
  session.json                              # Auth cookies (optional)
  cache/
    search-posts-<slug>-<ts>.json           # Cached post results
    search-comments-<slug>-<ts>.json        # Cached comment results
    search-subreddits-<slug>-<ts>.json      # Cached subreddit results
    search-users-<slug>-<ts>.json           # Cached user results
    autocomplete-<slug>-<ts>.json           # Cached autocomplete results
```

## Session expiry
Sessions last days to weeks depending on Reddit's cookie rotation. If you get auth errors or want fresh personalized results, re-run:
```bash
node reddit-search.mjs auth
```
