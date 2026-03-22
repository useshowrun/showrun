# Product Hunt Search Scraper

Search Product Hunt for products by keyword using browser automation. Returns rich product data including vote counts, descriptions, topics, and maker info by intercepting the site's internal GraphQL API responses.

## Prerequisites

### Node.js 22+
Check with `node --version`

### Install Dependencies
```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/product-hunt
npm install
```

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/product-hunt

# Basic search
node producthunt-search/scripts/producthunt-search.mjs "AI coding tools"

# Search with options
node producthunt-search/scripts/producthunt-search.mjs "password manager" --max 10
node producthunt-search/scripts/producthunt-search.mjs "productivity" --sort popular --max 30
node producthunt-search/scripts/producthunt-search.mjs "developer tools" --sort newest --max 20
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `<query>` | (required) | Search keyword or phrase |
| `--max <N>` | 20 | Max products to return (max 100) |
| `--sort <sort>` | `relevance` | Sort order: `relevance`, `newest`, `popular` |

## Output Format

```json
{
  "query": "AI coding tools",
  "sort": "relevance",
  "totalFound": 48,
  "returned": 20,
  "products": [
    {
      "id": "1103401",
      "name": "Contral",
      "tagline": "The agentic IDE which teaches while you build.",
      "description": "Full product description...",
      "slug": "contral",
      "url": "https://www.producthunt.com/posts/contral",
      "websiteUrl": "https://contral.dev",
      "votesCount": 342,
      "commentsCount": 45,
      "reviewsCount": 12,
      "reviewsRating": 4.5,
      "createdAt": "2026-03-20T13:40:44.000Z",
      "featuredAt": "2026-03-20T00:00:00.000Z",
      "thumbnail": "https://ph-files.imgix.net/...",
      "topics": ["Developer Tools", "Artificial Intelligence"],
      "makers": [
        {
          "id": "1234",
          "name": "Samagra Gune",
          "username": "samagra_gune",
          "headline": "Building things"
        }
      ],
      "hunter": {
        "id": "5678",
        "name": "John Doe",
        "username": "johndoe"
      }
    }
  ],
  "scrapedAt": "2026-03-22T01:30:00.000Z"
}
```

## Data Schema

| Field | Description |
|-------|-------------|
| `id` | Product Hunt post ID |
| `name` | Product name |
| `tagline` | Short one-line description |
| `description` | Full product description (may be null) |
| `slug` | URL slug for the product |
| `url` | Link to the product page on Product Hunt |
| `websiteUrl` | External product website URL |
| `votesCount` | Number of upvotes |
| `commentsCount` | Number of comments |
| `reviewsCount` | Number of reviews |
| `reviewsRating` | Average review rating (0–5) |
| `createdAt` | ISO timestamp of product submission |
| `featuredAt` | ISO timestamp when featured (null if not featured) |
| `thumbnail` | Thumbnail image URL |
| `topics` | Array of topic/category names |
| `makers` | Array of makers (builders) with id, name, username |
| `hunter` | Person who submitted/hunted the product |

## Technical Notes

- **Browser required** — Product Hunt uses Cloudflare protection; a real browser session via camoufox-js is needed
- **XHR interception** — captures the site's internal GraphQL API responses for structured data
- **Fallback DOM scraping** — if GraphQL responses aren't captured, falls back to DOM parsing using stable `data-test` attributes
- **No official API key needed** — uses the site's public-facing data
- **Cloudflare bypass** — camoufox-js fingerprints Firefox to bypass bot detection

## Auth Requirements

None — accesses public product listing data only.

## Rate Limits

Use responsibly. Product Hunt does not publish rate limits for browser-based access. For high-volume use, add delays between requests (recommended: 5+ seconds per page).
