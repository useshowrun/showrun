# Instagram Profile Skill

Fetches a complete public Instagram profile including bio, stats, and up to 12 recent posts.

## Usage

```bash
node instagram-profile/scripts/instagram-profile.mjs <username>
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| username | ✅ | Instagram username (without @) |

## Examples

```bash
node instagram-profile/scripts/instagram-profile.mjs natgeo
node instagram-profile/scripts/instagram-profile.mjs nasa
node instagram-profile/scripts/instagram-profile.mjs apple
```

## Output Schema

```json
{
  "username": "natgeo",
  "profile": {
    "id": "787132",
    "username": "natgeo",
    "fullName": "National Geographic",
    "biography": "Inspiring the explorer in everyone 🌎",
    "bioLinks": [{"url": "https://on.natgeo.com/instagram", "title": ""}],
    "externalUrl": "https://on.natgeo.com/instagram",
    "profilePicUrl": "https://scontent.cdninstagram.com/...",
    "followerCount": 275130000,
    "followingCount": 192,
    "postCount": 31454,
    "isVerified": true,
    "isPrivate": false,
    "isBusinessAccount": true,
    "categoryName": null,
    "hasClips": true
  },
  "posts": [
    {
      "id": "3854796740277763042",
      "shortcode": "DV-_TYxlvvi",
      "url": "https://www.instagram.com/p/DV-_TYxlvvi/",
      "type": "image",
      "takenAt": "2026-03-17T...",
      "caption": "At National Geographic...",
      "hashtags": ["#NatGeo33"],
      "likeCount": 7956,
      "commentCount": 141,
      "imageUrl": "https://scontent.cdninstagram.com/...",
      "videoUrl": null,
      "videoViewCount": null,
      "width": 1080,
      "height": 1350,
      "location": null,
      "accessibilityCaption": "Photo by National Geographic...",
      "carouselMedia": null,
      "owner": {"id": "787132", "username": "natgeo"}
    }
  ],
  "reels": [...],
  "meta": {
    "postsTotal": 31454,
    "postsReturned": 12,
    "reelsTotal": 90,
    "reelsReturned": 12
  }
}
```

## Post Types

| `type` | Description |
|--------|-------------|
| `image` | Single photo (GraphImage) |
| `video` | Single video / reel (GraphVideo) |
| `carousel` | Multiple slides (GraphSidecar) — `carouselMedia` array contains each slide |

## Error Codes

| Code | Description |
|------|-------------|
| `MISSING_ARG` | No username provided |
| `NOT_FOUND` | User doesn't exist |
| `AUTH_REQUIRED` | Profile is private or requires login |
| `NO_DATA` | API returned empty response |
| `API_ERROR` | Unexpected API error |
| `UNEXPECTED_ERROR` | Script crash |
