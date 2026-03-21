# TikTok Hashtag Scraper

Scrapes a TikTok hashtag/challenge page to get metadata and trending videos.

## Usage

```bash
node tiktok-hashtag/scripts/tiktok-hashtag.mjs <hashtag>
```

**Examples:**
```bash
node tiktok-hashtag/scripts/tiktok-hashtag.mjs nature
node tiktok-hashtag/scripts/tiktok-hashtag.mjs "#travel"
node tiktok-hashtag/scripts/tiktok-hashtag.mjs fyp
```

The `#` prefix is optional.

## How It Works

1. Opens a headless camoufox browser
2. Navigates to `https://www.tiktok.com/tag/{hashtag}`
3. Intercepts `/api/challenge/detail/` for hashtag metadata
4. Intercepts `/api/challenge/item_list/` for trending videos (~30)

## Output

```json
{
  "hashtag": "nature",
  "challenge": {
    "id": "5399",
    "title": "nature",
    "description": "Here's to the great outdoors.",
    "coverUrl": null,
    "viewCount": 363600000000,
    "videoCount": 0,
    "profileUrl": "https://www.tiktok.com/tag/nature"
  },
  "videos": [
    {
      "id": "...",
      "url": "https://www.tiktok.com/@user/video/...",
      "description": "Beautiful forest #nature",
      "hashtags": ["#nature"],
      "createTime": "2026-03-15T10:00:00.000Z",
      "duration": 30,
      "coverUrl": "https://...",
      "playUrl": "https://...",
      "diggCount": 45230,
      "shareCount": 1200,
      "commentCount": 89,
      "playCount": 890000,
      "author": { "uniqueId": "example_user", ... }
    }
  ],
  "meta": {
    "videosReturned": 30,
    "hasMore": true,
    "cursor": "1234567890000"
  }
}
```

## Notes

- `viewCount` represents total views across all hashtag videos
- TikTok returns "trending" videos (not strictly latest)
- `playUrl` expires quickly — use immediately

## Error Codes

| Code | Meaning |
|------|---------|
| `NOT_FOUND` | Hashtag does not exist |
| `MISSING_ARG` | No hashtag argument provided |
| `UNEXPECTED_ERROR` | Unhandled error |
