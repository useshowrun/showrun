# threads-profile

Scrape a Threads profile: bio, follower counts, and recent posts.

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
cd threads/threads-profile
node scripts/threads-profile.mjs @zuck
node scripts/threads-profile.mjs @natgeo --max-posts 10
node scripts/threads-profile.mjs https://www.threads.net/@nasa
```

## Output Format

```json
{
  "username": "zuck",
  "profile": {
    "id": "314216",
    "username": "zuck",
    "displayName": "Mark Zuckerberg",
    "bio": "...",
    "avatarUrl": "https://...",
    "followersCount": 12345678,
    "followingCount": 500,
    "isVerified": true,
    "isPrivate": false,
    "threadCount": 150
  },
  "posts": [
    {
      "id": "12345",
      "code": "DCqEPYPOFKN",
      "url": "https://www.threads.net/@zuck/post/DCqEPYPOFKN",
      "text": "Post content here...",
      "likeCount": 5000,
      "replyCount": 200,
      "repostCount": 50,
      "createdAt": "2024-01-15T12:30:00.000Z",
      "mediaUrls": ["https://..."],
      "author": { ... }
    }
  ],
  "meta": {
    "postsReturned": 20,
    "postsTotal": 150
  }
}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `BLOCKED` | No THREADS_COOKIE set, or cookie is invalid/expired |
| `NOT_FOUND` | Profile does not exist |
| `PARTIAL` | Session valid but could not extract data |
| `UNEXPECTED_ERROR` | Unexpected error (see logs) |

## Dependencies

- `camoufox-js` — headless browser with anti-detection
- Node.js >= 22

## Notes

- Threads locked all content behind login in late 2024
- Sessions expire after ~90 days — refresh your cookie if you get BLOCKED
- Private profiles: a fresh cookie from an account that follows the target is needed
