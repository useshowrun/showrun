# glassdoor-company-scraper

Scrape Glassdoor company data: overview/ratings, employee reviews, salary data, and job listings. Handles Cloudflare WAF, login overlays, rate limiting, and pagination.

---

## ⚠️ Critical: WAF Notice

Glassdoor uses **Cloudflare Managed Challenge** — ALL requests from data-center IPs, cloud VMs, VPS providers, and raw HTTP clients are blocked with HTTP 403 / persistent "Just a moment..." challenge.

| Environment | Works? |
|-------------|--------|
| Residential home/office IP | ✅ Yes |
| OpenClaw running locally on user's machine | ✅ Yes |
| Cloud VPS / AWS / Azure / data-center IP | ❌ Blocked |
| Turkish ISP data-center ranges | ❌ Blocked |
| curl / node-fetch / headless only | ❌ Always 403 |

**The only reliable method:** Connect to the user's **real Chrome browser** which has already visited Glassdoor and holds a valid `cf_clearance` cookie, running on a **residential IP**.

### How to set up (one-time):
1. Open `https://www.glassdoor.com` in your real Chrome browser — navigate at least one company page and let it fully load
2. Launch Chrome with CDP enabled (or if already open, find its debugging port):
   ```bash
   # If Chrome is already open, check if it has CDP enabled:
   curl http://localhost:9333/json/version 2>/dev/null || \
   curl http://localhost:9222/json/version 2>/dev/null
   # If not, restart Chrome:
   google-chrome-stable --remote-debugging-port=9333 --no-first-run
   ```
3. Run the skill with `--cdp-url=http://localhost:9333` (adjust port if needed)

> **If Chrome has no CDP port:** The user must restart Chrome with `--remote-debugging-port=9333`. Alternatively, use the OpenClaw browser relay if available.

> **If running on a cloud server:** This skill will NOT work — Glassdoor blocks cloud IPs at the Cloudflare level. The user must run it locally on their own machine.

**Do NOT attempt curl or node-fetch approaches** — they will always return 403.

---

## Prerequisites

- **Node.js 22+** (uses built-in `fetch`, native `WebSocket`)
- **`playwright` npm package** — install in this directory:
  ```bash
  cd skills/glassdoor/company-scraper
  npm install playwright
  ```
- **Google Chrome** (stable, not Chromium) — must be running with `--remote-debugging-port`
- User must have visited Glassdoor in Chrome recently (to have valid Cloudflare cookies)

### Check prerequisites:
```bash
node --version   # need 22+
# In skill directory:
npm install playwright 2>&1 | tail -3
curl http://localhost:9333/json/version | python3 -m json.tool
```

---

## Installation

```bash
cd skills/glassdoor/company-scraper
npm install playwright
```

No additional setup required — the script connects to your existing Chrome session automatically.

---

## Usage

### Search for a company (get company ID)
```bash
node scripts/company-scraper.mjs search <query> [options]
```

### Scrape company overview + ratings
```bash
node scripts/company-scraper.mjs overview <company-id> [options]
```

### Scrape employee reviews (paginated)
```bash
node scripts/company-scraper.mjs reviews <company-id> [options]
```

### Scrape salary data
```bash
node scripts/company-scraper.mjs salaries <company-id> [options]
```

### Scrape job listings
```bash
node scripts/company-scraper.mjs jobs <company-id> [options]
```

### Scrape all data for a company
```bash
node scripts/company-scraper.mjs all <company-id> [options]
```

---

## Options

```
--company-name=NAME   Company name (for URL construction, optional)
--page=N              Page number (default: 1)
--page-size=N         Reviews per page (default: 10, max: 50)
--sort=SORT           Review sort: DATE|HELPFUL|RATING (default: DATE)
--language=LANG       Language filter: eng|fra|deu|etc. (default: eng)
--current-only        Only reviews from current employees
--min-rating=N        Filter reviews by minimum rating (1-5)
--output=FILE         Save JSON output to file (default: stdout)
--cdp-url=URL         CDP endpoint (default: auto-detect on 9333, 9222, 9229)
--timeout=MS          Browser timeout in ms (default: 60000)
--no-cache            Skip cache and force fresh fetch
--country=CODE        Country/region: US|UK|CA|IN|AU|FR|DE (default: US)
```

---

## Examples

