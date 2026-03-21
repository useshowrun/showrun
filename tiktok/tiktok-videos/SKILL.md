# TikTok Videos Scraper

Fetches videos from a TikTok user profile, with optional pagination.

## Usage

```bash
node tiktok-videos/scripts/tiktok-videos.mjs <username> [--cursor <cursor>] [--count <n>]
```

**Examples:**
```bash
# First page (up to ~35 videos)
node tiktok-videos/scripts/tiktok-videos.mjs natgeo

# Next page with cursor from previous result
node tiktok-videos/scripts/tiktok-videos.mjs natgeo --cursor 1771438710000
```

## Output

```json
{
  "username": "natgeo",
  "videos": [ ... ],
  "meta": {
    "videosReturned": 35,
    "hasMore": true,
    "nextCursor": 1771438710000,
    "batchCount": 1
  }
}
```

## Pagination

Use `meta.nextCursor` with `--cursor` for the next page.
Stop when `meta.hasMore` is `false`.

## Error Codes

| Code | Meaning |
|------|---------|
| `NOT_FOUND` | User does not exist |
| `MISSING_ARG` | No username provided |
| `UNEXPECTED_ERROR` | Unhandled error |
