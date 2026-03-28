# Tripadvisor Review Scraper

Scrapes hotel, restaurant, and attraction reviews from Tripadvisor using their internal pre-registered GraphQL API. Works via CDP (Chrome DevTools Protocol) to leverage browser session cookies.

## What This Skill Does

- Fetch reviews for any Tripadvisor location (hotel, restaurant, attraction)
- Filter by rating, language, traveler type, travel season
- Sort by recency or review quality
- Paginate through all available reviews
- Get review count aggregations (rating distribution, language distribution)
- Search for locations by name to get their locationId

## Prerequisites

1. **Chrome/Chromium** with remote debugging enabled:
   ```bash
   google-chrome --remote-debugging-port=9333
   # or on Linux:
   chromium --remote-debugging-port=9333
   ```

2. **Node.js 22+** (built-in fetch + WebSocket required)

3. **Active Chrome session** — Chrome must be open. A Tripadvisor session is auto-established on first run.

> **No API key required.** This skill uses Tripadvisor's internal GraphQL API with browser cookies.

## Quick Start

```bash
cd skills/tripadvisor/review-scraper/scripts/

# Verify setup
node review-scraper.mjs check

# Search for a location
node review-scraper.mjs search "Marriott Times Square New York"

# Fetch reviews by locationId
node review-scraper.mjs reviews --id=93388

# Fetch reviews from a Tripadvisor URL
node review-scraper.mjs reviews "https://www.tripadvisor.com/Hotel_Review-g60763-d93388-Reviews-..."
```

## Finding a Location ID

Tripadvisor URLs encode the locationId:
```
/Hotel_Review-g{geoId}-d{locationId}-Reviews-Name.html
/Restaurant_Review-g{geoId}-d{locationId}-Reviews-Name.html
/Attraction_Review-g{geoId}-d{locationId}-Reviews-Name.html
```

The `d{locationId}` part is what you need. Example:
- `/Hotel_Review-g60763-d93388-Reviews-City_Express-...html` → locationId = **93388**
- `/Restaurant_Review-g60763-d478052-Reviews-Le_Bernardin-...html` → locationId = **478052**

You can also use the `search` command to find locationIds by name.

## Usage

### Check Connection
```bash
node review-scraper.mjs check
```
Verifies Chrome CDP connection and tests the review API. Output:
```json
{
  "status": "ok",
  "chromePort": 9333,
  "testLocationId": 93388,
  "testReviewCount": 197
}
```

### Search for a Location
```bash
node review-scraper.mjs search "hotel name city"
```
Returns array of matching locations with locationIds:
```json
[
  { "locationId": 93388, "url": "/Hotel_Review-...", "name": "City Express..." },
  ...
]
```

### Fetch Reviews
```bash
# Basic usage (10 most recent reviews)
node review-scraper.mjs reviews --id=93388

# From a Tripadvisor URL (locationId extracted automatically)
node review-scraper.mjs reviews "https://www.tripadvisor.com/Hotel_Review-g60763-d93388-..."

# Multiple pages (5 pages × 10 reviews = 50 reviews)
node review-scraper.mjs reviews --id=93388 --pages=5

# Custom page size
node review-scraper.mjs reviews --id=93388 --limit=25 --pages=2

# All reviews
node review-scraper.mjs reviews --id=93388 --all --limit=20

# With offset (start from review 50)
node review-scraper.mjs reviews --id=93388 --offset=50

# Save to file
node review-scraper.mjs reviews --id=93388 --pages=5 --output=reviews.json
```

### Filtering Options
```bash
# English reviews only (default)
node review-scraper.mjs reviews --id=93388 --lang=en

# All languages
node review-scraper.mjs reviews --id=93388 --lang=all

# Specific languages
node review-scraper.mjs reviews --id=93388 --lang=en,fr,de

# 5-star reviews only
node review-scraper.mjs reviews --id=93388 --rating=5

# Multiple ratings
node review-scraper.mjs reviews --id=93388 --rating=5,4

# 1-star reviews (useful for negative sentiment analysis)
node review-scraper.mjs reviews --id=93388 --rating=1,2

# Filter by traveler type
node review-scraper.mjs reviews --id=93388 --type=FAMILY
node review-scraper.mjs reviews --id=93388 --type=COUPLES,SOLO

# Valid traveler types: FAMILY, COUPLES, SOLO, BUSINESS, FRIENDS

# Text search
node review-scraper.mjs reviews --id=93388 --keyword="breakfast"
```

### Sorting Options
```bash
# Default (Tripadvisor's choice)
node review-scraper.mjs reviews --id=93388 --sort=default

# Most recent first
node review-scraper.mjs reviews --id=93388 --sort=recent

# Detailed reviews first (ML-sorted by descriptiveness)
node review-scraper.mjs reviews --id=93388 --sort=detailed
```

### Review Aggregations
```bash
# Get rating distribution and language counts
node review-scraper.mjs aggregations --id=93388 --lang=en
```

## Output Format

### Reviews Response
```json
{
  "locationId": 93388,
  "totalCount": 197,
  "fetchedCount": 10,
  "offset": 0,
  "lang": "en",
  "sort": "default",
  "reviews": [...]
}
```

