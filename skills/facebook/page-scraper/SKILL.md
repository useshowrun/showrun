# facebook-page-scraper

Scrape Facebook public Pages: metadata, follower counts, category, contact info, recent posts, and photos — **no Facebook account required** for basic page data. Full post feed pagination requires a valid Facebook session (cookies from logged-in Chrome).

---

## ⚠️ Critical Context

Facebook's data availability is **login-gated** except for basic page metadata:

| What you want | Works without login? | How |
|--------------|---------------------|-----|
| Page name, description, category | ✅ Yes | OG tags + DOM |
| Follower/like count | ✅ Yes | DOM text extraction |
| Page ID (numeric) | ✅ Yes | `al:android:url` meta tag |
| Cover photo, profile photo | ✅ Yes | OG image tag |
| Contact info (email, website) | ✅ Yes | DOM |
| 1–3 recent post stubs | ✅ Yes | DOM (very limited) |
| Full post feed (paginated) | ❌ No | Requires `c_user` + `xs` cookies |
| Post captions/full text | ❌ No | Requires login for feed access |
| Comments | ❌ No | Requires login |
| Groups | ❌ No | Requires login |
| Private profiles | ❌ No | Requires login |

**Why curl doesn't work**: Direct HTTP requests to facebook.com return a generic error page. The site requires JavaScript rendering. Only Playwright with a real Chrome instance works reliably.

**WAF**: No Cloudflare/DataDome on public pages. Facebook has internal bot-detection but real Chrome fingerprint via Playwright passes cleanly.

**`mbasic.facebook.com`**: Also requires login — returns only a login page without session.

---

## Prerequisites

- Node.js 22+
- `playwright` npm package:
  ```bash
  node -e "import('/usr/lib/node_modules/playwright/index.mjs').then(()=>console.log('ok'))"
  ```
- Google Chrome or Chromium:
  - Linux: `/opt/google/chrome/chrome` or `/usr/bin/google-chrome-stable`
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Or set `CHROME_EXECUTABLE` env var

### Install playwright (if missing):
```bash
sudo npm install -g playwright
npx playwright install chromium
```

---

## Quick Start (No Login Required)

```bash
cd skills/facebook/page-scraper/scripts

# Scrape a public page by slug:
node page-scraper.mjs scrape NASA

# Scrape with numeric page ID:
node page-scraper.mjs scrape 100044561550831

# Save output to file:
node page-scraper.mjs scrape Meta --output=/tmp/meta-page.json

# Scrape with existing Chrome session (faster, may show more posts):
node page-scraper.mjs scrape NASA --cdp-url=http://localhost:9333

# Verbose mode:
node page-scraper.mjs scrape NASA --verbose
```

---

## Setup (For Post Feed Access)

### Step 1: Capture session from Chrome

Open Chrome and log in to Facebook at `https://www.facebook.com`.

If Chrome has remote debugging enabled:
```bash
# Check if Chrome is running with CDP:
curl -s http://localhost:9333/json | head -5  # try 9333, 9222

node page-scraper.mjs auth --cdp-url=http://localhost:9333
# or:
node page-scraper.mjs auth --cdp-url=http://localhost:9222
```

Session is saved to: `~/.local/share/showrun/data/facebook/session.json`

### Step 2: Verify session

```bash
node page-scraper.mjs check-session
```

### Step 3: Scrape with session (more posts visible)

```bash
node page-scraper.mjs scrape NASA
# With session active, the feed shows significantly more posts in the DOM
```

---

## Usage

### Scrape a public page

```bash
node page-scraper.mjs scrape <page_slug_or_id> [options]
```

**Options:**
- `--output=<file>` — Save results to JSON file
- `--cdp-url=<url>` — Connect to existing Chrome (e.g. `http://localhost:9333`)
- `--no-headless` — Show browser window
- `--scroll=<n>` — Number of scroll attempts to load more posts (default: 3)
- `--cache` — Cache results to `~/.local/share/showrun/data/facebook/cache/`
- `--verbose` — Enable detailed logging

**Examples:**
```bash
# Basic page metadata:
node page-scraper.mjs scrape NASA

# With scrolling to reveal more posts:
node page-scraper.mjs scrape NASA --scroll=5

# Connect to logged-in Chrome:
node page-scraper.mjs scrape NASA --cdp-url=http://localhost:9333 --scroll=10

# Save to file:
node page-scraper.mjs scrape Meta --output=/tmp/meta.json

# Scrape by numeric ID:
node page-scraper.mjs scrape 100044561550831
```

