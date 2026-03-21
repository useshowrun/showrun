# trustpilot-business

Scrape full business details and reviews from a Trustpilot business page.

## Usage

```bash
node trustpilot-business.mjs '<JSON input>'
```

## Input (JSON)

```json
{
  "domain": "amazon.com",    // Required — business domain (e.g. "amazon.com", "www.amazon.com")
  "maxReviews": 20,          // Optional — max number of reviews to fetch (default: 20, max: 200)
  "language": "en",          // Optional — filter by language (default: "en", use "all" for all)
  "sort": "recency",         // Optional — sort order: "recency" (default) or "relevance"
  "stars": null,             // Optional — filter by star rating: 1, 2, 3, 4, or 5
                             //            Applied as post-filter (Trustpilot SSR doesn't support URL-based star filter)
                             //            Note: increases pages scraped to fill maxReviews quota
}
```

Or use environment variables:
```bash
DOMAIN="amazon.com" MAX_REVIEWS=40 node trustpilot-business.mjs
```

## Output

```json
RESULT:{
  "business": {
    "businessUnitId": "46ad346800006400050092d0",
    "domain": "www.amazon.com",
    "name": "Amazon",
    "websiteUrl": "https://www.amazon.com",
    "trustScore": 1.7,
    "stars": 1.5,
    "numberOfReviews": 44594,
    "totalReviewsInFilter": 27673,
    "profileImageUrl": "https://...",
    "categories": [{ "id": "book_store", "name": "Book Store", "isPrimary": true }],
    "contact": {
      "email": null,
      "phone": null,
      "address": null,
      "city": null,
      "zipCode": null,
      "country": "United Kingdom"
    },
    "url": "https://www.trustpilot.com/review/www.amazon.com"
  },
  "filters": {
    "hasActiveFilters": false,
    "totalNumberOfReviews": 42158,
    "totalNumberOfFilteredReviews": 27673,
    "pagination": {
      "currentPage": 1,
      "perPage": 20,
      "totalCount": 27673,
      "totalPages": 1384
    },
    "selected": { "languages": "en", "sort": "recency" }
  },
  "reviews": [
    {
      "id": "...",
      "title": "Amazon has sunk into the gutter",
      "text": "Wow. What happened to Amazon?...",
      "rating": 1,
      "likes": 0,
      "source": "Organic",
      "language": "en",
      "isVerified": false,
      "verificationLevel": "not-verified",
      "publishedDate": "2026-03-21T07:58:50.000Z",
      "updatedDate": null,
      "experiencedDate": "2026-03-20T00:00:00.000Z",
      "consumer": {
        "id": "...",
        "displayName": "SH",
        "countryCode": "US",
        "numberOfReviews": 22,
        "isVerified": false,
        "imageUrl": null
      },
      "reply": null,
      "location": null
    }
  ],
  "pagesScraped": 1,
  "reviewsUrl": "https://www.trustpilot.com/review/www.amazon.com"
}
```

## Environment Variables

- `SOCKS5_PROXY` — Optional. SOCKS5 proxy for residential IP routing. Format: `host:port`
  - Example: `SOCKS5_PROXY=127.0.0.1:11090`
  - Recommended: Use residential proxy to avoid PerimeterX blocks

## Anti-bot Notes

- Trustpilot uses PerimeterX — camoufox fingerprinted Firefox bypasses it
- Residential proxy strongly recommended
- 20 reviews per page (from __NEXT_DATA__)
- URL format: `/review/<domain>?page=N&languages=<lang>&sort=<sort>&stars=<N>`
- No rate limiting observed (can scrape multiple pages without delay issues)

## Data Source

`__NEXT_DATA__` → `props.pageProps`:
- `businessUnit` — full business profile
- `reviews` — 20 reviews per page
- `filters` — pagination info + active filter state
- `sidebarData.infoBusinessUnitBox.contact` — contact details
