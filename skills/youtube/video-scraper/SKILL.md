# youtube-video-scraper

Scrape YouTube public content without requiring a YouTube account:
- **Search** videos, channels, and playlists (with pagination)
- **Channel scraping** — videos, shorts, playlists, channel metadata (subscriber count, description)
- **Video metadata** — title, views, likes, duration, description, channel info, related videos
- **Comments** — paginated comment threads with reply counts

---

## ⚠️ Critical Context

YouTube's internal `youtubei/v1` API is used directly — **no YouTube Data API key or quota** needed.

| Feature | Works without login? | Method |
|---------|---------------------|--------|
| Search (videos/channels/playlists) | ✅ Yes | youtubei/v1/search |
| Channel metadata (name, subscribers) | ✅ Yes | youtubei/v1/browse |
| Channel videos/shorts/playlists | ✅ Yes | youtubei/v1/browse |
| Video metadata (title, views, duration) | ✅ Yes | youtubei/v1/next + player |
| Comments | ✅ Yes | youtubei/v1/next (continuation) |
| Video download URLs (streamingData) | ❌ No | Requires auth |
| Private videos/channels | ❌ No | Requires auth |
| Age-restricted streaming | ❌ No | Requires auth |

**Strategy:** All API calls are made via `page.evaluate(fetch(...))` within Chrome's browser context (Playwright/CDP). This uses the browser's real cookies and bypasses YouTube's WAF/bot detection. No signature computation needed (unlike TikTok).

---

## Prerequisites

- Node.js 22+
- `playwright` npm package:
  ```bash
  # Check if available:
  node -e "import('/usr/lib/node_modules/playwright/index.mjs').then(()=>console.log('ok'))"
  
  # Install if missing:
  sudo npm install -g playwright
  ```
- Google Chrome or Chromium:
  ```bash
  # Check paths tried (in order):
  # /opt/google/chrome/chrome
  # /usr/bin/google-chrome-stable
  # /usr/bin/google-chrome
  # /usr/bin/chromium
  # /usr/bin/chromium-browser
  which google-chrome-stable || which chromium
  ```

---

## Quick Start (No Login Required)

```bash
cd skills/youtube/video-scraper/scripts

# Search videos:
node video-scraper.mjs search "javascript tutorial" --filter=videos --pages=2

# Scrape channel videos:
node video-scraper.mjs channel @MrBeast --tab=videos --pages=2

# Get video metadata:
node video-scraper.mjs video dQw4w9WgXcQ

# Get video comments:
node video-scraper.mjs comments dQw4w9WgXcQ --pages=2
```

---

## Usage

### Search

```bash
node video-scraper.mjs search <query> [options]

# Options:
#   --filter=all|videos|channels|playlists  (default: all)
#   --pages=<n>                             (default: 3, ~20 results/page)
#   --limit=<n>                             Max items to return
#   --output=<file>                         Save to JSON file

# Examples:
node video-scraper.mjs search "python tutorial" --filter=videos --pages=1
node video-scraper.mjs search "NASA" --filter=channels
node video-scraper.mjs search "react hooks" --filter=videos --pages=3 --limit=50
node video-scraper.mjs search "cooking" --output=/tmp/cooking-search.json
```

### Channel Scraping

```bash
node video-scraper.mjs channel <channelId|@handle> [options]

# Options:
#   --tab=videos|shorts|playlists|posts  (default: videos)
#   --pages=<n>                          (default: 3, ~30 videos/page)
#   --limit=<n>                          Max videos
#   --output=<file>                      Save to JSON file

# Examples:
node video-scraper.mjs channel @MrBeast --tab=videos --pages=2
node video-scraper.mjs channel UCX6OQ3DkcsbYNE6H8uQQuVA --tab=shorts
node video-scraper.mjs channel @mkbhd --tab=playlists
node video-scraper.mjs channel @mkbhd --tab=videos --limit=50 --output=/tmp/mkbhd.json
```

