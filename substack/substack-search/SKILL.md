# substack-search

Search for Substack publications or posts matching a query.

## Usage

```bash
node substack-search/scripts/substack-search.mjs <query> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<query>` | Search term (required) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--mode <mode>` | `publications` | Search mode: `publications` or `posts` |
| `--publication <pub>` | (none) | For `posts` mode: limit to specific publication |
| `--max <N>` | 20 | Max results |

## Examples

```bash
# Search for publications about technology
node substack-search/scripts/substack-search.mjs "technology" --mode publications

# Search for AI-related publications
node substack-search/scripts/substack-search.mjs "artificial intelligence" --mode publications --max 10

# Search posts within a specific publication
node substack-search/scripts/substack-search.mjs "AI" --mode posts --publication simonwillison

# Search posts in Astral Codex Ten
node substack-search/scripts/substack-search.mjs "prediction markets" --mode posts --publication astralcodexten.substack.com --max 15
```

## Output Format

### Publications mode
```json
{
  "query": "technology",
  "mode": "publications",
  "total_results": 10,
  "publications": [
    {
      "name": "Import AI",
      "subdomain": "importai",
      "custom_domain": null,
      "description": "Weekly AI news...",
      "url": "https://importai.substack.com",
      "author_name": "Jack Clark",
      "author_handle": "jackclarkSF",
      "author_photo": "https://...",
      "logo_url": null,
      "subscriber_count": 50000,
      "category": "Technology"
    }
  ]
}
```

### Posts mode
```json
{
  "query": "AI safety",
  "mode": "posts",
  "publication": "simonwillison",
  "base_url": "https://simonwillison.substack.com",
  "total_results": 5,
  "posts": [
    {
      "id": 123456,
      "slug": "...",
      "title": "...",
      "canonical_url": "...",
      "post_date": "2026-01-15T00:00:00.000Z",
      "type": "newsletter",
      "is_paid": false,
      "reaction_count": 20,
      "comment_count": 8
    }
  ]
}
```

## Notes

- **Publications search**: Uses `https://substack.com/api/v1/search?q=<query>`. May return limited results if the Substack search API requires browser session. Falls back to leaderboard-based matching.
- **Posts search**: Paginates through a publication's post list and matches titles, subtitles, body text, and tags. Always works (no auth needed).
- **Best practice**: Use `--mode posts --publication <pub>` for reliable results within a known publication.
