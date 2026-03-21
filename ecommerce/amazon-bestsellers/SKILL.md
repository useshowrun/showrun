# Amazon Bestsellers Scraper

Scrapes the Top 100 bestselling products from any Amazon category.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/ecommerce

# All departments bestsellers (top 30)
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --max 30

# Books bestsellers
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --category books --max 50

# Electronics bestsellers
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --category electronics --max 30

# Movers & Shakers
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --category electronics --movers --max 30

# New Releases
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --category books --new-releases --max 30

# Custom subcategory URL
node amazon-bestsellers/scripts/amazon-bestsellers.mjs \
  --category https://www.amazon.com/Best-Sellers-Books-Mystery/zgbs/books/18 \
  --max 30

# List available subcategories for books
node amazon-bestsellers/scripts/amazon-bestsellers.mjs --category books --subcategories --max 5
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--category <slug\|url>` | All departments | Category slug or full URL |
| `--max <N>` | 30 | Max items to return (up to 100) |
| `--country <code>` | US | Amazon country: `US`, `UK`, `DE`, `FR`, `CA`, `JP`, etc. |
| `--movers` | false | Use Movers & Shakers list |
| `--new-releases` | false | Use New Releases list |
| `--subcategories` | false | Also return list of subcategories |

## Known Category Slugs

| Slug | Department |
|------|-----------|
| `books` | Books |
| `electronics` | Electronics |
| `toys-and-games` | Toys & Games |
| `clothing` / `fashion` | Clothing |
| `kitchen` | Kitchen & Dining |
| `sports` / `sports-and-outdoors` | Sports & Outdoors |
| `baby` | Baby |
| `beauty` | Beauty & Personal Care |
| `health` | Health & Household |
| `automotive` | Automotive |
| `pet-supplies` / `pets` | Pet Supplies |
| `video-games` / `games` | Video Games |
| `movies-and-tv` | Movies & TV |
| `music` | Music |
| `tools` | Tools & Home Improvement |
| `grocery` | Grocery & Gourmet Food |
| `office` | Office Products |
| `garden` | Garden & Outdoor |

## Output Format

```json
{
  "categoryUrl": "https://www.amazon.com/Best-Sellers/zgbs/books",
  "categoryName": "Amazon Best Sellers",
  "listType": "bestsellers",
  "country": "US",
  "totalLoaded": 30,
  "items": [
    {
      "asin": "1668236516",
      "rank": 1,
      "title": "Theo of Golden: A Novel",
      "url": "https://www.amazon.com/Theo-Golden-Novel-Allen-Levi/dp/1668236516",
      "price": "$14.98",
      "priceAmount": 14.98,
      "rating": 4.7,
      "reviewCount": 63894,
      "author": "Allen Levi",
      "format": "Paperback",
      "imageUrl": "https://images-na.ssl-images-amazon.com/images/I/71PjIDe6FLL._AC_UL900_SR900,600_.jpg"
    }
  ],
  "subcategories": [...],
  "scrapedAt": "2026-03-21T12:00:00.000Z"
}
```

## Technical Notes

- Uses stable selectors: `data-asin`, `img[alt]` for title, `aria-label` for ratings, `.a-color-price` for price
- Avoids obfuscated CSS class names (only uses stable/semantic class names)
- Price shows as formatted string (e.g., "$14.98", "EUR 12.95", "£10.99")
- Currency varies by IP geolocation (not by `--country` flag - Amazon ignores that for price display)
- Movers & Shakers items may show price range (e.g., "EUR 6.75 - EUR 12.95") for multi-variant products
- Pagination: fetches up to 100 items (page 1: items 1-30, page 2: items 31-60, etc.)
