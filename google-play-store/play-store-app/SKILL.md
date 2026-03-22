# play-store-app

Fetch full metadata and reviews for an Android app by package name or Google Play URL.

## Usage

```bash
node play-store-app/scripts/play-store-app.mjs <package-name-or-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<package-name-or-url>` | Android package name or Google Play URL (required) |

Accepted input formats:
- `com.Slack` — package name
- `com.instagram.android` — package name
- `https://play.google.com/store/apps/details?id=com.whatsapp` — full Google Play URL
- `play.google.com/store/apps/details?id=com.whatsapp` — URL without protocol

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--country <cc>` | `us` | 2-letter country code |
| `--lang <code>` | `en` | Language code |
| `--max-reviews <N>` | `50` | Max reviews to fetch (0 = skip reviews) |

## Examples

```bash
# Slack by package name
node play-store-app/scripts/play-store-app.mjs com.Slack

# Instagram with 200 reviews
node play-store-app/scripts/play-store-app.mjs com.instagram.android --max-reviews 200

# WhatsApp by URL
node play-store-app/scripts/play-store-app.mjs https://play.google.com/store/apps/details?id=com.whatsapp

# Metadata only (skip reviews)
node play-store-app/scripts/play-store-app.mjs com.Slack --max-reviews 0

# Turkish Play Store
node play-store-app/scripts/play-store-app.mjs com.Slack --country tr --lang tr
```

## Output Format

```json
{
  "appId": "com.Slack",
  "title": "Slack",
  "description": "Slack helps companies big and small...",
  "summary": "All your team communication in one place",
  "url": "https://play.google.com/store/apps/details?id=com.Slack&hl=en&gl=us",
  "developer": {
    "name": "SLACK TECHNOLOGIES L.L.C.",
    "devId": "SLACK+TECHNOLOGIES+L.L.C.",
    "email": "feedback@slack.com",
    "website": "http://slack.com",
    "address": "415 Mission St FL 3, San Francisco, CA 94105-2504, United States",
    "legalName": "Slack Technologies L.L.C"
  },
  "score": 4.666,
  "scoreText": "4.7",
  "ratings": 182900,
  "reviews": 7466,
  "histogram": { "1": 8169, "2": 1698, "3": 4510, "4": 14187, "5": 154319 },
  "price": 0,
  "free": true,
  "currency": "USD",
  "priceText": "Free",
  "offersIAP": false,
  "inAppProductPrice": null,
  "genre": "Business",
  "genreId": "BUSINESS",
  "categories": [{ "name": "Business", "id": "BUSINESS" }],
  "icon": "https://play-lh.googleusercontent.com/...",
  "headerImage": "https://play-lh.googleusercontent.com/...",
  "screenshots": ["https://play-lh.googleusercontent.com/..."],
  "video": null,
  "videoImage": null,
  "contentRating": "Everyone",
  "contentRatingDescription": null,
  "adSupported": false,
  "released": "Jul 22, 2013",
  "updated": "2026-03-17T01:54:29.000Z",
  "version": "26.03.30.0",
  "androidVersion": "10",
  "androidVersionText": "10",
  "installs": "10,000,000+",
  "minInstalls": 10000000,
  "maxInstalls": 44821692,
  "available": true,
  "privacyPolicy": "https://slack.com/trust/privacy/privacy-policy",
  "recentChanges": "Bug Fixes...",
  "preregister": false,
  "reviewsList": [
    {
      "id": "7e188c76-00e4-4927-adc7-3efbf9290bdb",
      "userName": "Chris Hammerschmidt",
      "userImage": "https://play-lh.googleusercontent.com/...",
      "score": 1,
      "thumbsUp": 0,
      "reviewCreatedVersion": "26.03.20.0",
      "at": "2026-03-21T09:34:10.180Z",
      "replyDate": null,
      "replyText": null,
      "title": null,
      "text": "in my experience: consistent issues loading content, unreliable notifications",
      "url": "https://play.google.com/store/apps/details?id=com.Slack&reviewId=..."
    }
  ]
}
```

## Data Sources

| Source | Method |
|--------|--------|
| App metadata | `google-play-scraper` → Google Play internal API |
| Reviews | `google-play-scraper` → Google Play internal RPC (paginated via nextPaginationToken) |

## Notes

- **Reviews** are fetched using pagination tokens — no hard limit on total count
- **Country & lang matter** — pricing, descriptions, and reviews differ between regions
- **Invalid package** → returns clean `NOT_FOUND` error, no crash
- **App with no reviews** → `reviewsList: []` (empty array)
- **`--max-reviews 0`** → skips review fetching entirely (faster for metadata-only use cases)
