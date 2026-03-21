# Instagram Agent Browser Skills

Scrape Instagram public profiles, posts, hashtags, and comments using the Instagram web API and DOM-based extraction.

**Login required** for full data access (hashtags, more than 12 posts, comments via API).

## Setup (First Time)

```bash
# Install dependencies
cd instagram && npm install

# Authenticate (run this first!)
# Option A: With credentials (recommended)
IG_USERNAME=myuser IG_PASSWORD=mypass node instagram-login/scripts/instagram-login.mjs

# Option B: Without credentials (tries auto-registration — likely needs phone verification)
node instagram-login/scripts/instagram-login.mjs
```

If auto-registration is blocked (phone required), Mahmut must create an account manually.
See [instagram-login/SKILL.md](instagram-login/SKILL.md) for full instructions.

## Available Skills

| Skill | Script | Auth Required | Description |
|-------|--------|--------------|-------------|
| [Login](instagram-login/SKILL.md) | `instagram-login/scripts/instagram-login.mjs` | No (creates/logs in) | Authenticate and save session cookies |
| [Profile](instagram-profile/SKILL.md) | `instagram-profile/scripts/instagram-profile.mjs` | Preferred | Fetch full profile + 12 recent posts |
| [Posts](instagram-posts/SKILL.md) | `instagram-posts/scripts/instagram-posts.mjs` | Preferred | Fetch recent posts by username |
| [Hashtag](instagram-hashtag/SKILL.md) | `instagram-hashtag/scripts/instagram-hashtag.mjs` | **Required** | Fetch top posts/reels for a hashtag |
| [Comments](instagram-comments/SKILL.md) | `instagram-comments/scripts/instagram-comments.mjs` | Preferred | Fetch comments from a post |

## Typical Workflow

```bash
# 1. Login (one time)
IG_USERNAME=myuser IG_PASSWORD=mypass node instagram-login/scripts/instagram-login.mjs

# 2. Use scrapers (session auto-loaded from ~/.instagram-session.json)
node instagram-profile/scripts/instagram-profile.mjs natgeo
node instagram-posts/scripts/instagram-posts.mjs nasa 12
node instagram-hashtag/scripts/instagram-hashtag.mjs photography
node instagram-comments/scripts/instagram-comments.mjs C1234567890
```

## API Architecture

### How It Works

Instagram's API requires proper headers and optionally a session cookie to return data. The key technique:

