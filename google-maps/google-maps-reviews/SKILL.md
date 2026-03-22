# google-maps-reviews

Scrapes paginated reviews for a Google Maps place, going far beyond the 10 inline reviews in the `google-maps-details` skill.

## Input

```
node scripts/google-maps-reviews.mjs <placeId|url> [--max N] [--sort SORT_MODE]
```

| Argument | Description |
|---|---|
| `placeId|url` | Google Maps place ID (e.g. `ChIJi4Zj86xP0xQRNsqp2ceMJ38`) or full Google Maps URL |
| `--max N` | Maximum number of reviews to fetch (default: 50) |
| `--sort` | Sort mode: `most_relevant` (default), `newest`, `highest_rating`, `lowest_rating` |

## Output

`RESULT:{json}` to stdout, logs to stderr.

```json
{
  "placeId": "ChIJi4Zj86xP0xQRNsqp2ceMJ38",
  "name": "V COFFEE ANKARA",
  "rating": 4.8,
  "totalReviewCount": 180,
  "sort": "most_relevant",
  "reviewsFetched": 50,
  "url": "https://www.google.com/maps/...",
  "reviews": [
    {
      "reviewId": "ChdDSUhNMG9nS0VJ...",
      "rating": 5,
      "text": "Amazing coffee shop...",
      "relativeTime": "a year ago",
      "absoluteDate": "2024-11-26",
      "author": {
        "name": "John Doe",
        "profileUrl": "https://www.google.com/maps/contrib/...",
        "avatarUrl": "https://lh3.googleusercontent.com/...",
        "contributorId": "109717571945306427658",
        "localGuide": true,
        "reviewCount": 42
      },
      "ownerResponse": {
        "text": "Thank you for your kind words!",
        "relativeTime": "11 months ago",
        "date": "2024-11-26"
      },
      "photos": ["https://lh3.googleusercontent.com/geougc-cs/..."],
      "likes": 3
    }
  ]
}
```

## Error Output

```json
{ "error": true, "code": "ERROR_CODE", "message": "description" }
```

**Error codes:**
- `MISSING_ARG` — No place ID or URL provided
- `PLACE_NOT_LOADED` — Google Maps place page failed to load
- `NO_REVIEWS_XHR` — Could not capture the reviews XHR (place has no reviews, or page didn't trigger XHR)
- `UNEXPECTED_ERROR` — Unhandled exception

## How It Works

1. Navigates to the Google Maps place page using camoufox-js (anti-detect browser)
2. Handles cookie consent if present
3. Clicks the "Reviews" tab to trigger the internal `listugcposts` XHR request
4. Captures the XHR URL (which includes a session token and feature ID)
5. Replays the XHR with updated pagination tokens to fetch all review pages
6. Each page returns 10 reviews; pagination token in the response is used for the next page
7. Deduplicates by reviewId

**Technical details:**
- Uses Google Maps' internal `listugcposts` API endpoint
- No brittle CSS class selectors — uses aria-label attributes for tab clicks
- Pagination is entirely XHR-based (no scrolling required)
- `?hl=en` ensures English results
- Polite 800ms delay between pages

## Examples

```bash
# Get 50 most relevant reviews for a place
node scripts/google-maps-reviews.mjs "ChIJi4Zj86xP0xQRNsqp2ceMJ38"

# Get 100 newest reviews
node scripts/google-maps-reviews.mjs "ChIJi4Zj86xP0xQRNsqp2ceMJ38" --max 100 --sort newest

# Get reviews using a Google Maps URL
node scripts/google-maps-reviews.mjs "https://www.google.com/maps/place/V+COFFEE+ANKARA/@39.9197,32.8539,17z" --max 20

# Get lowest-rated reviews (useful for sentiment analysis)
node scripts/google-maps-reviews.mjs "ChIJD3uTd9hx5kcR1IQvGfr8dbk" --max 50 --sort lowest_rating
```

## Requirements

- Node.js v24 (run with `source ~/.nvm/nvm.sh && nvm use 24`)
- `camoufox-js` (in `google-maps/node_modules`)
- Imports `../../lib/utils.mjs` from the parent `google-maps/` directory
