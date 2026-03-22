# substack-posts

Fetch posts from a Substack publication using the public REST API.

## Usage

```bash
node substack-posts/scripts/substack-posts.mjs <publication> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<publication>` | Publication slug, subdomain, or full domain (required) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--max <N>` | 20 | Maximum posts to fetch |
| `--offset <N>` | 0 | Pagination offset |
| `--type <type>` | (all) | Filter by type: `newsletter`, `podcast`, `thread`, `video` |
| `--free-only` | false | Only return free/public posts |
| `--include-body` | false | Include full HTML body (free posts only; large!) |
| `--publication-info` | false | Include publication metadata in output |

### Publication Input Formats

All of these are equivalent for Simon Willison's newsletter:
- `simonwillison` (slug only)
- `simonwillison.substack.com` (full subdomain)

Custom domain example:
- `platformer.news` (custom domain — API still works!)
- `astralcodexten.substack.com` (or `www.astralcodexten.com` for the custom domain)

## Examples

```bash
# Basic: 10 posts from Simon Willison's newsletter
node substack-posts/scripts/substack-posts.mjs simonwillison --max 10

# Custom domain
node substack-posts/scripts/substack-posts.mjs platformer.news --max 5

# Filter by type
node substack-posts/scripts/substack-posts.mjs astralcodexten.substack.com --type newsletter --max 20

# Free posts only, with publication info
node substack-posts/scripts/substack-posts.mjs simonwillison --free-only --publication-info

# Pagination
node substack-posts/scripts/substack-posts.mjs simonwillison --offset 20 --max 20

# Podcast posts only
node substack-posts/scripts/substack-posts.mjs darknetdiaries.substack.com --type podcast
```

## Output Format

```json
{
  "publication": "simonwillison",
  "base_url": "https://simonwillison.substack.com",
  "total_fetched": 10,
  "offset": 0,
  "source": "api",
  "filters": {
    "type": null,
    "free_only": false
  },
  "posts": [
    {
      "id": 123456,
      "slug": "post-slug",
      "title": "Post Title",
      "subtitle": "Optional subtitle",
      "type": "newsletter",
      "post_date": "2026-03-01T12:00:00.000Z",
      "canonical_url": "https://simonwillison.substack.com/p/post-slug",
      "is_paid": false,
      "is_free_preview": false,
      "audience": "everyone",
      "reaction_count": 42,
      "comment_count": 15,
      "word_count": 1200,
      "restacks": 5,
      "cover_image": "https://substackcdn.com/...",
      "authors": [
        {
          "name": "Simon Willison",
          "handle": "simonwillison",
          "photo_url": "https://..."
        }
      ],
      "tags": ["AI", "Tools"],
      "audio_url": null,
      "truncated_body": "First few paragraphs...",
      "body_html": null
    }
  ],
  "publication_info": {
    "id": 789,
    "name": "Simon Willison's Weblog",
    "subdomain": "simonwillison",
    "custom_domain": null,
    "description": "Irregular dispatches...",
    "logo_url": null,
    "payments_enabled": false
  }
}
```

## Data Sources

| Source | Method | When Used |
|--------|--------|-----------|
| Substack API `/api/v1/posts` | Pure HTTP GET | Primary (no auth required) |
| RSS Feed `/feed` | Pure HTTP GET, XML parse | Fallback if API fails |

## Notes

- **No auth required** — works for all public publications
- **Custom domains** — the API works on both `*.substack.com` and custom domains
- **Paid content** — `is_paid: true` posts show truncated body only (paywall)
- **body_html** — only populated for free posts when `--include-body` is used
- **Pagination** — Substack API maxes at 25 per request; `--offset` enables manual paging
