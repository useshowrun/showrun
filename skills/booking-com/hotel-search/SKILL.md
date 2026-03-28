# booking-com/hotel-search

Scrape hotel data from Booking.com: search results, property details, and guest reviews. Uses Chrome CDP for WAF bypass.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`, `WebSocket`)
- Google Chrome with remote debugging enabled
  ```bash
  # Launch Chrome with CDP (already running? skip this)
  google-chrome --remote-debugging-port=9333 &
  # OR check existing port:
  # ps aux | grep chrome | grep debugging-port
  ```

## ⚠️ Critical: WAF & Geo-IP Notes

Booking.com uses **AWS WAF** that blocks all non-browser HTTP requests. You **must** use Chrome CDP — the script executes all HTTP calls from within the browser via `Runtime.evaluate → fetch()`.

**Geo-IP Redirect**: Search results (`/searchresults.html`) redirect to the homepage from some IP regions (Turkey, etc.) with error `errorc_searchstring_not_found`. The script detects this and falls back to hotel-name-based lookup. Hotel detail pages and reviews work from all IPs.

## Setup

No auth setup needed. Chrome must be open with CDP enabled.

## Usage

### Search hotels in a destination

```bash
node scripts/hotel-search.mjs search "Amsterdam" --checkin=2025-06-01 --checkout=2025-06-03 --adults=2 --rooms=1
node scripts/hotel-search.mjs search "Paris, France" --checkin=2025-07-10 --checkout=2025-07-13
```

Options:
- `--checkin` — Check-in date (YYYY-MM-DD, default: 7 days from now)
- `--checkout` — Check-out date (YYYY-MM-DD, default: 9 days from now)
- `--adults` — Number of adults (default: 2)
- `--rooms` — Number of rooms (default: 1)
- `--page` — Results page (default: 1, 25 per page, use offset=25*page)
- `--stars` — Filter by stars (e.g. `4` or `4,5`)
- `--max-price` — Max price per night in EUR
- `--output` — Output file path (default: prints to stdout)

Returns: List of hotels with name, pageName, cc1, review score, price, location

### Get hotel details

```bash
node scripts/hotel-search.mjs detail nl/hisoestduinen --checkin=2025-06-01 --checkout=2025-06-03
node scripts/hotel-search.mjs detail fr/ibis-paris-gare-de-lyon --checkin=2025-08-10 --checkout=2025-08-12 --adults=2
```

The `{cc}/{pageName}` argument comes from search results or the hotel URL.

Returns: Full hotel profile including name, address, description, star rating, review score, facilities, FAQ, nearby places

### Scrape hotel reviews

```bash
node scripts/hotel-search.mjs reviews nl/hisoestduinen
node scripts/hotel-search.mjs reviews nl/hisoestduinen --pages=3
node scripts/hotel-search.mjs reviews fr/ibis-paris-gare-de-lyon --pages=5 --output=/tmp/reviews.json
```

Options:
- `--pages` — Number of pages to scrape (default: 1, 24 reviews/page)
- `--output` — Save JSON output to file

Returns: Reviews with reviewer name, country, date, score, positive/negative text, trip type, room type

### Resolve destination to destId

```bash
node scripts/hotel-search.mjs autocomplete "Amsterdam"
node scripts/hotel-search.mjs autocomplete "Eiffel Tower, Paris"
```

Returns: Matching destinations with destId and destType (used for search filtering)

## How It Works

### Architecture
All API calls are executed **from within the browser** via CDP `Runtime.evaluate`. This bypasses AWS WAF TLS fingerprinting.

```
Agent → CDP → Chrome → booking.com API
                ↑
           (uses browser's cookies + TLS fingerprint)
```

### Search Flow
1. `autocomplete` GraphQL → resolve destination name → `destId` + `destType`
2. Navigate CDP to `/searchresults.html?dest_id=...` 
3. If geo-blocked (redirect to index.html): parse hotel recommendations from homepage GraphQL
4. Scrape `[data-testid="property-card"]` elements or parse GraphQL cards

### Detail Flow
1. Navigate CDP to `/hotel/{cc}/{pageName}.html?checkin=...&checkout=...`
2. Extract JSON-LD structured data (`script[type="application/ld+json"]`)
3. Call `RoomPageDesktopRDS` GraphQL for room details + review scores
4. Call `Facilities` GraphQL for amenities list
5. Call `PropertyFaq` GraphQL for FAQ

### Reviews Flow
1. Navigate CDP to `/reviews/{cc}/hotel/{pageName}.html?page=1`
2. Scrape `.review_item` elements
3. Follow `link[rel="next"]` for pagination (24 reviews/page)

## WAF Detection & Recovery

The script monitors for WAF blocks:
- HTTP 202 with empty body → WAF challenge → reload page
- Redirect to `/index.html?errorc_searchstring_not_found` → geo-block → use fallback
- HTTP 403 → session blocked → needs fresh browser session

If blocked, the script will print clear error messages and exit with code 1.

## Session Expiry

Booking.com sessions are browser-based. If you see WAF errors:
1. Open Chrome, navigate to `https://www.booking.com`
2. Wait for the page to fully load (WAF challenge resolves automatically)
3. Re-run the script

## Data Storage

```
~/.local/share/showrun/data/booking-com/
├── search-{destination}-{date}.json     # Search results cache
├── hotel-{cc}-{pageName}.json           # Hotel detail cache
└── reviews-{cc}-{pageName}-p{n}.json    # Review page cache
```

Cached data expires after 1 hour.

## GraphQL Operations Used

| Operation | Purpose |
|-----------|---------|
| `AutoComplete` | Resolve destination name → destId |
| `RoomPageDesktopRDS` | Room details + availability + review scores |
| `Facilities` | Hotel amenities by category |
| `PropertyFaq` | FAQ about the property |
| `PropertySurroundingsBlockDesktop` | Nearby attractions, restaurants, airports |
| `MvRexWebRecPlatformPropertyCards` | Hotel recommendations (fallback for geo-blocked search) |

## Output Format

### Search Result
```json
{
  "destination": "Amsterdam, Netherlands",
  "destId": "-2140479",
  "checkin": "2025-06-01",
  "checkout": "2025-06-03",
  "totalResults": 1247,
  "hotels": [
    {
      "id": 10538,
      "name": "DoubleTree by Hilton Royal Parc Soestduinen",
      "pageName": "hisoestduinen",
      "cc1": "nl",
      "url": "https://www.booking.com/hotel/nl/hisoestduinen.html",
      "city": "Amersfoort",
      "country": "Netherlands",
      "starRating": 4,
      "reviewScore": 8.2,
      "reviewCount": 2371,
      "reviewText": "Very Good",
      "pricePerNight": "€ 142",
      "isGenius": false
    }
  ]
}
```

### Hotel Detail
```json
{
  "url": "https://www.booking.com/hotel/nl/hisoestduinen.html",
  "name": "DoubleTree by Hilton Royal Parc Soestduinen",
  "cc1": "nl",
  "pageName": "hisoestduinen",
  "description": "Located in the woodlands...",
  "address": {
    "streetAddress": "Van Weerden Poelmanweg 4-6",
    "postalCode": "3768 MN",
    "city": "Amersfoort",
    "country": "Netherlands"
  },
  "starRating": 4,
  "reviewScore": 8.2,
  "reviewCount": 2371,
  "image": "https://cf.bstatic.com/xdata/images/hotel/max500/...",
  "facilities": [...],
  "rooms": [...],
  "faq": [...]
}
```

### Review
```json
{
  "date": "March 16, 2026",
  "reviewerName": "Michal",
  "reviewerCountry": "Poland",
  "score": 8.0,
  "scoreWord": "Very Good",
  "positiveText": "Great breakfast!",
  "negativeText": "Small issues with bed cleanness",
  "tripType": "Leisure trip",
  "travelerType": "Family with young children",
  "roomType": "Twin Room",
  "stayDuration": "3 nights"
}
```

## Error Codes

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General error (see stderr) |
| 2 | WAF/bot block detected |
| 3 | CDP connection failed |
| 4 | Login required (should not occur for Booking.com) |
| 5 | Geo-IP block on search (fallback used) |
