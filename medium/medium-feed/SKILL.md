# medium-feed

Fetch a list of Medium posts by tag, author username, or publication.

## Usage

```bash
node medium-feed/scripts/medium-feed.mjs <tag-or-username> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<tag-or-username>` | Tag name, `@username`, or publication domain (required) |

**Auto-detection rules:**
- Starts with `@` → author feed
- Contains `.` → publication feed
- Otherwise → tag feed

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--type tag\|author\|publication` | auto | Force feed type |
| `--max <N>` | 10 | Max posts to return |
| `--no-enrich` | false | Skip GraphQL enrichment (faster, no claps/responses) |

## Examples

```bash
# Posts tagged "javascript"
node medium-feed/scripts/medium-feed.mjs javascript

# Posts tagged "artificial-intelligence", max 5
node medium-feed/scripts/medium-feed.mjs artificial-intelligence --max 5

# Author's posts
node medium-feed/scripts/medium-feed.mjs @towardsdatascience

# Author by name (no @ prefix, force type)
node medium-feed/scripts/medium-feed.mjs towardsdatascience --type author

# Publication feed
node medium-feed/scripts/medium-feed.mjs towardsdatascience.medium.com --type publication

# Fast (no claps/metadata enrichment)
node medium-feed/scripts/medium-feed.mjs javascript --no-enrich
```

## Output Format

```json
{
  "query": "javascript",
  "type": "tag",
  "feedTitle": "JavaScript on Medium",
  "feedDescription": "Latest stories tagged with JavaScript on Medium",
  "rssUrl": "https://medium.com/feed/tag/javascript",
  "total": 10,
  "enriched": true,
  "posts": [
    {
      "postId": "1a7cf81e911b",
      "title": "My Article Title",
      "subtitle": "A subtitle",
      "url": "https://medium.com/@user/my-article-1a7cf81e911b",
      "publishedAt": "2026-03-22T19:53:13.865Z",
      "updatedAt": "2026-03-22T19:53:13.865Z",
      "author": {
        "name": "Author Name",
        "username": "authorhandle",
        "bio": "Short bio",
        "avatarUrl": "https://miro.medium.com/v2/resize:fill:96:96/...",
        "url": "https://medium.com/@authorhandle",
        "followerCount": 1234
      },
      "publication": {
        "id": "abc123",
        "name": "Towards Data Science",
        "slug": "data-science",
        "description": "...",
        "url": "https://medium.com/data-science"
      },
      "claps": 125,
      "voters": 25,
      "responses": 4,
      "readingTime": 4,
      "wordCount": 1016,
      "tags": [
        { "id": "javascript", "name": "JavaScript" },
        { "id": "programming", "name": "Programming" }
      ],
      "excerpt": "First 300 characters of post content…",
      "coverImageUrl": "https://miro.medium.com/v2/resize:fit:1200/...",
      "isPaywalled": false
    }
  ]
}
```

## Notes

- **RSS limitation**: Medium RSS feeds return the latest ~10 posts; no pagination
- **Enrichment**: GraphQL calls add claps, voter count, responses count, author bio/avatar
- **Tags**: from GraphQL (display names); falls back to RSS `<category>` slugs
- **Author RSS**: returns `content:encoded` with full HTML for free posts
- **Tag RSS**: returns snippet only (no full HTML)
- **Nonexistent tag/author**: returns `total: 0, posts: []` with a note
