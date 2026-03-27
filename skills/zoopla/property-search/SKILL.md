# zoopla-property-search

Search Zoopla for UK property listings (for sale, to rent, or sold prices). Handles Cloudflare Turnstile WAF automatically using Playwright with a real Chrome browser.

## ⚠️ Critical: WAF Notice

Zoopla uses **Cloudflare Turnstile (managed challenge)** — ALL requests from fresh/datacenter IPs are blocked.

**The only reliable method:** Connect to the user's real Chrome browser (which has already visited Zoopla and has a valid `cf_clearance` cookie).

### How to set up (one-time):
1. Open Zoopla in your real Chrome browser and navigate a search page until it loads fully
2. Launch Chrome with CDP enabled:
   ```bash
   google-chrome-stable --remote-debugging-port=9222 --no-first-run
   ```
   OR if Chrome is already open, find its CDP URL from `chrome://flags` or use the OpenClaw browser relay
3. Run the skill with `--cdp-url=http://localhost:9222`

> **Alternative:** On a machine where the user browses normally, `cf_clearance` cookies persist for hours. The script can reuse these.

**Do NOT attempt curl or fetch-based approaches** — they will always return 403.

## Prerequisites

- Node.js 22+
- `playwright` npm package (`npm install playwright` in the skill directory)
- Google Chrome (`google-chrome-stable`) — must be launched with `--remote-debugging-port=9222`
- The user must have visited Zoopla in Chrome recently (to have valid Cloudflare cookies)

> On server environments without a real user session, use the OpenClaw browser relay (see `--cdp-url` option).

## Installation

```bash
cd skills/zoopla/property-search
npm install playwright
```

## Usage

### Search for-sale listings

```bash
node scripts/property-search.mjs sale <location> [options]
```

### Search to-rent listings

```bash
node scripts/property-search.mjs rent <location> [options]
```

### Fetch sold house prices

```bash
node scripts/property-search.mjs sold <location> [options]
```

### Options

```
--page=N          Page number (default: 1)
--page-size=N     Results per page (default: 25, max: 25)
--beds-min=N      Minimum bedrooms
--beds-max=N      Maximum bedrooms
--price-min=N     Minimum price (£)
--price-max=N     Maximum price (£)
--type=TYPE       Property type: house|flat|bungalow|land|commercial
--sort=SORT       Sort: newest|price-asc|price-desc (default: newest)
--radius=R        Search radius in miles: 0|0.25|0.5|1|3|5|10|15|20|30|40
--output=FILE     Save JSON output to file (default: stdout)
--cdp-url=URL     Use existing Chrome via CDP (e.g. http://localhost:9222)
--timeout=MS      Browser timeout in ms (default: 45000)
```

**Examples:**

```bash
# For-sale in London, 2+ beds under £500k
node scripts/property-search.mjs sale London --beds-min=2 --price-max=500000

# Page 2 of rentals in Manchester
node scripts/property-search.mjs rent Manchester --page=2

# Sold prices in postcode SW1A
node scripts/property-search.mjs sold SW1A

# Save to file
node scripts/property-search.mjs sale london --output=/tmp/zoopla-results.json

# Use existing Chrome (attach by running Chrome with --remote-debugging-port=9222)
node scripts/property-search.mjs sale london --cdp-url=http://localhost:9222
```

### Show help

```bash
node scripts/property-search.mjs
```

## How it works

1. **Browser launch** — Starts real (non-headless) Google Chrome via Xvfb, OR connects to an existing Chrome via CDP if `--cdp-url` is provided.

2. **Cloudflare bypass** — Navigates to the Zoopla URL and waits up to 45 seconds for the Cloudflare Turnstile managed challenge to auto-resolve. CF completes the challenge automatically once it recognises a real browser via JavaScript fingerprinting. If CF does not resolve within the timeout, the script exits with a WAF error.

