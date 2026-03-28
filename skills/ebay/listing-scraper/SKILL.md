# eBay Listing Scraper

Scrape eBay product listings, listing details, seller feedback profiles, and sold/completed listings. **No API key, no authentication, no browser required** — plain HTTP requests work.

## Prerequisites

- Node.js v18+
- `curl` (standard install — no special flags needed, no HTTP/2 required)

### Why no browser?

eBay uses **server-side rendering** for search results and listing pages. Listing data is embedded directly in the HTML returned by plain HTTP requests. No JavaScript execution is needed. No WAF (Cloudflare, DataDome, PerimeterX) detected.

**Session cookie trick:** eBay shows a "browser challenge" on item/feedback pages when visited directly without a session. The script automatically initializes a session by first fetching the search page, then uses those cookies for subsequent requests. Cookies are cached in `~/.local/share/showrun/data/ebay/cookies.txt` (refreshed every 4 hours).

## Setup

No setup required. Just run the script.

```bash
# Optional: create cache directory
mkdir -p ~/.local/share/showrun/data/ebay/cache
```

## Usage

```
node listing-scraper.mjs search <query> [options]
node listing-scraper.mjs sold <query> [options]
node listing-scraper.mjs listing <id-or-url>
node listing-scraper.mjs seller <username>
```

## Commands

### `search` — Product search

Search eBay for active listings by keyword.

```bash
# Basic search (1 page, ~50 listings)
node listing-scraper.mjs search "laptop"

# Multi-page search
node listing-scraper.mjs search "iphone 14" --pages=3

# With filters
node listing-scraper.mjs search "macbook pro" --condition=used --sort=price-asc

# Price range
node listing-scraper.mjs search "vintage camera" --min-price=50 --max-price=500

# Category + type filter
node listing-scraper.mjs search "gaming laptop" --category=58058 --type=buy-now

# Save to file
node listing-scraper.mjs search "gpu" --pages=5 --output=/tmp/gpus.json
```

**Output schema:**
```json
{
  "query": "laptop",
  "pages": 1,
  "totalScraped": 48,
  "sold": false,
  "options": {
    "sort": "price-asc",
    "condition": "used"
  },
  "listings": [
    {
      "listingId": "256687932761",
      "url": "https://www.ebay.com/itm/256687932761",
      "title": "HP X360 11 G6 11.6\" Touchscreen Laptop Core i3 8GB RAM 128GB SSD Windows 11",
      "imageUrl": "https://i.ebayimg.com/images/g/utQAAeSwAHNpuMRV/s-l500.jpg",
      "price": 179.78,
      "priceText": "$179.78",
      "freeShipping": true,
      "sponsored": false
    }
  ],
  "scrapedAt": "2026-01-01T00:00:00.000Z"
}
```

### `sold` — Completed/sold listings

Search eBay completed listings to see actual sold prices.

```bash
# Search sold listings (market research / price discovery)
node listing-scraper.mjs sold "macbook pro 2021" --pages=2

# Sold with price filters
node listing-scraper.mjs sold "rolex watch" --min-price=1000 --max-price=5000

# Save sold data
node listing-scraper.mjs sold "iphone 15 pro" --output=/tmp/sold.json
```

Output schema same as `search` but `"sold": true`.

### `listing` — Single listing detail

Get full details for one eBay listing.

```bash
# By listing ID
node listing-scraper.mjs listing 256687932761

# By full URL
node listing-scraper.mjs listing https://www.ebay.com/itm/256687932761
```

**Output schema:**
```json
{
  "itemId": "256687932761",
  "url": "https://www.ebay.com/itm/256687932761",
  "title": "HP X360 11 G6 11.6\" Touchscreen Laptop Core i3 8GB RAM 128GB SSD Windows 11 WiFi",
  "price": 179.78,
  "priceText": "$179.78",
  "currency": "USD",
  "condition": "Refurbished",
  "conditionUrl": "https://schema.org/RefurbishedCondition",
  "sellerUsername": "discountcomputerdepot",
  "sellerDisplayName": "Discount Computer Depot",
  "sellerFeedbackScore": 170099,
  "sellerFeedbackPercentage": 99.3,
  "freeShipping": true,
  "shippingType": "FreePickup",
  "soldCount": 340,
  "categoryId": "177",
  "categoryName": "Laptops & Netbooks",
  "itemLocation": "United States",
  "imageUrl": "https://i.ebayimg.com/images/g/utQAAeSwAHNpuMRV/s-l500.jpg",
  "images": [
    "https://i.ebayimg.com/images/g/utQAAeSwAHNpuMRV/s-l500.jpg"
  ],
  "scrapedAt": "2026-01-01T00:00:00.000Z"
}
```

