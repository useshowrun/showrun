# apple-app-store

Scraper skills for the Apple App Store. Fetches iOS app metadata and reviews using the public iTunes APIs — no authentication, no browser, no bot protection to worry about.

## Skills

| Skill | Description |
|-------|-------------|
| [app-store-search](./app-store-search/SKILL.md) | Search for iOS apps by keyword |
| [app-store-app](./app-store-app/SKILL.md) | Get full app details + reviews by app ID or URL |

## Data Sources

| Source | URL | Notes |
|--------|-----|-------|
| iTunes Search API | `https://itunes.apple.com/search` | Search by keyword |
| iTunes Lookup API | `https://itunes.apple.com/lookup?id=<id>` | Full metadata by app ID |
| Reviews RSS (JSON) | `https://itunes.apple.com/<cc>/rss/customerreviews/id=<id>/page=<n>/sortBy=mostRecent/json` | Up to 500 reviews (10 pages × 50) |

## Notes

- **No authentication required** — iTunes API is fully open
- **No browser needed** — pure HTTP GET requests
- **International** — use `--country` flag for any country's App Store (pricing, availability, reviews differ)
- **Reviews** — paginated JSON RSS feed, up to 50 per page, max 10 pages (500 reviews total)
