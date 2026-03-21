# Telegram Agent Browser Skills

Scrape public Telegram channels: messages, metadata, member counts, media.

## Data Source

Telegram exposes public channels at `https://t.me/s/{channel}` — server-side rendered HTML.
No API key, no login, no bot required. Works for **public channels only**.

> **Note**: Only channels with public history enabled appear at `t.me/s/`. Groups, private channels,
> and channels without public history return a redirect (NOT_FOUND).

## Prerequisites

### Node.js 22+
Required. Use `nvm use 24` or specify the full path.

### Install Dependencies
```bash
cd telegram && npm install
```

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Channel](telegram-channel/SKILL.md) | `telegram-channel/scripts/telegram-channel.mjs` | Scrape channel info + messages with pagination |

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SOCKS5_PROXY` | No | Optional SOCKS5 proxy host:port (e.g. `127.0.0.1:11090`) |

## Anti-bot / Access Notes

- No bot detection on `t.me/s/*` — camoufox works cleanly without any special measures
- Residential proxy NOT required — t.me is accessible from datacenter IPs
- Rate limiting: none observed; pages are cacheable public HTML
- Pages: each `?before=N` page returns ~20 messages

## Selector Stability

**Zero CSS class selectors used.** All data comes from:
- `data-post="channel/ID"` attribute — message ID extraction
- `datetime="..."` attribute — ISO timestamp (100% stable)
- `class="tgme_channel_info_counters"` — channel stats (stable ID-based HTML)
- `class="counter_value"` / `class="counter_type"` — subscriber/photo/video/link counts
- `class="tgme_widget_message_views"` — view count per message
- `class="tgme_widget_message_reactions"` — reactions block
- `class="tgme_widget_message_link_preview"` — embedded URL previews
- Message text from `class="tgme_widget_message_text"` (stable, not obfuscated)
- Video/photo URLs from `<video src>` and `background-image:url(...)` inline styles

## Output Format

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
      "text": "Message text here...",
      "mediaType": "video",
      "photoUrls": ["https://cdn4.telesco.pe/..."],
      "videoUrl": "https://cdn4.telesco.pe/...mp4?token=...",
      "videoDuration": "0:18",
      "linkPreview": {
        "url": "https://example.com",
        "siteName": "Example",
        "title": "Article Title",
        "description": "Article description",
        "imageUrl": "https://..."
      },
      "forwardedFrom": "Source Channel",
      "links": [{"url": "...", "text": "..."}],
      "hashtags": ["example"],
      "views": 5340000,
      "viewsText": "5.34M",
      "reactions": [
        {"type": "stars", "count": 39400, "countText": "39.4K"},
        {"type": "emoji", "count": 86100, "countText": "86.1K"}
      ],
      "totalReactions": 172500
    }
  ],
  "meta": {
    "fetched": 20,
    "requestedMax": 20,
    "hasMore": true,
    "nextBeforeId": 453,
    "pagesLoaded": 1
  }
}
```

## Session Log

### 2026-03-21 (scraper-skill-builder-14)
- Built telegram-channel skill using t.me/s/ SSR HTML parsing
- t.me/s/{channel} serves complete channel data without any bot detection
- No login, no API key, no bot token needed
- Pagination via ?before=messageId parameter (20 messages per page)
- Channel info: title, verified, subscribers, photos/videos/links count, description, photo
- Messages: id, url, datetime, text, mediaType, photoUrls, videoUrl, videoDuration, linkPreview, forwardedFrom, links, hashtags, views, reactions
- Key insight: `data-post="channel/ID"` provides stable message ID; `datetime` attr gives ISO timestamp
- Key insight: reactions block contains both paid-stars reactions and emoji reactions
- Key insight: redirects to t.me (not t.me/s) indicate non-public channel (NOT_FOUND)
- Tests: durov ✅, telegram ✅, hacker_news_feed ✅, invalid → NOT_FOUND ✅, pagination ✅
