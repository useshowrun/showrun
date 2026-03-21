# YouTube Search Scraper

Searches YouTube and returns video results.

## Usage

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/youtube
node youtube-search/scripts/youtube-search.mjs <query> [maxResults]
```

## Arguments

| Arg | Type | Description |
|-----|------|-------------|
| `query` | required | Search query |
| `maxResults` | optional | Max results to return (default: 20) |

## Examples

```bash
node youtube-search/scripts/youtube-search.mjs "space exploration" 20
node youtube-search/scripts/youtube-search.mjs "cooking pasta" 10
```

## Output

```json
{
  "query": "space exploration",
  "count": 5,
  "results": [
    {
      "videoId": "Wi_jQ-DJ-qk",
      "url": "https://www.youtube.com/watch?v=Wi_jQ-DJ-qk",
      "title": "Where will space exploration take us in the next 50 years?",
      "channelName": "BBC Ideas and BBC World Service",
      "channelId": null,
      "channelUrl": null,
      "viewCountText": "41,218 views",
      "viewCount": 41218,
      "duration": "5:00",
      "publishedText": "1 year ago",
      "thumbnailUrl": "https://i.ytimg.com/vi/Wi_jQ-DJ-qk/hq720.jpg",
      "descriptionSnippet": "Day trips to the Moon, living on Mars...",
      "badges": ["CC"]
    }
  ]
}
```

## Notes

- Extracts from `ytInitialData.contents.twoColumnSearchResultsRenderer`
- Returns ~20 results from initial page load (first "page" of search)
- Channel IDs may be null for some results (depends on YouTube's response)
- badges: "CC" = subtitles, "4K" = 4K video, "LIVE" = live stream, etc.
