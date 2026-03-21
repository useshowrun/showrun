# Facebook Comments Skill

Scrape comments from a public Facebook post.

## Usage

```bash
node facebook-comments/scripts/facebook-comments.mjs <post_url> [maxComments]
```

## Examples

```bash
# Full post URL
node facebook-comments/scripts/facebook-comments.mjs \
  "https://www.facebook.com/natgeo/posts/pfbid02NiboEjWxMhTZEKce7SM37..." \
  20

# Permalink format
node facebook-comments/scripts/facebook-comments.mjs \
  "https://www.facebook.com/permalink/story.php?story_fbid=123456&id=789"

# Photo post
node facebook-comments/scripts/facebook-comments.mjs \
  "https://www.facebook.com/photo/?fbid=123456789"
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `post_url` | Yes | Full Facebook post URL |
| `maxComments` | No | Max comments to return (default: 20) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FB_COOKIES` | JSON array of cookie objects for authenticated access |

## Output

```json
{
  "postUrl": "https://www.facebook.com/natgeo/posts/pfbid...",
  "finalUrl": "https://www.facebook.com/natgeo/posts/pfbid...",
  "postInfo": {
    "pageName": "National Geographic",
    "postText": "Living with both ADHD and autism...",
    "totalComments": 17,
    "totalReactions": 150,
    "totalShares": 35
  },
  "commentCount": 17,
  "commentsReturned": 6,
  "hasMore": true,
  "comments": [
    {
      "id": "25584012594610269",
      "name": "Sarah Corso",
      "text": "I have ADHD and my husband has autism. Together we harness the power of AuDHD.",
      "timeText": "9m",
      "profileUrl": null,
      "likeCount": null,
      "badge": null
    },
    {
      "id": "1715119086503653",
      "name": "Benjamin Birdsey",
      "text": "I an imagine the \"don't touch me\" vibe...",
      "timeText": "37m",
      "profileUrl": null,
      "likeCount": null,
      "badge": "Top fan"
    }
  ],
  "isAuthenticated": false,
  "meta": {
    "note": "Without authentication, only ~5-10 top comments visible.",
    "source": "dom_extraction"
  }
}
```

## How It Works

### DOM Extraction

Facebook renders a preview of top comments for logged-out users in the SSR DOM. 
Each comment is rendered as a `[role="article"]` element.

The extraction algorithm:
1. Select all `[role="article"]` elements
2. Filter out parent containers (those that contain child articles)
3. Parse leaf article innerText:
   - Optional badge ("Top fan", "Author", etc.)
   - Commenter name
   - Comment text
   - Relative timestamp ("5m", "2h", "3d")
   - Like count (numeric suffix)
4. Extract `comment_id` from timestamp links for comment IDs

### Comment Fields

| Field | Description |
|-------|-------------|
| `id` | Comment ID (numeric string, when available) |
| `name` | Commenter's display name |
| `text` | Comment text content |
| `timeText` | Relative timestamp ("5m", "2h", "3d", "Just now") |
| `profileUrl` | Commenter's Facebook profile URL (when available) |
| `likeCount` | Number of likes on the comment (when shown) |
| `badge` | Commenter badge ("Top fan", "Author", etc.) |

### Authentication

Without cookies, Facebook shows ~5-10 "Most Relevant" top comments.
For full comment access:

1. Log into Facebook in your browser
2. Export cookies as JSON (use "EditThisCookie" or similar extension)
3. Set `FB_COOKIES='[{"name":"c_user","value":"...","domain":".facebook.com",...}]'`

### Post URL Formats Supported

- `/page/posts/pfbid...` — modern permalink format
- `/permalink/story.php?story_fbid=...&id=...` — classic permalink
- `/photo/?fbid=...` — photo posts
- `/posts/pfbid...` — direct posts URL

### Limitations

- **No login**: ~5-10 "Most Relevant" comments only
- **With login**: More comments accessible; use scroll pagination for full load
- `profileUrl` often unavailable for logged-out users (privacy protection)
- `likeCount` shows only when Facebook explicitly renders the count
