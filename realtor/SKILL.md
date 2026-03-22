# Realtor.com Scraper

Scrapes US real estate listings from Realtor.com — search by location with price/bed/bath filters, and get full property details.

## Skills

| Skill | Description |
|-------|-------------|
| `realtor-search` | Search listings by location with price/bed/bath filters |
| `realtor-listing` | Full property details from a listing URL |

## Quick Start

```bash
cd realtor
npm install  # first time only
source ~/.nvm/nvm.sh && nvm use 24

# Search listings in Austin, TX
node realtor-search/scripts/realtor-search.mjs "Austin, TX" --max-price 500000 --beds 3

# With residential proxy
SOCKS5_PROXY=127.0.0.1:11090 node realtor-search/scripts/realtor-search.mjs "Austin, TX" --beds 2 --max 20

# Get full property details
node realtor-listing/scripts/realtor-listing.mjs "https://www.realtor.com/realestateandhomes-detail/..."
```

## Anti-bot Notes

Realtor.com uses moderate bot detection. Camoufox (fingerprinted Firefox) bypasses it reliably.

| Endpoint | Protection | Status |
|----------|------------|--------|
| `/realestateandhomes-search/...` | Cloudflare/custom | ✅ Bypassed by camoufox |
| `/realestateandhomes-detail/...` | Cloudflare/custom | ✅ Bypassed by camoufox |

**Residential proxy recommended** for production use.
- Set `SOCKS5_PROXY=127.0.0.1:11090`

## Data Sources

All data comes from `__NEXT_DATA__` (Next.js SSR JSON embedded in HTML):
- `props.pageProps.properties` — search result listings array
- `props.pageProps.totalCount` — total matching results
- `props.pageProps.property` — full property detail object

**Fallback:** JSON-LD `<script type="application/ld+json">` for basic property info.

## URL Format

### Search URLs
```
/realestateandhomes-search/{City_ST}/
/realestateandhomes-search/{City_ST}/price-na-500000/beds-2/baths-1/
/realestateandhomes-search/{City_ST}/price-200000-500000/type-single-family/pg-2/
```

Supported filter path segments:
- `price-na-500000` — max price
- `price-200000-500000` — price range
- `beds-2` — min bedrooms
- `baths-1` — min bathrooms
- `type-single-family`, `type-condos`, `type-townhomes`, `type-land`
- `pg-2`, `pg-3` — pagination

### Detail URLs
```
/realestateandhomes-detail/{slug}/
```

## Structure

```
realtor/
  SKILL.md          ← this file
  package.json
  lib/
    utils.mjs       ← shared browser/data helpers
  realtor-search/
    SKILL.md
    scripts/
      realtor-search.mjs
  realtor-listing/
    SKILL.md
    scripts/
      realtor-listing.mjs
```

## Session Log

### 2026-03-22 (scraper-skill-builder-realtor subagent)
- Built using __NEXT_DATA__ extraction (Next.js SSR)
- Camoufox bypasses Realtor.com bot detection
- Search: `props.pageProps.properties` array with full listing objects
- Detail: `props.pageProps.property` with nested description, photos, details, advertisers
- Fallback: JSON-LD structured data for basic listing info
- XHR intercept implemented as secondary fallback for API responses
