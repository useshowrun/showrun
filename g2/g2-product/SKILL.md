# g2-product

Get full product details + reviews from G2.com by product slug or URL.

## Usage

```bash
node scripts/g2-product.mjs <product-slug-or-url> [--max-reviews N]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<product-slug-or-url>` | Yes | Slug (e.g. `salesforce-sales-cloud`) or full G2 URL |
| `--max-reviews N` | No | Maximum reviews to collect (default: 20) |

## Examples

```bash
node scripts/g2-product.mjs salesforce-sales-cloud
node scripts/g2-product.mjs slack --max-reviews 50
node scripts/g2-product.mjs "https://www.g2.com/products/zoom/reviews"
node scripts/g2-product.mjs invalid-slug-xyz  # Returns clean error
```

## Output

```json
{
  "product": {
    "name": "Slack",
    "slug": "slack",
    "url": "https://www.g2.com/products/slack/reviews",
    "logoUrl": "https://...",
    "rating": 4.5,
    "reviewCount": 33156,
    "category": "Business Instant Messaging",
    "categories": ["Business Instant Messaging", "Team Collaboration"],
    "shortDescription": "...",
    "longDescription": "...",
    "pricingInfo": "freemium",
    "features": ["File Sharing", "Search", "Integrations"],
    "integrations": ["Google Drive", "GitHub", "Zoom"],
    "alternatives": ["microsoft-teams", "zoom"],
    "websiteUrl": "https://slack.com"
  },
  "reviews": [
    {
      "id": "review_abc123",
      "title": "Best team communication tool",
      "rating": 5,
      "pros": "...",
      "cons": "...",
      "body": "...",
      "date": "2024-03-15T00:00:00Z",
      "helpfulCount": 12,
      "verified": true,
      "reviewer": {
        "name": "John D.",
        "title": "Software Engineer",
        "companySize": "11-50",
        "industry": "Computer Software",
        "company": "Acme Corp"
      }
    }
  ],
  "reviewsUrl": "https://www.g2.com/products/slack/reviews",
  "pagesScraped": 1
}
```

## Data Sources

1. `window.gon` — G2's server-side data (product + reviews)
2. JSON-LD — `SoftwareApplication` schema (fallback)
3. XHR interception — review pagination AJAX
4. DOM — `data-*` attributes, `aria-label`, `itemprop` (fallback)

## Anti-Bot Notes

G2 uses Cloudflare. camoufox-js typically bypasses it.
Set `SOCKS5_PROXY=host:port` for residential proxy if blocked.
