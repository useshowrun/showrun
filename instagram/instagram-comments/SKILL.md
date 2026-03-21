# Instagram Comments Skill

Scrape comments from a public Instagram post or reel.

## Usage

```bash
node instagram-comments/scripts/instagram-comments.mjs <shortcode_or_url> [maxComments]
```

## Examples

```bash
# By shortcode
node instagram-comments/scripts/instagram-comments.mjs C1234567890

# By full URL
node instagram-comments/scripts/instagram-comments.mjs https://www.instagram.com/p/C1234567890/
node instagram-comments/scripts/instagram-comments.mjs https://www.instagram.com/reel/C1234567890/

# With max comments limit
node instagram-comments/scripts/instagram-comments.mjs C1234567890 50
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `shortcode_or_url` | Yes | Post shortcode (e.g. `C1234567890`) or full Instagram URL |
| `maxComments` | No | Max comments to return (default: 24) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `IG_COOKIES` | JSON array of cookie objects for authenticated access |

## Output

```json
{
  "shortcode": "C1234567890",
  "postUrl": "https://www.instagram.com/p/C1234567890/",
  "postInfo": {
    "id": "3123456789012345678",
    "shortcode": "C1234567890",
    "type": "GraphImage",
    "caption": "Post caption text #hashtag",
    "likeCount": 12345,
    "commentCount": 456,
    "ownerUsername": "nasa",
    "takenAt": "2024-01-15T12:00:00.000Z"
  },
  "commentCount": 456,
  "commentsReturned": 24,
  "hasMore": true,
  "nextMinId": "17...",
  "comments": [
    {
      "id": "17890123456789012",
      "text": "Amazing photo! 🌟",
      "username": "example_user",
      "fullName": "Example User",
      "profilePicUrl": "https://...",
      "isVerified": false,
      "likeCount": 42,
      "createdAt": "2024-01-15T13:00:00.000Z",
      "replyCount": 3,
      "replies": [
        {
          "id": "17890123456789013",
          "text": "I agree!",
          "username": "another_user",
          "likeCount": 5,
          "createdAt": "2024-01-15T14:00:00.000Z"
        }
      ]
    }
  ],
  "meta": {
    "note": "Without authentication, limited to ~24 comments per page.",
    "source": "xhr_interception"
  }
}
```

## How It Works

### Multi-Strategy Extraction

1. **XHR Interception** (best): Intercepts Instagram's native `/api/v1/media/{id}/comments/` API calls made by the browser while loading the post page. Returns structured comment data with full user info.

2. **Embedded JSON** (fallback): Parses embedded `window.__additionalDataLoaded` or `window._sharedData` JSON from script tags. Available in older Instagram pages.

3. **Direct API Fetch** (fallback): Extracts media_id from the page and calls the comments API directly using the same session cookies. Works when logged in via `IG_COOKIES`.

4. **DOM Extraction** (last resort): Parses visible comments from the rendered HTML using `<time>` elements and profile links as anchors.

### Authentication

Without cookies, Instagram returns ~24 comments (first page load). For full pagination:

1. Log into Instagram in your browser
2. Export cookies as JSON (use a browser extension like "EditThisCookie")
3. Set `IG_COOKIES='[{"name":"sessionid","value":"...","domain":".instagram.com","path":"/",...}]'`

### Limitations

- **No login**: ~24 comments maximum (first page only)
- **With login**: Full comment access including pagination via `nextMinId`
- Private posts return "not found"
- `nextMinId` can be used for cursor-based pagination in future API calls
