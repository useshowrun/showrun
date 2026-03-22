# Fiverr — Skill Suite

Search and scrape Fiverr freelance gig listings, gig details, seller info, and reviews.

## Skills

| Skill | Script | Purpose |
|-------|--------|---------|
| `fiverr-search` | `fiverr-search/scripts/fiverr-search.mjs` | Search gigs by keyword with filters |
| `fiverr-gig` | `fiverr-gig/scripts/fiverr-gig.mjs` | Get full gig details + seller info + reviews |

## Architecture

### ⚠️ Bot Protection Status: BLOCKED (needs residential proxy)
Fiverr uses **PerimeterX** (pxAppId: `PXK3bezZfO`) which blocks all datacenter and Turkish IPs
with "It needs a human touch" (HTTP 403) — for **both** HTTP requests and headless browsers.
camoufox with headless=true and headless='virtual' both fail. HTTP curl also fails.
PerimeterX performs IP reputation scoring — only residential IPs pass the challenge.

**To enable:** Set `SOCKS5_PROXY=host:port` to route through a residential proxy.

### Anti-bot strategy
Fiverr uses **PerimeterX** + **Next.js React SPA** architecture.
All data is server-side rendered (SSR) into `<script id="__NEXT_DATA__">` as JSON.
The code is extraction-ready — the blocker is IP reputation, not the extraction logic.

Extraction strategy (priority order):
1. **`__NEXT_DATA__`** — Primary. Full gig/search data embedded in SSR JSON
2. **XHR intercept** — Fallback. Captures `/api/v2/search/gigs` or `/api/v2/gigs/` API calls
3. **JSON-LD** — Structured data fallback (search results via `ItemList`)
4. **DOM fallback** — Last resort using `data-testid` and aria attributes

### Key technical notes
- Fiverr uses PerimeterX (pxAppId: PXK3bezZfO) — datacenter IPs are blocked
- Fiverr uses Next.js — `__NEXT_DATA__` is the most reliable data source once unblocked
- Prices may be stored in cents (divide by 100 if > 1000 and integer)
- Search URL: `https://www.fiverr.com/search/gigs?query=<keyword>&sort_by=best_selling`
- Gig URL: `https://www.fiverr.com/<username>/<gig-slug>`

### Directory structure
```
fiverr/
├── SKILL.md                            — this file
├── package.json                        — camoufox-js dependency
├── lib/
│   └── utils.mjs                       — shared browser/extraction utilities
├── fiverr-search/
│   └── scripts/
│       └── fiverr-search.mjs           — search skill
└── fiverr-gig/
    └── scripts/
        └── fiverr-gig.mjs              — gig detail skill
```

### Environment variables
- `SOCKS5_PROXY` — Optional residential proxy: `host:port` (e.g. `127.0.0.1:11091`)

## Usage

```bash
cd fiverr && source ~/.nvm/nvm.sh && nvm use 24

# Search for gigs
node fiverr-search/scripts/fiverr-search.mjs "logo design"
node fiverr-search/scripts/fiverr-search.mjs "wordpress developer" --max 10 --sort rating
node fiverr-search/scripts/fiverr-search.mjs "video editing" --budget-min 10 --budget-max 50

# Get gig details
node fiverr-gig/scripts/fiverr-gig.mjs "https://www.fiverr.com/seller/gig-slug"
node fiverr-gig/scripts/fiverr-gig.mjs "seller/gig-slug" --max-reviews 50
```

## Output Format

### fiverr-search
```json
{
  "query": "logo design",
  "sort": "best_selling",
  "returned": 20,
  "gigs": [
    {
      "gigId": "123456",
      "title": "I will design a professional logo",
      "gigUrl": "https://www.fiverr.com/seller/gig-slug",
      "thumbnailUrl": "https://...",
      "seller": {
        "username": "seller",
        "displayName": "Seller Name",
        "level": "Level Two Seller",
        "rating": 4.9,
        "reviewCount": 1234,
        "avatarUrl": "https://...",
        "country": "US"
      },
      "startingPrice": 15,
      "currency": "USD",
      "deliveryDays": 3,
      "rating": 4.9,
      "reviewCount": 1234,
      "isProSeller": false,
      "isPro": false
    }
  ],
  "scrapedAt": "2026-03-22T00:00:00.000Z"
}
```

### fiverr-gig
```json
{
  "gigId": "123456",
  "title": "I will design a professional logo",
  "gigUrl": "https://www.fiverr.com/seller/gig-slug",
  "thumbnailUrl": "https://...",
  "description": "Full gig description text...",
  "packages": [
    {
      "name": "Basic",
      "price": 15,
      "deliveryDays": 3,
      "description": "Package description",
      "revisions": 3,
      "features": ["Source file", "Logo transparency"]
    }
  ],
  "tags": ["logo", "branding", "design"],
  "categories": ["Graphics & Design", "Logo Design"],
  "faqs": [
    { "question": "What do you need from me?", "answer": "Your brand name and preferences" }
  ],
  "seller": {
    "username": "seller",
    "displayName": "Seller Name",
    "level": "Level Two Seller",
    "rating": 4.9,
    "reviewCount": 1234,
    "avatarUrl": "https://...",
    "country": "US",
    "bio": "Professional graphic designer...",
    "memberSince": "2018-03-01",
    "responseTime": "1 hour",
    "ordersInQueue": 5,
    "languages": ["English", "Spanish"],
    "skills": ["Logo Design", "Branding"]
  },
  "startingPrice": 15,
  "currency": "USD",
  "deliveryDays": 3,
  "rating": 4.9,
  "reviewCount": 1234,
  "isProSeller": false,
  "isPro": false,
  "reviews": [
    {
      "id": "789",
      "reviewer": "buyer123",
      "rating": 5,
      "text": "Excellent work!",
      "date": "2026-01-15",
      "sellerResponse": null
    }
  ]
}
```

## Error Codes
- `MISSING_ARG` — Required argument not provided
- `UNKNOWN_ARG` — Unrecognized CLI argument
- `INVALID_INPUT` — Invalid gig URL/path format
- `CLOUDFLARE_BLOCKED` — Cloudflare challenge detected (use SOCKS5_PROXY)
- `NOT_FOUND` — Gig or seller does not exist
- `NO_DATA` — Could not extract data from page
- `FATAL` — Unexpected error
