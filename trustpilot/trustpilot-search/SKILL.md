# trustpilot-search

Search for businesses on Trustpilot by query string.

## Usage

```bash
node trustpilot-search.mjs '<JSON input>'
```

## Input (JSON)

```json
{
  "query": "amazon",           // Required — business name or domain to search
  "maxResults": 10,            // Optional — max number of results (default: 10, max: 100)
  "page": 1,                   // Optional — page number (default: 1)
  "country": "US"              // Optional — country filter (e.g. "US", "GB", "DE")
}
```

Or use environment variables:
```bash
QUERY="amazon" MAX_RESULTS=10 node trustpilot-search.mjs
```

## Output

```json
RESULT:{
  "query": "amazon",
  "country": "US",
  "totalHits": 576,
  "totalPages": 58,
  "currentPage": 1,
  "businesses": [
    {
      "businessUnitId": "46ad346800006400050092d0",
      "domain": "www.amazon.com",
      "name": "Amazon",
      "numberOfReviews": 44594,
      "trustScore": 1.7,
      "stars": 1.5,
      "location": { "country": "United Kingdom" },
      "contact": { "website": "https://www.amazon.com" },
      "categories": [{ "id": "book_store", "name": "Book Store", "isPrimary": true }],
      "url": "https://www.trustpilot.com/review/www.amazon.com"
    }
  ]
}
```

## Environment Variables

- `SOCKS5_PROXY` — Optional. SOCKS5 proxy for residential IP routing. Format: `host:port`
  - Example: `SOCKS5_PROXY=127.0.0.1:11090`
  - Recommended: Use residential proxy to avoid PerimeterX blocks

## Anti-bot Notes

- Trustpilot uses PerimeterX — camoufox fingerprinted Firefox bypasses it
- Residential proxy recommended for reliability
- Search page (`/search?query=...`) loads cleanly in browser
- All data in `__NEXT_DATA__` JSON — no additional API calls needed
- Also intercepts `/api/consumersitesearch-api/businessunits/search` for extended results

## Data Source

`__NEXT_DATA__` → `props.pageProps.businessUnits` — array of business units matching the query.
Also: `/api/consumersitesearch-api/businessunits/search?query=...&page=...&pageSize=...`