Both `@handle` and `UCxxxxxxxxx` channel IDs are supported.

### Video Metadata

```bash
node video-scraper.mjs video <videoId>

# Examples:
node video-scraper.mjs video dQw4w9WgXcQ
node video-scraper.mjs video nLRL_NcnK-4
node video-scraper.mjs video dQw4w9WgXcQ --output=/tmp/video.json
```

### Comments

```bash
node video-scraper.mjs comments <videoId> [options]

# Options:
#   --pages=<n>    (default: 3, ~20 comments/page)
#   --limit=<n>    Max comments
#   --output=<file>

# Examples:
node video-scraper.mjs comments dQw4w9WgXcQ --pages=2
node video-scraper.mjs comments nLRL_NcnK-4 --limit=100 --output=/tmp/comments.json
```

### Use Specific Chrome Instance

```bash
# Connect to existing Chrome with remote debugging:
node video-scraper.mjs search "test" --cdp-url=http://localhost:9333
node video-scraper.mjs channel @MrBeast --cdp-url=http://localhost:9222
```

### Show Browser Window (Debug)

```bash
node video-scraper.mjs search "test" --no-headless
```

---

## Output Format

### Search Results

```json
{
  "query": "javascript tutorial",
  "filter": "videos",
  "estimatedResults": 1234567,
  "results": [
    {
      "type": "video",
      "videoId": "hdI2bqOjy3c",
      "url": "https://www.youtube.com/watch?v=hdI2bqOjy3c",
      "title": "JavaScript Tutorial for Beginners",
      "channel": {
        "name": "Programming with Mosh",
        "id": "UCWv7vMbMWH4-V0ZXdmDpPBA",
        "url": "https://www.youtube.com/channel/UCWv7vMbMWH4-V0ZXdmDpPBA"
      },
      "duration": "48:17",
      "viewCount": "8,057,519 views",
      "publishedTime": "3 years ago",
      "thumbnailUrl": "https://i.ytimg.com/vi/hdI2bqOjy3c/hqdefault.jpg",
      "description": "This JavaScript tutorial for beginners will teach you the core..."
    }
  ],
  "meta": {
    "scraped_at": "2026-03-28T00:00:00.000Z",
    "query": "javascript tutorial",
    "filter": "videos",
    "total_fetched": 40,
    "pages_fetched": 2,
    "has_more": true
  }
}
```

### Channel

```json
{
  "channel": {
    "channelId": "UCX6OQ3DkcsbYNE6H8uQQuVA",
    "name": "MrBeast",
    "handle": null,
    "url": "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
    "description": "SUBSCRIBE FOR A COOKIE!...",
    "keywords": "MrBeast philanthropy challenges...",
    "subscriberCount": "473M subscribers",
    "thumbnailUrl": "https://yt3.googleusercontent.com/...",
    "isFamilySafe": true
  },
  "tab": "videos",
  "videos": [
    {
      "videoId": "JFtlf8RoPZY",
      "url": "https://www.youtube.com/watch?v=JFtlf8RoPZY",
      "title": "Trapped On An Island Until I Build A Boat",
      "publishedTime": "3 weeks ago",
      "viewCount": "85,321,447 views",
      "duration": "15:00",
      "thumbnailUrl": "https://i.ytimg.com/vi/JFtlf8RoPZY/hqdefault.jpg",
      "isLive": false
    }
  ],
  "meta": {
    "scraped_at": "2026-03-28T00:00:00.000Z",
    "channel_id": "UCX6OQ3DkcsbYNE6H8uQQuVA",
    "tab": "videos",
    "total_fetched": 30,
    "pages_fetched": 1,
    "has_more": true
  }
}
```

### Video Metadata

