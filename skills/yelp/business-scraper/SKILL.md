# yelp-business-scraper

Scrape business search results, business details, and reviews from Yelp.

**No login required.** Uses Chrome CDP to bypass DataDome WAF.

---

## Prerequisites

- Node.js 18+
- Chrome/Chromium running with remote debugging enabled:
  ```bash
  google-chrome --remote-debugging-port=9333 --no-first-run --no-default-browser-check &
  # or if already running, check: curl http://127.0.0.1:9333/json/version
  ```
- `ws` npm package:
  ```bash
  cd skills/yelp/business-scraper/scripts && npm install ws
  # or globally: npm install -g ws
  ```

---

## Setup

```bash
# Check Chrome CDP is accessible
curl http://127.0.0.1:9333/json/version

# Install dependencies (from scripts dir)
cd skills/yelp/business-scraper/scripts
npm install ws
```

### Environment Variables (optional)

| Variable    | Default       | Description           |
|-------------|---------------|-----------------------|
| `CDP_PORT`  | `9333`        | Chrome CDP port       |
| `CDP_HOST`  | `127.0.0.1`   | Chrome CDP host       |

---

## Commands

### Search Businesses

```bash
node scripts/business-scraper.mjs search "<query>" "<location>"
```

**Parameters:**
- `<query>` — What to search (e.g., "restaurants", "coffee shops", "plumbers")
- `<location>` — Where to search (e.g., "San Francisco, CA", "New York, NY")

**Options:**
- `--start=N` — Pagination offset (default: 0). Use 0, 10, 20, 30... (10 results/page)
- `--sortby=S` — Sort order: `best_match` (default), `rating`, `review_count`, `distance`
- `--limit=N` — Max results to return

**Examples:**
```bash
# Basic search
node scripts/business-scraper.mjs search "restaurants" "San Francisco, CA"

# Sorted by rating, starting at page 2
node scripts/business-scraper.mjs search "pizza" "New York, NY" --sortby=rating --start=10

# First 5 results
node scripts/business-scraper.mjs search "coffee" "Chicago, IL" --limit=5
```

**Output schema:**
```json
{
  "query": "restaurants",
  "location": "San Francisco, CA",
  "start": 0,
  "sortby": "best_match",
  "totalFound": 13,
  "businesses": [
    {
      "ranking": 1,
      "bizId": "BI40rGhpngLNPacrjWpseQ",
      "alias": "dumpling-kitchen-san-francisco",
      "name": "Dumpling Kitchen",
      "url": "https://www.yelp.com/biz/dumpling-kitchen-san-francisco",
      "rating": 4.1,
      "reviewCount": 2300,
      "phone": "(415) 682-8938",
      "priceRange": "$$",
      "categories": ["Chinese"],
      "neighborhoods": ["Parkside"],
      "isAd": false
    }
  ]
}
```

---

### Get Business Details

```bash
node scripts/business-scraper.mjs get <business-alias>
```

The `business-alias` is the URL slug from Yelp (e.g., `gary-danko-san-francisco` from `yelp.com/biz/gary-danko-san-francisco`).

**Examples:**
```bash
node scripts/business-scraper.mjs get gary-danko-san-francisco
node scripts/business-scraper.mjs get nopalito-san-francisco
```

**Output schema:**
```json
{
  "encid": "WavvLdfdP6g8aZTtbBQHTw",
  "alias": "gary-danko-san-francisco",
  "name": "Gary Danko",
  "url": "https://www.yelp.com/biz/gary-danko-san-francisco",
  "rating": 4.5,
  "reviewCount": 6113,
  "phone": "(415) 749-2060",
  "priceRange": "$$$$",
  "categories": [
    {"title": "New American", "alias": "newamerican"},
    {"title": "French", "alias": "french"}
  ],
  "address": {
    "street": "800 N Point St",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94109",
    "formatted": "800 N Point St\nSan Francisco, CA 94109"
  },
  "hours": {
    "today": ["5:00 PM - 10:00 PM"],
    "isOpenNow": false,
    "hasSpecialHours": false
  },
  "isClosed": false,
  "neighborhoods": ["Russian Hill", "Fisherman's Wharf"]
}
```

---

### Get Business Reviews

```bash
node scripts/business-scraper.mjs reviews <business-alias>
```

**Options:**
- `--pages=N` — Number of pages to scrape (10 reviews/page, default: 1)
- `--sort=S` — Sort order: `RELEVANCE_DESC` (default), `DATE_DESC`, `RATING_ASC`, `RATING_DESC`

**Examples:**
```bash
# First 10 reviews (1 page)
node scripts/business-scraper.mjs reviews gary-danko-san-francisco

# 30 most recent reviews (3 pages)  
node scripts/business-scraper.mjs reviews gary-danko-san-francisco --pages=3 --sort=DATE_DESC

# Save to file
node scripts/business-scraper.mjs reviews gary-danko-san-francisco --pages=5 > /tmp/reviews.json
```