```bash
# Search for a company to get its ID
node scripts/company-scraper.mjs search "google"
# Returns: [{"name":"Google","id":"9079"}, ...]

# Get company overview (ratings, description, etc.)
node scripts/company-scraper.mjs overview 9079 --company-name=Google

# Get reviews (first page)
node scripts/company-scraper.mjs reviews 9079 --company-name=Google

# Get reviews (page 3, sorted by helpful)
node scripts/company-scraper.mjs reviews 9079 --page=3 --sort=HELPFUL

# Get all reviews pages 1-5
for i in 1 2 3 4 5; do
  node scripts/company-scraper.mjs reviews 9079 --page=$i --output=/tmp/reviews-p$i.json
done

# Get salary data
node scripts/company-scraper.mjs salaries 9079 --company-name=Google

# Get all data
node scripts/company-scraper.mjs all 9079 --company-name=Google --output=/tmp/google-glassdoor.json

# Connect to Chrome on non-default port
node scripts/company-scraper.mjs overview 9079 --cdp-url=http://localhost:9222
```

---

## Data output format

### Search result
```json
{
  "source": "glassdoor",
  "action": "search",
  "query": "google",
  "results": [
    { "name": "Google", "id": "9079", "url": "https://www.glassdoor.com/Overview/Working-at-Google-EI_IE9079.htm" },
    { "name": "Google Fiber", "id": "395806", "url": "..." }
  ]
}
```

### Overview result
```json
{
  "source": "glassdoor",
  "action": "overview",
  "companyId": "9079",
  "companyName": "Google",
  "fetchedAt": "2026-03-28T10:00:00Z",
  "data": {
    "id": "9079",
    "name": "Google",
    "description": "...",
    "website": "https://about.google/",
    "headquarters": "Mountain View, CA",
    "size": "10000+ employees",
    "founded": "1998",
    "industry": "Computer Hardware & Software",
    "revenue": "$10+ billion (USD) per year",
    "overallRating": 4.2,
    "ratings": {
      "culture": 4.4,
      "workLifeBalance": 3.9,
      "seniorManagement": 3.7,
      "compensation": 4.5,
      "careerOpportunities": 4.1
    },
    "ceoApproval": 91,
    "businessOutlook": 73,
    "reviewCount": 25438
  }
}
```

### Reviews result
```json
{
  "source": "glassdoor",
  "action": "reviews",
  "companyId": "9079",
  "pagination": { "currentPage": 1, "totalPages": 50, "pageSize": 10, "totalCount": 500 },
  "reviews": [
    {
      "reviewId": 12345,
      "reviewTitle": "Great place to work",
      "reviewerTitle": "Software Engineer",
      "reviewerLocation": "Mountain View, CA",
      "reviewDate": "2026-03-15",
      "isCurrentEmployee": true,
      "employmentStatus": "REGULAR",
      "ratingOverall": 5,
      "ratingCulture": 5,
      "ratingWorkLifeBalance": 4,
      "ratingSeniorManagement": 4,
      "ratingCompensation": 5,
      "ratingCareerOpportunities": 5,
      "pros": "Great benefits, smart colleagues, challenging work",
      "cons": "Large company, can be bureaucratic",
      "advice": "",
      "isRecommended": true,
      "outlook": "POSITIVE",
      "ceoApproval": "APPROVE"
    }
  ]
}
```

---

## Error codes

| Exit code | Error code | Meaning |
|-----------|-----------|---------|
| 0 | — | Success |
| 1 | `SETUP_ERROR` | Missing dependency (playwright, Chrome) |
| 1 | `COMPANY_NOT_FOUND` | No matching company in search |
| 1 | `PARSE_ERROR` | Could not extract data from page |
| 1 | `NETWORK_ERROR` | Failed to load Glassdoor page |
| 2 | `WAF_BLOCKED` | Cloudflare challenge not cleared |
| 3 | `LOGIN_REQUIRED` | Glassdoor requires login for this data |
| 3 | `RATE_LIMITED` | Too many requests — wait before retrying |

---

## How it works

1. **CDP Connect** — Connects to real Chrome via Chrome DevTools Protocol
2. **Session reuse** — Uses existing `cf_clearance` cookie (no new Cloudflare challenge)
3. **Navigate page** — Opens company URL in Chrome tab
4. **Wait for content** — Detects Cloudflare, waits for challenge to clear
5. **Extract data** — Pulls `__NEXT_DATA__` JSON or `apolloState` from HTML
6. **BFF API calls** — For reviews/pagination, calls `/bff/employer-profile-mono/employer-reviews` via browser fetch (inherits session cookies)
7. **Cache results** — Saves to `~/.local/share/showrun/data/glassdoor/cache/`

### Cloudflare detection
The script monitors for:
- Page title: "Just a moment..." → waiting for challenge
- Page title: "Security | Glassdoor" → hard block (need residential IP or new session)
- HTTP 403 responses → WAF blocked

