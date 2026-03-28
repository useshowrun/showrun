# trustpilot-review-scraper

Scrape Trustpilot business profiles and reviews. Find businesses by domain, filter reviews by star rating, language, and date. Handles pagination, rate limiting, and WAF bot detection.

**Two modes:**
- **API mode** (preferred): Trustpilot public REST API — requires a free API key
- **CDP mode** (fallback): Chrome browser session — no API key, but ⚠️ blocked from data-center/Turkish IPs

---

## ⚠️ Critical Context

| Feature | API key needed? | CDP works from data-center IP? |
|---------|----------------|-------------------------------|
| Find business by domain | ✅ Yes | ❌ BLOCKED (WAF) |
| Get reviews (paginated) | ✅ Yes | ❌ BLOCKED (WAF) |
| Filter by stars | ✅ Yes | ❌ BLOCKED (WAF) |
| Filter by language | ✅ Yes | ❌ BLOCKED (WAF) |

**Trustpilot WAF (CloudFront)** blocks requests from:
- Data-center IP ranges (AWS, Azure, Turkish ISPs, etc.)
- Non-browser HTTP clients (curl, node-fetch without proper fingerprints)
- New Chrome tabs without cookies/session

**API mode is the recommended approach** — free API keys are available at https://developers.trustpilot.com/

**CDPmode requires:**
1. Chrome running with `--remote-debugging-port=9333` on an **unblocked (residential) IP**
2. Error: `WAF_BLOCKED` = IP is blocked — switch to API mode

---

## Prerequisites

- **Node.js 22+** (uses built-in `fetch`, `WebSocket`) — no npm dependencies needed
- Node 22 includes native `WebSocket` support, so both API mode and CDP mode work with zero npm installs

### Check Node version
```bash
node --version  # need 22+
```

---

## Setup (API Mode — Recommended)

### Step 1: Get a free API key

1. Go to https://developers.trustpilot.com/
2. Sign up for a free "Trustpilot for Business" account
3. Create an application to get your **API key (Client ID)**

### Step 2: Set the API key

```bash
export TRUSTPILOT_API_KEY=your_api_key_here
```

Or save it permanently to the session file:
```bash
# On first run, create the session file
mkdir -p ~/.local/share/showrun/data/trustpilot
echo '{"apiKey":"your_api_key_here"}' > ~/.local/share/showrun/data/trustpilot/session.json
```

### Step 3: Test it

```bash
cd skills/trustpilot/review-scraper/scripts
node review-scraper.mjs check
```

Expected output:
```
API key found: xxxx...xxxx
Testing API access...
✅ API mode works! Found: Apple
```

---

## Setup (CDP Mode — Fallback)

### ⚠️ WARNING: CDP mode is blocked from data-center IPs

If you're on a VPS, cloud instance, or Turkish ISP, CDP mode **will not work**.
You'll get: `WAF_BLOCKED: Trustpilot blocked the browser request`

CDP mode only works from residential IPs.

### Step 1: Start Chrome with remote debugging

```bash
google-chrome --remote-debugging-port=9333 &
# Then navigate to https://www.trustpilot.com in the browser
```

### Step 2: Capture session

```bash
node review-scraper.mjs auth
```

Expected output:
```
✅ CDP session captured
   Port: 9333
   Cookies: 3 Trustpilot cookies
```

If you see `WAF_BLOCKED`, your IP is blocked — use API mode instead.

---

## Usage

### Find a Business

```bash
node review-scraper.mjs search apple.com
node review-scraper.mjs search amazon.com
node review-scraper.mjs search "netflix.com"
node review-scraper.mjs search apple.com --output=json
```

Returns: business unit ID, trust score, review count, categories.

### Get Reviews

```bash
node review-scraper.mjs reviews apple.com              # page 1, 20 reviews
node review-scraper.mjs reviews apple.com --pages=3    # 3 pages (60 reviews)
node review-scraper.mjs reviews apple.com --limit=50   # max 50 reviews
```

