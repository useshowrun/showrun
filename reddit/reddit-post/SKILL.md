# Reddit Post Scraper

Scrapes a Reddit post along with its comments using Reddit's internal JSON API.

## Usage

```bash
node reddit-post/scripts/reddit-post.mjs <post_url_or_id> [commentLimit] [commentSort]
```

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `post_url_or_id` | (required) | Full post URL or just the post ID (e.g. `abc123`) |
| `commentLimit` | `100` | Max number of comments to fetch (1-500) |
| `commentSort` | `top` | Comment sort: `top`, `best`, `new`, `controversial`, `old`, `qa` |

### Examples

```bash
# Fetch post by URL
node reddit-post/scripts/reddit-post.mjs https://www.reddit.com/r/technology/comments/abc123/post_title/

# Fetch post by ID only
node reddit-post/scripts/reddit-post.mjs abc123

# Fetch with 200 newest comments
node reddit-post/scripts/reddit-post.mjs abc123 200 new
```

## Output (RESULT:{json})

```json
{
  "post": {
    "id": "abc123",
    "title": "Post title",
    "author": "username",
    "subreddit": "technology",
    "score": 45231,
    "upvoteRatio": 0.97,
    "numComments": 1203,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "selfText": "Post body text if any...",
    "url": "https://example.com/article",
    "permalink": "https://www.reddit.com/r/technology/comments/abc123/..."
  },
  "commentCount": 100,
  "commentSort": "top",
  "comments": [
    {
      "id": "xyz789",
      "author": "commenter",
      "body": "Comment text",
      "score": 234,
      "createdAt": "2024-01-15T11:00:00.000Z",
      "depth": 0,
      "replies": [...]
    }
  ]
}
```

## Notes

- Fetches the post JSON from Reddit's `/.json` endpoint
- Comments are returned as a tree (nested replies)
- "Load more" placeholders are excluded (top-level comments only)
