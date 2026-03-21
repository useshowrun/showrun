# Facebook Ad Library Scraper

Searches the public Facebook Ad Library for ads by keyword or advertiser.
No login required — the Ad Library is publicly accessible at https://www.facebook.com/ads/library/.

## Strategy

1. Navigate to the Ad Library URL with search params
2. DOM parsing to extract ad cards (each identified by unique "Library ID:")
3. Card boundary detection: walk up from "Library ID:" text node until `libIdCount > 1`, take the previous ancestor as the single card container
4. Scroll to load more ads (infinite scroll pagination)

### Ad Card Data

Each card is bounded by finding the ancestor element where exactly one "Library ID:" text exists. Within that element:
- `Library ID:` → unique numeric ad ID
- First meaningful text line → status (Inactive/Active)
- Date pattern → `startDate` and `endDate`
- Line before "Sponsored" → advertiser name
- Lines after "Sponsored" (until stop patterns) → ad text
- `a[href*="facebook.com"]` matching advertiser name → advertiser page URL
- External links via `l.facebook.com/l.php?u=<encoded>` → decoded landing page URLs
- `img[src*="fbcdn"]` (excluding small thumbnails) → ad images
- `video source[src]` → video URLs

### DOM vs API

Facebook's Ad Library initially loads ads in SSR, then loads more via GraphQL as user scrolls.
The DOM-based approach works for both initial load and scroll-loaded content.
No need to intercept API calls (they're compressed and complex to parse).

## Usage

```bash
# Basic keyword search (US, all status, 20 ads)
node facebook-ad-library.mjs "nike shoes"

# Active ads only, more results
node facebook-ad-library.mjs apple --status active --max 50

# Germany, image ads only
node facebook-ad-library.mjs tesla --country DE --media image --max 20

# Exact phrase search
node facebook-ad-library.mjs "just do it" --type keyword_exact_phrase

# Search by page name
node facebook-ad-library.mjs Nike --type page

# All countries
node facebook-ad-library.mjs "cryptocurrency" --country ALL
```

## Options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--type` | `keyword_unordered`, `keyword_exact_phrase`, `page` | `keyword_unordered` | Search type |
| `--country` | `US`, `ALL`, `DE`, `GB`, `TR`, `FR`, etc. | `US` | Country code |
| `--status` | `active`, `inactive`, `all` | `all` | Ad status filter |
| `--media` | `all`, `image`, `video`, `meme`, `no_image` | `all` | Media type filter |
| `--max` | Integer | `20` | Max ads to return |

## Output

```json
{
  "keyword": "nike",
  "country": "US",
  "adStatus": "all",
  "searchType": "keyword_unordered",
  "totalCountText": ">50,000 results",
  "ads": [
    {
      "libraryId": "638485615120135",
      "status": "inactive",
      "startDate": "Nov 8, 2023",
      "endDate": "Apr 26, 2025",
      "advertiser": "Nike",
      "advertiserUrl": "https://www.facebook.com/nike/",
      "adText": "Encuentra tu mejor estilo.\n...",
      "images": ["https://scontent.xx.fbcdn.net/..."],
      "videoUrls": [],
      "landingPageUrls": ["https://www.nike.com/..."],
      "platforms": [],
      "hasMultipleVersions": true,
      "hasEuTransparency": true,
      "adLibraryUrl": "https://www.facebook.com/ads/library/?id=638485615120135"
    }
  ],
  "meta": {
    "returned": 20,
    "hasMore": true
  }
}
```

## Selector Stability

- **Zero CSS class selectors** — card boundary detection uses textContent pattern matching only
- Library ID text node → walk up until `libIdCount > 1` — this is a robust DOM boundary detection technique
- Works regardless of Facebook's CSS class randomization/deployment changes
- External links via URL query parameter (`l.php?u=...`) → stable Facebook redirect pattern

## Performance

- Initial load: ~10s for 30 ads
- Each scroll batch: ~2.5s for ~30 more ads
- Total for 50 ads: ~30-45s

## Known Limitations

- `platforms` field sometimes empty — platform icons are rendered as SVG/CSS, hard to detect reliably from text
- Pagination stops after ~4 consecutive empty scrolls
- Ad Library may show 0 results for very unusual keywords
- Date parsing uses month name patterns — may fail for localized dates (non-English)
- `totalCountText` is a string like ">50,000 results" — not an exact number

## Files

- `scripts/facebook-ad-library.mjs` — main scraper script
- `../../lib/utils.mjs` — shared utilities (createFbBrowser, createFbContext)
