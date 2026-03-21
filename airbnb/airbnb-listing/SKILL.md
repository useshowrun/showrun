# airbnb-listing

Scrape full details for a single Airbnb property listing.

## Input

```json
{
  "listingId": "1158653190110852406",
  "checkin":   "2026-04-10",
  "checkout":  "2026-04-11",
  "adults":    2
}
```

- **`listingId`** *(required)*: The Airbnb room ID (from `/rooms/{id}` URL).
- **`checkin`/`checkout`**: YYYY-MM-DD. Needed for accurate price display.
- **`adults`**: Number of guests (default: 1).

## Output

```json
{
  "listingId": "1158653190110852406",
  "url": "https://www.airbnb.com/rooms/1158653190110852406?...",
  "title": "Park Terrace Hotel",
  "propertyType": "Room in hotel",
  "location": "New York",
  "address": "18 West 40th Street, New York, NY, 10018, United States",
  "description": "Step inside rooms with floor-to-ceiling windows...",
  "highlights": [
    { "title": "Near upscale shopping on 5th Avenue", "subtitle": "..." }
  ],
  "amenities": [
    { "title": "Wifi", "available": true, "group": null },
    { "title": "Gym", "available": true, "group": null }
  ],
  "photos": ["https://a0.muscache.com/...", "..."],
  "rating": 4.86,
  "reviewCount": 79,
  "categoryRatings": [
    { "category": "CLEANLINESS", "rating": 5.0, "label": "Cleanliness" }
  ],
  "latitude": 40.7525,
  "longitude": -73.9831,
  "capacity": 2,
  "roomDetails": ["1 bed", "1 private bath"],
  "houseRules": ["Check-in after 3:00 PM", "Checkout before 12:00 PM", "Pets allowed"],
  "checkinTime": "3:00 PM",
  "checkoutTime": "12:00 PM",
  "petsAllowed": true
}
```

## Run

```bash
echo '{"listingId":"1158653190110852406","checkin":"2026-04-10","checkout":"2026-04-11","adults":2}' \
  | node scripts/airbnb-listing.mjs
```

Or:
```bash
SOCKS5_PROXY=127.0.0.1:11091 node scripts/airbnb-listing.mjs '{"listingId":"12345","checkin":"2026-05-01","checkout":"2026-05-03"}'
```
