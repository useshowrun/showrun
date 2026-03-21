# tripadvisor-search — Tripadvisor Hotel Search

Search for hotels in any city and return a list of hotels with ratings, review counts, and prices.

## Usage

```bash
cd tripadvisor
npm install

# Search by city name
CITY="New York City" node tripadvisor-search/scripts/tripadvisor-search.mjs

# Search with limit
CITY="Istanbul" MAX_RESULTS=20 node tripadvisor-search/scripts/tripadvisor-search.mjs

# Search with known geoId (skips typeahead lookup)
GEO_ID=60763 CITY="New York City" node tripadvisor-search/scripts/tripadvisor-search.mjs

# Search with custom proxy
SOCKS5_PROXY=127.0.0.1:11091 CITY="Paris" node tripadvisor-search/scripts/tripadvisor-search.mjs
```

## Input

| Env Var | Required | Description |
|---------|----------|-------------|
| `CITY` | Yes* | City name to search hotels in |
| `GEO_ID` | No* | Known Tripadvisor geoId (skips typeahead lookup) |
| `MAX_RESULTS` | No | Max hotels to return (default: 30) |
| `CITY_SLUG` | No | City URL slug (e.g. `New_York_City_New_York`) for direct URL |
| `SOCKS5_PROXY` | No | SOCKS5 proxy (default: `127.0.0.1:11091`) |
| `TA_COOKIES` | No | JSON array of auth cookies |

*Either `CITY` or `GEO_ID` is required.

## Output

```json
{
  "city": "New York City",
  "geoId": "60763",
  "listingUrl": "https://www.tripadvisor.com/Hotels-g60763-Hotels.html",
  "total": 10,
  "hotels": [
    {
      "name": "The Bryant Park Hotel",
      "url": "/Hotel_Review-g60763-d224214-Reviews-The_Bryant_Park_Hotel-New_York_City_New_York.html",
      "locationId": "224214",
      "geoId": "60763",
      "rating": 4.7,
      "reviewCount": 5449,
      "priceFrom": 357
    }
  ]
}
```

## Strategy

1. Load Tripadvisor homepage (establishes Cloudflare session)
2. Type city name into search box → intercept `Typeahead_autocomplete` GQL response
3. Extract `locationId` (geoId) for the city
4. Navigate to `/Hotels-g{geoId}-Hotels.html`
5. Extract hotel cards:
   - Name: `a[href*="Hotel_Review"]` with non-review-count text
   - IDs: URL pattern `/Hotel_Review-g{geoId}-d{locationId}-Reviews`
   - Rating: `svg > title` text like "4.7 of 5 bubbles" (within card container)
   - Reviews: text regex `(N,NNN reviews)` 
   - Price: text regex `from $NNN`

## Known Issues

- Residential proxy required (SOCKS5_PROXY)
- Max ~30 hotels per page without pagination
- Some hotel cards may not have prices (e.g., sold-out properties)
- GeoId lookup may fail if city name has multiple matches — use GEO_ID to override
