# Google Maps Search

Search Google Maps for businesses/places by query and location.

## Usage

```bash
node google-maps-search/scripts/google-maps-search.mjs <query> [location] [maxResults]
```

**Examples:**
```bash
node google-maps-search/scripts/google-maps-search.mjs "coffee" "Ankara" 20
node google-maps-search/scripts/google-maps-search.mjs "pizza restaurants" "Istanbul" 10
node google-maps-search/scripts/google-maps-search.mjs "dentists" "Berlin" 15
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | ✅ | Search term (e.g., "coffee shops", "restaurants") |
| `location` | ❌ | Location to search in (e.g., "Istanbul", "Ankara") |
| `maxResults` | ❌ | Maximum results to return (default: 20) |

## Output

`RESULT:{json}` on stdout with this schema:

```json
{
  "query": "coffee",
  "location": "Ankara",
  "count": 20,
  "places": [
    {
      "name": "Verte Coffee House",
      "address": "Sümer-2 Cd. 24-A",
      "rating": 4.9,
      "reviewCount": 544,
      "category": "Coffee shop",
      "openStatus": "Open · Closes 11 pm",
      "placeId": "ChIJu38xAyhP0xQRjRIRycvj29M",
      "url": "https://www.google.com/maps/place/...",
      "thumbnail": "https://lh3.googleusercontent.com/..."
    }
  ]
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `MISSING_ARG` | No query provided |
| `NO_RESULTS` | Page loaded but no results extracted |
| `UNEXPECTED_ERROR` | Unexpected exception |

## Notes

- Uses `?hl=en` to force English language results
- Scrolls the results feed to load more results beyond the initial batch
- Stops scrolling when reaching the end of results or after 25 scroll attempts
- camoufox headless mode runs without Xvfb requirement (`headless: true`)
