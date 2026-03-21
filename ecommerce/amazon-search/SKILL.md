# amazon-search — Amazon Product Search

Searches Amazon for products by keyword and returns paginated results.
No login required.

## Usage

```bash
node amazon-search/scripts/amazon-search.mjs <query> [maxResults] [options]
```

## Examples

```bash
# Simple search
node amazon-search/scripts/amazon-search.mjs "wireless headphones" 20

# UK Amazon, sorted by reviews
node amazon-search/scripts/amazon-search.mjs "coffee maker" 10 --country UK --sort review-rank

# Second page of results
node amazon-search/scripts/amazon-search.mjs "laptop stand" 20 --page 2

# Price sorted low to high
node amazon-search/scripts/amazon-search.mjs "running shoes" 30 --sort price-asc-rank
```

## Arguments

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `<query>` | string | ✅ | — | Search keyword(s) |
| `[maxResults]` | number | ❌ | 20 | Max products to collect (paginates automatically) |
| `--page N` | number | ❌ | 1 | Start at page N |
| `--sort` | string | ❌ | relevanceblender | Sort order (see table below) |
| `--country` | string | ❌ | US | Amazon domain country code |

### Sort Options

| Value | Description |
|-------|-------------|
| `relevanceblender` | Relevance (default) |
| `price-asc-rank` | Price: Low to High |
| `price-desc-rank` | Price: High to Low |
| `review-rank` | Avg. Customer Review |
| `date-desc-rank` | Newest Arrivals |
| `featured` | Featured |

### Country Codes

US, UK, DE, FR, JP, IN, CA, AU, MX, BR, IT, ES

## Output

```json
{
  "query": "wireless headphones",
  "country": "US",
  "domain": "amazon.com",
  "sort": "relevanceblender",
  "startPage": 1,
  "endPage": 2,
  "totalText": "1-48 of over 50,000 results",
  "count": 20,
  "results": [
    {
      "asin": "B0CRMZHDG8",
      "title": "Sony WH-1000XM5 Wireless Headphones",
      "url": "https://www.amazon.com/dp/B0CRMZHDG8/...",
      "priceRaw": "$279.99",
      "price": { "amount": 279.99, "currency": "USD", "raw": "$279.99" },
      "originalPriceRaw": "$349.99",
      "originalPrice": { "amount": 349.99, "currency": "USD", "raw": "$349.99" },
      "rating": 4.6,
      "reviewCount": 45230,
      "thumbnailUrl": "https://m.media-amazon.com/images/...",
      "imageUrl": "https://m.media-amazon.com/images/...",
      "isPrime": true,
      "isSponsored": false,
      "deliveryInfo": "FREE delivery Tuesday, Jan 14"
    }
  ]
}
```

## Anti-Bot Notes

Amazon search is harder to scrape than product pages.
- camoufox fingerprinted Firefox is required
- If `BOT_DETECTED`: wait and retry from different IP
- Sponsored results are included but flagged as `isSponsored: true`
- For full product details (specs, images, reviews), use `amazon-product` on each ASIN
