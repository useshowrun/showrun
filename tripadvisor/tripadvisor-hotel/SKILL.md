# tripadvisor-hotel — Tripadvisor Hotel Detail Scraper

Fetch full hotel details from a Tripadvisor hotel review page, including name, rating, address, amenities, photos, and up to 10 reviews.

## Usage

```bash
cd tripadvisor
npm install

# By hotel URL
HOTEL_URL="https://www.tripadvisor.com/Hotel_Review-g48561-d115817-Reviews-The_Point-Saranac_Lake_New_York.html" \
  node tripadvisor-hotel/scripts/tripadvisor-hotel.mjs

# By relative URL
HOTEL_URL="/Hotel_Review-g60763-d224214-Reviews-The_Bryant_Park_Hotel-New_York_City_New_York.html" \
  node tripadvisor-hotel/scripts/tripadvisor-hotel.mjs

# By locationId
LOCATION_ID=115817 GEO_ID=48561 node tripadvisor-hotel/scripts/tripadvisor-hotel.mjs

# With custom proxy
SOCKS5_PROXY=127.0.0.1:11091 HOTEL_URL="..." node tripadvisor-hotel/scripts/tripadvisor-hotel.mjs
```

## Input

| Env Var | Required | Description |
|---------|----------|-------------|
| `HOTEL_URL` | Yes* | Full or relative Tripadvisor hotel URL |
| `LOCATION_ID` | Yes* | Tripadvisor hotel locationId (d-number in URL) |
| `GEO_ID` | No | Tripadvisor geoId (g-number in URL, optional with LOCATION_ID) |
| `SOCKS5_PROXY` | No | SOCKS5 proxy (default: `127.0.0.1:11091`) |
| `TA_COOKIES` | No | JSON array of auth cookies |
| `MAX_RETRIES` | No | Retry attempts (default: 2) |

*Either `HOTEL_URL` or `LOCATION_ID` is required.

## Output

```json
{
  "name": "The Point",
  "url": "https://www.tripadvisor.com/Hotel_Review-g48561-d115817-Reviews-...",
  "geoId": "48561",
  "locationId": "115817",
  "priceRange": "$$$ (Based on Average Nightly Rates...)",
  "rating": 4.9,
  "reviewCount": 151,
  "address": {
    "street": "222 Beaverwood Rd",
    "city": "Saranac Lake",
    "region": "New York",
    "postalCode": "12983-3029",
    "country": "US"
  },
  "coordinates": {
    "lat": 44.30367,
    "lng": -74.33052
  },
  "amenities": [
    "Free parking",
    "Free internet",
    "Free breakfast",
    "Bicycle rental",
    "Skiing",
    "Pets Allowed ( Dog / Pet Friendly )",
    "Bar / lounge",
    "Restaurant"
  ],
  "photos": [
    "https://dynamic-media-cdn.tripadvisor.com/media/photo-o/2c/1f/ae/9a/mohawk.jpg?w=900&h=600&s=1"
  ],
  "reviews": [
    {
      "author": "Ricardo P",
      "profileUrl": "https://www.tripadvisor.com/Profile/X1831IHricardop",
      "rating": 5,
      "title": "Unique place, with impeccable service.",
      "text": "What a unique setting! Kyle and his team run an incredible...",
      "date": "Sep 2025"
    }
  ],
  "breadcrumb": ["United States", "New York (NY)", "Saranac Lake", "Saranac Lake Hotels", "The Point"],
  "imageUrl": "https://dynamic-media-cdn.tripadvisor.com/media/photo-o/2c/1f/ae/9a/mohawk.jpg?w=500&h=-1&s=1"
}
```

## Strategy

1. Load Tripadvisor homepage (establishes Cloudflare session)
2. Navigate to hotel review page
3. Extract `<script type="application/ld+json">` with `@type: "LodgingBusiness"` for primary data
4. Extract review cards from `[data-test-target="HR_CC_CARD"]`:
   - Author from first line: `"{author} wrote a review {date}"`
   - Rating from `svg > title` "N of 5 bubbles" pattern
   - Title and text from subsequent lines
5. Extract photos from `img[src*="dynamic-media-cdn.tripadvisor.com"]`

## Data Sources

| Field | Source |
|-------|--------|
| name, rating, reviewCount | JSON-LD `aggregateRating` |
| address, coordinates | JSON-LD `address`, `geo` |
| amenities | JSON-LD `amenityFeatures[]` |
| priceRange | JSON-LD `priceRange` |
| mainPhoto | JSON-LD `image` |
| reviews (author, title, text, date) | DOM `[data-test-target="HR_CC_CARD"]` innerText |
| review rating | DOM `svg > title` "N of 5 bubbles" |
| photos | DOM `img[src*="dynamic-media-cdn.tripadvisor.com"]` |
| breadcrumb | JSON-LD `BreadcrumbList` |

## Known Issues

- Residential proxy required (SOCKS5_PROXY)
- Max 10 reviews per page (DOM extraction; TA renders ~10 review cards)
- Some hotels may redirect URL (e.g., geo mismatch) — final URL is used
- TA may rate-limit after many hotel page requests; use delays between requests
