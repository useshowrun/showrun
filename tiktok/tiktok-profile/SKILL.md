# TikTok Profile Scraper

Fetch a public TikTok profile and its most recent videos.

## Prerequisites

- No login required for public profiles
- Node.js 22+
- `npm install` in the `tiktok/` directory

## Usage

```bash
node tiktok-profile/scripts/tiktok-profile.mjs <username>
```

**Examples:**
```bash
node tiktok-profile/scripts/tiktok-profile.mjs natgeo
node tiktok-profile/scripts/tiktok-profile.mjs charlidamelio
node tiktok-profile/scripts/tiktok-profile.mjs @nasa
```

The `@` prefix is optional.

## How It Works

1. Opens a headless camoufox browser (fingerprinted as macOS desktop)
2. Navigates to `https://www.tiktok.com/@{username}`
3. Extracts profile data from `__UNIVERSAL_DATA_FOR_REHYDRATION__` embedded JSON
4. Intercepts the `/api/post/item_list/` API call to capture the first ~35 videos

## Output

Emits `RESULT:{json}` on stdout. Structure:

```json
{
  "username": "natgeo",
  "profile": {
    "id": "6780344874811442181",
    "uniqueId": "natgeo",
    "nickname": "National Geographic",
    "signature": "Inspiring the explorer in everyone 🌎",
    "avatarUrl": "https://...",
    "isVerified": true,
    "isPrivate": false,
    "bioLink": "http://on.natgeo.com/natgeotiktok",
    "followerCount": 9382666,
    "followingCount": 60,
    "heartCount": 47782567,
    "videoCount": 1257,
    "commerceCategory": "Media & Entertainment",
    "language": "en",
    "secUid": "MS4wLjABAAAA..."
  },
  "videos": [
    {
      "id": "7618952195341323533",
      "url": "https://www.tiktok.com/@natgeo/video/7618952195341323533",
      "description": "An adventure doesn't have to be... #NatGeo33",
      "hashtags": ["#NatGeo33"],
      "createTime": "2026-03-19T18:25:55.000Z",
      "duration": 41,
      "width": 1080,
      "height": 1920,
      "ratio": "540p",
      "coverUrl": "https://...",
      "playUrl": "https://...",
      "diggCount": 1953,
      "shareCount": 82,
      "commentCount": 17,
      "playCount": 12100,
      "collectCount": 0,
      "author": { "uniqueId": "natgeo", "nickname": "National Geographic", ... },
      "music": { "title": "original sound", ... },
      "challenges": [{ "title": "natgeo33", ... }],
      "isAd": false,
      "isPinned": false
    }
  ],
  "meta": {
    "videoTotal": 1257,
    "videosReturned": 35,
    "hasMore": true,
    "cursor": 1771438710000
  }
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `NOT_FOUND` | User does not exist or is banned |
| `NO_DATA` | Could not extract page data (possible anti-bot) |
| `MISSING_ARG` | No username argument provided |
| `UNEXPECTED_ERROR` | Unhandled error |

## Notes

- TikTok serves geo-targeted content; the browser fingerprint uses en-US locale
- The `playUrl` field expires quickly (minutes/hours); use it immediately
- `cursor` can be used with `tiktok-videos` to paginate further
