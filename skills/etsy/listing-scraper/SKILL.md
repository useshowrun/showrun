# Etsy Listing Scraper

Scrape Etsy product listings, shop profiles, listing details, and customer reviews. Bypasses DataDome bot protection using Camoufox (stealth Firefox).

## Prerequisites

- Node.js v22+
- **camoufox-js** npm package (see Setup below)
  - No other dependencies
  - No API key required
  - No Etsy account required

### Why Camoufox?

Etsy uses **DataDome** bot protection. Direct HTTP requests and plain headless Chromium are blocked with a CAPTCHA interstitial. Camoufox (Firefox-based anti-detect browser) successfully bypasses this protection.

## Setup

### Install camoufox-js

```bash
mkdir -p ~/.local/share/showrun/data/etsy
cd ~/.local/share/showrun/data/etsy
npm init -y && npm install camoufox-js
```

### If camoufox is already installed (e.g., pitchbook skill)

```bash
export CAMOUFOX_PATH=~/.local/share/showrun/data/pitchbook/node_modules/camoufox-js
```

The script auto-detects camoufox from these paths (in order):
1. `$CAMOUFOX_PATH` env var
2. `~/.local/share/showrun/data/pitchbook/node_modules/camoufox-js`
3. `~/.local/share/showrun/data/etsy/node_modules/camoufox-js`
4. Relative `../../node_modules/camoufox-js` from script

## Usage

```
node listing-scraper.mjs search <query> [options]
node listing-scraper.mjs listing <url-or-id> [options]
node listing-scraper.mjs shop <shop-name> [options]
node listing-scraper.mjs reviews <url-or-id> [options]
```

## Commands

### `search` — Product search

Search Etsy for listings by keyword.

```bash
# Basic search (returns 1 page, ~48-60 listings)
node listing-scraper.mjs search "handmade ring"

# Multi-page search
node listing-scraper.mjs search "handmade ring" --pages=3

# With filters
node listing-scraper.mjs search "vintage lamp" --min-price=50 --max-price=500

# Sort options: relevancy | newest | price_asc | price_desc | highest_reviews
node listing-scraper.mjs search "pottery mug" --sort=price_asc --pages=2

# Save output to file
node listing-scraper.mjs search "silver necklace" --output=/tmp/results.json
```

**Output schema:**
```json
{
  "query": "handmade ring",
  "pages": 1,
  "totalScraped": 48,
  "filters": { "minPrice": null, "maxPrice": null, "sort": null },
  "listings": [
    {
      "listingId": "1234567890",
      "shopId": "11633483",
      "title": "Blue Aquamarine Sterling Silver Bracelet",
      "priceText": "€85.00",
      "currency": "€",
      "imageUrl": "https://i.etsystatic.com/...",
      "url": "https://www.etsy.com/listing/1234567890/blue-aquamarine",
      "badges": {
        "bestseller": false,
        "starSeller": true,
        "freeShipping": false
      }
    }
  ],
  "scrapedAt": "2025-01-01T00:00:00.000Z"
}
```

### `listing` — Single listing detail

Scrape full product details from a listing page.

```bash
# By listing ID
node listing-scraper.mjs listing 1234567890

# By full URL
node listing-scraper.mjs listing https://www.etsy.com/listing/1234567890/product-name
```

**Output schema:**
```json
{
  "listingId": "1234567890",
  "url": "https://www.etsy.com/listing/1234567890/...",
  "title": "Product Name",
  "description": "Full description text...",
  "price": {
    "currency": "EUR",
    "lowPrice": "85.00",
    "highPrice": "95.00",
    "availability": "InStock",
    "shippingFrom": "US"
  },
  "shopName": "ShopOwnerName",
  "rating": 4.9,
  "reviewCount": 1250,
  "images": [
    "https://i.etsystatic.com/.../il_fullxfull.jpg"
  ],
  "categories": [
    { "name": "Jewelry", "url": "https://www.etsy.com/c/jewelry", "position": 1 },
    { "name": "Rings", "url": "https://www.etsy.com/c/jewelry/rings", "position": 2 }
  ],
  "reviews": [
    { "text": "Beautiful item!", "rating": 5, "date": "2025-01-01", "author": "buyer123" }
  ],
  "tags": ["handmade", "sterling silver", "ring"],
  "scrapedAt": "2025-01-01T00:00:00.000Z"
}
```

### `shop` — Shop profile

Scrape shop profile and product listings.

```bash
# Basic shop scrape (first page of listings)
node listing-scraper.mjs shop CaitlynMinimalist

# Multiple pages of listings
node listing-scraper.mjs shop CaitlynMinimalist --pages=3
```

