# Google Maps Details

Get full details for a specific Google Maps place by placeId or URL.

## Usage

```bash
node google-maps-details/scripts/google-maps-details.mjs <placeId|url>
```

**Examples:**
```bash
# By place ID (ChIJ format)
node google-maps-details/scripts/google-maps-details.mjs "ChIJu38xAyhP0xQRjRIRycvj29M"

# By Google Maps URL
node google-maps-details/scripts/google-maps-details.mjs "https://www.google.com/maps/place/Verte+Coffee+House/..."
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `placeId` or `url` | ✅ | ChIJ... place ID or full Google Maps URL |

## Output

`RESULT:{json}` on stdout with this schema:

```json
{
  "name": "Verte Coffee House",
  "address": "Kızılay, Sümer-2 Cd. 24-A, 06420 Çankaya/Ankara, Türkiye",
  "phone": "+90 542 683 13 35",
  "website": "https://www.vertecoffeehouse.com/",
  "rating": 4.9,
  "reviewCount": 544,
  "category": "Coffee shop",
  "hours": {
    "Monday": "8 am to 11 pm",
    "Tuesday": "8 am to 11 pm",
    "Wednesday": "8 am to 11 pm",
    "Thursday": "8 am to 11 pm",
    "Friday": "8 am to 11 pm",
    "Saturday": "8 am to 11 pm",
    "Sunday": "8 am to 11 pm"
  },
  "openStatus": "Open · Closes 11 pm",
  "coordinates": { "lat": 39.9224919, "lng": 32.8502069 },
  "placeId": "ChIJu38xAyhP0xQRjRIRycvj29M",
  "url": "https://www.google.com/maps/place/Verte+Coffee+House/@...",
  "photos": [
    "https://lh3.googleusercontent.com/gps-cs-s/..."
  ],
  "reviews": [
    {
      "author": "Amiin Sulaymaan",
      "rating": 5,
      "text": "Loved this café...",
      "time": "a month ago",
      "reviewerCount": "1 review"
    }
  ]
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `MISSING_ARG` | No placeId/URL provided |
| `PLACE_NOT_LOADED` | Could not load the place page |
| `UNEXPECTED_ERROR` | Unexpected exception |

## Notes

- Navigates to `place_id:<id>` URL which redirects to the canonical URL with coordinates
- Extracts hours from the hours dropdown (button aria-labels)
- Reviews are extracted from the Reviews tab (up to 10)
- Photos are extracted from the overview page (up to 10)
- Category from `div.DkEaL` element
- Phone/address/website from `data-item-id` attributes on buttons/links
