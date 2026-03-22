# app-store-app

Fetch full metadata and reviews for an iOS app by app ID or App Store URL.

## Usage

```bash
node app-store-app/scripts/app-store-app.mjs <app-id-or-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<app-id-or-url>` | Numeric app ID or App Store URL (required) |

Accepted input formats:
- `618783545` — numeric app ID
- `https://apps.apple.com/us/app/slack/id618783545` — full App Store URL
- `apps.apple.com/us/app/slack/id618783545` — URL without protocol

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--country <cc>` | `us` | 2-letter country code |
| `--max-reviews <N>` | `50` | Max reviews to fetch (0 = skip reviews) |

## Examples

```bash
# Slack by app ID
node app-store-app/scripts/app-store-app.mjs 618783545

# Instagram by URL
node app-store-app/scripts/app-store-app.mjs https://apps.apple.com/us/app/instagram/id389801252

# WhatsApp with 200 reviews
node app-store-app/scripts/app-store-app.mjs 310633997 --max-reviews 200

# Skip reviews (metadata only)
node app-store-app/scripts/app-store-app.mjs 618783545 --max-reviews 0

# Turkish App Store
node app-store-app/scripts/app-store-app.mjs 618783545 --country tr
```

## Output Format

```json
{
  "id": "618783545",
  "name": "Slack",
  "bundleId": "com.tinyspeck.chatlyio",
  "developer": {
    "name": "Slack Technologies, Inc.",
    "artistId": "null"
  },
  "url": "https://apps.apple.com/us/app/slack-for-desktop/id618783545?uo=4",
  "description": "Slack is a messaging app for business...",
  "rating": 4.7,
  "ratingCount": 1234567,
  "currentVersionRating": 4.8,
  "currentVersionRatingCount": 98765,
  "price": 0,
  "currency": "USD",
  "inAppPurchases": null,
  "genres": ["Business", "Productivity"],
  "primaryGenre": "Business",
  "artworkUrl": "https://is1-ssl.mzstatic.com/image/thumb/.../512x512bb.jpg",
  "screenshotUrls": ["https://..."],
  "ipadScreenshotUrls": ["https://..."],
  "minimumOsVersion": "16.0",
  "fileSizeBytes": 185073664,
  "version": "26.03.30",
  "releaseNotes": "Bug fixes and performance improvements.",
  "releaseDate": "2009-12-09T12:00:00Z",
  "currentVersionReleaseDate": "2026-03-19T15:00:00Z",
  "contentAdvisoryRating": "4+",
  "languagesISO2A": ["EN", "AR", "DE", "ES", "FR", "JA", "KO", "PT", "ZH"],
  "reviews": [
    {
      "id": "13870183948",
      "rating": 5,
      "title": "Perfect",
      "body": "Perfect",
      "author": "vital1906",
      "version": "26.03.30",
      "date": "2026-03-20T20:38:32-07:00",
      "helpful": 0
    }
  ]
}
```

## Data Sources

| Source | Method |
|--------|--------|
| iTunes Lookup API | `https://itunes.apple.com/lookup?id=<appId>&country=<cc>` |
| Reviews RSS (JSON) | `https://itunes.apple.com/<cc>/rss/customerreviews/id=<appId>/page=<n>/sortBy=mostRecent/json` |

## Notes

- **Reviews** are fetched from the iTunes RSS JSON feed (up to 500 max: 10 pages × 50 reviews each)
- **Country matters** — pricing, availability, and reviews differ between stores
- **Invalid ID** → returns clean `NOT_FOUND` error, no crash
- **App with no reviews** → `reviews: []` (empty array)
