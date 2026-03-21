# YouTube Channel Scraper

Fetches a YouTube channel's metadata plus recent videos (up to ~28-30 from initial page load).

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/youtube
node youtube-channel/scripts/youtube-channel.mjs <channelId|@handle|username> [maxVideos]
```

## Arguments

| Arg | Type | Description |
|-----|------|-------------|
| `channelId` | required | Channel identifier: UC... ID, @handle, or legacy username |
| `maxVideos` | optional | Max videos to return (default: 30) |

## Examples

```bash
# By channel ID (most reliable)
node youtube-channel/scripts/youtube-channel.mjs UCpVm7bg6pXKo1Pr6k5kxG9A 20

# By legacy username
node youtube-channel/scripts/youtube-channel.mjs NationalGeographic 15

# By @handle (may fall back to /user/ URL)
node youtube-channel/scripts/youtube-channel.mjs @NatGeo 10
```

## Output

```json
{
  "channel": {
    "title": "National Geographic",
    "handle": "@NatGeo",
    "channelId": "UCpVm7bg6pXKo1Pr6k5kxG9A",
    "description": "Inspiring people to care about the planet!...",
    "subscriberCount": 25900000,
    "subscriberCountText": "25.9M subscribers",
    "videoCount": 11000,
    "videoCountText": "11K videos",
    "thumbnailUrl": "https://yt3.googleusercontent.com/...",
    "bannerUrl": null,
    "canonicalUrl": "https://www.youtube.com/channel/UCpVm7bg6pXKo1Pr6k5kxG9A"
  },
  "videos": [
    {
      "videoId": "D7wnwfH55fw",
      "url": "https://www.youtube.com/watch?v=D7wnwfH55fw",
      "title": "Rise and Fall of the Third Reich's Deadly Fleet...",
      "viewCount": 5397,
      "viewCountText": "5,397 views",
      "duration": "47:23",
      "durationSeconds": 2843,
      "publishedText": "4 hours ago",
      "thumbnailUrl": "https://i.ytimg.com/vi/...",
      "description": null,
      "isLive": false
    }
  ],
  "meta": {
    "videosReturned": 5,
    "hasContinuation": true,
    "source": "https://www.youtube.com/user/NationalGeographic/videos"
  }
}
```

## Notes

- Initial page load returns ~28-30 videos (richGridRenderer); continuation requires API calls
- `@handle` format may 404 on Firefox; script automatically tries `/user/` and `/c/` fallbacks
- Use channel ID (`UC...`) for most reliable access
