# google-maps-place-search

Search Google Maps for businesses/places and extract structured data: name, address, phone, rating, reviews, hours, website, coordinates.

## ⚠️ No Login Required

Google Maps is publicly accessible — **no Google account or API key needed**. The skill handles the GDPR cookie consent page automatically.

## Prerequisites

- Node.js 22+
- `playwright` npm package (install below)
- Google Chrome or Chromium (`google-chrome-stable`)

## Installation

```bash
cd skills/google-maps/place-search
npm install playwright
```

> **Note:** `playwright` includes its own Chromium, but this skill prefers your installed Chrome at `/usr/bin/google-chrome-stable`. Set `CHROME_EXECUTABLE=/path/to/chrome` to override.

## Usage

### Search for businesses

```bash
node scripts/place-search.mjs search <query> [options]
```

**Examples:**
```bash
# Basic search
node scripts/place-search.mjs search "coffee shops New York"

# Get more results
node scripts/place-search.mjs search "restaurants London" --limit=30

# Also fetch full details for each result (slower — makes one extra page load per result)
node scripts/place-search.mjs search "dentists Austin TX" --details

# Save to file
node scripts/place-search.mjs search "pizza Manhattan" --output=/tmp/results.json

# Use existing Chrome browser (attach mode — see WAF section)
node scripts/place-search.mjs search "hotels Tokyo" --cdp-url=http://localhost:9222
```

### Get details for a specific place

Use a Google Maps place URL (the long URL from your browser).

```bash
node scripts/place-search.mjs details <google-maps-url> [options]
```

**Examples:**
```bash
# Get place details
node scripts/place-search.mjs details "https://www.google.com/maps/place/Empire+State+Building/@40.7484,-73.9967,17z"

# Also extract reviews
node scripts/place-search.mjs details "https://www.google.com/maps/place/..." --reviews
```

### Show help

```bash
node scripts/place-search.mjs
```

## All options

| Option | Default | Description |
|--------|---------|-------------|
| `--limit=N` | 20 | Max search results |
| `--details` | off | Fetch full details per result (slower) |
| `--reviews` | off | Extract reviews (details command only) |
| `--output=FILE` | stdout | Save JSON to file |
| `--headed` | off | Show browser window (useful for debugging) |
| `--cdp-url=URL` | — | Connect to existing Chrome via CDP |
| `--timeout=MS` | 30000 | Navigation timeout |

## How it works

1. **Browser launch** — Starts headless Chrome (or connects via CDP to an existing instance).
2. **Consent bypass** — If Google's GDPR consent page appears, the script auto-clicks "Accept".
3. **English locale** — Forces `hl=en&gl=us` URL parameters to get English-language results.
4. **DOM scraping** — Waits for the JavaScript-rendered results, then extracts from the feed.
5. **Scroll pagination** — Scrolls the results feed to load more items (Google Maps loads 20 at a time).
6. **Caching** — Results are saved to `~/.local/share/showrun/data/google-maps/cache/`.

## Output format

### Search results

```json
{
  "source": "google-maps",
  "fetchedAt": "2026-03-27T12:00:00.000Z",
  "query": "coffee shops New York",
  "pagination": {
    "page": 1,
    "limit": 20,
    "returned": 20
  },
  "results": [
    {
      "name": "Starbucks",
      "rating": 4.1,
      "reviewCount": 523,
      "type": "Coffee shop",
      "priceLevel": "$$",
      "address": "750 Lexington Ave, New York, NY 10022",
      "openStatus": "Open · Closes 10 PM",
      "url": "https://www.google.com/maps/place/Starbucks/...",
      "cid": "0x89c25905...:0x...",
      "thumbnail": "https://lh5.googleusercontent.com/..."
    }
  ]
}
```

### Place details (with `--details` or `details` command)

