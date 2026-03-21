# Etsy Product Search Scraper

Search Etsy for product listings by keyword. No login required.

## Strategy

1. Navigate to `etsy.com/search?q=<keyword>`
2. Parse DOM listing cards identified by `[data-listing-id][data-shop-id]`
3. Extract product data using stable selectors (aria-label, data attributes, semantic class names)
4. Scroll to load more listings via infinite scroll

### Stable Selectors Used

| Data | Selector | Why Stable |
|------|----------|-----------|
| Title | `h3[title]` attr | Semantic HTML title attribute |
| Price | `.currency-symbol` + `.currency-value` | Etsy's stable naming (not obfuscated) |
| Rating | `[aria-label*="star rating with"]` | ARIA accessibility attribute |
| Listing URL | `a[href*="/listing/"]` | URL path pattern |
| Image | First `img` tag | Position-based, stable |
| Shop name | `a[href*="/shop/"]` URL path | URL path pattern |
| Free shipping | Text content match | Text content |
| Badges | Text content patterns | Text content |

## Usage

\`\`\`bash
# Basic search (20 listings)
node etsy-search.mjs "handmade ceramic mug"

# More results
node etsy-search.mjs "vintage leather wallet" --max 50

# With filters
node etsy-search.mjs "knitted sweater" --min-price 20 --max-price 100 --free-shipping
\`\`\`

## Output

\`\`\`json
{
  "keyword": "handmade ceramic mug",
  "searchUrl": "https://www.etsy.com/search?q=handmade+ceramic+mug",
  "totalCountText": null,
  "listings": [
    {
      "listingId": "1852533507",
      "shopId": "40689618",
      "title": "Mushroom mug/Large ceramic mug...",
      "price": "€66,99",
      "originalPrice": null,
      "rating": 4.9,
      "reviewCount": 982,
      "hasFreeShipping": true,
      "shopName": "HanpantsurovCeramic",
      "listingUrl": "https://www.etsy.com/listing/1852533507/...",
      "imageUrl": "https://i.etsystatic.com/...il_570xN...jpg",
      "badges": ["Free shipping"],
      "isAd": true
    }
  ],
  "meta": { "returned": 5, "hasMore": true, "filters": {...} }
}
\`\`\`

## Known Limitations

- `totalCountText` is null (Etsy doesn't expose total count in DOM easily)
- Price is in local currency (depends on visitor's location/IP)
- `reviewCount` may be null for new listings
- Nonexistent queries fall back to 1 random listing (Etsy's default behavior)
