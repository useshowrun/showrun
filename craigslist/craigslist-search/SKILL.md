# craigslist-search

Search Craigslist listings by city and category, with optional keyword and price filters.

## Usage

```bash
node craigslist-search/scripts/craigslist-search.mjs <city> <category> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<city>` | Craigslist city subdomain (e.g. `sfbay`, `newyork`, `chicago`, `london`) |
| `<category>` | Category code (e.g. `sss`, `hhh`, `jjj`) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--query <kw>` | (none) | Search keyword |
| `--min-price <N>` | (none) | Minimum price filter |
| `--max-price <N>` | (none) | Maximum price filter |
| `--max <N>` | 25 | Max results to return |

## Examples

```bash
# Search for bicycles for sale in SF Bay Area
node craigslist-search/scripts/craigslist-search.mjs sfbay sss --query bicycle --max 10

# Search for apartments in NYC with price range
node craigslist-search/scripts/craigslist-search.mjs newyork hhh --query apartment --min-price 1500 --max-price 3000

# Search for developer jobs in Chicago
node craigslist-search/scripts/craigslist-search.mjs chicago jjj --query developer

# Browse all for-sale listings in Seattle (no keyword)
node craigslist-search/scripts/craigslist-search.mjs seattle sss --max 50

# Search in London
node craigslist-search/scripts/craigslist-search.mjs london sss --query iphone
```

## Output Schema

```json
{
  "city": "sfbay",
  "category": "sss",
  "query": "bicycle",
  "minPrice": null,
  "maxPrice": null,
  "totalFound": 5,
  "listings": [
    {
      "id": "7912241254",
      "title": "Retrospec Sully BMX Kruiser",
      "price": 275,
      "currency": "USD",
      "location": "petaluma",
      "url": "https://sfbay.craigslist.org/nby/bik/d/petaluma-retrospec-sully-bmx-kruiser/7912241254.html",
      "thumbnailUrl": "https://images.craigslist.org/00b0b_47hg7cuHCNg_0Mo0Mo_1200x900.jpg",
      "images": ["https://images.craigslist.org/00b0b_...jpg"],
      "lat": 38.250698,
      "lng": -122.615501,
      "category": "sss",
      "postedAt": null
    }
  ]
}
```

**Notes:**
- `postedAt` is `null` in search results — fetch the listing URL for exact post date
- `thumbnailUrl` and `images` may be empty if a listing has no photos
- Jobs (`jjj`) typically have `price: 0`; price filters won't work for those
- Invalid city names result in `FETCH_FAILED` error
- Empty results return `{"totalFound": 0, "listings": []}`

## Common Category Codes

| Code | Category |
|------|----------|
| `sss` | For sale (all) |
| `hhh` | Housing |
| `jjj` | Jobs |
| `ggg` | Gigs |
| `svc` | Services |
| `ccc` | Community |
| `bik` | Bicycles |
| `for` | Free stuff |
| `mob` | Mobile phones |
| `pet` | Pets |
| `fud` | Food+drink |
