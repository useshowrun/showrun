# Yellowpages Business Scraper

Scrape Yellowpages.com for local business listings: search results, business details, contact info, hours, categories, ratings, and geo-coordinates.

**WAF:** Cloudflare — bypassed using `curl_cffi` Python library with Firefox TLS fingerprint. No API key, no login required.

## Prerequisites

- Node.js v18+
- Python 3.8+ with `curl_cffi`:

```bash
# Install curl_cffi (only once)
pip install curl-cffi
# OR if using a venv:
/path/to/venv/bin/pip install curl-cffi
```

**Note:** The script auto-detects Python at these paths (in order):
1. `~/.openclaw/.venv/bin/python3` (OpenClaw venv)
2. `$PYTHON_BIN` env var
3. `python3` in PATH
4. `python` in PATH

Set `PYTHON_BIN=/path/to/python` if curl_cffi is installed in a custom location.

## Setup

No additional setup needed. Just install `curl_cffi` and run.

## Usage

```bash
node business-scraper.mjs search <query> <location> [options]
node business-scraper.mjs detail <url-or-path>
```

## Commands

### `search` — Business search

Search Yellowpages for businesses by type/name and location.

```bash
# Basic search (1 page, 30 results)
node business-scraper.mjs search "pizza" "New York, NY"

# Multi-page search (60 results)
node business-scraper.mjs search "plumber" "Los Angeles, CA" --pages=2

# Search by business name
node business-scraper.mjs search "McDonald's" "Chicago, IL"

# Search by zip code
node business-scraper.mjs search "dentist" "90210"

# Save to file
node business-scraper.mjs search "lawyers" "Austin, TX" --pages=3 --output=/tmp/lawyers.json
```

**Output schema:**
```json
{
  "query": "pizza",
  "location": "New York, NY",
  "totalCount": 1834,
  "pagesScraped": 1,
  "totalScraped": 30,
  "listings": [
    {
      "ypid": "459218516",
      "name": "Famous Original Ray's Pizza",
      "url": "https://www.yellowpages.com/new-york-ny/mip/famous-original-rays-pizza-459218516",
      "path": "/new-york-ny/mip/famous-original-rays-pizza-459218516",
      "phone": "(212) 956-7297",
      "streetAddress": "736 7th Ave",
      "locality": "New York, NY 10019",
      "address": "736 7th Ave, New York, NY 10019",
      "categories": ["Pizza", "American Restaurants", "Take Out Restaurants"],
      "rating": 4,
      "reviewCount": 4,
      "tripAdvisorRating": 3.5,
      "tripAdvisorCount": 185,
      "website": "http://www.rayspizza.com",
      "imageUrl": "https://i1.ypcdn.com/blob/...",
      "priceRange": "$$$$",
      "openStatus": "closed now",
      "listingType": "free"
    }
  ],
  "scrapedAt": "2026-01-01T00:00:00.000Z"
}
```

### `detail` — Business detail page

Fetch full details for a specific business: full address, coordinates, hours, categories, reviews.

```bash
# By path (from search results)
node business-scraper.mjs detail "/new-york-ny/mip/famous-original-rays-pizza-459218516"

# By full URL
node business-scraper.mjs detail "https://www.yellowpages.com/new-york-ny/mip/famous-original-rays-pizza-459218516"

# Save to file
node business-scraper.mjs detail "/new-york-ny/mip/famous-original-rays-pizza-459218516" --output=/tmp/detail.json
```

**Output schema:**
```json
{
  "url": "https://www.yellowpages.com/new-york-ny/mip/famous-original-rays-pizza-459218516",
  "ypid": "459218516",
  "name": "Famous Original Ray's Pizza",
  "phone": "(212) 956-7297",
  "extraPhones": "Fax: (212) 307-0606",
  "website": "http://www.rayspizza.com",
  "streetAddress": "736 7th Ave",
  "city": "New York",
  "state": "NY",
  "zip": "10019",
  "country": "US",
  "address": "736 7th Ave, New York, NY, 10019",
  "latitude": 40.760372,
  "longitude": -73.98398,
  "rating": 4,
  "reviewCount": 4,
  "priceRange": "$$$$",
  "categories": ["Pizza", "American Restaurants", "Fast Food Restaurants"],
  "openingHours": ["Mo-Su 09:00-04:00"],
  "hoursRaw": "9:00 am - 4:00 am",
  "menuUrl": "https://www.yellowpages.com/new-york-ny/mip/.../menu",
  "imageUrl": "https://i2.ypcdn.com/blob/...",
  "imageThumbnailUrl": "https://i2.ypcdn.com/blob/..._400x260_crop.jpg",
  "otherInfo": "Cuisines: Pizza, Take Out, Italian... Price Range: Above Average",
  "yearsInBusiness": 23,
  "recentReviews": [
    {
      "author": "Gustavo W.",
      "authorUrl": "/user/2204994644/reviews",
      "datePosted": "10/15/2023"
    }
  ],
  "scrapedAt": "2026-01-01T00:00:00.000Z"
}
```