```json
{
  "videoId": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
  "description": "The official video for...",
  "publishDate": "Oct 25, 2009",
  "viewCount": "1,629,789,567 views",
  "likeCount": "17M",
  "duration": "3:33",
  "durationSeconds": 213,
  "channel": {
    "id": "UCuAXFkgsw1L7xaCfnd5JJOw",
    "name": "Rick Astley",
    "subscriberCount": "3.97M subscribers",
    "url": "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw"
  },
  "keywords": ["rick astley", "never gonna give you up", ...],
  "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "isLive": false,
  "isPrivate": false,
  "relatedVideos": [...],
  "meta": {
    "scraped_at": "2026-03-28T00:00:00.000Z",
    "videoId": "dQw4w9WgXcQ",
    "playabilityStatus": "OK"
  }
}
```

### Comments

```json
{
  "videoId": "dQw4w9WgXcQ",
  "comments": [
    {
      "commentId": "Ugyw...",
      "author": "John Smith",
      "authorChannelId": "UCxxxxxxxxx",
      "text": "This song never gets old!",
      "likeCount": 45231,
      "publishedTime": "3 years ago",
      "isChannelOwner": false,
      "isPinned": false,
      "replyCount": 127,
      "voteStatus": "INDIFFERENT",
      "replies": []
    }
  ],
  "meta": {
    "scraped_at": "2026-03-28T00:00:00.000Z",
    "videoId": "dQw4w9WgXcQ",
    "total_fetched": 40,
    "pages_fetched": 2,
    "has_more": true
  }
}
```

---

## How It Works

### Architecture

1. **Browser Launch**: Connects to existing Chrome via CDP (port 9333 or 9222) OR launches fresh headless Chrome
2. **Session Init**: Navigates to `https://www.youtube.com` to load `ytcfg` (API key, client version, visitor data)
3. **API Calls**: All requests made via `page.evaluate(fetch(...))` using browser's real session cookies
4. **No Auth Needed**: YouTube's `youtubei/v1` API works without login for all public content

### Why use `page.evaluate` instead of direct HTTP?

YouTube detects direct HTTP requests and may return `LOGIN_REQUIRED` for some endpoints. Making the API calls from within the browser's context (via `page.evaluate`) uses the browser's existing session, cookies, and TLS fingerprint — bypassing bot detection completely.

### Search Pagination

1. First page: POST to `/youtubei/v1/search` with `query` + optional `params` filter
2. Response contains results in `contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents`
3. Continuation token in `continuationItemRenderer.continuationEndpoint.continuationCommand.token`
4. Next pages: POST with `continuation` token instead of `query`. Response uses `onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems[0].itemSectionRenderer.contents` (results wrapped in itemSectionRenderer)

### Channel Tab Navigation

1. First call `/youtubei/v1/browse` with `browseId` (channel ID) and `params` (tab selector)
2. Tab params: `videos=EgZ2aWRlb3PyBgQKAjoA`, `shorts=EgZzaG9ydHPyBgUKA5oBAA%3D%3D`, `playlists=EglwbGF5bGlzdHPyBgQKAkIA`
3. Videos in `richGridRenderer.contents[].richItemRenderer.content.videoRenderer`
4. Pagination: continuation token from `richGridRenderer.contents[-1].continuationItemRenderer`
5. Pagination responses in `onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems`

### Comment Loading

Comments use a two-step process:
1. **Step 1**: POST `/youtubei/v1/next` with `videoId` → get comment continuation token from `engagementPanels` (panel where `panelIdentifier` contains "comment", e.g. `engagement-panel-comments-section`)
2. **Step 2**: POST `/youtubei/v1/next` with `continuation: <token>` → get first comments page
3. **Step 3+**: Use continuation token from each page's `continuationItemRenderer` for subsequent pages
4. **Note**: Page 1 response has TWO endpoints: one for header, one for comments. The scraper handles this automatically.
5. **New Entity framework**: YouTube stores comment data in `frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload` (keyed by `commentId`). The `commentThreadRenderer` items only contain reference keys (`commentViewModel.commentId`). The scraper automatically builds an entity map and joins data.

