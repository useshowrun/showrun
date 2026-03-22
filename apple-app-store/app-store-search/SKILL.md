# app-store-search

Search for iOS apps on the Apple App Store by keyword, returning metadata for each result.

## Usage

```bash
node app-store-search/scripts/app-store-search.mjs <query> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<query>` | Search term (required) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--country <cc>` | `us` | 2-letter country code |
| `--max <N>` | `25` | Max results to return (1–200) |
| `--type <entity>` | `software` | App type: `software` (iOS) \| `mac_software` \| `tv_software` |

## Examples

```bash
# Search for Slack
node app-store-search/scripts/app-store-search.mjs slack

# Top 10 photo editor apps
node app-store-search/scripts/app-store-search.mjs "photo editor" --max 10

# Fitness apps in the UK store
node app-store-search/scripts/app-store-search.mjs fitness --country gb --max 20

# Mac apps
node app-store-search/scripts/app-store-search.mjs "productivity" --type mac_software

# Turkish App Store
node app-store-search/scripts/app-store-search.mjs "video düzenleme" --country tr
```

## Output Format

```json
{
  "query": "slack",
  "country": "us",
  "entity": "software",
  "total": 25,
  "apps": [
    {
      "id": "618783545",
      "name": "Slack",
      "bundleId": "com.tinyspeck.chatlyio",
      "developer": "Slack Technologies, Inc.",
      "rating": 4.7,
      "ratingCount": 1234567,
      "price": 0,
      "currency": "USD",
      "genre": "Business",
      "iconUrl": "https://is1-ssl.mzstatic.com/image/thumb/.../512x512bb.jpg",
      "url": "https://apps.apple.com/us/app/slack-for-desktop/id618783545?uo=4"
    }
  ]
}
```

## Data Source

iTunes Search API — `https://itunes.apple.com/search?term=<query>&entity=software&country=<cc>&limit=<N>`

No authentication required. Returns full JSON.
