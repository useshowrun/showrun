# Airbnb — Skill Suite

Search and scrape Airbnb property listings and details.

## Skills

| Skill | Script | Purpose |
|-------|--------|---------|
| `airbnb-search` | `airbnb-search/scripts/airbnb-search.mjs` | Search property listings by location and dates |
| `airbnb-listing` | `airbnb-listing/scripts/airbnb-listing.mjs` | Get full details for a single listing |

## Architecture

### Anti-bot strategy
Airbnb does **not** use third-party bot detection (no DataDome, no Cloudflare challenge).
All data is **server-side rendered (SSR)** into an embedded `<script type="application/json">`
tag with `data-deferred-state-0="true"`. No JavaScript execution or interaction is needed —
just load the page and parse the script tag.

### Key selectors
- **SSR data**: `script[data-deferred-state-0="true"]` (or `#data-deferred-state-0`)
- **JSON-LD fallback**: `script[type="application/ld+json"]`
- **Stable `data-testid` attributes**: `listing-card-title`, `listing-card-name`, etc.
- **Listing links**: `a[href^="/rooms/"]`

### Data structure
```
niobeClientData = [
  ["StaysSearch:{...}", { data: { presentation: { staysSearch: { results: { searchResults: [...] } } } } }]
  // or
  ["StaysPdpSections:{...}", { data: { presentation: { stayProductDetailPage: { sections: {...} } }, node: {...} } }]
]
```

### Search pagination
- 18 results per page
- Next page: add `&items_offset=18` (then 36, 54, 72...)
- Max ~90 results total (5 pages)

### Listing room ID
The room ID (for `/rooms/{id}` URLs) is stored in:
```
searchResult.demandStayListing.id  → base64 decode → "DemandStayListing:12345" → "12345"
```

## Setup

```bash
cd airbnb
npm install
```

## Usage

### Search
```bash
echo '{"location":"New York, NY, United States","checkin":"2026-04-10","checkout":"2026-04-11","adults":2,"maxPages":2}' \
  | node airbnb-search/scripts/airbnb-search.mjs
```

With proxy:
```bash
SOCKS5_PROXY=127.0.0.1:11091 node airbnb-search/scripts/airbnb-search.mjs '{"location":"Paris, France","maxPages":1}'
```

### Listing detail
```bash
echo '{"listingId":"1158653190110852406","checkin":"2026-04-10","checkout":"2026-04-11","adults":2}' \
  | node airbnb-listing/scripts/airbnb-listing.mjs
```

## ENV Variables
| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | Optional residential proxy, e.g. `127.0.0.1:11091` |

## Output format

All scripts output `RESULT:{json}` to **stdout**, logs to **stderr**.

## Known Limitations
- Prices only shown when check-in/checkout dates are provided
- No review text extraction (only summary ratings)
- Host contact info requires login
- Max ~90 results per search query (Airbnb API limit)
- IP-based geo-detection may affect currency/locale (use `currency=USD` param)
