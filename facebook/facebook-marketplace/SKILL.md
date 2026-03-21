# Facebook Marketplace Scraper

Scrapes marketplace listings from Facebook Marketplace.

## Overview

**Without login (default):** Returns ~20 featured listings for the IP-detected location (no keyword search, no categories, no item details).

**With `FB_COOKIES`:** Full search by keyword, category, location, pagination.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/facebook

# Browse featured listings (no login required)
node facebook-marketplace/scripts/facebook-marketplace.mjs

# Browse with limit
node facebook-marketplace/scripts/facebook-marketplace.mjs --max 20

# Search with authentication
FB_COOKIES='[...]' node facebook-marketplace/scripts/facebook-marketplace.mjs --query bicycle --location nyc --max 50

# Browse a location
FB_COOKIES='[...]' node facebook-marketplace/scripts/facebook-marketplace.mjs --location sanfrancisco --max 30

# Category + location  
FB_COOKIES='[...]' node facebook-marketplace/scripts/facebook-marketplace.mjs --location sanfrancisco --max 50

# Price-filtered search
FB_COOKIES='[...]' node facebook-marketplace/scripts/facebook-marketplace.mjs --query "iphone" --min-price 100 --max-price 500 --location nyc
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--query <text>` | (none) | Keyword search (**requires FB_COOKIES**) |
| `--location <slug>` | (IP-detected) | Location slug (e.g., `sanfrancisco`, `nyc`, `losangeles`) |
| `--category <id>` | (none) | Category ID filter (**requires FB_COOKIES**) |
| `--max <N>` | 20 | Max listings to return |
| `--sort <order>` | `best_match` | Sort: `best_match`, `price_ascend`, `price_descend`, `creation_time_descend` |
| `--min-price <N>` | (none) | Minimum price filter |
| `--max-price <N>` | (none) | Maximum price filter |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FB_COOKIES` | JSON array of Facebook session cookies for authenticated access |

## Output Format

```json
{
  "query": "bicycle",
  "location": "San Francisco, California",
  "category": null,
  "sortBy": "best_match",
  "isAuthenticated": false,
  "totalLoaded": 20,
  "hasMore": false,
  "listings": [
    {
      "id": "921138577376098",
      "url": "https://www.facebook.com/marketplace/item/921138577376098/",
      "title": "Barrels/ Barriles.",
      "customTitle": null,
      "price": "FREE",
      "priceAmount": 0,
      "minPrice": null,
      "maxPrice": null,
      "location": "Napa, California",
      "locationCity": "Napa",
      "locationState": "CA",
      "photoUrl": "https://scontent.xx.fbcdn.net/...",
      "videoUrl": null,
      "seller": { "name": "John Doe", "id": "pfbid..." },
      "isLive": true,
      "isSold": false,
      "isPending": false,
      "isHidden": false,
      "categoryName": "Garden",
      "virtualCategory": "Watering Equipment",
      "categoryId": "800089866739547",
      "deliveryTypes": ["IN_PERSON"],
      "listingTags": [],
      "createdAt": "2026-03-21T05:00:00.000Z"
    }
  ],
  "meta": {
    "note": "Logged-out mode: only ~20 featured listings available...",
    "url": "https://www.facebook.com/marketplace/",
    "scrapedAt": "2026-03-21T12:00:00.000Z"
  }
}
```

## Data Schema

| Field | Description |
|-------|-------------|
| `id` | Unique listing ID |
| `url` | Direct URL to the listing |
| `title` | Listing title |
| `price` | Formatted price (e.g., "$1,050", "FREE") |
| `priceAmount` | Numeric price |
| `minPrice`/`maxPrice` | Price range (for range-priced items) |
| `location` | Display location (city, state) |
| `photoUrl` | Primary listing photo URL |
| `videoUrl` | Video URL (if listing has video) |
| `seller.name` | Seller's name |
| `seller.id` | Seller's Facebook ID |
| `isLive` | True if listing is active |
| `isSold` | True if item is sold |
| `isPending` | True if sale is pending |
| `categoryName` | Top-level category |
| `virtualCategory` | Sub-category |
| `deliveryTypes` | `["IN_PERSON"]`, `["SHIPPED"]`, or both |
| `createdAt` | ISO timestamp of when listing was created |

## Anti-Bot Notes

- Facebook Marketplace is accessible without login at `facebook.com/marketplace/`
- Search/category/item pages require login (redirect to `/login/`)
- camoufox handles FB's bot detection (fingerprinted Firefox)
- The featured marketplace feed is SSR-rendered (no additional GraphQL calls needed)

## Limitations

### Without Login
- Only ~20 featured listings (location determined by IP)
- No keyword search
- No category filtering
- No location selection
- No individual item details

### With Login (FB_COOKIES)
- Full search, category, location functionality
- Pagination via scrolling
- Location slugs: `sanfrancisco`, `nyc`, `losangeles`, `chicago`, `houston`, etc.