## All Options

| Flag | Description | Default |
|------|-------------|---------|
| `--pages=N` | Pages to scrape (30 results/page) | 1 |
| `--delay=MS` | Delay between pages in ms | 1500 |
| `--output=FILE` | Save JSON output to file | — |
| `--verbose` | Enable verbose logging | off |

## Typical Workflows

### Find all pizza places in a city + get full details

```bash
# Step 1: Search (get list with YPIDs and paths)
node business-scraper.mjs search "pizza" "Brooklyn, NY" --pages=2 --output=/tmp/pizza.json

# Step 2: Get detail for each (use .path from search results)
node business-scraper.mjs detail "/brooklyn-ny/mip/di-fara-pizza-4565893" --output=/tmp/difara.json
```

### Bulk business research

```bash
# Scrape multiple pages of lawyers in Chicago
node business-scraper.mjs search "lawyers" "Chicago, IL" --pages=5 --output=/tmp/chicago-lawyers.json
```

## How It Works

### WAF Bypass
Yellowpages.com is protected by Cloudflare. Plain HTTP requests (curl, fetch, axios) get blocked with HTTP 403. The script uses Python's `curl_cffi` library with `impersonate="firefox133"` to replicate Firefox's exact TLS fingerprint, including JA3/JA4 signatures. This reliably bypasses Cloudflare.

### Search Pages
1. GET `https://www.yellowpages.com/search?search_terms=QUERY&geo_location_terms=LOCATION&page=N`
2. Parse `<div class="search-results organic">` container
3. Extract each `<div class="result">` block
4. Pull business name, phone, address, categories, rating from HTML elements

### Detail Pages
1. GET `https://www.yellowpages.com/{city-state}/mip/{slug}-{ypid}`
2. Parse `<script type="application/ld+json">` for structured data (most reliable)
3. Supplement with CSS selectors for hours, extra phones, other info

### Pagination
- URL param: `&page=N` (1-indexed)
- 30 results per page
- Total count shown in HTML: "Showing 1-30 of 1834"

## WAF & Rate Limiting

**Cloudflare present:** Plain HTTP → HTTP 403. Use `curl_cffi` (built into this script).

**Exit code 4** = WAF/Cloudflare block. This means:
1. The `curl_cffi` library isn't installed → install it
2. IP is hard-blocked (rare) → use a residential proxy: `export ALL_PROXY=http://proxy:port`
3. Cloudflare updated their challenge → update curl_cffi: `pip install --upgrade curl-cffi`

**Rate limiting:** No hard rate limits observed. Default `--delay=1500` is sufficient. Increase to `--delay=3000` if hitting rate limits.

**Datacenter IPs:** Work fine with `curl_cffi` Firefox impersonation.
**Residential IPs:** Also work fine.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage / config error |
| 2 | No results found / business not found (404) |
| 3 | Network / HTTP error |
| 4 | WAF / Cloudflare block detected |
| 5 | Rate limited (HTTP 429) |

## Data Notes

- `rating` is 1–5 stars (integer) or `null` if unrated
- `reviewCount` is YP reviews; `tripAdvisorRating`/`tripAdvisorCount` are TripAdvisor data
- `listingType`: `"free"` (unclaimed/basic) or `"paid"` (enhanced listing)
- `priceRange`: `$`, `$$`, `$$$`, or `$$$$`
- `openingHours` (detail): schema.org format, e.g. `["Mo-Su 09:00-04:00"]`
- `address` in search results: combined `"street, locality"` (e.g. `"736 7th Ave, New York, NY 10019"`)
- `address` in detail: combined from structured components