### Login overlay detection
Glassdoor shows a login overlay after ~5 reviews but the data is still in the HTML. The script:
- Extracts data from `__NEXT_DATA__` before the overlay appears
- Uses BFF API which returns full data regardless of overlay

---

## Data storage & caching

```
~/.local/share/showrun/data/glassdoor/
├── session.json                    # Cached CDP endpoint
└── cache/
    ├── search-{query}.json         # Search results
    ├── overview-{id}.json          # Company overview
    ├── reviews-{id}-p{N}.json      # Review pages
    ├── salaries-{id}.json          # Salary data
    └── jobs-{id}-p{N}.json         # Job listings
```

Cache is valid for **1 hour** by default. Use `--no-cache` to bypass.

---

## Session expiry & rate limiting

- **Cloudflare session expires** after ~1-2 hours → re-visit Glassdoor in Chrome
- **Rate limiting:** If you see 429 or sudden 403s, wait 60 seconds before retrying
- **Login overlay:** Doesn't block scraping — data is in HTML before overlay renders

### Recovery from session expiry
```bash
# Refresh Glassdoor session in Chrome first:
# Navigate to https://www.glassdoor.com in the Chrome browser

# Then retry:
node scripts/company-scraper.mjs reviews 9079 --no-cache
```

---

## Pagination guide

### Reviews
```bash
# Get total page count from first result:
node scripts/company-scraper.mjs reviews 9079 | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(f'Total pages: {d[\"pagination\"][\"totalPages\"]}')
"

# Loop through all pages:
TOTAL=$(node scripts/company-scraper.mjs reviews 9079 | python3 -c "import json,sys; print(json.load(sys.stdin)['pagination']['totalPages'])")
for i in $(seq 1 $TOTAL); do
  node scripts/company-scraper.mjs reviews 9079 --page=$i --output=/tmp/reviews-p$i.json
  sleep 2  # Rate limit protection
done
```

### Jobs
```bash
# Jobs pagination is built-in — pass --page=N
node scripts/company-scraper.mjs jobs 9079 --page=2
```

---

## Troubleshooting

### "WAF_BLOCKED: Cloudflare challenge not cleared"
- Open Glassdoor in Chrome and navigate any company page — wait for it to fully load
- If you get a "Just a moment..." page, wait and refresh until content loads
- If the challenge never clears: your IP may be blocked (cloud/VPS/Turkish ISP range)
- Then retry the script

### "Redirected to glassdoor.nl / glassdoor.fr / etc."
Glassdoor auto-redirects to regional domains based on your IP's country. The script handles this.
If you're repeatedly landing on a non-English Glassdoor regional site with a Cloudflare challenge:
- Your IP may be in a blocked range for glassdoor.com
- Try accessing `https://www.glassdoor.com/` manually in Chrome — if you get English content, the script will work
- If Chrome shows glassdoor.nl/de/fr etc. content (not glassdoor.com), the regional API endpoints may behave differently

### "Cannot connect to Chrome CDP"
```bash
# Check if Chrome is running with CDP:
curl http://localhost:9333/json/version
# If nothing, start Chrome:
google-chrome-stable --remote-debugging-port=9333
# Then visit glassdoor.com in the browser
```

### "Empty results / no data extracted"
- The `__NEXT_DATA__` format may have changed — check the raw page:
  ```bash
  # In Chrome DevTools console: view-source:https://www.glassdoor.com/Overview/Working-at-Google-EI_IE9079.11,17.htm
  # Search for "__NEXT_DATA__" to see current structure
  ```
- Open a GitHub issue with the page URL and error details

### "LOGIN_REQUIRED"
- Some review pages require a Glassdoor account
- For basic data (overview + first page reviews), login is NOT required
- For full pagination, consider using a logged-in browser session

---

## Company ID reference

Common company IDs for testing:
| Company | ID |
|---------|-----|
| Google | 9079 |
| Apple | 1651 |
| Amazon | 6036 |
| Microsoft | 1651 |
| Meta | 40772 |
| Netflix | 11891 |
| Airbnb | 391850 |
| Tesla | 43129 |
| eBay | 7853 |
| Twitter/X | 100569 |

> Get any company's ID via: `node scripts/company-scraper.mjs search "company name"`

---

## Output handling note

**Glassdoor data can be verbose.** A full company profile with 50 reviews per page can be 500KB+. Always use `--output=FILE` for large requests:

```bash
node scripts/company-scraper.mjs all 9079 --output=/tmp/google-glassdoor.json 2>&1
# Then inspect selectively:
cat /tmp/google-glassdoor.json | python3 -m json.tool | head -50
```
