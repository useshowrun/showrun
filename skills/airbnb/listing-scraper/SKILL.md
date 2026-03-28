# airbnb/listing-scraper

Scrape Airbnb listings, reviews, and availability. Uses Airbnb's internal REST and GraphQL APIs. **No authentication required** for public data. No Cloudflare/WAF blocking observed.

## Prerequisites

- Node.js 18+ (uses built-in `fetch`)
- *(Optional)* Google Chrome with remote debugging enabled — enhances requests with browser session cookies, but the script works without it.
  ```bash
  google-chrome --remote-debugging-port=9333 &
  ```

## ⚠️ WAF & Auth Notes

- **No WAF** for these endpoints. Works from datacenter IPs including Turkish IPs.
- **No login required** for search, reviews, availability calendar, and listing details.
- If you see HTTP 403 or auth errors: the listing may be geo-restricted or delisted.
- If rate-limited (429): increase `RATE_LIMIT_MS` to 2000+.

## Setup

No setup required. Run commands directly:

```bash
node scripts/listing-scraper.mjs help
```

## Usage

### Search listings in a location

```bash
# Basic search
node scripts/listing-scraper.mjs search "Paris, France"

# With dates and guests
node scripts/listing-scraper.mjs search "Paris, France" --checkin=2025-06-01 --checkout=2025-06-05 --adults=2

# Multiple pages (18 listings per page)
node scripts/listing-scraper.mjs search "New York, United States" --pages=3

# Save to file
node scripts/listing-scraper.mjs search "London, United Kingdom" --checkin=2025-07-10 --checkout=2025-07-15 --output=/tmp/london.json
```

Returns: Array of listing objects with id, name, city, rating, reviews count, price, coordinates, property type, amenity IDs, superhost flag, etc. Plus pagination info.

**Pagination is automatic** — each page fetches 18 listings. Use `--pages=N` to fetch multiple pages.

### Get listing reviews

```bash
# First page of reviews (7 reviews)
node scripts/listing-scraper.mjs reviews 37879131

# Multiple pages
node scripts/listing-scraper.mjs reviews 37879131 --pages=5

# Save to file
node scripts/listing-scraper.mjs reviews 37879131 --pages=10 --output=/tmp/reviews.json
```

Listing ID is the numeric ID from the URL: `airbnb.com/rooms/37879131` → `37879131`

Returns: Array of review objects with comments, rating, reviewer name, date, host response, language.

### Get availability calendar

```bash
node scripts/listing-scraper.mjs availability 37879131
node scripts/listing-scraper.mjs availability 37879131 --month=6 --year=2025 --months=3
```

Returns: Calendar data with available/unavailable dates, min/max nights, pricing per day.

### Get listing detail (extended info)

```bash
node scripts/listing-scraper.mjs detail 37879131 --checkin=2025-06-01 --checkout=2025-06-05
```

Returns: Section-based data from the listing detail page. If empty, use search + reviews instead — they contain the same core data.

### Location auto-suggestions

```bash
node scripts/listing-scraper.mjs suggest "Paris"
node scripts/listing-scraper.mjs suggest "New Yor"
```

Returns: Location suggestions (city, neighborhood, landmark) with names and subtitles. Useful for finding the correct query string before searching.

## All Options

### Search options

| Flag | Default | Description |
|------|---------|-------------|
| `--checkin=YYYY-MM-DD` | none | Check-in date |
| `--checkout=YYYY-MM-DD` | none | Check-out date |
| `--adults=N` | 2 | Number of adults |
| `--pages=N` | 1 | Pages to fetch (18/page) |
| `--currency=USD` | USD | Currency code |
| `--output=path.json` | stdout | Save to file |

### Reviews options

| Flag | Default | Description |
|------|---------|-------------|
| `--pages=N` | 1 | Pages to fetch (7/page) |
| `--limit=N` | 7 | Reviews per page |
| `--output=path.json` | stdout | Save to file |

### Availability options

