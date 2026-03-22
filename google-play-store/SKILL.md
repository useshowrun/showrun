# google-play-store

Scraper skills for the Google Play Store. Fetches Android app metadata and reviews using the `google-play-scraper` npm package — a reverse-engineered client for Google's internal Play Store APIs. No browser, no authentication, no API keys required.

## Skills

| Skill | Description |
|-------|-------------|
| [play-store-search](./play-store-search/SKILL.md) | Search for Android apps by keyword |
| [play-store-app](./play-store-app/SKILL.md) | Get full app details + reviews by package name or URL |

## Data Sources

| Source | URL | Notes |
|--------|-----|-------|
| Google Play Search | `https://play.google.com/store/search?q=<query>&c=apps` | Internal API via google-play-scraper |
| App Detail | `https://play.google.com/store/apps/details?id=<packageName>` | Full metadata |
| Reviews | Internal Google Play RPC | Paginated via nextPaginationToken |

## Notes

- **No authentication required** — uses Google's public (but internal) Play Store APIs
- **No browser needed** — pure HTTP via `google-play-scraper` npm package
- **International** — use `--country` and `--lang` flags for localized results (pricing, reviews, descriptions differ)
- **Reviews** — paginated using Google's internal token system, no hard page limit
- **Package dependency** — `google-play-scraper` must be installed (`npm install` in this directory)
