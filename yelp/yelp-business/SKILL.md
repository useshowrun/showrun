# Skill: yelp-business

Get detailed information about a specific Yelp business by slug/alias.

## Script

```
node scripts/yelp-business.mjs [options]
```

## Options (env vars)

| Variable | Description | Default |
|----------|-------------|---------|
| `SLUG` | Yelp business slug/alias (e.g., "sightglass-coffee-san-francisco-7") | **required** |
| `INCLUDE_REVIEWS` | Include recent reviews. Set to `0` to skip. | `1` (include) |
| `SOCKS5_PROXY` | Residential proxy (required to bypass DataDome) | `127.0.0.1:11091` |
| `MAX_RETRIES` | Retry attempts on failure | `2` |

## Output format

```
RESULT:{...business detail json...}
```

```json
{
  "name": "Sightglass Coffee",
  "slug": "sightglass-coffee-san-francisco-7",
  "alias": "sightglass-coffee-san-francisco-7",
  "url": "https://www.yelp.com/biz/sightglass-coffee-san-francisco-7",
  "rating": 4.0,
  "reviewCount": 2195,
  "priceRange": "$$",
  "categories": [
    {"title": "Coffee Roasteries", "alias": "coffeeroasteries"},
    {"title": "Coffee & Tea", "alias": "coffee"}
  ],
  "address": {
    "street": "270 Seventh St",
    "street2": null,
    "city": "San Francisco",
    "state": "CA",
    "zip": "94103",
    "country": "US"
  },
  "phone": "(415) 861-1313",
  "website": "https://sightglasscoffee.com",
  "hours": [
    {"day": "Monday", "hours": "7:00 AM - 5:00 PM"},
    {"day": "Tuesday", "hours": "7:00 AM - 5:00 PM"},
    ...
  ],
  "isOpenNow": null,
  "amenities": [],
  "photos": [
    "https://s3-media0.fl.yelpcdn.com/bphoto/OzB1ws0gqoEN4bQxj0AHAg/l.jpg",
    ...
  ],
  "reviews": [
    {
      "rating": 5,
      "text": "Great coffee and atmosphere...",
      "author": "Jane D.",
      "authorLocation": "San Francisco, CA",
      "date": "2026-03-15T12:00:00-07:00",
      "language": "en"
    },
    ...
  ],
  "yelpUrl": "https://www.yelp.com/biz/sightglass-coffee-san-francisco-7"
}
```

## Data sources

- **Primary**: Yelp's internal GQL batch API (`/gql/batch`) — intercepted as the page loads
  - Contains: name, rating, reviewCount, categories, address, phone, priceRange, hours, reviews, photos
  - Operations used: `GetLocalBusinessJsonLinkedData`, `GetBusinessHours`, `GetBusinessReviewFeed`
- **Fallback**: JSON-LD structured data and DOM extraction

## Anti-bot notes (updated 2026-03-21)

- Requires a residential SOCKS5 proxy (SOCKS5_PROXY env var)
- Uses camoufox Firefox fingerprinting to bypass DataDome
- Loads Yelp homepage first (establishes DataDome session), then navigates to biz page
- Business pages use a lighter DataDome check than search pages — generally reliable
- **IP rate limit**: DataDome flags IPs making too many requests in a short window
  - If blocked, wait 30-60 minutes before retrying
  - Never make more than ~5 requests per hour on the same proxy IP
- **Website URL**: Extracted from GQL `businessUrl.url` field (most reliable)
  - Falls back to `biz_redir` links in DOM
  - Note: Yelp masks website URLs through their redirect service in DOM
