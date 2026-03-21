# Reddit Search Scraper

Searches Reddit for posts matching a query, optionally restricted to a specific subreddit.

## Usage

```bash
node reddit-search/scripts/reddit-search.mjs <query> [subreddit] [sort] [limit] [time]
```

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `query` | (required) | Search query string |
| `subreddit` | (optional) | Restrict search to this subreddit (e.g. `technology`) |
| `sort` | `relevance` | Sort: `relevance`, `hot`, `top`, `new`, `comments` |
| `limit` | `25` | Number of results (1-100) |
| `time` | `all` | Time filter: `hour`, `day`, `week`, `month`, `year`, `all` |

### Examples

```bash
# Global search for "artificial intelligence"
node reddit-search/scripts/reddit-search.mjs "artificial intelligence"

# Search r/programming for "rust language"
node reddit-search/scripts/reddit-search.mjs "rust language" programming

# Top posts about "machine learning" from past month
node reddit-search/scripts/reddit-search.mjs "machine learning" "" top 50 month
```

## Output (RESULT:{json})

```json
{
  "query": "artificial intelligence",
  "subreddit": null,
  "sort": "relevance",
  "limit": 25,
  "time": "all",
  "count": 25,
  "after": "t3_abc123",
  "results": [
    {
      "id": "abc123",
      "title": "Post title",
      "author": "username",
      "subreddit": "technology",
      "score": 45231,
      "numComments": 1203,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "url": "https://example.com/article",
      "permalink": "https://www.reddit.com/r/technology/comments/abc123/..."
    }
  ]
}
```

## Notes

- Uses Reddit's search JSON API via browser automation
- Empty subreddit string "" means global search
- Sort by `relevance` uses Reddit's ranking algorithm
- Sort by `comments` finds most-discussed posts
