# Instagram Hashtag Skill

Scrapes top posts/reels for a hashtag from Instagram's explore page.
Uses DOM-based extraction — no login required.

## Usage

```bash
node instagram-hashtag/scripts/instagram-hashtag.mjs <hashtag>
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| hashtag | ✅ | Hashtag to search (with or without #) |

## Examples

```bash
node instagram-hashtag/scripts/instagram-hashtag.mjs photography
node instagram-hashtag/scripts/instagram-hashtag.mjs "#istanbul"
node instagram-hashtag/scripts/instagram-hashtag.mjs sunset
```

## Output Schema

```json
{
  "hashtag": "#photography",
  "pageTitle": "Photography • 4.5B reels on Instagram",
  "reelCount": "4.5B",
  "postCount": null,
  "count": 12,
  "posts": [
    {
      "shortcode": "DUaPa2AAZGc",
      "url": "https://www.instagram.com/reel/DUaPa2AAZGc/",
      "type": "reel",
      "thumbnailUrl": null,
      "videoPreviewUrl": "https://scontent.cdninstagram.com/.../video.mp4",
      "altText": null
    }
  ],
  "meta": {
    "note": "DOM-based extraction — no login required. Returns top 12 preview posts/reels.",
    "url": "https://www.instagram.com/explore/tags/photography/"
  }
}
```

## Notes

- Returns the **top 12** posts/reels shown on the hashtag explore page
- Data is **limited** — only shortcode, URL, type, and video preview URL
- For full post data (likes, caption, etc.), use the `instagram-profile` skill with the post's author
- The hashtag page shows a "Popular Searches" preview with auto-playing videos
- `thumbnailUrl` is null when videos autoplay (browser doesn't expose poster)
- `videoPreviewUrl` contains the actual video source URL (can be downloaded)

## Error Codes

| Code | Description |
|------|-------------|
| `MISSING_ARG` | No hashtag provided |
| `AUTH_REQUIRED` | Instagram requires login (rate limited) |
| `NO_RESULTS` | No posts found for hashtag |
| `UNEXPECTED_ERROR` | Script crash |