### Capture session from Chrome

```bash
node page-scraper.mjs auth [--cdp-url=<url>]
```

### Check session validity

```bash
node page-scraper.mjs check-session
```

### Show help

```bash
node page-scraper.mjs --help
```

---

## Output Format

```json
{
  "page": {
    "id": "100044561550831",
    "slug": "NASA",
    "name": "NASA - National Aeronautics and Space Administration",
    "url": "https://www.facebook.com/NASA",
    "description": "Explore the universe and discover our home planet. There's space for everybody. ✨",
    "follower_count": 26865295,
    "following_count": 52,
    "category": "Government organization",
    "cover_photo_url": "https://scontent.xx.fbcdn.net/...",
    "profile_photo_url": "https://scontent.xx.fbcdn.net/...",
    "website": "nasa.gov",
    "email": "public-inquiries@hq.nasa.gov",
    "phone": null,
    "address": null,
    "verified": false,
    "transparency_info": "NATIONAL AERONAUTICS AND SPACE ADMINISTRATION is responsible for this Page"
  },
  "posts": [
    {
      "post_id": "2024462534774292",
      "type": "event",
      "text_preview": "NASA plans to go live. Wed, Apr 1 at 12:50 PM EDT...",
      "timestamp_relative": "4h",
      "reaction_count": 629,
      "comment_count": 37,
      "post_url": "https://www.facebook.com/events/2024462534774292/",
      "media_urls": []
    }
  ],
  "photos": [
    {
      "photo_id": "1479660223529349",
      "thumbnail_url": "https://scontent.xx.fbcdn.net/...",
      "photo_url": "https://www.facebook.com/photo/?fbid=1479660223529349"
    }
  ],
  "meta": {
    "scraped_at": "2026-03-28T01:00:00.000Z",
    "session_used": false,
    "posts_note": "Only 1-3 posts visible without login. Run auth + scrape with session for more.",
    "scroll_attempts": 3
  }
}
```

---

## Data Storage

```
~/.local/share/showrun/data/facebook/
├── session.json                     # Auth cookies (c_user, xs, datr, etc.)
└── cache/
    └── page-{slug}.json             # Cached page results
```

---

## Error Handling & Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Page requires login (private page or login wall) |
| 3 | Page not found (404) |
| 4 | WAF/rate-limit block |
| 5 | Session expired (re-run auth) |

---

## Session Expiry

If you see `Session expired`, re-authenticate:

```bash
node page-scraper.mjs auth --cdp-url=http://localhost:9333
```

Then re-run your scrape. Sessions typically last 30–90 days.

---

## Rate Limiting

Facebook aggressively rate-limits headless browser access from datacenter/residential IPs.

**Observed behaviour:**
- First 5–8 page loads per hour: usually allowed
- After ~10 headless requests: Facebook starts redirecting ALL pages to `/login/`
- Rate limit duration: ~30–60 minutes per IP
- Reset: wait 30–60 minutes, then rate limit typically clears

**Symptoms when rate-limited:**
```
[facebook:error] Facebook requires login to view this page (redirected to https://www.facebook.com/login/...)
```
Exit code: `2`

**To handle rate limits:**
1. Wait 30–60 minutes before retrying
2. Use a logged-in session (`auth` command) — rate limits are much more lenient for authenticated requests
3. Use a residential proxy for bulk scraping
4. Spread requests over time (the script runs one request at a time)

**With auth session:** Rate limiting is rare (Facebook allows much more scraping for authenticated accounts).

The script implements automatic delays between scroll events.

---

## WAF / Bot Detection

Facebook uses internal bot scoring but **not Cloudflare or DataDome** on public pages.

Signs of WAF block:
- HTML body contains `"Sorry, something went wrong"` 
- HTTP 302 redirect to `/login/` for a public page
- Response is under 5KB (minimal HTML)

If blocked, retry with `--no-headless` to see what's happening, or wait 5–10 minutes.

---

## Login Wall Detection

The script detects login walls by checking:
1. Page body shows only a login form (no page metadata visible)
2. OG tags are missing or minimal
3. Page redirects to `/login/`

When a login wall is detected and no session exists, exit code 2 is returned with a clear message.

---

## Camoufox Fallback

Not implemented — standard Playwright with real Chrome passes Facebook's bot detection without issues. No stealth mode needed for public page access.
