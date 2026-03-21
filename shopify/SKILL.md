# Shopify Agent Browser Skills

Scrape product catalogs from any public Shopify store.

## Key Insight

Every Shopify store exposes a **public JSON API** (no authentication required):
- `/products.json` — paginated product catalog
- `/products/<handle>.json` — single product details
- `/collections.json` — all store collections
- `/collections/<handle>/products.json` — products in a collection

This makes Shopify one of the easiest platforms to scrape reliably.

## Prerequisites

### Node.js 22+
```bash
node --version
```

### Install Dependencies
```bash
cd shopify && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Products](shopify-products/SKILL.md) | `shopify-products/scripts/shopify-products.mjs` | Browse all products, filter by collection, get single product details |

## Typical Workflow

```bash
# Browse all products
node shopify-products/scripts/shopify-products.mjs allbirds.com --max 50

# Filter by collection
node shopify-products/scripts/shopify-products.mjs allbirds.com --collection sale --max 20

# Get a single product
node shopify-products/scripts/shopify-products.mjs allbirds.com --product mens-tree-runners

# List all collections
node shopify-products/scripts/shopify-products.mjs allbirds.com --collections
```

## Anti-Bot Notes

Most Shopify stores serve the JSON API without any bot protection. 
Some stores use Cloudflare — use `--browser` to bypass via camoufox.
