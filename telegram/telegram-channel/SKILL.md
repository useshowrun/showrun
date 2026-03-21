# Telegram Channel Scraper

Scrape public Telegram channel messages, metadata, and member counts.

## Usage

```bash
cd telegram
node telegram-channel/scripts/telegram-channel.mjs <channel> [--max N] [--before ID]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<channel>` | Yes | Channel username: `durov`, `@telegram`, `https://t.me/bbcnews` |
| `--max N` | No | Max messages to return (default: 20) |
| `--before ID` | No | Start fetching from before this message ID (pagination) |

### Environment

| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | Optional: `host:port` for SOCKS5 proxy routing |

## Examples

```bash
# Scrape last 20 messages from @durov
node telegram-channel/scripts/telegram-channel.mjs durov

# Scrape 50 messages from Telegram's official channel
node telegram-channel/scripts/telegram-channel.mjs telegram --max 50

# Paginate: get messages before ID 400
node telegram-channel/scripts/telegram-channel.mjs durov --before 400 --max 10

# Full URL input
node telegram-channel/scripts/telegram-channel.mjs "https://t.me/hacker_news_feed"
```

## Output

```json
{
  "channel": {
    "username": "durov",
    "title": "Pavel Durov",
    "description": "Founder of Telegram.",
    "isVerified": true,
    "photoUrl": "https://cdn4.telesco.pe/...",
    "subscriberCount": 10400000,
    "subscriberText": "10.4M",
    "photoCount": 90,
    "videoCount": 36,
    "linkCount": 168
  },
  "messages": [
    {
      "messageId": 473,
      "messageUrl": "https://t.me/durov/473",
      "datetime": "2026-03-15T14:58:00+00:00",
      "isEdited": false,
      "author": "Pavel Durov",
      "text": "Message text...",
      "mediaType": "video",
      "photoUrls": ["https://cdn4.telesco.pe/...jpg"],
      "videoUrl": "https://cdn4.telesco.pe/...mp4?token=...",
      "videoDuration": "0:18",
      "linkPreview": {
        "url": "https://example.com",
        "siteName": "Site Name",
        "title": "Title",
        "description": "Desc",
        "imageUrl": null
      },
      "links": [{"url": "https://...", "text": "link text"}],
      "hashtags": ["tag1"],
      "views": 5340000,
      "viewsText": "5.34M",
      "reactions": [
        {"type": "stars", "count": 39400, "countText": "39.4K"},
        {"type": "emoji", "count": 86100, "countText": "86.1K"}
      ],
      "totalReactions": 125500
    }
  ],
  "meta": {
    "fetched": 20,
    "requestedMax": 20,
    "hasMore": true,
    "nextBeforeId": 453,
    "pagesLoaded": 2
  }
}
```

## Limitations

- **Public channels only**: `t.me/s/` only works for channels with public message history
- **No comments**: Telegram web view doesn't expose comments
- **Media tokens expire**: Video URLs contain time-limited tokens (hours/days)
- **~20 messages per page**: Telegram returns ~20 messages per `?before=N` page
- **No full resolution photos**: Photo URLs are medium resolution from CSS background-image
- **Emoji reactions**: Reaction counts available but emoji type is an ID (not Unicode)

## Test Results (2026-03-21)

| Test | Result |
|------|--------|
| `durov --max 5` | ✅ Pavel Durov: 10.4M subs, verified, 5 messages with views/reactions |
| `telegram --max 10` | ✅ Telegram News: 11M subs, 10 video messages with link previews |
| `hacker_news_feed --max 5` | ✅ Hacker News: 27.7K subs, 5 text messages with view counts |
| `durov --before 400 --max 3` | ✅ Pagination: returned messages #373-#399 range |
| `thisdoesnotexist12345abc` | ✅ NOT_FOUND error returned cleanly |
| `@telegram` (handle format) | ✅ Works correctly |
| `https://t.me/durov` (URL format) | ✅ Correctly parsed |
