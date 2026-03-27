# instagram-profile-scraper

Scrape public Instagram profiles: bio, follower count, following count, post count, and recent posts (images, videos, carousels) — **no Instagram account required** for basic scraping. Full post pagination requires a valid session cookie (captured from a logged-in Chrome browser).

---

## ⚠️ Important Context

Instagram's API is **heavily restricted**:
- **Public profile info**: Works without login — bio, stats, 12 most recent posts
- **Post pagination (>12 posts)**: Requires `sessionid` cookie from a logged-in Chrome session
- **Comments, followers, search**: Require login
- **Private profiles**: Only bio/stats visible (no posts without login + follow)

The scraper uses Chrome/Playwright to make API calls **from within the browser context**, which bypasses Instagram's CORS restrictions and WAF detection.

---

## Prerequisites

- Node.js 22+
- `playwright` npm package (check: `node -e "import('/usr/lib/node_modules/playwright/index.mjs').then(()=>console.log('ok'))"`)
- Google Chrome or Chromium (`/opt/google/chrome/chrome`, `/usr/bin/google-chrome-stable`, or set `CHROME_EXECUTABLE`)

### Install playwright (if missing):
```bash
sudo npm install -g playwright
# or locally:
cd skills/instagram/profile-scraper
npm install playwright
```

---

## Quick Start (No Login)

```bash
cd skills/instagram/profile-scraper/scripts
node profile-scraper.mjs scrape cristiano
```

Returns: profile bio + stats + 12 most recent posts. No auth required.

---

## Setup (For Full Post Pagination)

### Step 1: Capture session from Chrome

Make sure Chrome is open and you're **logged in to Instagram** at `https://www.instagram.com`.

If Chrome has remote debugging enabled (port 9222 or 9333):
```bash
node profile-scraper.mjs auth --cdp-url=http://localhost:9222
# or:
node profile-scraper.mjs auth --cdp-url=http://localhost:9333
```