### `seller` — Seller feedback profile

Get seller feedback score, positive percentage, and star rating.

```bash
node listing-scraper.mjs seller discountcomputerdepot
node listing-scraper.mjs seller apple
```

**Output schema:**
```json
{
  "username": "discountcomputerdepot",
  "feedbackScore": 170099,
  "positiveFeedbackPercent": 99.3,
  "averageRating": 4.8,
  "ratingCount": 7790,
  "storeName": "discountcomputerdepot",
  "profileUrl": "https://www.ebay.com/usr/discountcomputerdepot",
  "feedbackUrl": "https://www.ebay.com/fdbk/feedback_profile/discountcomputerdepot",
  "scrapedAt": "2026-01-01T00:00:00.000Z"
}
```

## All Options

| Flag | Description | Default |
|------|-------------|---------|
| `--pages=N` | Pages to scrape | 1 |
| `--category=ID` | eBay category ID | 0 (all) |
| `--min-price=N` | Minimum price USD | — |
| `--max-price=N` | Maximum price USD | — |
| `--condition=COND` | `new`, `used`, `refurbished`, `parts` | — |
| `--sort=SORT` | `best-match`, `ending-soon`, `newest`, `price-asc`, `price-desc` | best-match |
| `--type=TYPE` | `all`, `buy-now`, `auction` | all |
| `--ipg=N` | Items per page | 50 |
| `--delay=MS` | Delay between pages | 1500 |
| `--output=FILE` | Save JSON to file | — |
| `--verbose` | Verbose logging | off |

## Common Category IDs

| ID | Category |
|----|----------|
| 0 | All categories |
| 58058 | Computers/Tablets & Networking |
| 9355 | Cell Phones & Smartphones |
| 11450 | Clothing, Shoes & Accessories |
| 1249 | Video Games & Consoles |
| 293 | Consumer Electronics |
| 11233 | DVDs & Movies |
| 267 | Books |
| 12576 | Business & Industrial |
| 6028 | Camera & Photo |
| 2984 | Sporting Goods |
| 11116 | Toys & Hobbies |

## How It Works

### Search pages
1. HTTP GET `https://www.ebay.com/sch/i.html?_nkw=QUERY&_ipg=50&_pgn=PAGE`
2. Parse `<li data-listingid=...>` elements in the SSR HTML
3. Extract listing ID, title (from `alt`), price, image URL from each card

### Listing detail
1. HTTP GET `https://www.ebay.com/itm/{itemId}`
2. Extract page title (minus " | eBay") for item title
3. Parse inline JSON blobs for price, condition (schema.org), seller data
4. Detect "Free shipping" text, "N sold" count

### Seller feedback
1. HTTP GET `https://www.ebay.com/fdbk/feedback_profile/{username}`
2. Parse "170,099 feedback" text for score
3. Parse "Positive Feedback (last 12 months): 99.3%" text
4. Parse JSON `starRating.averageRating.value` for star score

## WAF & Rate Limiting

**No WAF detected** — eBay does not use Cloudflare, DataDome, or PerimeterX.

**Session cookies required for item/feedback pages:** eBay shows a "browser challenge" (argon2 wasm-based) when `/itm/` or `/fdbk/` pages are accessed without a prior session. The script automatically handles this by:
1. Fetching search page first to get session cookies
2. Reusing those cookies for all subsequent requests
3. Caching cookies for up to 4 hours

Tested from:
- Datacenter IP (NL/EU): ✅ search, listing, seller all work
- Turkish IP: ✅ search works (listing/seller need session cookies, handled automatically)

**Rate limiting:** No hard rate limits observed. `--delay=1500` (default) is sufficient.

**If unexpectedly blocked:**
1. Delete cookies: `rm ~/.local/share/showrun/data/ebay/cookies.txt`
2. Increase delay: `--delay=5000`
3. Use a residential proxy: `export http_proxy=http://proxy:port`

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage / config error |
| 2 | No results found |
| 3 | Network / HTTP error |
| 4 | WAF / bot block detected |
| 5 | Rate limited (HTTP 429) |

## Data Storage

```
~/.local/share/showrun/data/ebay/
  cookies.txt    Session cookies (auto-created, refreshed every 4h)
  cache/         Optional: saved JSON output files
```

To reset session (if blocked):
```bash
rm ~/.local/share/showrun/data/ebay/cookies.txt
```

## Pagination Notes

- eBay paginates search with `_pgn` parameter (1-based)
- 50 items per page recommended (`_ipg=50`)
- eBay limits pagination depth to ~500 pages
- Sold listings have the same pagination behavior
