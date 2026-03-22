# realtor-search

Search Realtor.com US real estate listings by location with optional price, bed, bath, and property type filters.

## Usage

```bash
# CLI args
node scripts/realtor-search.mjs "Austin, TX" --max-price 500000 --beds 3 --baths 2

# JSON input
node scripts/realtor-search.mjs '{"location":"Austin, TX","maxPrice":500000,"beds":3}'

# With proxy
SOCKS5_PROXY=127.0.0.1:11090 node scripts/realtor-search.mjs "San Francisco, CA" --max 20

# Zip code
node scripts/realtor-search.mjs 78701 --beds 2 --max 10
```

## Args

| Arg | Type | Description |
|-----|------|-------------|
| `location` | string (required) | City+state ("Austin, TX" or "Austin_TX") or zip code |
| `--min-price N` | number | Minimum list price |
| `--max-price N` | number | Maximum list price |
| `--beds N` | number | Minimum bedrooms |
| `--baths N` | number | Minimum bathrooms |
| `--type TYPE` | string | Property type: house\|condo\|townhome\|land |
| `--max N` | number | Max results (default: 42) |
| `--pages N` | number | Pages to scrape (default: 1, ~42 listings/page) |

## Output

```json
{
  "location": "Austin, TX",
  "normalizedLocation": "Austin_TX",
  "searchUrl": "https://www.realtor.com/realestateandhomes-search/Austin_TX/",
  "totalCount": 2847,
  "pagesScraped": 1,
  "hasMore": true,
  "listings": [
    {
      "listingId": "2926792989",
      "propertyId": "M2926792989",
      "price": 425000,
      "beds": 3,
      "baths": 2,
      "sqft": 1450,
      "address": { "street": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701" },
      "propertyType": "single_family",
      "listingStatus": "for_sale",
      "daysOnMarket": 5,
      "url": "https://www.realtor.com/realestateandhomes-detail/...",
      "thumbnailUrl": "https://ap.rdcpix.com/...",
      "lat": 30.2672,
      "lng": -97.7431,
      "listingDate": "2026-03-17"
    }
  ]
}
```
