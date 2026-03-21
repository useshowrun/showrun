# Reddit Subreddit Scraper

Scrapes posts from any subreddit using Reddit's internal JSON API via browser automation.
No login required for public subreddits. NSFW subreddits may require login.

## Usage

```bash
node reddit-subreddit/scripts/reddit-subreddit.mjs <subreddit> [sort] [limit] [time]
```

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `subreddit` | (required) | Subreddit name (with or without r/) |
| `sort` | `hot` | Sort: `hot`, `new`, `top`, `rising`, `controversial` |
| `limit` | `25` | Number of posts (1-100) |
| `time` | `day` | Time filter for `top`/`controversial`: `hour`, `day`, `week`, `month`, `year`, `all` |

### Examples

```bash
# Top 25 hot posts from r/technology
node reddit-subreddit/scripts/reddit-subreddit.mjs technology

# Top 50 newest posts from r/worldnews
node reddit-subreddit/scripts/reddit-subreddit.mjs worldnews new 50

# Top 100 all-time posts from r/programming
node reddit-subreddit/scripts/reddit-subreddit.mjs programming top 100 all
```

## Output (RESULT:{json})

```json
{
  "subreddit": "technology",
  "sort": "hot",
  "limit": 25,
  "count": 25,
  "after": "t3_abc123",
  "posts": [
    {
      "id": "abc123",
      "fullname": "t3_abc123",
      "url": "https://example.com/article",
      "permalink": "https://www.reddit.com/r/technology/comments/abc123/...",
      "title": "Post title here",
      "author": "username",
      "subreddit": "technology",
      "flair": "AI",
      "score": 45231,
      "upvoteRatio": 0.97,
      "numComments": 1203,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "isVideo": false,
      "isSelf": false,
      "domain": "example.com",
      "thumbnail": "https://...",
      "media": null,
      "awards": 3
    }
  ]
}
```

## Notes

- Uses Reddit's `/.json` endpoint by intercepting XHR responses — bypasses bot detection
- Rate limit: Reddit allows ~60 req/min for unauthenticated requests
- For pagination, use the `after` field from the response