```json
{
  "source": "google-maps",
  "fetchedAt": "2026-03-27T12:00:00.000Z",
  "name": "Empire State Building",
  "rating": 4.7,
  "reviewCount": 148203,
  "type": "Skyscraper",
  "address": "20 W 34th St., New York, NY 10001",
  "phone": "+1 212-736-3100",
  "website": "https://www.esbnyc.com/",
  "priceLevel": "$$$",
  "openStatus": "Open · Closes 11 PM",
  "hours": {
    "Monday": "8 AM–11 PM",
    "Tuesday": "8 AM–11 PM",
    "...": "..."
  },
  "latitude": 40.7484405,
  "longitude": -73.9856644,
  "url": "https://www.google.com/maps/place/...",
  "cid": "0x89c259a9b3117469:0xd134e199a405a163",
  "photoCount": 12034,
  "reviews": [...]
}
```

## Handling rate limiting

Google Maps does not publish official rate limits, but excessive scraping triggers bot detection:

- The script adds a 1-second delay between detail page loads automatically.
- For large batches (100+ places), add delays between runs.
- If you see `WAF_BLOCKED` errors, switch to headed mode or CDP attach.

```bash
# Rate-limited safe mode: search + fetch details slowly
node scripts/place-search.mjs search "restaurants NYC" --limit=10 --details
```

## WAF / Bot detection

Google Maps uses JavaScript fingerprinting but **does NOT use Cloudflare or PerimeterX**. The script runs normally in headless Chrome. If detection occurs:

1. **Switch to headed mode** (shows browser window):
   ```bash
   node scripts/place-search.mjs search "..." --headed
   ```

2. **Use your existing Chrome** (best fingerprint):
   ```bash
   # Launch Chrome with CDP
   google-chrome-stable --remote-debugging-port=9222 --no-first-run
   # Then run with CDP URL:
   node scripts/place-search.mjs search "..." --cdp-url=http://localhost:9222
   ```

3. **Signs of WAF block:**
   - Output contains `"error": "WAF_BLOCKED"`
   - Exit code is `2`
   - Results are empty even for common queries

## Session expiry / Consent re-trigger

Google Maps doesn't require login. However, the GDPR consent cookie can expire.

**If consent is re-triggered:** The script auto-handles it. No action needed.

**If the script hangs on consent:** Run with `--headed` to debug visually.

## Pagination

Google Maps search shows results as you scroll — there are no traditional page numbers.

- `--limit=N` controls how many results to collect.
- The script scrolls the feed until it has enough results or reaches the end.
- Typical max per query: ~100-200 results (Google limits display).

```bash
# Get 50 results
node scripts/place-search.mjs search "hotels Paris" --limit=50
```

## Output handling (important for agents)

Search results can be large. **Always redirect output to a file** and read selectively:

```bash
# Save to file
node scripts/place-search.mjs search "restaurants NYC" > /tmp/results.json 2>&1

# Or use --output flag
node scripts/place-search.mjs search "restaurants NYC" --output=/tmp/results.json

# Read first few results
head -50 /tmp/results.json
# Or read from cache
head -50 ~/.local/share/showrun/data/google-maps/cache/search-restaurants_NYC.json
```

## Data storage

```
~/.local/share/showrun/data/google-maps/
└── cache/
    ├── search-coffee_shops_New_York.json
    ├── search-restaurants_London.json
    └── place-0x89c259a9b3117469_0xd134e199a405a163.json
```

## Error codes

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | Configuration/usage error |
| 2 | WAF block / bot detection |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `playwright not installed` | Run `npm install playwright` in skill dir |
| `Chrome not found` | Set `CHROME_EXECUTABLE=/path/to/chrome` |
| Empty results | Try `--headed` to see what's happening |
| WAF_BLOCKED | Use `--headed` or `--cdp-url` with real Chrome |
| Consent loop | Run with `--headed` to debug |
| Slow results | Normal — browser scraping takes 5-15 seconds per search |

## Environment variables

| Variable | Description |
|----------|-------------|
| `CHROME_EXECUTABLE` | Path to Chrome binary |
| `CHROME_CDP_URL` | CDP URL for existing Chrome instance |
| `QUIET` | Suppress debug output if set |
