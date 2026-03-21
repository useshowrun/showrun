# YouTube Video Scraper

Gets full metadata for a specific YouTube video.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/youtube
node youtube-video/scripts/youtube-video.mjs <videoId|url>
```

## Arguments

| Arg | Type | Description |
|-----|------|-------------|
| `videoId` | required | YouTube video ID or full URL |

## Examples

```bash
# By video ID
node youtube-video/scripts/youtube-video.mjs dQw4w9WgXcQ

# By full URL
node youtube-video/scripts/youtube-video.mjs "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## Output

```json
{
  "videoId": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "description": "The official video for Never Gonna Give You Up...",
  "channelId": "UCuAXFkgsw1L7xaCfnd5JJOw",
  "channelName": "Rick Astley",
  "channelUrl": "https://www.youtube.com/@RickAstleyYT",
  "channelThumbnailUrl": "https://yt3.ggpht.com/...",
  "viewCount": 1752851237,
  "likeCount": 18000000,
  "duration": "3:34",
  "durationSeconds": 213,
  "publishedDate": "2009-10-24T23:57:33-07:00",
  "uploadDate": "2009-10-24T23:57:33-07:00",
  "category": "Music",
  "keywords": ["rick astley", "Never Gonna Give You Up", ...],
  "thumbnailUrl": "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp",
  "thumbnails": [...],
  "isFamilySafe": true,
  "isUnlisted": false,
  "isLiveBroadcast": false,
  "isLive": null
}
```

## Notes

- Source: `ytInitialPlayerResponse` (video details) + `ytInitialData` (channel thumbnail, like count)
- likeCount is extracted from the like button UI text (may be rounded: "18M")
- No class name selectors — all data from embedded JSON
