# Capterra Scraper — SKILL.md

## ⚠️ STATUS: BLOCKED

Capterra (capterra.com) uses **Cloudflare Managed Challenge** on all pages.
- HTTP 403 "Just a moment..." from Turkish/datacenter IPs — even with camoufox fingerprinted Firefox
- **Requires residential proxy** (`SOCKS5_PROXY=host:port`) to bypass
- Once bypassed: all data is in `__NEXT_DATA__` JSON (Next.js SSR)

## Skills

### capterra-search
Search for software products by keyword or category.

```bash
# Keyword search
node capterra-search/scripts/capterra-search.mjs "CRM software" --max 10

# Category browse
node capterra-search/scripts/capterra-search.mjs "project management" --category "project-management"

# With proxy (required from non-residential IPs)
SOCKS5_PROXY=127.0.0.1:11090 node capterra-search/scripts/capterra-search.mjs "CRM" --max 20
```

**Args:**
- `<query>` — Required — search query string
- `--max N` — Optional — max results (default: 10)
- `--category <slug>` — Optional — category slug (e.g. `crm`, `project-management`, `accounting`)
  When provided, browses `/category-software/` listing instead of search

**Returns:** `RESULT:{...}` with:
```json
{
  "query": "CRM",
  "category": null,
  "searchUrl": "https://www.capterra.com/search/?query=CRM",
  "totalFound": 500,
  "products": [
    {
      "name": "Salesforce",
      "id": "12345",
      "slug": "Salesforce",
      "url": "https://www.capterra.com/p/12345/Salesforce/",
      "logoUrl": "https://...",
      "rating": 4.4,
      "reviewCount": 18789,
      "shortDescription": "...",
      "pricingInfo": "Starting from $25.00/mo",
      "categories": ["CRM Software", "Sales Force Automation"]
    }
  ]
}
```

### capterra-product
Get full product details + reviews.

```bash
# Full URL
SOCKS5_PROXY=127.0.0.1:11090 node capterra-product/scripts/capterra-product.mjs \
  https://www.capterra.com/p/26943/Slack/ --max-reviews 50

# ID/slug format
SOCKS5_PROXY=127.0.0.1:11090 node capterra-product/scripts/capterra-product.mjs \
  26943/Slack --max-reviews 20
```

**Args:**
- `<product-url-or-slug>` — Required — full URL or `<id>/<slug>` format
- `--max-reviews N` — Optional — max reviews to collect (default: 20)

**Returns:** `RESULT:{...}` with:
```json
{
  "product": {
    "name": "Slack",
    "id": "26943",
    "slug": "Slack",
    "url": "https://www.capterra.com/p/26943/Slack/",
    "vendor": "Salesforce",
    "rating": 4.7,
    "reviewCount": 23456,
    "ratingBreakdown": {
      "ease": 4.8,
      "value": 4.5,
      "features": 4.7,
      "support": 4.4
    },
    "pricing": {
      "hasFreeVersion": true,
      "hasFreeTrial": true,
      "startingPrice": "$7.25/mo",
      "pricingModel": "Subscription",
      "currency": "USD"
    },
    "features": ["File Sharing", "Group Messaging", "Video Conferencing"],
    "platforms": ["Web", "iOS", "Android", "Windows", "Mac"],
    "categories": ["Team Communication", "Business Messaging"],
    "integrations": ["Google Drive", "Zoom", "GitHub"]
  },
  "reviews": [
    {
      "id": "rev_123",
      "title": "Great team communication tool",
      "rating": 5,
      "pros": "Easy to use, great integrations",
      "cons": "Can get noisy",
      "date": "2025-01-15",
      "helpful": 12,
      "author": "Jane Smith",
      "role": "Product Manager",
      "companySize": "51-200",
      "industry": "Software",
      "verified": true
    }
  ],
  "productUrl": "https://www.capterra.com/p/26943/Slack/",
  "pagesScraped": 1
}
```

## Site Structure

| URL Pattern | Description |
|-------------|-------------|
| `https://www.capterra.com/search/?query=<keyword>` | Search results |
| `https://www.capterra.com/<category>-software/` | Category browse |
| `https://www.capterra.com/p/<id>/<slug>/` | Product detail page |
| `https://www.capterra.com/p/<id>/<slug>/reviews/` | Product reviews |

## Bot Protection

**Cloudflare Managed Challenge** — HTTP 403 from datacenter/Turkish IPs.

### Requirements to bypass:
1. **Residential IP** via `SOCKS5_PROXY=host:port` env var
2. **camoufox fingerprinted Firefox** (already used — passes JS proof-of-work)

### How Cloudflare Managed Challenge works:
- Serves a JS challenge that must be solved in-browser (proof-of-work + fingerprinting)
- camoufox handles the JS execution and fingerprint masking
- But datacenter/Turkish IPs are in Cloudflare's blocklist → 403 regardless
- Residential IP bypasses the IP blocklist → challenge resolves → page loads

### SOCKS5_PROXY format:
```
SOCKS5_PROXY=127.0.0.1:11090   # local tunnel
SOCKS5_PROXY=1.2.3.4:1080      # remote residential proxy
```

## Data Architecture

Once accessible (with residential proxy):
- **__NEXT_DATA__** (primary): All SSR data as JSON in `<script id="__NEXT_DATA__">`
  - Search: `props.pageProps.initialData.searchResults[]`
  - Product: `props.pageProps.product`, `.reviews`, `.pricing`, `.features`
- **JSON-LD** (secondary): SoftwareApplication schema with name, rating, description
- **XHR** (review pagination): `/api/reviews/...` or internal Gartner APIs

## Files

```
capterra/
├── SKILL.md
├── package.json
├── node_modules/
├── lib/
│   └── utils.mjs            # Shared utilities (browser, extraction, parsing)
├── capterra-search/
│   └── scripts/
│       └── capterra-search.mjs
└── capterra-product/
    └── scripts/
        └── capterra-product.mjs
```

## Error Codes

| Code | Meaning |
|------|---------|
| `BLOCKED` | Cloudflare Managed Challenge — set `SOCKS5_PROXY` |
| `MISSING_ARG` | Required argument not provided |
| `INVALID_ARG` | Could not parse product URL/slug |
| `TIMEOUT` | Page load timed out |
| `SCRAPE_ERROR` | Unexpected error during scraping |

## Known Notes

- Capterra is owned by Gartner — shares infrastructure with Software Advice and GetApp
- Reviews require verified purchase/use — high quality but limited public access
- Search results are sponsored-order by default — organic ranking mixed in
- Category pages (`/crm-software/`) often have richer data than keyword search
- Product IDs are stable (e.g., Slack is always `/p/26943/Slack/`)