### Individual Review Object
```json
{
  "id": 956659647,
  "rating": 1,
  "title": "Keep Driving",
  "text": "Keep Driving.  By far the worst hotel...",
  "publishedDate": "2024-06-25",
  "createdDate": "2024-06-25",
  "language": "en",
  "originalLanguage": "en",
  "translationType": null,
  "username": "gpsass1961",
  "displayName": "gpsass1961",
  "hometown": "Chandler, Arizona",
  "totalReviews": 50,
  "profileUrl": "/Profile/gpsass1961",
  "tripType": "FAMILY",
  "stayDate": "2024-06-30",
  "helpfulVotes": 0,
  "mgmtResponse": null,
  "additionalRatings": [
    { "label": "Value", "rating": 3 },
    { "label": "Service", "rating": 1 }
  ],
  "photos": [
    {
      "id": 639586178,
      "urlTemplate": "https://dynamic-media-cdn.tripadvisor.com/media/photo-o/...jpg?w={width}&h={height}&s=1",
      "maxWidth": 2048,
      "maxHeight": 1536,
      "caption": ""
    }
  ],
  "alertStatus": false,
  "locationName": "City Express By Marriott Lafayette",
  "locationId": 93388,
  "placeType": "ACCOMMODATION",
  "reviewDetailUrl": "/ShowUserReviews-g40261-d93388-r956659647-..."
}
```

### Aggregations Response
```json
{
  "locationId": 93388,
  "overallRating": 3.5,
  "reviewCount": 197,
  "reviewCountByRating": {
    "oneRatingCount": 25,
    "twoRatingCount": 18,
    "threeRatingCount": 40,
    "fourRatingCount": 80,
    "fiveRatingCount": 34
  },
  "reviewCountByLanguage": {
    "en": 180,
    "fr": 10,
    "de": 7
  }
}
```

## Technical Details

### How It Works
1. Connect to Chrome via CDP (port 9333 by default)
2. Use `Runtime.evaluate` to execute `fetch()` calls within the browser context
3. This allows cookies to be automatically included, bypassing WAF protections
4. The GraphQL endpoint `/data/graphql/ids` accepts pre-registered query IDs

### GraphQL API Endpoint
```
POST https://www.tripadvisor.com/data/graphql/ids
Content-Type: application/json
X-Requested-By: TNI client 0.1
```

### Key Query IDs
| Query ID | Operation | Purpose |
|----------|-----------|---------|
| `ef1a9f94012220d3` | `ReviewsProxy_getReviewListPageForLocation` | Fetch review list |
| `a162e8f65ea938d9` | `locations` | Get location name by ID |
| `e6367f6494143cbf` | Review aggregations | Rating/language distribution |
| `13fbbde7cccdbabc` | `CommunityUGC__locationTips` | Short tips |

> ⚠️ **Query IDs are discovered from JS bundles** and may change when Tripadvisor deploys updates. If the scraper stops working, re-run the discovery process.

### Pagination Strategy
- Default page size: 10 reviews
- Hotels typically support up to 10 per page
- Restaurants: up to 15 per page
- Use `--limit=25` for larger batches
- `offset` increments by `limit` each page
- Pagination stops when `offset >= totalCount`

## Error Handling & Troubleshooting

### WAF Blocked (403)
```
[ta:error] WAF/Bot protection triggered.
```
**Solutions:**
1. Open `https://www.tripadvisor.com` in Chrome manually
2. Solve any CAPTCHA if shown
3. Wait a few minutes before retrying
4. Ensure Chrome is not in headless mode

### Rate Limited (429)
```
[ta:error] Rate limited. Wait 30-60 seconds and retry.
```
The script will report this clearly. Wait and retry.

### CDP Connection Failed
```
[ta:error] CDP connection failed: Chrome not found on ports 9333, 9222
```
Start Chrome with remote debugging:
```bash
google-chrome --remote-debugging-port=9333
# If Chrome is already running, kill it first or use a different profile:
google-chrome --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-debug
```

### Empty Results
- Verify the locationId is correct
- Check the `totalCount` in the response
- Some locations may have 0 reviews
- Filters might be too restrictive

### Query ID Outdated
If you see GraphQL errors about invalid variables, the query IDs may have been updated. Check for a newer version of this skill or re-run discovery.

## Known Limitations

1. **Requires Chrome**: Cannot run headlessly without additional tooling (see note below)
2. **Session dependency**: Requires valid browser session cookies
3. **Query IDs**: May change when Tripadvisor updates their JS bundles
4. **Rate limiting**: Not scientifically tested; be conservative with batch sizes
5. **No direct API**: Tripadvisor's public Content API (api.content.tripadvisor.com) requires registration and has usage limits; this skill uses the internal API
6. **Location search**: The `search` command navigates to a search page; for programmatic location lookup, prefer extracting locationId from URLs

## Using with Headless Chrome

For automated/server environments, use Chrome with a display:
```bash
# Option 1: Xvfb virtual display
Xvfb :99 -screen 0 1920x1080x24 &
DISPLAY=:99 google-chrome --remote-debugging-port=9333 --no-sandbox

# Option 2: Use undetected-chromedriver / camoufox
# (May avoid detection better than regular headless Chrome)
```

## Changelog

- **2026-03-28**: Initial implementation. Discovery via CDP network interception on real Chrome session. Review query ID `ef1a9f94012220d3` verified working against live Tripadvisor.
