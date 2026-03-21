# Instagram Posts Skill

Fetches recent posts from a public Instagram profile (max 12 without login).

## Usage

```bash
node instagram-posts/scripts/instagram-posts.mjs <username> [maxPosts]
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| username | ✅ | — | Instagram username (without @) |
| maxPosts | ❌ | 12 | Max posts to return (max 12, API limit) |

## Examples

```bash
node instagram-posts/scripts/instagram-posts.mjs natgeo
node instagram-posts/scripts/instagram-posts.mjs nasa 12
```

## Output Schema

```json
{
  "username": "natgeo",
  "userId": "787132",
  "posts": [
    {
      "id": "3854796740277763042",
      "shortcode": "DV-_TYxlvvi",
      "url": "https://www.instagram.com/p/DV-_TYxlvvi/",
      "type": "image",
      "takenAt": "2026-03-17T...",
      "caption": "Caption text...",
      "hashtags": ["#hashtag1"],
      "likeCount": 7956,
      "commentCount": 141,
      "imageUrl": "https://scontent.cdninstagram.com/...",
      "videoUrl": null,
      "videoViewCount": null,
      "width": 1080,
      "height": 1350,
      "location": null,
      "accessibilityCaption": "Photo by...",
      "carouselMedia": null,
      "owner": {"id": "787132", "username": "natgeo"}
    }
  ],
  "meta": {
    "totalPosts": 31454,
    "postsReturned": 12,
    "note": "Without authentication, limited to 12 most recent posts"
  }
}
```

## Limitations

- **Max 12 posts** — Instagram's unauthenticated API limit
- Returns only the **most recent** 12 posts
- For older posts, authentication would be needed
