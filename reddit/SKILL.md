# Reddit Agent Browser Skills

Scrape Reddit posts, comments, and search results using browser automation (camoufox-js).
Uses Reddit's internal JSON API (`.json` endpoints) via XHR interception — no official API key required.

## Prerequisites

### Node.js 22+
Check with `node --version`

### Install Dependencies
```bash
cd reddit && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Subreddit](reddit-subreddit/SKILL.md) | `reddit-subreddit/scripts/reddit-subreddit.mjs` | Browse posts from any subreddit with sort/filter options |
| [Post](reddit-post/SKILL.md) | `reddit-post/scripts/reddit-post.mjs` | Fetch a post and its comment tree |
| [Search](reddit-search/SKILL.md) | `reddit-search/scripts/reddit-search.mjs` | Search across Reddit or within a subreddit |

## Typical Workflows

### Browse a subreddit
```bash
node reddit-subreddit/scripts/reddit-subreddit.mjs technology hot 25
```

### Get post + comments
```bash
node reddit-post/scripts/reddit-post.mjs https://www.reddit.com/r/technology/comments/abc123/title/
```

### Search Reddit
```bash
node reddit-search/scripts/reddit-search.mjs "artificial intelligence" "" relevance 25 month
```

## How It Works

- Opens the Reddit JSON API URL in a headless camoufox browser
- Reddit serves JSON when `.json` is appended to any listing URL
- The browser intercepts the JSON response and parses it
- No login required for public subreddits (NSFW may be gated)

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

## Rate Limits

Reddit allows ~60 requests/minute for unauthenticated users. For high-volume scraping,
consider adding delays between requests.

## Data Schema

All posts return these common fields:
- `id`, `fullname` — Reddit's internal IDs
- `title`, `author`, `subreddit`
- `score`, `upvoteRatio`, `numComments`
- `createdAt` — ISO timestamp
- `url`, `permalink`
- `selfText` — post body (for text posts)
- `media` — image/video info
- `isVideo`, `isSelf`, `isNsfw`, `isStickied`, `isPinned`
- `awards` — total award count
