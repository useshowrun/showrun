# Pinterest Search Scraper

Search Pinterest for pins by keyword. No login required.

## Strategy

1. Navigate to `pinterest.com/search/pins/?q=<keyword>`
2. Intercept `BaseSearchResource` API calls which return structured pin data
3. Parse `resource_response.data.results[]` — each entry is a complete pin object
4. Scroll to load more (pagination via `bookmark` token returned in each API response)

### Why API Interception?

Pinterest's DOM has pins as images without text content — scraping the DOM directly gives
only image URLs. The `BaseSearchResource` API returns rich JSON with descriptions, pinner info,
board data, external links, and reaction counts.

### Available Without Login

Pinterest allows public search without login. The site shows a "Log in to see more" banner
but still returns 16+ pins per API call and continues loading on scroll.

### API Response Structure

```
resource_response.data.results[] (array of pin objects):
  - id, type, title, description, seo_alt_text
  - images: { "170x": {url, width, height}, "236x", "474x", "736x", "orig" }
  - link (external URL)
  - domain (external domain name)
  - pinner: { username, full_name, image_medium_url }
  - board: { name, pin_count, owner: { username } }
  - created_at (RFC 2822 timestamp)
  - reaction_counts: { "1": N } (number of "heart" reactions)
  - is_promoted (boolean)
  - dominant_color (hex color)
  
resource_response.bookmark: (string, next page token)
```

## Usage

```bash
# Default: 20 pins
node pinterest-search.mjs "coffee latte art"

# More pins
node pinterest-search.mjs "minimalist home decor" --max 50

# Single word
node pinterest-search.mjs mountains

# With auth (PT_COOKIES env var)
PT_COOKIES='[{"name":"_auth","value":"1","domain":".pinterest.com"},...]' node pinterest-search.mjs coffee
```

## Output

```json
{
  "keyword": "coffee latte art",
  "searchUrl": "https://www.pinterest.com/search/pins/?q=coffee%20latte%20art",
  "pins": [
    {
      "id": "3237030976770350",
      "title": null,
      "description": "there is a cup of coffee with a heart in the foamy liquid on it",
      "link": "https://www.instagram.com/p/CLeytOUBeSu/",
      "domain": "instagram.com",
      "imageUrl": "https://i.pinimg.com/originals/b7/f0/58/b7f058366c85cb628ac8dd2cf4ce86cd.jpg",
      "thumbnailUrl": "https://i.pinimg.com/236x/b7/f0/58/b7f058366c85cb628ac8dd2cf4ce86cd.jpg",
      "dominantColor": "#8e715a",
      "createdAt": "Wed, 01 May 2024 15:10:57 +0000",
      "saves": null,
      "reactionCount": 78,
      "pinner": {
        "username": "halolh5",
        "fullName": "Hala H",
        "profileUrl": "https://www.pinterest.com/halolh5/"
      },
      "board": {
        "name": "latte art",
        "pinCount": 18,
        "url": "https://www.pinterest.com/halolh5/"
      },
      "isPromoted": false,
      "pinUrl": "https://www.pinterest.com/pin/3237030976770350/"
    }
  ],
  "meta": {
    "returned": 10,
    "hasMore": true,
    "loginRequired": false
  }
}
```

## Selector Stability

- **Zero CSS class selectors** — all data from intercepted JSON API
- `BaseSearchResource` API endpoint: stable since 2020+
- `resource_response.data.results` structure: stable Pinterest internal API format

## Known Limitations

- `saves` field is always `null` for anonymous users (requires login)
- For nonsense queries, Pinterest falls back to "popular/trending" pins
- Pin descriptions are sometimes empty (for user-uploaded pins without description)
- `board.url` in the result is the pinner's root profile, not the specific board URL
- Scrolling loads more but may stop at ~100-200 pins for anonymous users

## Files

- `scripts/pinterest-search.mjs` — main scraper script
- `../../lib/utils.mjs` — shared utilities (parsePin, etc.)
