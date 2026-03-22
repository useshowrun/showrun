# g2-search

Search G2.com for software products by keyword.

## Usage

```bash
node scripts/g2-search.mjs <query> [--max N] [--category <category>]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<query>` | Yes | Search query (e.g. "CRM software") |
| `--max N` | No | Maximum results to return (default: 10) |
| `--category` | No | Category filter slug |

## Output

```json
{
  "query": "CRM software",
  "category": null,
  "totalFound": 847,
  "products": [
    {
      "name": "Salesforce Sales Cloud",
      "slug": "salesforce-sales-cloud",
      "url": "https://www.g2.com/products/salesforce-sales-cloud/reviews",
      "logoUrl": "https://images.g2crowd.com/uploads/...",
      "rating": 4.3,
      "reviewCount": 24156,
      "category": "CRM",
      "categories": ["CRM", "Sales Force Automation"],
      "shortDescription": "...",
      "pricingInfo": "starts at $25/mo"
    }
  ]
}
```

## Data Sources

1. `window.gon` — G2's server-side data object
2. XHR interception — API responses during page load
3. DOM fallback — `data-*` attributes, aria labels, product links
4. JSON-LD — `ItemList` / `SoftwareApplication` schema

## Anti-Bot Notes

G2 uses Cloudflare. camoufox-js typically bypasses it.
Set `SOCKS5_PROXY=host:port` for residential proxy if blocked.