**Output schema:**
```json
{
  "name": "CaitlynMinimalist",
  "url": "https://www.etsy.com/shop/CaitlynMinimalist",
  "announcement": "Shop description...",
  "salesText": "15,000+ sales",
  "admirersText": null,
  "isStarSeller": true,
  "rating": 4.9,
  "reviewCount": 12000,
  "owner": "Caitlyn",
  "location": "United States",
  "listings": [...],
  "listingCount": 48,
  "sections": [...],
  "scrapedAt": "2025-01-01T00:00:00.000Z"
}
```

### `reviews` — Listing reviews

Scrape customer reviews from a listing page.

```bash
node listing-scraper.mjs reviews 1234567890
node listing-scraper.mjs reviews https://www.etsy.com/listing/1234567890/product-name
```

**Output schema:**
```json
{
  "listingId": "1234567890",
  "title": "Product Name",
  "url": "https://www.etsy.com/listing/1234567890/...",
  "reviewCount": 10,
  "reviews": [
    {
      "text": "Great quality, exactly as described!",
      "rating": 5,
      "date": "2025-01-15",
      "author": "buyer456",
      "images": []
    }
  ],
  "scrapedAt": "2025-01-01T00:00:00.000Z"
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--pages=N` | 1 | Number of pages to scrape |
| `--min-price=N` | — | Minimum price filter |
| `--max-price=N` | — | Maximum price filter |
| `--sort=SORT` | relevancy | Sort: `relevancy`, `newest`, `price_asc`, `price_desc`, `highest_reviews` |
| `--output=FILE` | stdout | Save JSON to file |
| `--headed` | false | Show browser window (debugging) |
| `--timeout=MS` | 30000 | Page load timeout |
| `--delay=MS` | 2000 | Delay between pages |
| `--camoufox-path=P` | auto | Path to camoufox-js module |
| `--proxy=URL` | — | Proxy URL (e.g. `socks5://user:pass@host:port`) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CAMOUFOX_PATH` | Override camoufox-js module path |
| `ETSY_PROXY` | Proxy URL (alternative to `--proxy` flag) |
| `QUIET` | Set to `1` to suppress debug logs |

## Pagination

Etsy search shows ~48–62 listings per page. Pages are indexed from 1.
URL format: `https://www.etsy.com/search?q=query&page=N`

Maximum pages: ~250 (results thin out after page 50 for most queries).

## Bot Detection & Rate Limiting

| Detection Method | Behavior |
|-----------------|----------|
| DataDome CAPTCHA | Exit code 4 with clear message |
| Slow responses | Built-in `--delay` between pages |
| Rate limit | Exit code 5 |

**If blocked (exit code 4):**
1. Ensure camoufox-js is properly installed (not plain Playwright)
2. Try `--headed` flag to observe the browser
3. Increase `--delay=5000` for slower browsing
4. Check `CAMOUFOX_PATH` points to a valid camoufox installation
5. **IP temporarily blocked?** DataDome tracks IPs and may block server/VPS/Turkish IPs
   after repeated requests. Wait 10-30 minutes before retrying.
   Residential IPs (home broadband) have much lower block rates.
6. **Too many requests?** Spread requests over time — pause 5-10 seconds between pages.
   Avoid scraping thousands of pages in a single session.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage / configuration error |
| 2 | No results found |
| 4 | DataDome CAPTCHA / WAF block |
| 5 | Rate limit |

## Data Storage

Scraped data is cached in: `~/.local/share/showrun/data/etsy/cache/`

## Technical Notes

### How Etsy loads data

1. **Initial page load** (SSR): Full HTML returned with listing IDs in `data-listing-id` attributes
2. **Async specs**: POST requests to `/api/v3/ajax/bespoke/member/neu/specs/listingCards` load additional listing card HTML
3. **Listing pages**: Use `application/ld+json` structured data (Product schema) for clean data extraction
4. **No clean JSON API**: Etsy's internal bespoke API returns server-rendered HTML, not clean JSON

### Selector strategy

1. `data-listing-id` attributes on listing cards (reliable, data-attribute-based)
2. `application/ld+json` Product schema on listing pages (richest data)
3. CSS class selectors as fallback (may break on redesigns)

### URL structure

- Search: `https://www.etsy.com/search?q={query}&page={n}&min={price}&max={price}&order={sort}`
- Listing: `https://www.etsy.com/listing/{id}/{slug}`
- Shop: `https://www.etsy.com/shop/{shop-name}`
- Shop page: `https://www.etsy.com/shop/{shop-name}?page={n}`

## Known Limitations

- Currency shown depends on server-side locale (may show EUR, USD, GBP, etc.)
- Reviews pagination: only first page of reviews is scraped per listing (Etsy doesn't paginate reviews via URL params)
- Shop stats (sales count, admirers) are scraped from DOM text; may need regex cleanup for numbers
- `--sort` filter depends on Etsy's current URL parameter format (last validated March 2025)