1. Launch camoufox browser (Firefox-based anti-detect)
2. Load session cookies from `~/.instagram-session.json` (if available)
3. Navigate to `instagram.com/` to establish CSRF token
4. Use `page.evaluate()` to make `fetch()` calls **from within the browser page** with:
   - `x-ig-app-id: 936619743392459` (Instagram's web app ID)
   - `x-csrftoken: <token from cookie>`
   - `x-requested-with: XMLHttpRequest`
   - `credentials: 'include'` (sends session cookies)

This bypasses CORS restrictions and makes Instagram's API return data as if a real browser is making the requests.

### Session Cookie Priority

All scrapers load cookies in this order:
1. `IG_COOKIES` env var (JSON array of cookie objects)
2. `~/.instagram-session.json` (saved by `instagram-login` skill)
3. Logged-out mode (limited data)

### Key Endpoints

| Endpoint | Method | Auth Required | Description |
|----------|--------|--------------|-------------|
| `/api/v1/users/web_profile_info/?username=X` | GET | No | Full profile + 12 posts + 12 reels |
| `/api/v1/feed/user/{id}/?count=N` | GET | **Yes** | User feed (login required) |
| `/api/v1/media/{id}/info/` | GET | **Yes** | Post details (login required) |
| `/explore/tags/{hashtag}/` | DOM | No | Top 12 hashtag posts (DOM scraping) |

### Data Available Without Login

**Profile (`web_profile_info`):**
- `id`, `username`, `full_name`, `biography`, `bio_links`
- `edge_followed_by.count` (followers), `edge_follow.count` (following)
- `edge_owner_to_timeline_media.count` (total posts)
- `edge_owner_to_timeline_media.edges` (12 most recent posts with full data)
- `edge_felix_video_timeline.edges` (12 most recent reels with full data)
- `is_verified`, `is_private`, `is_business_account`, etc.

**Each post includes:**
- `id`, `shortcode`, URL
- Type: `GraphImage`, `GraphVideo`, `GraphSidecar` (carousel)
- `taken_at_timestamp`, caption, hashtags
- `edge_liked_by.count` (likes), `edge_media_to_comment.count` (comments)
- `display_url` (full image), `thumbnail_src` (thumbnail)
- For videos: `video_url`, `video_view_count`, `dash_info`
- For carousels: `edge_sidecar_to_children.edges` (all slides)
- `location` (if tagged)

**Hashtag page (DOM scraping):**
- 12 reel/post URLs with shortcodes
- Video preview URLs
- Page title with reel count (e.g., "4.5B reels")

### Error Handling

All scripts handle these gracefully (no crashes):

- **NOT_FOUND**: Post/user doesn't exist → returns `{"error": true, "code": "NOT_FOUND", ...}`
- **SESSION_EXPIRED**: Session expired or invalid → returns `{"error": true, "code": "SESSION_EXPIRED", "instruction": "node instagram-login/scripts/instagram-login.mjs"}`

### Limitations (Without Login)

- **Max 12 posts** from profile (API limit)
- **No pagination** of posts/reels without login
- **Hashtag pages** require login — blocked for logged-out users
- **Feed/comments** limited to ~12-16 DOM-rendered comments without login
- **Private profiles** — no data available
- **Rate limiting** — wait 5s between requests for different users

### Limitations (With Login)

- **Session expiry** — Instagram sessions last ~90 days; re-run `instagram-login` to refresh
- **Rate limiting** — still applies; don't hammer the API
- **Pagination** — authenticated API supports pagination via `end_cursor`

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

## Browser Automation via Remote Camoufox Server

For tasks that require real browser interactions (clicks, file uploads, form submissions) rather than in-page `fetch()` calls, use the **camoufox Python server + playwright-core Node.js client** pattern.

### How It Works

1. Start camoufox as a remote Playwright WS server (Python)
2. Connect from Node.js using `playwright-core`'s `firefox.connect(wsEndpoint)`
3. Use the full Playwright API — `page.click()`, `page.setInputFiles()`, `page.waitForEvent()`, etc.

This avoids the limitations of `setInputFiles()` on React-managed inputs that don't fire synthetic events properly.

### Starting the Server

```python
# /tmp/camoufox-server.py
import subprocess, base64, sys, time, os
from pathlib import Path
import orjson
from playwright._impl._driver import compute_driver_executable
from camoufox.utils import launch_options
from camoufox.pkgman import LOCAL_DATA

LAUNCH_SCRIPT = LOCAL_DATA / "launchServer.js"

def camel_case(s):
    if len(s) < 2: return s
    c = ''.join(x.capitalize() for x in s.lower().split('_'))
    return c[0].lower() + c[1:]

def to_camel(d):
    return {camel_case(k): v for k, v in d.items()}

config = launch_options(headless=True, port=19222, ws_path="camoufox")

# Remove null proxy — camoufox JS launch script chokes on proxy: null
if config.get("proxy") is None:
    del config["proxy"]

data = orjson.dumps(to_camel(config))
nodejs = compute_driver_executable()[0]
if isinstance(nodejs, tuple):
    nodejs = nodejs[0]

process = subprocess.Popen(
    [nodejs, str(LAUNCH_SCRIPT)],
    cwd=Path(nodejs).parent / "package",
    stdin=subprocess.PIPE,
    text=True,
)
process.stdin.write(base64.b64encode(data).decode())
process.stdin.close()
print("ws://localhost:19222/camoufox", flush=True)
process.wait()
```

Run with:
```bash
/home/karacasoft/.openclaw/.venv/bin/python3 /tmp/camoufox-server.py &
```

### Connecting from Node.js

```js
import { firefox } from "playwright-core";

const browser = await firefox.connect("ws://localhost:19222/camoufox");
const context = await browser.newContext();
const page = await context.newPage();

await page.goto("https://example.com");
console.log(await page.title()); // works

await browser.close();
```

### Notes
- `playwright-core` is available in the showrun node_modules: `import { firefox } from "playwright-core"`
- Run scripts from `agent-browser-skills/instagram/` directory so the package resolves correctly
- The server must be started before connecting — it takes ~2-3 seconds to launch
- Use `headless=True` (Python server arg) for non-interactive runs
- Session cookies can be injected via `context.addCookies()` after connecting

## Anti-Bot Notes

Instagram uses sophisticated bot detection. camoufox-js (Firefox-based anti-detect browser) handles:
- Browser fingerprinting
- User-agent realism
- WebGL fingerprinting

The approach of fetching from within the page context (via `page.evaluate()`) mimics real browser behavior more closely than direct HTTP requests.

Rate limiting: wait at least 5 seconds between requests for different users.
