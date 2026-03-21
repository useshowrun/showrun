# YouTube Comments Scraper

Fetches comments from any public YouTube video. No API key or login required.

## Strategy

Uses camoufox (fingerprinted Firefox) to navigate to the YouTube video page, then intercepts the internal `youtubei/v1/next` API calls that YouTube makes when comments are triggered by scrolling.

### Data Architecture (YouTube's comment format as of 2026)

YouTube uses a mutation-based system split across two parts of each API response:

1. **`frameworkUpdates.entityBatchUpdate.mutations[]`**  
   Contains `commentEntityPayload` objects with actual comment data:
   - `properties.commentId` — unique comment ID
   - `properties.content.content` — comment text
   - `properties.publishedTime` — e.g. "6 years ago (edited)"
   - `author.displayName` — channel handle
   - `author.channelId` — UCxxxx channel ID
   - `author.isVerified` — verified badge
   - `toolbar.likeCountNotliked` — like count as string (e.g. "201K")
   - `toolbar.replyCount` — reply count
   - `toolbar.heartState` — "TOOLBAR_HEART_STATE_HEARTED" if creator liked
   - `avatar.image.sources[].url` — author thumbnail

2. **`onResponseReceivedEndpoints`**  
   Contains ordered comment ID lists and continuation tokens:
   - `reloadContinuationItemsCommand` (targetId: "comments-section") — initial load
   - `appendContinuationItemsAction` (targetId: "comments-section") — pagination
   - Each contains `continuationItems[]` with `commentThreadRenderer.commentViewModel.commentViewModel.commentId`
   - The last item is `continuationItemRenderer` with next page's `continuationToken`
   - The header item (`commentsHeaderRenderer`) has the total comment count

### Anti-bot / Consent handling

- SOCS consent cookie bypasses YouTube's GDPR consent dialog
- camoufox fingerprinted Firefox is indistinguishable from a real Firefox user
- No rate limiting observed with moderate usage

## Usage

```bash
# Basic: get 20 top comments (default)
node youtube-comments.mjs dQw4w9WgXcQ

# Get 100 comments
node youtube-comments.mjs dQw4w9WgXcQ --max 100

# Sort by newest first
node youtube-comments.mjs dQw4w9WgXcQ --sort new

# Full URL also works
node youtube-comments.mjs "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## Output

```json
{
  "videoId": "dQw4w9WgXcQ",
  "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "totalComments": 2424107,
  "comments": [
    {
      "id": "Ugzge340dBgB75hWBm54AaABAg",
      "text": "can confirm: he never gave us up",
      "author": "@YouTube",
      "authorChannelId": "UCBR8-60-B28hp2BmDPdntcQ",
      "authorChannelUrl": "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      "authorAvatarUrl": "https://yt3.ggpht.com/...",
      "isAuthorVerified": true,
      "publishedTime": "10 months ago",
      "likeCount": 201000,
      "replyCount": 960,
      "isLikedByCreator": false,
      "isPinned": false
    }
  ],
  "meta": {
    "returned": 20,
    "hasMore": true,
    "sortedBy": "top"
  }
}
```

## Selector Stability

- **Zero CSS class selectors** — all data from intercepted JSON API responses
- No DOM scraping for comment data
- SOCS cookie: stable since 2023 (YouTube's consent bypass)
- `youtubei/v1/next` endpoint: stable internal YouTube API

## Known Limitations

- Comments are loaded in batches of ~20 per scroll. For large maxComments, allow more scroll time.
- Sort by "newest first" requires clicking the sort UI after comments load; may not always succeed.
- Pinned comments from `pinnedCommentBadge` — structure may vary by video.
- Videos with disabled comments return `totalComments: null, comments: []`.

## Files

- `scripts/youtube-comments.mjs` — main scraper script
- `../../lib/utils.mjs` — shared utilities (addConsentCookies, extractPageJson, etc.)
