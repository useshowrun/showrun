# booking-search

Search Booking.com for hotels and properties in any city.

## Usage

```bash
node booking-search.mjs <location> [checkin] [checkout] [options]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `location` | Yes | City or destination (e.g., "Istanbul", "Paris", "New York") |
| `checkin` | No | Check-in date in YYYY-MM-DD format (default: tomorrow) |
| `checkout` | No | Check-out date in YYYY-MM-DD format (default: checkin +1 day) |

## Options

| Flag | Description |
|------|-------------|
| `--adults N` | Number of adults (default: 2) |
| `--rooms N` | Number of rooms (default: 1) |
| `--offset N` | Pagination offset (default: 0; increment by 25) |
| `--sort <key>` | Sort order: `popularity` (default), `price`, `review_score`, `class_ascending`, `class_descending` |

## Examples

```bash
# Search Istanbul hotels for April 2026
node booking-search.mjs "Istanbul" 2026-04-01 2026-04-02

# Search Paris hotels sorted by price
node booking-search.mjs "Paris" 2026-06-15 2026-06-20 --sort price

# Paginate to next 25 results
node booking-search.mjs "Istanbul" 2026-04-01 2026-04-02 --offset 25

# Search for 3 adults, 2 rooms
node booking-search.mjs "Rome" 2026-07-01 2026-07-05 --adults 3 --rooms 2
```

## Output

```json
{
  "location": "Istanbul",
  "destId": "-755070",
  "destType": "CITY",
  "destLabel": "Istanbul, Marmara Region, Turkey",
  "checkin": "2026-04-01",
  "checkout": "2026-04-02",
  "totalNights": 1,
  "offset": 0,
  "results": [
    {
      "name": "Grand Hotel Istanbul",
      "hotelUrl": "https://www.booking.com/hotel/tr/grand-hotel-istanbul.en-gb.html",
      "stars": 4,
      "reviewScore": 8.7,
      "reviewLabel": "Fabulous",
      "reviewCount": 3095,
      "locationScore": 9.5,
      "pricePerNight": 112,
      "currency": "€",
      "taxesIncluded": true,
      "address": "Beyoglu, Istanbul (Taksim)",
      "distanceFromCentre": "1.2 km from centre",
      "roomType": "Standard Double Room",
      "hasDeal": false,
      "dealText": null,
      "thumbnail": "https://cf.bstatic.com/xdata/images/hotel/..."
    }
  ],
  "meta": {
    "scrapedAt": "2026-03-21T...",
    "authenticated": false
  }
}
```

## Notes

- Returns ~25 properties per page (Booking.com's default page size)
- Use `--offset 25`, `--offset 50`, etc. for pagination
- Prices are in the currency detected by IP geolocation (e.g., EUR from European IPs)
- `reviewScore` is out of 10 (not 5)
- `stars` is property category (1-5), `reviewScore` is guest rating
- Hotel URLs are cleaned of tracking parameters (keep checkin/checkout params)