### Filter Reviews

```bash
# By star rating (1-5, comma-separated)
node review-scraper.mjs reviews apple.com --stars=1          # only 1-star
node review-scraper.mjs reviews apple.com --stars=1,2        # 1-star and 2-star

# By language
node review-scraper.mjs reviews apple.com --lang=en          # English only
node review-scraper.mjs reviews apple.com --lang=de          # German only
node review-scraper.mjs reviews apple.com --lang=all         # all languages

# By sort order
node review-scraper.mjs reviews apple.com --sort=recency     # newest first (default)
node review-scraper.mjs reviews apple.com --sort=oldest      # oldest first
```

### JSON Output

```bash
node review-scraper.mjs reviews apple.com --output=json > out.json
node review-scraper.mjs search amazon.com --output=json
```

### Paginate

```bash
# Get pages 2-4 (skip page 1)
node review-scraper.mjs reviews apple.com --page=2 --pages=3

# Get 100 reviews total (5 pages × 20)
node review-scraper.mjs reviews amazon.com --pages=5 --output=json > amazon-reviews.json
```

---

## Output Schema

### Business Unit (from `search` or embedded in `reviews`)
```json
{
  "id": "46aa1826000064000500920e",
  "displayName": "Apple",
  "identifyingName": "www.apple.com",
  "domain": "www.apple.com",
  "numberOfReviews": 11772,
  "trustScore": 1.8,
  "stars": 2,
  "websiteUrl": "https://www.apple.com",
  "isClaimed": false,
  "isCollectingReviews": true,
  "categories": [{"id": "electronics_store", "name": "Electronics Store"}]
}
```

### Reviews response
```json
{
  "domain": "www.apple.com",
  "businessUnit": {
    "id": "46aa1826000064000500920e",
    "displayName": "Apple",
    "trustScore": 1.8,
    "stars": 2
  },
  "pagination": {
    "currentPage": 1,
    "perPage": 20,
    "totalCount": 9298,
    "totalPages": 465
  },
  "count": 20,
  "reviews": [...]
}
```

### Review object
```json
{
  "id": "69b4970dc3420330409b6ccd",
  "title": "Absolutely unacceptable",
  "text": "Absolutely unacceptable, I originally bought mine air pod max...",
  "rating": 1,
  "publishedDate": "2026-03-14T01:00:29.000Z",
  "updatedDate": null,
  "experiencedDate": "2026-03-13T00:00:00.000Z",
  "language": "en",
  "isVerified": false,
  "verificationLevel": "not-verified",
  "consumer": {
    "id": "69b496fdc9f17630aad77090",
    "displayName": "Calvin Shengtian",
    "countryCode": "US",
    "numberOfReviews": 1
  },
  "reply": null,
  "source": "Organic",
  "reviewUrl": "https://www.trustpilot.com/reviews/69b4970dc3420330409b6ccd"
}
```

---

## Data Storage

```
~/.local/share/showrun/data/trustpilot/
  session.json                  Saved API key or session config
  cache/
    business-<domain>.json      Cached business unit (1h TTL)
    reviews-<domain>-<ts>.json  Cached review results
```

---

## Rate Limiting

**Public API limits** (from Trustpilot docs):
- 833 calls per 5 minutes
- 10,000 calls per hour

The script handles rate limiting automatically:
1. Detects `429 Too Many Requests`
2. Reads `x-ratelimit-reset` header
3. Waits until reset + 2s buffer
4. Retries automatically

For high-volume scraping:
- Use `--pages=N` rather than N separate calls (each page = 1 API call)
- Cache results with `--output=json > file.json`
- Default `--perPage=20` — increase to 100 for fewer API calls

---

## Session Expiry

API keys do not expire but can be revoked. Signs of expiry:
- `API_KEY_INVALID: HTTP 401` or `HTTP 403`

**Fix:** Get a new API key from https://developers.trustpilot.com/ and update session:
```bash
echo '{"apiKey":"new_key_here"}' > ~/.local/share/showrun/data/trustpilot/session.json
```