**Output schema:**
```json
{
  "business": {
    "encid": "WavvLdfdP6g8aZTtbBQHTw",
    "alias": "gary-danko-san-francisco",
    "name": "Gary Danko",
    "rating": 4.5,
    "totalReviewCount": 6115
  },
  "sortBy": "RELEVANCE_DESC",
  "pagesScraped": 1,
  "reviewsReturned": 10,
  "reviews": [
    {
      "encid": "anq7Zl8a27NFAP0FqG9cVA",
      "rating": 5,
      "text": "Gary Danko has been on my list for a while...",
      "language": "en",
      "author": {
        "encid": "rroYLaikz03UdBeUjBkCpQ",
        "displayName": "MoonDance B.",
        "location": "Toronto, Canada",
        "reviewCount": 1,
        "isElite": false
      },
      "createdAt": "2026-03-26T17:45:14-07:00",
      "photoCount": 3
    }
  ]
}
```

---

## How It Works

Yelp uses **DataDome WAF** that blocks direct HTTP requests (curl, requests, etc.).

The scraper uses **Chrome CDP (Chrome DevTools Protocol)** to:
1. **Search results** — Load the Yelp search page; extract business list from `window.yelp.react_root_props` (Server-Side Rendered JSON embedded in HTML).
2. **Business details** — Load the business page; extract from the Apollo GraphQL cache embedded in the SSR HTML. Also intercepts the `/biz/{id}/props` API response.
3. **Reviews** — Load the business page to establish cookies, then use `fetch()` from within the page's JavaScript context (same-origin, DataDome bypass) to call the `/gql/batch` GraphQL endpoint with the `GetBusinessReviewFeed` operation.

### GraphQL Endpoints Used

| Operation | Endpoint | documentId |
|-----------|----------|------------|
| `GetBusinessReviewFeed` | `POST /gql/batch` | `6c42e4744b662c607dddf3031426e89c8ad492ee98fd3c8ef778787ae898247b` |
| `GetLocalBusinessJsonLinkedData` | `POST /gql/batch` | `619b0b64de025819cc6f695f2641c72b6f48fae5ff57c92bb5437314203fdafc` |
| `GetBusinessHours` | `POST /gql/batch` | `3a647e54dc8a46dfe3992682c5cc4d184e3731cdf2ecd9a2e24d6bc03c2fbb35` |

> **Note:** Yelp uses persisted GQL queries with `documentId` (content hashes). These IDs may change when Yelp deploys new frontend code. If requests fail with 400/422, the documentIds need to be re-discovered (re-run the discovery scripts in `/tmp/discovery/`).

---

## Pagination

### Search Pagination
```bash
# Page 1 (results 1-10)
node scripts/business-scraper.mjs search "restaurants" "SF, CA" --start=0

# Page 2 (results 11-20)
node scripts/business-scraper.mjs search "restaurants" "SF, CA" --start=10

# Page 3 (results 21-30)
node scripts/business-scraper.mjs search "restaurants" "SF, CA" --start=20
```

### Review Pagination
Reviews use cursor-based pagination internally. Use `--pages=N` to get more:
```bash
# 50 reviews (5 pages × 10)
node scripts/business-scraper.mjs reviews gary-danko-san-francisco --pages=5
```

---

## WAF / Rate Limiting

- **DataDome** blocks direct HTTP requests — CDP browser is required
- Add delays between page loads (already 2s minimum between review pages)
- If WAF is detected, the error message will say `WAF_BLOCKED`
- Exit code `2` = WAF blocked; exit code `1` = other error

---

## Data Storage

Results are cached at:
```
~/.local/share/showrun/data/yelp/cache/
├── search-{timestamp}.json
├── biz-{alias}.json
└── reviews-{alias}.json
```

---

## Output Handling (for agents)

Business details and reviews can be large. Best practices:
1. **Redirect to file:**
   ```bash
   node scripts/business-scraper.mjs reviews gary-danko-san-francisco --pages=5 > /tmp/reviews.json
   ```
2. **Summarize in your own words** — don't paste full JSON into conversation
3. **Use jq to filter:**
   ```bash
   cat /tmp/reviews.json | jq '.reviews[] | {rating, text: .text[:100], author: .author.displayName}'
   ```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `CDP not available at 127.0.0.1:9333` | Chrome not running with debugging | Start Chrome with `--remote-debugging-port=9333` |
| `WAF_BLOCKED` | DataDome detected bot | Wait 5-10 min, retry |
| `documentIds need re-discovery` | GQL hashes changed | Re-run `yelp-capture-gql2.mjs` from `/tmp/discovery/` |
| `Could not extract page data` | SSR structure changed | Check page HTML structure, update extraction logic |
| `Missing dependency: npm install ws` | ws not installed | `cd scripts && npm install ws` |