If Chrome is NOT running with remote debugging, the script will look for an existing browser via CDP. If not found, it will launch a fresh headless Chrome (you'll need to log in manually with `--no-headless`).

Session is saved to: `~/.local/share/showrun/data/instagram/session.json`

### Step 2: Verify session
```bash
node profile-scraper.mjs check-session
```

### Step 3: Scrape with pagination
```bash
node profile-scraper.mjs scrape cristiano --posts=50
```

---

## Usage

### Scrape a profile (no login)
```bash
node profile-scraper.mjs scrape <username>
node profile-scraper.mjs scrape @username   # @ prefix is stripped automatically
```

### Scrape with more posts (requires auth)
```bash
node profile-scraper.mjs scrape cristiano --posts=100
```

### Save results to file
```bash
node profile-scraper.mjs scrape natgeo --output=/tmp/natgeo.json
```

### Use specific Chrome instance
```bash
node profile-scraper.mjs scrape cristiano --cdp-url=http://localhost:9333
```

### Show browser window (useful for debugging)
```bash
node profile-scraper.mjs scrape cristiano --no-headless
```

### Cache results
```bash
node profile-scraper.mjs scrape cristiano --cache
# Subsequent calls return cached data immediately
```

---

## Output Format

```json
{
  "profile": {
    "id": "173560420",
    "username": "cristiano",
    "full_name": "Cristiano Ronaldo",
    "biography": "...",
    "bio_links": [
      { "title": "Herbalife Pro2Col", "url": "https://hrbl.me/CR7Pro2col" }
    ],
    "external_url": "https://...",
    "profile_pic_url": "https://scontent.cdninstagram.com/...",
    "profile_pic_url_hd": "https://scontent.cdninstagram.com/...",
    "is_private": false,
    "is_verified": true,
    "is_business_account": false,
    "is_professional_account": false,
    "category_name": null,
    "follower_count": 672704201,
    "following_count": 630,
    "post_count": 4029,
    "highlight_reel_count": 15
  },
  "posts": [
    {
      "id": "3862270794885266037",
      "shortcode": "DWZitMjgHp1",
      "type": "GraphSidecar",
      "display_url": "https://scontent.cdninstagram.com/...",
      "thumbnail_src": "https://...",
      "is_video": false,
      "video_url": null,
      "taken_at": "2026-03-23T18:09:39.000Z",
      "like_count": 865550,
      "comment_count": 10835,
      "caption": "On the ball ⚽️",
      "location": null,
      "accessibility_caption": "...",
      "dimensions": { "height": 1080, "width": 1080 },
      "children": [
        { "id": "...", "display_url": "...", "is_video": false, "dimensions": {...} }
      ],
      "post_url": "https://www.instagram.com/p/DWZitMjgHp1/"
    }
  ],
  "meta": {
    "scraped_at": "2026-03-28T00:00:00.000Z",
    "posts_fetched": 12,
    "posts_total": 4029,
    "has_more_posts": true,
    "pagination_note": "Only 12 posts available without login. Run auth to enable full pagination.",
    "session_used": false
  }
}
```

---

## Post Types

| Type | Description |
|------|-------------|
| `GraphImage` | Single photo |
| `GraphVideo` | Single video (Reel or regular) |
| `GraphSidecar` | Carousel (multiple images/videos) — check `children` array |

For carousels, the `display_url` is the first item. All items are in `children`.

---

## How It Works

1. **Browser Launch**: Connects to existing Chrome via CDP (`--cdp-url`) or launches fresh headless Chrome.
2. **Cookie Setup**: If session file exists, injects cookies into browser context. Otherwise uses only base cookies (csrftoken, ig_did, datr, mid) from visiting instagram.com.
3. **Profile Fetch**: Calls `https://i.instagram.com/api/v1/users/web_profile_info/?username={username}` from within the browser page context (via `page.evaluate(fetch)`). This uses the browser's cookies and avoids CORS restrictions.
4. **Data Extraction**: Parses the nested JSON response into clean profile + posts data.
5. **Post Pagination** (with session): If `--posts` > 12 and session exists, calls `https://i.instagram.com/api/v1/feed/user/{userId}/?count=12&max_id={cursor}` iteratively with 2-3s delays between pages.

---

## Error Handling

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | — |
| 1 | General error | Check stderr for details |
| 2 | Login required | Run `auth` command first |
| 3 | Profile not found or private | Check username spelling; private profiles need follow+session |
| 4 | WAF/rate-limit block | Wait 5-10 min, try `--cdp-url` to use real Chrome |
| 5 | Session expired | Re-run `node profile-scraper.mjs auth` |

---

## Rate Limiting

Instagram's limits (approximate, without residential proxy):
- **Profile API** (`web_profile_info`): ~10-20 requests per session before temporary rate limit
- **Feed API** (`feed/user`): ~30-60 requests/hour per session
- Built-in delays: 2-3 seconds between feed pages

Rate limit symptoms (exit code 4):
- HTTP 401 with `"message":"Please wait a few minutes before you try again."`
- HTTP 429

If you hit rate limits:
1. **Wait 5-10 minutes** and retry — rate limits are temporary
2. Use `--cdp-url` to attach to a real Chrome session with login cookies
3. For high-volume scraping, use residential proxies and add longer delays

---

## WAF/Bot Detection

Instagram uses its own WAF (not PerimeterX/Cloudflare on the API endpoints). The scraper avoids detection by:
- Making calls **from within the browser context** (not raw curl)
- Using the browser's real cookies and fingerprint
- Setting standard browser headers (`X-IG-App-ID`, `X-ASBD-ID`, etc.)

If you get blocked:
1. Use `--cdp-url=http://localhost:9333` to attach to your real Chrome session
2. Try `--no-headless` to see what Instagram is showing
3. Wait 10+ minutes and retry

---

## Session Expiry

Instagram sessions last until you log out or Instagram invalidates them (days to weeks typically).

Signs of session expiry:
- HTTP 401 response
- `"require_login": true` in response body
- Exit code 5

Re-capture session:
```bash
node profile-scraper.mjs auth --cdp-url=http://localhost:9333
```

---

## Forced Logout Handling

If Instagram forces a logout (security challenge, suspicious activity):
1. The script detects `challenge` or `checkpoint` in the page content
2. Exits with code 4 and message about security challenge
3. Solution: open Chrome manually, complete the challenge, log back in, re-run `auth`

---

## Private Accounts

For private accounts without session:
- Profile data (bio, stats) is returned
- Posts array will be empty
- Exit code 3 is NOT used (profile exists, just private)
- `meta.pagination_note` explains the situation

For private accounts WITH session + following relationship:
- Full post scraping works (same as public)

---

## Data Storage

```
~/.local/share/showrun/data/instagram/
├── session.json                     # Stored sessionid + cookies
└── cache/
    └── profile-{username}.json      # Cached profile data (with --cache)
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CHROME_CDP_URL` | CDP URL for existing Chrome | (none) |
| `CHROME_EXECUTABLE` | Path to Chrome binary | auto-detect |
| `QUIET` | Suppress log output | (unset) |
| `DEBUG` | Show full stack traces on error | (unset) |

---

## Known Limitations & Caveats

1. **12-post limit without auth**: Instagram's `web_profile_info` only returns the 12 most recent posts. Pagination requires a valid session.

2. **No hashtag scraping**: Hashtag endpoints require login and are CORS-blocked. Not implemented.

3. **No comment scraping**: Comments require authentication.

4. **No story scraping**: Stories require authentication.

5. **Image URLs expire**: CDN URLs (`scontent.cdninstagram.com`) are time-limited. Download them promptly.

6. **Post counts may differ**: `profile.post_count` is the total, but archived/deleted posts aren't scraped.

7. **CORS restriction**: The API MUST be called from within the browser context (page.evaluate), NOT directly from Node.js. This is why the script uses Playwright.

8. **Turkish IP note**: Tested from a Turkish IP — no additional geo-restrictions observed on `web_profile_info`.