3. **Data extraction** — Extracts property data from the `__NEXT_DATA__` JSON embedded in every Zoopla page (Next.js app). This is the authoritative data source — same data the browser renders. Falls back to DOM scraping if `__NEXT_DATA__` is absent.

4. **Pagination** — Use `--page=N` to fetch additional pages. Total results are shown in the output metadata.

5. **Output** — Prints normalised JSON to stdout (or `--output` file).

## Output format

```json
{
  "source": "zoopla",
  "fetchedAt": "2024-01-15T12:00:00.000Z",
  "query": {
    "type": "sale",
    "location": "london",
    "page": 1,
    "pageSize": 25
  },
  "pagination": {
    "currentPage": 1,
    "pageSize": 25,
    "totalResults": 1000,
    "totalPages": 40
  },
  "properties": [
    {
      "id": "12345678",
      "status": "sale",
      "url": "https://www.zoopla.co.uk/for-sale/details/12345678/",
      "price": 450000,
      "priceLabel": "£450,000",
      "address": "1 Example Street, London SW1A 1AA",
      "postcode": "SW1A 1AA",
      "latitude": 51.5074,
      "longitude": -0.1278,
      "bedrooms": 3,
      "bathrooms": 2,
      "propertyType": "Semi-detached house",
      "tenure": "Freehold",
      "description": "A beautiful property...",
      "features": ["Garden", "Parking", "Chain free"],
      "images": ["https://lid.zoocdn.com/645/430/abc123.jpg"],
      "agent": {
        "name": "Example Estates",
        "phone": "020 7123 4567"
      },
      "dateAdded": "2024-01-10T00:00:00.000Z",
      "dateReduced": null
    }
  ]
}
```

## Error handling

| Error | Meaning | Fix |
|-------|---------|-----|
| `WAF_BLOCKED` | Cloudflare challenge not resolved in time | Increase `--timeout`, check Chrome is not headless |
| `NO_CHROME` | Chrome/Chromium not found | Install `google-chrome-stable` |
| `NO_XVFB` | Xvfb not available | Install `xorg-server-xvfb` |
| `SESSION_EXPIRED` | CF cookies expired | Re-run (script handles this automatically) |
| `NO_RESULTS` | No listings found | Try broader search, different location |
| `RATE_LIMITED` | Too many requests | Add delay between calls, the script retries |

## Detecting WAF blocks

The script prints `[WAF] Cloudflare block detected` to stderr when blocked. The exit code will be `2`.

To programmatically detect: check `result.error.code === 'WAF_BLOCKED'` in the JSON output (when using `--output`).

## Rate limiting

Zoopla has no documented rate limits. The script adds:
- 1.5s delay between page navigations
- Exponential backoff on 403: 2s → 4s → 8s (max 3 retries)

Don't run more than 1 instance per browser session.

## Data storage

```
~/.local/share/showrun/data/zoopla/
└── cache/
    └── sale-london-p1.json         # Cached results
    └── rent-manchester-p2.json
    └── sold-SW1A.json
```

## Session expiry / forced logout

Zoopla doesn't require login — Cloudflare session cookies (`cf_clearance`) are sufficient. These typically last 1-24 hours.

If you get `WAF_BLOCKED`:
1. **Open Chrome** on your normal machine and visit `https://www.zoopla.co.uk/` — wait for it to load
2. Launch Chrome with CDP: `google-chrome-stable --remote-debugging-port=9222`
3. Re-run the skill with `--cdp-url=http://localhost:9222`

The `cf_clearance` cookie obtained this way is valid for hours and the skill will reuse it automatically.

## Limitations

- Max 25 results per page (Zoopla's limit)
- Typically up to ~1000 total results per search (Zoopla limits display)
- Images: uses `lid.zoocdn.com` CDN, sizes: `354/255`, `645/430`, `800/600`
- Cloudflare challenge can take 5–20 seconds to auto-resolve on a fresh session