For CDP mode, sessions expire when browser cookies are cleared:
```bash
node review-scraper.mjs auth  # re-capture session
```

---

## Error Reference

| Error | Meaning | Fix |
|-------|---------|-----|
| `WAF_BLOCKED` | IP blocked by Trustpilot CloudFront WAF | Use API mode or residential IP |
| `API_KEY_INVALID` | Bad or expired API key | Get new key from developers.trustpilot.com |
| `NO_NEXT_DATA` | Page structure changed or blocked | Check if IP is blocked |
| `HTTP 429` | Rate limited | Script auto-waits and retries |
| Chrome not found | CDP unavailable | Start Chrome with `--remote-debugging-port=9333` |
| `Auth required` | Private endpoint hit | Use API mode with valid key |
| Business not found | Domain not on Trustpilot | Try without `www.` prefix |

---

## WAF / Bot Detection Details

Trustpilot uses **AWS CloudFront WAF** with aggressive bot detection:

- **Blocked**: All data-center IPs, Turkish ISP ranges, headless browsers (Playwright/Puppeteer without fingerprinting)
- **Blocked**: Standard `curl`, `axios`, `node-fetch` HTTP clients (TLS fingerprint mismatch)
- **Allowed**: Residential IPs with real Chrome/Firefox TLS fingerprint + cookies
- **Allowed**: Valid API key requests (separate endpoint, different WAF rules)

Error response when blocked:
```json
{"error":true,"message":"Your request has been blocked as it has been identified as coming from a bot that's against our terms of service."}
HTTP 403 (CloudFront)
```

**Why camoufox doesn't help**: The block is at the IP level, not the browser fingerprint level. Even camoufox (stealth Firefox) is blocked from data-center/blocked IPs.

---

## Typical Workflows

### Analyze a company's negative reviews
```bash
export TRUSTPILOT_API_KEY=your_key
node review-scraper.mjs search apple.com
node review-scraper.mjs reviews apple.com --stars=1,2 --pages=5 --output=json > apple-bad-reviews.json
```

### Competitive analysis
```bash
for domain in apple.com samsung.com microsoft.com; do
  node review-scraper.mjs search $domain --output=json >> competitive.json
  sleep 2
done
```

### Full review dump
```bash
node review-scraper.mjs reviews amazon.com --pages=50 --lang=en --output=json > amazon-en-reviews.json
```

### Get recent reviews
```bash
node review-scraper.mjs reviews netflix.com --sort=recency --pages=3 --output=json
```

---

## API Reference

### Trustpilot Public API Endpoints Used

**Find business unit by domain:**
```
GET https://api.trustpilot.com/v1/business-units/find?name={domain}
Header: apikey: YOUR_KEY
```

**Get reviews:**
```
GET https://api.trustpilot.com/v1/business-units/{id}/reviews
Header: apikey: YOUR_KEY
Query: page, perPage, stars, language, orderBy
```

**Key notes:**
- `page` starts at 1 (not 0)
- `perPage` max is 100
- `stars` accepts comma-separated values: `1,2,3,4,5`
- `language` accepts ISO codes (`en`, `de`, `fr`) or `all`
- `orderBy` values: `createdat.desc`, `createdat.asc`

**Rate limit:** 833 calls/5min, 10K calls/hour

---

## Next.js Data Structure (CDP Mode Reference)

The Trustpilot web app is built with Next.js. When loading a review page, data is embedded in:
```javascript
document.getElementById('__NEXT_DATA__').textContent  // JSON string
```

Key paths:
```javascript
data.props.pageProps.businessUnit   // Business unit info
data.props.pageProps.reviews        // Array of 20 reviews
data.props.pageProps.filters        // Pagination and filter state
data.buildId                        // Next.js build ID (changes with deployments)
```

URL parameters for filtering:
```
https://www.trustpilot.com/review/{domain}?page=2&stars=1&languages=en&sort=recency
```
