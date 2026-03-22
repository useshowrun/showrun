# amazon-product — Amazon Product Scraper

Fetches full product details from an Amazon product page by ASIN or URL.
No login required for public products.

## Usage

```bash
node amazon-product/scripts/amazon-product.mjs <asin|url> [--reviews] [--country US|UK|DE|...]
```

## Examples

```bash
# By ASIN
node amazon-product/scripts/amazon-product.mjs B0CRMZHDG8

# By URL
node amazon-product/scripts/amazon-product.mjs "https://www.amazon.com/dp/B0CRMZHDG8"

# With reviews
node amazon-product/scripts/amazon-product.mjs B0CRMZHDG8 --reviews

# UK Amazon
node amazon-product/scripts/amazon-product.mjs B0CRMZHDG8 --country UK
```

## Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `<asin\|url>` | string | ✅ | ASIN (e.g. B0CRMZHDG8) or full Amazon URL |
| `--reviews` | flag | ❌ | Also scrape first page of customer reviews |
| `--country` | string | ❌ | Amazon domain: US, UK, DE, FR, JP, IN, CA, AU, MX, BR, IT, ES (default: US) |

## Output

```json
{
  "asin": "B0CRMZHDG8",
  "title": "Product Name",
  "brand": "Brand Name",
  "url": "https://www.amazon.com/dp/B0CRMZHDG8",
  "country": "US",
  "domain": "amazon.com",
  "priceRaw": "$24.99",
  "price": { "amount": 24.99, "currency": "USD", "raw": "$24.99" },
  "originalPriceRaw": "$34.99",
  "originalPrice": { "amount": 34.99, "currency": "USD", "raw": "$34.99" },
  "discountPercent": 28,
  "rating": 4.5,
  "reviewCount": 12543,
  "availability": "In Stock",
  "inStock": true,
  "images": [
    { "url": "https://m.media-amazon.com/...", "width": 1500, "height": 1500 }
  ],
  "features": [
    "Feature 1 from bullet points",
    "Feature 2"
  ],
  "description": "Full product description text",
  "specifications": {
    "Brand": "BrandName",
    "Item Weight": "1.5 pounds",
    "Dimensions": "10 x 5 x 3 inches"
  },
  "categories": ["Electronics", "Headphones"],
  "bestSellersRank": ["#1 in Wireless Headphones"],
  "variants": [
    { "title": "Black", "asin": "B0CRMZHDG8" },
    { "title": "White", "asin": "B0CRMZHDG9" }
  ],
  "soldBy": "Amazon.com",
  "soldByAmazon": true,
  "packageQuantity": null,
  "reviews": [...]  // only if --reviews flag is set
}
```

## Review Object (--reviews)

```json
{
  "reviewId": "R1ABCDEFGH",
  "reviewerName": "John D.",
  "rating": 5.0,
  "title": "Great product!",
  "date": "Reviewed in the United States on January 1, 2025",
  "verifiedPurchase": true,
  "body": "Full review text here...",
  "helpfulVotes": "42 people found this helpful"
}
```

## Anti-Bot Notes

Amazon has strong bot detection. camoufox (fingerprinted Firefox) bypasses most checks.
- If `BOT_DETECTED` error: wait 5-10 minutes and retry from a different IP
- Rate limit: avoid requesting the same product repeatedly
- Images may expire after a few hours (re-scrape to get fresh URLs)
