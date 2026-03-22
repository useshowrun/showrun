# play-store-search

Search for Android apps on the Google Play Store by keyword.

## Usage

```bash
node play-store-search/scripts/play-store-search.mjs <query> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<query>` | Search term (required) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--country <cc>` | `us` | 2-letter country code |
| `--lang <code>` | `en` | Language code |
| `--max <N>` | `25` | Max results to return |

## Examples

```bash
# Basic search
node play-store-search/scripts/play-store-search.mjs slack

# Limit results
node play-store-search/scripts/play-store-search.mjs "photo editor" --max 10

# Localized search (Turkish)
node play-store-search/scripts/play-store-search.mjs "fotoğraf düzenle" --country tr --lang tr

# UK market
node play-store-search/scripts/play-store-search.mjs fitness --country gb --lang en --max 20
```

## Output Format

```json
{
  "query": "slack",
  "country": "us",
  "lang": "en",
  "total": 5,
  "apps": [
    {
      "appId": "com.Slack",
      "title": "Slack",
      "developer": "SLACK TECHNOLOGIES L.L.C.",
      "developerId": "SLACK+TECHNOLOGIES+L.L.C.",
      "score": 4.43,
      "scoreText": "4.4",
      "price": null,
      "free": false,
      "currency": null,
      "priceText": null,
      "summary": "All your team communication in one place",
      "icon": "https://play-lh.googleusercontent.com/...",
      "url": "https://play.google.com/store/apps/details?id=com.Slack"
    }
  ]
}
```

## Notes

- Results are returned in Play Store's relevance order
- `price` and `currency` may be `null` for free apps (Play Store doesn't always return these in search)
- `score` is based on all-time ratings
