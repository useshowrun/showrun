# rightmove-search

Search Rightmove (rightmove.co.uk) for UK property listings using pure HTTP.

## How It Works

1. **Location resolution**: Fetches `/property-for-sale/{Location}.html` or `/property-to-rent/{Location}.html` which Rightmove SSR-resolves to the canonical location, embedding `__NEXT_DATA__` with the `locationIdentifier` (e.g. `REGION^87490`).
2. **Search**: Fetches `/property-for-sale/find.html?searchType=SALE&locationIdentifier=...` with optional filters. Results are embedded in `__NEXT_DATA__.props.pageProps.searchResults.properties`.
3. **Pagination**: Uses `index` parameter (0, 24, 48, ...) to paginate until `--max` results are collected.

## Usage

```bash
node rightmove-search/scripts/rightmove-search.mjs <location> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<location>` | UK place name: city, region, postcode area (e.g. "London", "Manchester", "SE1") |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--type sale\|rent` | Transaction type | `sale` |
| `--min-price <N>` | Minimum price (£) | — |
| `--max-price <N>` | Maximum price (£) | — |
| `--min-beds <N>` | Minimum bedrooms | — |
| `--max-beds <N>` | Maximum bedrooms | — |
| `--max <N>` | Max results to return | `25` |
| `--property-type <type>` | `house`, `flat`, `bungalow`, `land` | — |
| `--radius <N>` | Search radius in miles | `0.0` |

### Property Type Values

| Value | Maps to Rightmove types |
|-------|------------------------|
| `house` | detached, semi-detached, terraced, mews, etc. |
| `flat` | flat, studio |
| `bungalow` | bungalow, park-home |
| `land` | land |

## Examples

```bash
# Basic search - London properties for sale
node rightmove-search/scripts/rightmove-search.mjs London

# Rent in Manchester - 2 bed max, £2000 limit
node rightmove-search/scripts/rightmove-search.mjs Manchester --type rent --max-beds 2 --max-price 2000

# Edinburgh for sale - 3+ bed houses under £600k
node rightmove-search/scripts/rightmove-search.mjs Edinburgh --min-beds 3 --max-price 600000 --property-type house

# Flats in Oxford - get 50 results
node rightmove-search/scripts/rightmove-search.mjs Oxford --property-type flat --max 50

# Invalid location (returns clean error)
node rightmove-search/scripts/rightmove-search.mjs "NotARealPlace123"
```

## Output Schema

```json
{
  "location": {
    "locationIdentifier": "REGION^87490",
    "displayName": "London",
    "locationType": "REGION",
    "id": 87490
  },
  "searchType": "BUY",
  "totalFound": 25,
  "properties": [
    {
      "propertyId": 87729723,
      "url": "https://www.rightmove.co.uk/properties/87729723",
      "displayAddress": "Rutland Park, Catford, London, SE6",
      "bedrooms": 2,
      "bathrooms": 2,
      "propertySubType": "Flat",
      "price": {
        "amount": 370000,
        "currency": "GBP",
        "frequency": "not specified",
        "displayPrice": "£370,000",
        "qualifier": ""
      },
      "listingUpdate": {
        "reason": "price_reduced",
        "date": "2026-03-02T18:41:08Z"
      },
      "thumbnailUrl": "https://media.rightmove.co.uk:443/...",
      "featuredProperty": false,
      "isPremiumListing": false,
      "addedDate": "2026-03-22T14:47:16Z",
      "tenure": "LEASEHOLD",
      "agent": {
        "name": "Foxtons",
        "branchName": "Foxtons, Dulwich",
        "phone": "020 3909 8985",
        "branchUrl": "https://www.rightmove.co.uk/...",
        "logoUrl": "https://media.rightmove.co.uk/..."
      },
      "location": { "lat": 51.43579, "lng": -0.03302 },
      "displaySize": "724 sq. ft.",
      "channel": "BUY"
    }
  ]
}
```
