# E-Commerce Agent Browser Skills

Scrape product data from Amazon (search results and product details).
No API key or login required for public product pages.

## Prerequisites

### Node.js 24 (nvm)
Run with: `/home/karacasoft/.nvm/versions/node/v24.13.1/bin/node`

### Install Dependencies
```bash
cd ecommerce && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [amazon-product](amazon-product/SKILL.md) | `amazon-product/scripts/amazon-product.mjs` | Full product details by ASIN or URL |
| [amazon-search](amazon-search/SKILL.md) | `amazon-search/scripts/amazon-search.mjs` | Search Amazon for products |

## Typical Workflow

```bash
# 1. Search for products
node amazon-search/scripts/amazon-search.mjs "wireless headphones" 10

# 2. Get full details for each ASIN
node amazon-product/scripts/amazon-product.mjs B0CRMZHDG8 --reviews
```

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

## Supported Amazon Domains

| Country Code | Domain |
|-------------|--------|
| US | amazon.com |
| UK | amazon.co.uk |
| DE | amazon.de |
| FR | amazon.fr |
| JP | amazon.co.jp |
| IN | amazon.in |
| CA | amazon.ca |
| AU | amazon.com.au |
| IT | amazon.it |
| ES | amazon.es |
| MX | amazon.com.mx |
| BR | amazon.com.br |

## Data Available

### amazon-product
- `asin`, `title`, `brand`, `url`, `country`, `domain`
- `priceRaw`, `price { amount, currency }`, `originalPrice`, `discountPercent`
- `rating`, `reviewCount`
- `availability`, `inStock`
- `images[]` — with dimensions and high-res URLs
- `features[]` — bullet points
- `description` — product description text
- `specifications{}` — key/value technical specs
- `categories[]` — breadcrumb categories
- `bestSellersRank[]` — BSR in category
- `variants[]` — color/size variants with ASINs
- `soldBy`, `soldByAmazon`
- `reviews[]` — customer reviews (with `--reviews` flag)

### amazon-search
- `query`, `country`, `domain`, `sort`, `totalText`, `count`
- `results[]`:
  - `asin`, `title`, `url`
  - `priceRaw`, `price`, `originalPrice`
  - `rating`, `reviewCount`
  - `thumbnailUrl`, `imageUrl`
  - `isPrime`, `isSponsored`, `deliveryInfo`

## Anti-Bot Strategy

Amazon uses strong bot detection, but camoufox (fingerprinted Firefox) is effective:
- Randomized fingerprint (OS, fonts, canvas, WebGL, screen size)
- Firefox engine (not Chromium) — less commonly flagged
- humanize parameter adds natural timing
- No CSS class name selectors — all data from:
  - `data-asin` attributes (stable product identifiers)
  - `aria-label` on star ratings (accessibility-stable)
  - `.a-offscreen` price spans (screen-reader accessible prices)
  - `data-a-dynamic-image` JSON for image URLs

If bot detection triggers:
1. Wait 5-10 minutes before retry
2. Try from a different IP/VPN
3. For high-volume scraping, consider Amazon Product Advertising API
