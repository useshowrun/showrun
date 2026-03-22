# rightmove-listing

Fetch full property details from a Rightmove listing using pure HTTP.

## How It Works

Fetches `https://www.rightmove.co.uk/properties/<id>` which embeds:
```js
window.PAGE_MODEL = { propertyData: { ... } };
```
in the HTML. The `propertyData` object contains all listing details including
description, images, floorplans, key features, tenure, stations, and agent info.

## Usage

```bash
node rightmove-listing/scripts/rightmove-listing.mjs <property-url-or-id>
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<property-url-or-id>` | Rightmove property URL or numeric ID |

### Accepted Formats

```
87729723
https://www.rightmove.co.uk/properties/87729723
https://www.rightmove.co.uk/properties/87729723#/?channel=RES_BUY
```

## Examples

```bash
# By property ID
node rightmove-listing/scripts/rightmove-listing.mjs 87729723

# By full URL
node rightmove-listing/scripts/rightmove-listing.mjs "https://www.rightmove.co.uk/properties/87729723"

# Invalid ID returns clean error
node rightmove-listing/scripts/rightmove-listing.mjs 00000000
```

## Output Schema

```json
{
  "propertyId": "87729723",
  "url": "https://www.rightmove.co.uk/properties/87729723",
  "displayAddress": "Rutland Park, Catford, London, SE6",
  "bedrooms": 2,
  "bathrooms": 2,
  "propertySubType": "Flat",
  "transactionType": "buy",
  "channel": "BUY",
  "description": "Arranged over 2 floors, this 2 bedroom house...",
  "summary": null,
  "keyFeatures": [
    "Wonderful 2 bedroom house arranged over 2 floors",
    "Large reception room",
    "Delightful private garden"
  ],
  "price": {
    "primary": "£370,000",
    "secondary": null,
    "qualifier": "",
    "perSqFt": "£511.05 per sq ft"
  },
  "location": {
    "lat": 51.43579,
    "lng": -0.03302,
    "outcode": "SE6",
    "incode": "4LH",
    "ukCountry": "England"
  },
  "images": [
    { "url": "https://media.rightmove.co.uk/...", "srcUrl": "...", "caption": null }
  ],
  "floorplans": [
    { "url": "https://media.rightmove.co.uk/...", "caption": null }
  ],
  "virtualTourUrl": null,
  "tenure": {
    "type": "LEASEHOLD",
    "yearsRemaining": 91,
    "message": null
  },
  "livingCosts": {
    "councilTaxBand": null,
    "councilTaxExempt": false,
    "annualGroundRent": 50,
    "annualServiceCharge": 709.52,
    "groundRentReviewPeriodYears": null
  },
  "nearestStations": [
    {
      "name": "Bellingham Station",
      "types": ["NATIONAL_TRAIN"],
      "distance": 0.614,
      "unit": "miles"
    }
  ],
  "nearestAirports": [],
  "broadband": {
    "checkerUrl": "https://partnerships-broadband.comparethemarket.com/...",
    "disclaimer": "..."
  },
  "epcGraphs": [],
  "listingHistory": {
    "summary": "Reduced on 02/03/2026"
  },
  "sizings": [],
  "agent": {
    "branchId": 57287,
    "name": "Foxtons",
    "branchName": "Foxtons, Dulwich",
    "branchUrl": "https://www.rightmove.co.uk/...",
    "logoUrl": "https://media.rightmove.co.uk/...",
    "primaryColour": "#017163"
  },
  "contact": {
    "phone": "020 3909 8985",
    "intlPhone": null,
    "contactMethod": "EMAIL"
  },
  "brochures": [],
  "tags": [],
  "features": []
}
```
