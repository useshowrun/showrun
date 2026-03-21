# TikTok Comments Scraper

Scrapes comments from any public TikTok video.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/tiktok
node tiktok-comments/scripts/tiktok-comments.mjs <videoUrl|videoId> [--max <N>]
```

## Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `<videoUrl|videoId>` | TikTok video URL or numeric video ID | required |
| `--max <N>` | Max comments to return (paginates automatically) | 50 |

## Examples

```bash
# By full URL
node tiktok-comments/scripts/tiktok-comments.mjs "https://www.tiktok.com/@natgeo/video/7123456789012345678"

# By video ID
node tiktok-comments/scripts/tiktok-comments.mjs 7123456789012345678

# Get more comments
node tiktok-comments/scripts/tiktok-comments.mjs "https://www.tiktok.com/@nasa/video/7456789012345678901" --max 100
```

## Output

```json
{
  "videoId": "7123456789012345678",
  "videoUrl": "https://www.tiktok.com/@natgeo/video/7123456789012345678",
  "totalComments": 1234,
  "comments": [
    {
      "id": "7098765432109876543",
      "text": "Amazing shot!",
      "likeCount": 254,
      "replyCount": 12,
      "createTime": "2023-05-15T14:32:00.000Z",
      "author": {
        "id": "12345678",
        "uniqueId": "cooluser",
        "nickname": "Cool User",
        "avatarUrl": "https://...",
        "isVerified": false
      }
    }
  ],
  "meta": {
    "returned": 50,
    "hasMore": true,
    "cursor": "50"
  }
}
```

## How It Works

1. Navigate to the TikTok video page with camoufox (fingerprinted Firefox)
2. Intercept `/api/comment/list/` XHR responses (TikTok loads comments via API)
3. Scroll to comments section to trigger initial comment load
4. For pagination: intercept subsequent `/api/comment/list/?cursor=N` calls
5. Also reads embedded `__UNIVERSAL_DATA_FOR_REHYDRATION__` for video metadata

## API Endpoint

| Endpoint | Purpose |
|----------|---------|
| `/api/comment/list/` | Paginated comment list (cursor-based, 20 per page) |

## Selector Stability

- **Zero CSS class selectors** used
- All data from intercepted XHR API responses
- Comment section scrolling uses `[data-e2e="comment-item"]` for detection only

## Notes

- Requires no login for public videos
- Private videos will return a NOT_FOUND/PRIVATE error
- Rate limiting: TikTok may throttle after many requests; use delay between runs
- Comment playUrl (video URL) expires quickly — don't cache these
