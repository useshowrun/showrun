---
name: hackernews-stories
description: "Browse Hacker News feeds, view posts with comment trees, vote, favorite, comment, and submit stories."
---

# hackernews-stories

Browse Hacker News feeds, view posts with comment trees, vote, favorite, comment, and submit stories.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)

## Setup
No setup required for read-only commands. Feed browsing and viewing use public APIs (Firebase + Algolia).

To enable authenticated actions (vote, fave, comment, submit), extract HN session cookies from Chrome:
```bash
node hackernews-stories.mjs auth
```

## Usage

### Browse feeds
```bash
# Top stories (default 20 items)
node hackernews-stories.mjs top

# Limit and paginate
node hackernews-stories.mjs top --limit=10
node hackernews-stories.mjs top --offset=20 --limit=10

# Newest stories
node hackernews-stories.mjs new --limit=15

# Best stories (all-time)
node hackernews-stories.mjs best

# Ask HN posts
node hackernews-stories.mjs ask --limit=5

# Show HN posts
node hackernews-stories.mjs show

# Job postings
node hackernews-stories.mjs jobs --limit=10
```

### View a post with comments
```bash
# View post + comment tree (default 3 levels deep)
node hackernews-stories.mjs view 47530330

# Deeper comment tree
node hackernews-stories.mjs view 47530330 --depth=5
```

### Vote on an item
```bash
# Upvote
node hackernews-stories.mjs vote 47530330 up

# Remove vote
node hackernews-stories.mjs vote 47530330 un

# Downvote (requires high karma)
node hackernews-stories.mjs vote 47530330 down
```

### Favorite
```bash
# Favorite an item
node hackernews-stories.mjs fave 47530330

# Unfavorite
node hackernews-stories.mjs fave 47530330 --un
```

### Comment
```bash
# Comment on a story
node hackernews-stories.mjs comment 47530330 "Great article, thanks for sharing!"

# Reply to a comment (same command, use the comment's ID)
node hackernews-stories.mjs comment 47530445 "I agree with your point about..."
```

### Submit a story
```bash
# Submit a link
node hackernews-stories.mjs submit "My Open Source Project" --url=https://example.com

# Submit a text post (Ask HN, etc.)
node hackernews-stories.mjs submit "Ask HN: What tools do you use?" --text="I'm curious about..."
```

## How it works

1. **auth** -- Uses CDP to extract cookies from an open HN browser tab. Saves session cookie and username to disk. Required only for vote, fave, comment, and submit.
2. **top / new / best / ask / show / jobs** -- Calls Firebase `GET /v0/{endpoint}.json` to get an array of item IDs, then batch-fetches item details (10 concurrently) using `GET /v0/item/{id}.json`. Uses `--offset` and `--limit` to paginate through the full ID array. Jobs may not have score or descendants and display "N/A" instead.
3. **view** -- Calls Algolia `GET /api/v1/items/{id}` which returns the full item with a nested `children` array (the entire comment tree in one request). Renders comments recursively with indentation, up to `--depth` levels.
4. **vote** -- Scrapes the auth token from the item's HTML page (the token is in the vote link href), then calls `GET /vote?id={id}&how={direction}&auth={token}`. Downvoting requires high karma.
5. **fave** -- Scrapes the auth token from the item's HTML page, then calls `GET /fave?id={id}&auth={token}` (append `&un=t` to unfavorite).
6. **comment** -- Scrapes the hmac token from the item page (`/item?id={id}`) for story comments, or from the reply page (`/reply?id={id}`) for comment replies. POSTs to `/comment` with `parent`, `hmac`, `text`, and `goto`. Uses `redirect: 'manual'` to detect 302 success.
7. **submit** -- Scrapes the fnid token from the `/submit` page (tokens expire quickly). POSTs to `/r` with `fnid`, `fnop=submit-page`, `title`, `url`, and `text`. Only one of `url` or `text` should be provided.

## Data storage
```
~/.local/share/showrun/data/hackernews-stories/
  session.json                              # Auth cookies
  cache/
    top-<offset>-<ts>.json                  # Cached top stories
    new-<offset>-<ts>.json                  # Cached new stories
    best-<offset>-<ts>.json                 # Cached best stories
    ask-<offset>-<ts>.json                  # Cached ask stories
    show-<offset>-<ts>.json                 # Cached show stories
    job-<offset>-<ts>.json                  # Cached job postings
    item-<id>-<ts>.json                     # Cached item views
```

## Session expiry
HN session cookies typically last a few days. Re-run auth if commands fail:
```bash
node hackernews-stories.mjs auth
```