| Flag | Default | Description |
|------|---------|-------------|
| `--month=N` | current | Month (1-12) |
| `--year=N` | current | Year |
| `--months=N` | 3 | Number of months to fetch |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_PORT` | 9333 | Chrome remote debugging port |
| `AIRBNB_API_KEY` | built-in | Override Airbnb API key |
| `RATE_LIMIT_MS` | 800 | Delay between requests (ms) |
| `NO_CACHE` | off | Set to `1` to disable caching |
| `DEBUG` | off | Set to `1` for error stack traces |
| `CACHE_TTL` | 3600000 | Cache TTL in ms (1 hour) |

## API Details

Airbnb uses two internal API layers:

### REST v2: Search
```
GET https://www.airbnb.com/api/v2/explore_tabs
```
- Required header: `X-Airbnb-API-Key: d306zoyjsyarp7ifhu67rjxn52tv0t20`
- Pagination: `items_offset` + `section_offset` from previous response
- No auth required

### GraphQL v3: Reviews, Availability, Detail
```
GET https://www.airbnb.com/api/v3/{OperationName}/{sha256Hash}
POST https://www.airbnb.com/api/v3/{OperationName}/{sha256Hash}  (for detail)
```
- Uses Automatic Persisted Queries (APQ) format
- Required header: `X-Airbnb-API-Key`
- Listing IDs must be base64-encoded as `StayListing:<id>` for GraphQL endpoints

### Known Operation Hashes
| Operation | Hash |
|-----------|------|
| `StaysPdpReviewsQuery` | `2ed951bfedf71b87d9d30e24a419e15517af9fbed7ac560a8d1cc7feadfa22e6` |
| `PdpAvailabilityCalendar` | `b23335819df0dc391a338d665e2ee2f5d3bff19181d05c0b39bc6c5aac403914` |
| `AutoSuggestionsQuery` | `840ae28ff24af2a4729bd74fb5b98eadcd3412e3a28fea5c97b3ebce7f4f5730` |
| `StaysPdpSections` | `7afae2523702f3fb10726682c19bdfb2313518a4eb1b9f7b15b217e1de1905e5` |

### Listing Data Fields (from search)
```json
{
  "id": "37879131",
  "name": "Charming apartment in Marais",
  "city": "Paris",
  "neighborhood": "3rd Arrondissement",
  "publicAddress": "Paris, Île-de-France, France",
  "latitude": 48.8624,
  "longitude": 2.3548,
  "avgRating": 4.97,
  "reviewsCount": 265,
  "isSuperhost": true,
  "personCapacity": 4,
  "bedrooms": 2,
  "bathrooms": 1,
  "beds": 2,
  "roomType": "Entire home/apt",
  "roomTypeCategory": "entire_home",
  "propertyType": "Entire rental unit",
  "pictureUrl": "https://a0.muscache.com/...",
  "amenityIds": [1, 4, 5, 8, 137],
  "minNights": 2,
  "maxNights": 365,
  "cancelPolicy": "CANCEL_FLEXIBLE",
  "badges": ["Guest favorite"],
  "pdpUrl": "https://www.airbnb.com/rooms/37879131",
  "price": null
}
```

Note: `price` is null when no dates provided. Add `--checkin`/`--checkout` to get pricing.

## Error Handling

The script handles these error conditions:

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | — |
| 1 | General error | Check stderr for message |
| 2 | Auth required | Listing needs login (rare for public data) |
| 3 | WAF/bot block | Increase rate limit, use CDP |

### Rate Limiting
If blocked (429):
```bash
RATE_LIMIT_MS=2000 node scripts/listing-scraper.mjs search "Paris"
```

### Session/Cookie Issues
If API key stops working or responses seem wrong:
```bash
# Use Chrome CDP to pick up fresh browser cookies
# Chrome must be running with: google-chrome --remote-debugging-port=9333
CDP_PORT=9333 node scripts/listing-scraper.mjs search "Paris"
```

### WAF Detection
```bash
# Check if getting blocked
DEBUG=1 node scripts/listing-scraper.mjs search "Paris"
# Look for 403 errors or empty responses
```

## Data Storage

Results cached at: `~/.local/share/showrun/data/airbnb-listing-scraper/cache/`

Cache TTL: 1 hour (configurable via `CACHE_TTL` env var).

## Typical Workflow

```bash
# 1. Find the right location query
node scripts/listing-scraper.mjs suggest "New York"

# 2. Search listings with dates
node scripts/listing-scraper.mjs search "New York, United States" \
  --checkin=2025-06-01 --checkout=2025-06-05 --adults=2 --pages=2 \
  --output=/tmp/nyc-listings.json

# 3. Get reviews for a specific listing (ID from search results)
node scripts/listing-scraper.mjs reviews 37879131 --pages=5 --output=/tmp/reviews.json

# 4. Check availability
node scripts/listing-scraper.mjs availability 37879131 --month=6 --year=2025
```
