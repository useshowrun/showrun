# Shopify Products Scraper

Scrape product catalog from any public Shopify store using the built-in JSON API.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/shopify

# Browse all products (paginated)
node shopify-products/scripts/shopify-products.mjs allbirds.com --max 50

# Filter by collection
node shopify-products/scripts/shopify-products.mjs gymshark.com --collection sale --max 30

# Single product details
node shopify-products/scripts/shopify-products.mjs allbirds.com --product mens-tree-runners

# List all collections
node shopify-products/scripts/shopify-products.mjs allbirds.com --collections

# Bypass Cloudflare protection
node shopify-products/scripts/shopify-products.mjs somestore.com --browser --max 20

# Start from page 3
node shopify-products/scripts/shopify-products.mjs allbirds.com --max 50 --page 3
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `<store_url>` | (required) | Store URL (e.g., `allbirds.com`, `gymshark.com`, `https://kylie.com`) |
| `--max <N>` | 50 | Max products to return |
| `--collection <handle>` | (none) | Filter by collection handle |
| `--product <handle>` | (none) | Get a single product by handle |
| `--collections` | false | List all collections instead of products |
| `--page <N>` | 1 | Start page number |
| `--browser` | false | Force camoufox browser mode (for Cloudflare stores) |

## Output Format

### Products
```json
{
  "storeUrl": "https://allbirds.com",
  "mode": "api",
  "type": "products",
  "collection": null,
  "totalLoaded": 50,
  "products": [
    {
      "id": 4870548979792,
      "handle": "mens-tree-runners",
      "url": "https://allbirds.com/products/mens-tree-runners",
      "title": "Men's Tree Runner - Jet Black (White Sole)",
      "vendor": "Allbirds",
      "productType": "Shoes",
      "description": "The Allbirds Tree Runner is a breathable...",
      "descriptionHtml": "<p>The Allbirds Tree Runner...</p>",
      "tags": ["allbirds::material => tree", "allbirds::gender => mens"],
      "isAvailable": true,
      "minPrice": 100.00,
      "maxPrice": 100.00,
      "currency": null,
      "options": [
        { "name": "Size", "values": ["8", "9", "10", "11", "12"] }
      ],
      "variants": [
        {
          "id": 33179624669264,
          "title": "8",
          "sku": "TR3MJBW080",
          "price": 100.00,
          "compareAtPrice": null,
          "available": true,
          "option1": "8",
          "option2": null,
          "option3": null,
          "requiresShipping": true,
          "inventoryQuantity": 332,
          "barcode": "843416184854",
          "weight": 0.86
        }
      ],
      "primaryImage": {
        "id": 123456,
        "src": "https://cdn.shopify.com/...",
        "alt": null,
        "width": 1500,
        "height": 1500
      },
      "images": [],
      "publishedAt": "2019-10-31T23:20:55.000Z",
      "createdAt": "2021-01-29T21:57:15.000Z",
      "updatedAt": "2026-03-21T11:35:49.000Z"
    }
  ],
  "scrapedAt": "2026-03-21T12:00:00.000Z"
}
```

### Collections
```json
{
  "storeUrl": "https://allbirds.com",
  "type": "collections",
  "totalLoaded": 45,
  "collections": [
    {
      "id": 270995030096,
      "handle": "30-off-tree-runner-go-tree-gliders",
      "url": "https://allbirds.com/collections/30-off-tree-runner-go-tree-gliders",
      "title": "30% Off Tree Runner Go & Tree Gliders",
      "description": "",
      "productsCount": 104,
      "image": null,
      "publishedAt": "2024-09-07T...",
      "updatedAt": "2026-03-21T..."
    }
  ]
}
```

## Technical Notes

- Uses Shopify's **public** `/products.json` API (no auth required on any store)
- Max 250 products per API page
- Automatic pagination — fetches pages until `maxProducts` reached
- Falls back to camoufox browser if Cloudflare returns 403/503
- `currency` field is not in products.json — use storefront API or store page for currency
- `inventoryQuantity` is only available on stores that expose it (many do)

## Popular Shopify Stores

| Store | URL | Notes |
|-------|-----|-------|
| Allbirds | allbirds.com | Shoes, works great |
| Gymshark | gymshark.com | Fitness apparel |
| Kylie Cosmetics | kylie.com | Beauty products |
| Fashion Nova | fashionnova.com | Fashion |
| Chubbies | chubbies.com | Men's shorts |
| Pura Vida | puravidabracelets.com | Jewelry |
| Death Wish Coffee | deathwishcoffee.com | Coffee |
| Bombas | bombas.com | Socks |
