# YouTube Agent Browser Skills

Scrape YouTube channel data, video details, and search results.
No API key or login required — extracts from embedded page data (ytInitialData / ytInitialPlayerResponse).

## Prerequisites

### Node.js 24 (nvm)
Run with: `/home/karacasoft/.nvm/versions/node/v24.13.1/bin/node`

### Install Dependencies
```bash
cd youtube && npm install
```

### Fix better-sqlite3 (if needed)
```bash
cd youtube/node_modules/better-sqlite3
/home/karacasoft/.nvm/versions/node/v24.13.1/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Channel](youtube-channel/SKILL.md) | `youtube-channel/scripts/youtube-channel.mjs` | Channel metadata + recent videos |
| [Video](youtube-video/SKILL.md) | `youtube-video/scripts/youtube-video.mjs` | Full video metadata |
| [Search](youtube-search/SKILL.md) | `youtube-search/scripts/youtube-search.mjs` | Search YouTube for videos |
| [Comments](youtube-comments/SKILL.md) | `youtube-comments/scripts/youtube-comments.mjs` | Comments on any video (with pagination) |
| [Transcript](youtube-transcript/SKILL.md) | `youtube-transcript/scripts/youtube-transcript.mjs` | Full captions/subtitles from any video (multi-language) |

## Typical Workflow

```
1. Search for channels  →  node youtube-search/scripts/youtube-search.mjs "national geographic" 10
2. Get channel videos   →  node youtube-channel/scripts/youtube-channel.mjs NationalGeographic 30
3. Get video details    →  node youtube-video/scripts/youtube-video.mjs dQw4w9WgXcQ
```

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

## Data Available

### Channel
- `channel`: title, handle, channelId, description, subscriberCount/Text, videoCount/Text,
             thumbnailUrl, bannerUrl, canonicalUrl
- `videos[]`: videoId, url, title, viewCount/Text, duration, publishedText, thumbnailUrl, description

### Video
- videoId, url, title, description
- channelId, channelName, channelUrl, channelThumbnailUrl
- viewCount, likeCount
- duration, durationSeconds
- publishedDate, uploadDate, category
- keywords[], thumbnailUrl, thumbnails[]
- isFamilySafe, isUnlisted, isLiveBroadcast

### Search Results
- query, count
- results[]: videoId, url, title, channelName, channelId, channelUrl,
             viewCount/Text, duration, publishedText, thumbnailUrl, descriptionSnippet, badges

### Comments
- videoId, videoUrl, totalComments
- comments[]: id, text, author, authorChannelId, authorChannelUrl, authorAvatarUrl,
              isAuthorVerified, publishedTime, likeCount, replyCount, isLikedByCreator, isPinned
- meta: returned, hasMore, sortedBy

## Anti-Bot Notes

YouTube is relatively bot-friendly for basic data.
- Uses SOCS cookie to bypass consent page
- Extracts data from embedded `ytInitialData` / `ytInitialPlayerResponse` JSON in page scripts
- No class names or brittle CSS selectors — all data from structured page JSON
- `@handle` format channels may 404 on Firefox/camoufox; fallback to `/user/` or `/channel/ID` works
- Channel data via `/user/legacyName` or `/channel/channelId` is most reliable
