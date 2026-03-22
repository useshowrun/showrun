# G2 Scraper Skills

Scrapes **g2.com** for software product reviews, ratings, and pricing information.

## Skills

### g2-search
Search for software products by keyword.

```bash
node g2/g2-search/scripts/g2-search.mjs "CRM software" [--max 10] [--category "crm"]
```

### g2-product
Get full product details + reviews from a G2 product slug or URL.

```bash
node g2/g2-product/scripts/g2-product.mjs salesforce-sales-cloud [--max-reviews 20]
node g2/g2-product/scripts/g2-product.mjs "https://www.g2.com/products/slack/reviews" [--max-reviews 10]
```

## Anti-Bot Notes

G2 uses Cloudflare. camoufox-js bypasses it in most cases.

- **Data sources:** `window.gon` (server-side data), JSON-LD `SoftwareApplication` schema, XHR interception
- **Proxy:** Set `SOCKS5_PROXY=host:port` for residential IP if blocked

## Output Format

`RESULT:{json}` on stdout, logs to stderr.
