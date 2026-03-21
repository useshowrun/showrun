# Tripadvisor Agent Browser Skills

Scrape hotel listings, hotel details, and reviews from Tripadvisor.

## Prerequisites

### Residential Proxy (Required)
Tripadvisor uses Cloudflare bot detection. Datacenter/server IPs return an empty ~1.2KB body.
A residential proxy is **mandatory** for all Tripadvisor requests.

**Default proxy:** `127.0.0.1:11091` (SSH tunnel to Mahmut's desktop)

To set up the residential proxy tunnel:
```bash
ssh -f -N karacasoft@192.168.1.11 -L 127.0.0.1:11091:127.0.0.1:18081
```

Override with:
```bash
export SOCKS5_PROXY=host:port
```

### Node.js 24+
```bash
nvm use 24
```

### Install Dependencies
```bash
cd tripadvisor && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Hotel Search](tripadvisor-search/SKILL.md) | `tripadvisor-search/scripts/tripadvisor-search.mjs` | Search hotels in any city |
| [Hotel Detail](tripadvisor-hotel/SKILL.md) | `tripadvisor-hotel/scripts/tripadvisor-hotel.mjs` | Full hotel details + reviews |

## Anti-Bot Architecture

Tripadvisor uses Cloudflare bot detection with these properties:

| Endpoint | Protection | Status |
|----------|------------|--------|
| Homepage `/` | Cloudflare JS challenge | ✅ Bypassed by camoufox |
| Hotel pages `/Hotel_Review-...` | Same challenge (after warmup) | ✅ Works |
| Search page `/Search?q=...` | Cloudflare + empty body | ⚠️ Limited (returns bare shell) |
| Hotel listing `/Hotels-g...` | JS challenge | ✅ Works after homepage warmup |
| GQL `/data/graphql/ids` | Session-tied | ✅ Works after homepage warmup |

**Strategy:** Always load homepage first (warmup), then navigate to target page.

## Data Sources

### JSON-LD (Primary)
Hotel pages embed `<script type="application/ld+json">` with `@type: "LodgingBusiness"`:
- `name`, `url`, `priceRange`
- `aggregateRating` → `ratingValue`, `reviewCount`
- `address` → full PostalAddress
- `geo` → `latitude`, `longitude`
- `amenityFeatures[]` → list of amenities (stable, schema.org format)
- `image` → main hotel photo URL

### DOM Review Cards (Secondary)
Review cards use `[data-test-target="HR_CC_CARD"]` (stable test attribute):
- Author: first line contains `"{author} wrote a review {month year}"`
- Rating: `svg > title` text like `"5 of 5 bubbles"` (accessible, stable)
- Title + text: lines after contributions line
- Max: 10 reviews per page (DOM-rendered)

### Hotel Listing Cards
Links follow `a[href*="Hotel_Review"]` pattern:
- Name from link text (filter out `"(N reviews)"` links)
- geoId + locationId extracted from URL pattern `/Hotel_Review-g{geoId}-d{locationId}-Reviews`
- Rating from `svg > title` "N.N of 5 bubbles" within card container
- Review count from text regex `([\d,]+) reviews?`

### Typeahead GQL API
`POST /data/graphql/ids` with `preRegisteredQueryId` — `Typeahead_autocomplete` operation:
- Returns `locationId` (geoId) for cities, hotels, restaurants
- Triggered by typing in the search box on homepage
- Response contains `localizedName`, `placeType`, `hierarchy`

## Typical Workflow

```
1. Search hotels in city  →  CITY="Istanbul" node tripadvisor-search/scripts/tripadvisor-search.mjs
2. Get hotel details      →  HOTEL_URL="/Hotel_Review-g..." node tripadvisor-hotel/scripts/tripadvisor-hotel.mjs
```

## Known Issues

1. **Server IP blocking**: Without residential proxy → empty body (1.2KB). Always use SOCKS5_PROXY.
2. **Rate limiting**: After many requests, TA may temporarily block the IP. Add delays between requests.
3. **Review ratings in DOM**: Ratings are in `svg > title` text (not aria-label). This is stable.
4. **Geo redirect**: Tripadvisor sometimes redirects the URL to a nearby location if the locationId doesn't match the geo. The final URL is used for extraction.
5. **Photo deduplication**: Photos from `dynamic-media-cdn.tripadvisor.com` are deduplicated; avatar/default photos are excluded.

## Output Format

All scripts write `RESULT:{...json...}` to stdout. Errors write `RESULT:{error:true,...}` to stdout.
All progress logs go to stderr.

## Session Management

No authentication required. Public hotel data is accessible without login.
Set `TA_COOKIES` env var (JSON array) for authenticated access to user-specific features.
