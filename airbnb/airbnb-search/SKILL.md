# airbnb-search

Search Airbnb property listings by location and optional dates.

## Input

```json
{
  "location":  "New York, NY, United States",
  "checkin":   "2026-04-10",
  "checkout":  "2026-04-11",
  "adults":    2,
  "children":  0,
  "infants":   0,
  "pets":      0,
  "placeId":   "ChIJOwg_06VPwokRYv534QaPC8g",
  "maxPages":  3
}
```

- **`location`** *(required)*: Free-text location. Converted to Airbnb slug format.
  Examples: `"New York, NY, United States"`, `"Paris, France"`, `"Tokyo, Japan"`
- **`checkin`/`checkout`**: YYYY-MM-DD format. Required to get pricing data.
- **`adults`**: Number of adult guests (default: 1).
- **`placeId`**: Google Place ID for more accurate location results.
- **`maxPages`**: Max pages to scrape, 18 results per page (default: 1, max ~5).

## Output

```json
{
  "location": "New York, NY, United States",
  "totalCount": 85,
  "listings": [
    {
      "listingId": "1158653190110852406",
      "propertyId": "1526609014738945064",
      "url": "https://www.airbnb.com/rooms/1158653190110852406?...",
      "title": "Park Terrace Hotel",
      "subtitle": "Hotel in Midtown East",
      "name": "Park Terrace Hotel",
      "rating": 4.86,
      "reviewCount": 79,
      "ratingLabel": "4.86 out of 5 average rating, 79 reviews",
      "priceLabel": "$150 for 1 night",
      "thumbnailUrl": "https://a0.muscache.com/...",
      "photos": ["https://a0.muscache.com/...", "..."],
      "latitude": 40.7525,
      "longitude": -73.9831,
      "badges": []
    }
  ],
  "hasMore": true,
  "pagesScraped": 1,
  "searchUrl": "https://www.airbnb.com/s/New-York--NY--United-States/homes?..."
}
```

## Run

```bash
echo '{"location":"New York, NY, United States","checkin":"2026-04-10","checkout":"2026-04-11","adults":2}' \
  | node scripts/airbnb-search.mjs
```

Or with proxy:
```bash
SOCKS5_PROXY=127.0.0.1:11091 node scripts/airbnb-search.mjs '{"location":"London, United Kingdom"}'
```
