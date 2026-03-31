# reddit-posts

Browse Reddit feeds, view posts with comments, vote, save, and comment from the terminal. All API-based -- no browser needed after initial auth.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)

## Setup
```bash
node reddit-posts.mjs auth
```
Extracts session cookies, CSRF token, bearer token, and modhash from an open Reddit tab in Chrome. Feed commands (home, popular, all, sub, view, comments) work without auth.

## Usage

### Browse feeds
```bash
# Homepage feed (hot by default)
node reddit-posts.mjs home

# Top posts from this week
node reddit-posts.mjs home --sort=top --time=week --limit=10

# Popular posts
node reddit-posts.mjs popular --sort=new

# All subreddits combined
node reddit-posts.mjs all --sort=rising

# Specific subreddit
node reddit-posts.mjs sub programming --sort=top --time=month

# Paginate results
node reddit-posts.mjs home --after=t3_abc123

# Best posts (auth required, personalized)
node reddit-posts.mjs best --limit=10
```

### View a post
```bash
# By full URL
node reddit-posts.mjs view https://www.reddit.com/r/node/comments/abc123/some-slug/

# By post ID
node reddit-posts.mjs view abc123

# By fullname
node reddit-posts.mjs view t3_abc123

# With more comment depth
node reddit-posts.mjs view abc123 --depth=5 --sort=top
```

### View comments
```bash
# Just the comment tree (no post body)
node reddit-posts.mjs comments abc123

# Sort by new, limit depth
node reddit-posts.mjs comments abc123 --sort=new --depth=2
```

### Vote
```bash
# Upvote a post
node reddit-posts.mjs vote t3_abc123 up

# Downvote a comment
node reddit-posts.mjs vote t1_def456 down

# Remove vote
node reddit-posts.mjs vote t3_abc123 unvote
```

### Save / unsave
```bash
node reddit-posts.mjs save t3_abc123
node reddit-posts.mjs unsave t3_abc123
```

### Post a comment
```bash
# Reply to a post
node reddit-posts.mjs comment t3_abc123 "Great post, thanks for sharing!"

# Reply to a comment
node reddit-posts.mjs comment t1_def456 "I agree with your point"
```

## How it works

1. **auth** -- Uses CDP to extract cookies, CSRF token, modhash, and bearer token from a Reddit browser tab. Saves session to disk. Required for vote, save, unsave, comment, and best commands.
2. **home** -- Calls `GET /.json` with sort, time, and limit params. Returns post titles, authors, scores, comment counts, and permalinks.
3. **popular** -- Calls `GET /r/popular.json` with same params. Shows trending posts across Reddit.
4. **all** -- Calls `GET /r/all.json`. Shows posts from all subreddits combined.
5. **sub** -- Calls `GET /r/{name}/{sort}.json`. Shows posts from a specific subreddit with sort-specific URL paths.
6. **best** -- Calls `GET https://oauth.reddit.com/best` with bearer token. Returns personalized best posts.
7. **view** -- Calls `GET /comments/{id}.json`. Returns full post info and a recursive comment tree rendered with indentation (configurable depth).
8. **comments** -- Same endpoint as view but only outputs the comment tree.
9. **vote** -- POSTs to `https://oauth.reddit.com/api/vote` with fullname and direction (1, -1, or 0).
10. **save / unsave** -- POSTs to `https://oauth.reddit.com/api/save` or `/api/unsave` with the item fullname.
11. **comment** -- POSTs to `https://oauth.reddit.com/api/comment` with parent fullname and text. Returns the created comment's ID and permalink.

## Data storage
```
~/.local/share/showrun/data/reddit-posts/
  session.json                              # Auth cookies, bearer token, modhash
  cache/
    home-<sort>-<ts>.json                   # Cached homepage results
    popular-<sort>-<ts>.json                # Cached popular results
    all-<sort>-<ts>.json                    # Cached all results
    sub-<name>-<sort>-<ts>.json             # Cached subreddit results
    best-<ts>.json                          # Cached best results
    post-<id>-<ts>.json                     # Cached post + comments
    comments-<id>-<ts>.json                 # Cached comments only
```

## Session expiry
Sessions last days to weeks depending on Reddit's cookie and token rotation. The bearer token may expire sooner than cookies. If you get auth errors, re-run:
```bash
node reddit-posts.mjs auth
```
