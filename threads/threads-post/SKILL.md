# threads-post

Scrape a single Threads post: content, author, media, and replies.

## ⚠️ Authentication Required

Threads requires login for all content. You must provide a session cookie.

### Getting Your Cookie

1. Log in to **https://www.threads.net** in Chrome or Firefox
2. Open DevTools → **Application** → **Cookies** → `threads.net` or `threads.com`
3. Find the cookie named **`sessionid`** and copy its value
4. Set the environment variable:

```bash
export THREADS_COOKIE="<your sessionid value>"
```

Or use the full cookie string (more headers = better session):
```bash
export THREADS_COOKIE_JSON="sessionid=abc123; ds_user_id=456789; csrftoken=xyz"
```

## Usage

```bash
# Activate Node.js 24
source ~/.nvm/nvm.sh && nvm use 24

# Set your cookie
export THREADS_COOKIE="your-session-id-here"

# Run
cd threads/threads-post
node scripts/threads-post.mjs https://www.threads.net/@zuck/post/DCqEPYPOFKN
node scripts/threads-post.mjs https://www.threads.net/@natgeo/post/C123 --max-replies 20
```

## Output Format

```json
{
  "post": {
    "id": "12345",
    "code": "DCqEPYPOFKN",
    "url": "https://www.threads.net/@zuck/post/DCqEPYPOFKN",
    "text": "Post content here...",
    "likeCount": 5000,
    "replyCount": 200,
    "repostCount": 50,
    "quoteCount": 10,
    "createdAt": "2024-01-15T12:30:00.000Z",
    "mediaUrls": ["https://..."],
    "author": {
      "id": "314216",
      "username": "zuck",
      "displayName": "Mark Zuckerberg",
      "avatarUrl": "https://...",
      "isVerified": true
    }
  },
  "replies": [
    {
      "id": "67890",
      "text": "Reply content...",
      "likeCount": 100,
      "createdAt": "2024-01-15T12:35:00.000Z",
      "author": { ... },
      "mediaUrls": []
    }
  ],
  "meta": {
    "repliesReturned": 20,
    "repliesTotal": 200
  }
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `BLOCKED` | No THREADS_COOKIE set, or cookie is invalid/expired |
| `NOT_FOUND` | Post does not exist |
| `PARTIAL` | Session valid but could not extract data |
| `UNEXPECTED_ERROR` | Unexpected error (see logs) |

## Dependencies

- `camoufox-js` — headless browser with anti-detection
- Node.js >= 22

## Notes

- Threads locked all content behind login in late 2024
- Sessions expire after ~90 days — refresh your cookie if you get BLOCKED
- Post IDs (codes) look like `DCqEPYPOFKN` — alphanumeric strings in the URL
