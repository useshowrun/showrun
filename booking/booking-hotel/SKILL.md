# booking-hotel

Scrape full details for a specific Booking.com hotel by URL or hotel slug.

## Usage

```bash
node booking-hotel.mjs <hotel-url-or-slug> [checkin] [checkout] [options]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `hotel-url-or-slug` | Yes | Full Booking.com hotel URL or slug (e.g., `hotel/tr/istanbul-grand-pera`) |
| `checkin` | No | Check-in date in YYYY-MM-DD format (default: tomorrow) |
| `checkout` | No | Check-out date in YYYY-MM-DD format (default: checkin +1 day) |

## Options

| Flag | Description |
|------|-------------|
| `--adults N` | Number of adults (default: 2) |
| `--rooms N` | Number of rooms (default: 1) |

## Examples

```bash
# Scrape hotel by full URL
node booking-hotel.mjs "https://www.booking.com/hotel/tr/istanbul-grand-pera.en-gb.html" 2026-04-01 2026-04-02

# Scrape by slug
node booking-hotel.mjs "hotel/pl/teatr" 2026-04-01 2026-04-02

# Without dates (just general info)
node booking-hotel.mjs "https://www.booking.com/hotel/tr/the-marmara-pera.html"
```

## Output

```json
{
  "name": "HOTEL TEATR",
  "stars": 4,
  "reviewScore": 9.3,
  "reviewCount": 1033,
  "reviewLabel": "Superb",
  "reviewSubscores": {
    "Free WiFi": 9.5,
    "Location": 9.9,
    "Cleanliness": 9.4
  },
  "description": "Situated in Kraków and with...",
  "address": {
    "street": "21 Świętego Krzyża, Old Town, 31-023 Kraków, Poland",
    "city": "21 Świętego Krzyża",
    "region": "Lesser Poland",
    "country": "Poland",
    "postalCode": "31-023"
  },
  "addressText": "21 Świętego Krzyża, Old Town, 31-023 Kraków, Poland...",
  "locationDesc": "Couples particularly like the location — they rated it 9.9 for a two-person trip.",
  "hotelUrl": "https://www.booking.com/hotel/pl/teatr.en-gb.html",
  "photos": [
    "https://cf.bstatic.com/xdata/images/hotel/max1024x768/484049650.jpg?..."
  ],
  "popularFacilities": ["Non-smoking rooms", "Restaurant", "Free WiFi", "Family rooms"],
  "allFacilities": ["Non-smoking rooms", "Restaurant", "Free WiFi", ...],
  "pois": ["John Paul II International Airport Kraków–Balice 16 km"],
  "featuredReview": {
    "text": "\"The property was in a brilliant location and was very modern\"",
    "author": "Dani, United Kingdom"
  },
  "breadcrumbs": ["Old Town"],
  "cancellationPolicy": null,
  "prepaymentPolicy": "No prepayment needed – pay at the property",
  "faq": {
    "question": "How far is HOTEL TEATR from the centre of Kraków?",
    "answer": "HOTEL TEATR is 400 m from the centre of Kraków."
  },
  "meta": {
    "ogTitle": "HOTEL TEATR, Kraków, Poland",
    "scrapedAt": "2026-03-21T...",
    "authenticated": false
  }
}
```

## Notes

- `reviewScore` is out of 10 (Booking.com's 1-10 scale)
- `stars` is the official property category (1-5 stars)
- `photos` URLs use `max1024x768` resolution (upgraded from thumbnails)
- `pois` = nearby places of interest (airports, attractions, etc.)
- Cancellation/prepayment policies depend on check-in/checkout dates provided
- Full facilities list may not be available for all properties