### Channel Handle Resolution

`@handle` format is automatically resolved to `UCxxxxxxxxx` channel ID via:
```
POST /youtubei/v1/navigation/resolve_url
Body: { url: "https://www.youtube.com/@handle" }
Response: endpoint.browseEndpoint.browseId → UCxxxxxxxxx
```

---

## Error Handling

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | — |
| 1 | General error | Check stderr for details |
| 2 | Not found | Check videoId/channelId spelling |
| 3 | Login required | Content is private; use authenticated Chrome session |
| 4 | WAF/bot block | Use `--cdp-url=http://localhost:9333` to attach to real Chrome |
| 5 | Rate limited | Wait 30-60 seconds and retry |

---

## Rate Limiting

YouTube's limits (approximate):
- **Search**: ~100+ requests per session — very lenient
- **Browse**: ~100+ requests per session
- **Comments**: ~50+ requests per session
- Built-in default delay: 1500ms between requests

Rate limit symptoms:
- Empty response body
- `quotaExceeded` in responseContext serviceTrackingParams

If rate limited:
1. Increase `--delay=3000` (3 seconds between requests)
2. Use `--cdp-url` to attach to a real Chrome session with history
3. Wait 1-5 minutes and retry

---

## WAF / Bot Detection

YouTube has relatively light bot detection compared to other platforms. The scraper avoids detection by:
- Making all API calls from within Chrome's browser context (`page.evaluate`)
- Using real browser cookies and TLS fingerprint
- Realistic request timing (1500ms delays)

If you get bot-blocked:
1. Use `--cdp-url=http://localhost:9333` to attach to your real Chrome session
2. Try `--no-headless` to see what YouTube is showing
3. Navigate to `youtube.com` manually first, then retry

---

## Session Expiry / Forced Logout

YouTube sessions last months. Signs of session issues:
- `status: LOGIN_REQUIRED` across all endpoints
- Redirect to login page detected

Recovery:
1. Open Chrome manually and visit `youtube.com`
2. Re-run your command — it will pick up the fresh session automatically

---

## Pagination Details

| Command | Items per page | Pagination token location |
|---------|----------------|--------------------------|
| search | ~20 results | `continuationItemRenderer` at end of section |
| channel (videos tab) | ~30 videos | `richGridRenderer.contents[-1].continuationItemRenderer` |
| channel (shorts tab) | ~30 shorts | Same as above |
| comments | ~20 comments | `continuationItemRenderer` in comment items |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CHROME_EXECUTABLE` | Path to Chrome binary | auto-detect |
| `QUIET` | Suppress log output to stderr | (unset) |
| `DEBUG` | Show full stack traces | (unset) |

---

## Known Limitations & Caveats

1. **No video download URLs**: `streamingData` in the player response requires authentication. The scraper returns metadata only — use yt-dlp for actual video downloads.

2. **Tab params may change**: YouTube rotates internal params. The script uses hardcoded params with dynamic fallback extraction from the channel's home page response.

3. **Subscriber counts are text**: Returned as "473M subscribers" — parse with regex if you need a number.

4. **Related videos format varies**: YouTube A/B tests different response formats. The scraper handles both `lockupViewModel` (newer) and `compactVideoRenderer` (older) formats.

5. **Comment likes are integers**: Unlike views, likeCount on comments is returned as a number, not a formatted string.

6. **Private content**: Videos marked as private return exit code 3. No workaround without authentication.

7. **Age-restricted content**: Can fetch metadata but not streaming URLs.

8. **Regional availability**: Some content may not appear from certain IP addresses.

9. **Live streams**: `isLive: true` in video metadata. Live stream scraping is not specifically optimized.

10. **Shorts**: Scraped via the `shorts` tab of a channel. Search doesn't have a dedicated Shorts filter.
