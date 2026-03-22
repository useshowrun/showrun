# Product Hunt Daily Products Scraper

Fetches today's (or a specific date's) top products from Product Hunt using the public Atom feed. No authentication or browser required.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/product-hunt

# Today's products (default)
node producthunt-daily/scripts/producthunt-daily.mjs

# Products from a specific date
node producthunt-daily/scripts/producthunt-daily.mjs --date 2026-03-20

# Filter by category/topic
node producthunt-daily/scripts/producthunt-daily.mjs --category ai
node producthunt-daily/scripts/producthunt-daily.mjs --category developer-tools --max 20

# All entries from the feed (no date filter)
node producthunt-daily/scripts/producthunt-daily.mjs --all --max 50
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--date <YYYY-MM-DD>` | today (UTC) | Filter products by publication date |
| `--category <slug>` | (all) | Filter by topic category (e.g. `ai`, `developer-tools`, `productivity`, `design-tools`) |
| `--max <N>` | 50 | Max products to return |
| `--all` | false | Return all feed entries, ignore date filter |

## Known Category Slugs

Product Hunt uses topic slugs as category filters. Some common ones:
- `ai`
- `developer-tools`
- `productivity`
- `design-tools`
- `marketing`
- `social-media`
- `games`
- `health-fitness`

## Output Format

```json
{
  "date": "2026-03-21",
  "category": null,
  "totalFetched": 50,
  "totalFiltered": 12,
  "returned": 12,
  "products": [
    {
      "id": 1103401,
      "title": "Contral",
      "tagline": "The agentic IDE which teaches while you build.",
      "author": "Samagra Gune",
      "productUrl": "https://www.producthunt.com/products/contral",
      "discussionUrl": "https://www.producthunt.com/products/contral",
      "externalUrl": "https://www.producthunt.com/r/p/1103401?app_id=339",
      "publishedAt": "2026-03-20T20:40:44.000Z",
      "updatedAt": "2026-03-22T01:03:33.000Z"
    }
  ],
  "scrapedAt": "2026-03-22T01:30:00.000Z"
}
```

## Data Schema

| Field | Description |
|-------|-------------|
| `id` | Product Hunt post ID (numeric) |
| `title` | Product name |
| `tagline` | Short product description |
| `author` | Maker/hunter name who submitted the product |
| `productUrl` | URL to the product page on Product Hunt |
| `discussionUrl` | URL to the discussion/comments page |
| `externalUrl` | Referral link to the product's external website |
| `publishedAt` | ISO timestamp when the product was first published |
| `updatedAt` | ISO timestamp of last update (vote activity) |

## Technical Notes

- **No authentication needed** — uses the public Atom feed at `producthunt.com/feed`
- **No browser required** — pure HTTPS with Node.js built-ins
- **Feed limit** — the feed returns up to 50 entries at a time, ordered by recent update (vote activity)
- **Vote counts NOT available** in the feed — for vote counts, use the `producthunt-search` scraper which intercepts browser XHR calls
- **Date filtering** is applied client-side on the `publishedAt` field
- Products from the feed may span multiple days due to active voting keeping older products in the feed
- The feed updates throughout the day as products receive votes

## Auth Requirements

None — the Atom feed is fully public.

## Rate Limits

No documented rate limits for the feed. Use reasonable delays for automated polling (e.g., once every few minutes).
