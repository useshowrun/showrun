# realtor-listing

Get full property details from a Realtor.com listing URL.

## Usage

```bash
# CLI URL arg
node scripts/realtor-listing.mjs "https://www.realtor.com/realestateandhomes-detail/..."

# JSON input
node scripts/realtor-listing.mjs '{"url":"https://www.realtor.com/realestateandhomes-detail/..."}'

# With proxy
SOCKS5_PROXY=127.0.0.1:11090 node scripts/realtor-listing.mjs "https://..."
```

## Args

| Arg | Type | Description |
|-----|------|-------------|
| `url` | string (required) | Full Realtor.com listing URL |

## Output

```json
{
  "listingId": "2926792989",
  "propertyId": "M2926792989",
  "price": 425000,
  "address": { "street": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701" },
  "beds": 3,
  "baths": 2,
  "sqft": 1450,
  "lotSize": 5000,
  "yearBuilt": 2002,
  "propertyType": "single_family",
  "listingStatus": "for_sale",
  "daysOnMarket": 5,
  "listingDate": "2026-03-17",
  "url": "https://www.realtor.com/realestateandhomes-detail/...",
  "thumbnailUrl": "https://ap.rdcpix.com/...",
  "lat": 30.2672,
  "lng": -97.7431,
  "description": "Beautiful 3BR home with...",
  "images": ["https://ap.rdcpix.com/...", "..."],
  "features": {
    "Interior": ["Hardwood floors", "Granite counters"],
    "Exterior": ["Deck", "Attached garage"]
  },
  "agentName": "Jane Smith",
  "agentPhone": "512-555-1234",
  "agentBrokerage": "Keller Williams",
  "hoaFee": 150,
  "taxHistory": [{"year": 2025, "amount": 8500}],
  "priceHistory": [],
  "nearbySchools": [
    { "name": "Austin Elementary", "rating": 8, "grades": "K-5", "distance": 0.4, "type": "elementary" }
  ]
}
```
