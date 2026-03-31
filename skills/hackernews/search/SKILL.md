# hackernews-search

Search Hacker News stories, comments, authors, and front page via the Algolia HN Search API.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)

## Setup
No setup required. All commands use the public Algolia API and work without authentication.

To optionally extract HN session cookies (for use by other HN tools):
```bash
node hackernews-search.mjs auth
```

## Usage

### Search stories
```bash
# Basic story search (sorted by relevance)
node hackernews-search.mjs stories startup

# Sort by date (newest first)
node hackernews-search.mjs stories "machine learning" --sort=date

# Filter by minimum points
node hackernews-search.mjs stories rust --points=100

# Stories from the past week only
node hackernews-search.mjs stories "open source" --time=week --limit=10

# Paginate results (0-indexed)
node hackernews-search.mjs stories javascript --page=2
```

### Search comments
```bash
# Search comment text
node hackernews-search.mjs comments "best framework"

# Recent comments sorted by date
node hackernews-search.mjs comments "type system" --sort=date --time=month

# High-scoring comments
node hackernews-search.mjs comments "recommend" --points=10 --limit=15
```

### Author activity
```bash
# All activity by a user (newest first)
node hackernews-search.mjs author pg

# Only stories by a user
node hackernews-search.mjs author dang --type=story

# Only comments by a user
node hackernews-search.mjs author tptacek --type=comment --limit=50

# High-scoring submissions
node hackernews-search.mjs author patio11 --points=50
```

### Front page
```bash
# Yesterday's front page (default)
node hackernews-search.mjs front

# Front page for a specific date
node hackernews-search.mjs front 2024-01-15
```

## How it works

1. **auth** -- Uses CDP to extract cookies from an open HN browser tab. Saves session cookie and username to disk. Optional; all search commands work without it.
2. **stories** -- Calls Algolia `GET /search?tags=story` (or `/search_by_date` with `--sort=date`) with query, hitsPerPage, page, and optional numericFilters for points and time range. Returns title, URL, author, points, comment count, date, and objectID.
3. **comments** -- Calls Algolia `GET /search?tags=comment` (or `/search_by_date`) with the same flag set. Returns a 150-character preview of comment text, author, story title, story ID, and date.
4. **author** -- Calls Algolia `GET /search_by_date?tags=author_{name}` with optional story/comment type filter. Returns mixed stories and comments labeled by type, newest first.
5. **front** -- Calls Algolia `GET /search?tags=front_page` with `numericFilters=created_at_i>{start},created_at_i<{end}` for the target date (defaults to yesterday). Returns up to 30 stories that appeared on the front page that day.

## Data storage
```
~/.local/share/showrun/data/hackernews-search/
  session.json                              # Auth cookies (optional)
  cache/
    stories-<slug>-<page>-<ts>.json         # Cached story results
    comments-<slug>-<page>-<ts>.json        # Cached comment results
    author-<name>-<ts>.json                 # Cached author results
    front-<date>-<ts>.json                  # Cached front page results
```

## Session expiry
Auth is optional for this taskpack. If you use `auth` to extract HN cookies for other tools, sessions typically last a few days. Re-run:
```bash
node hackernews-search.mjs auth
```
