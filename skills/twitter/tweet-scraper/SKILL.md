# twitter-tweet-scraper

Scrape Twitter/X public data: user profiles, tweet timelines, individual tweets, and search results.

**No account required** for: profiles, user timelines, individual tweet lookup.
**Account required** for: search (`from:user`, keyword search, hashtag search).

---

## ⚠️ Critical Context

| Feature | Auth needed? | How |
|---------|-------------|-----|
| User profile (any public account) | ❌ No | Guest token |
| User tweets (timeline, paginated) | ❌ No | Guest token |
| Individual tweet by ID | ❌ No | Guest token |
| Search by keyword/hashtag | ✅ Yes | Chrome session |
| Followers / Following | ✅ Yes | Chrome session |

**Why search requires auth**: Twitter redirects unauthenticated search requests to the login page. The GraphQL `SearchTimeline` endpoint returns `{"errors":[{"code":215,"message":"Bad Authentication data"}]}` with only a guest token.

**Guest token flow**: Twitter's web app uses a hardcoded Bearer token + rotating guest token. The Bearer token is embedded in their JS bundle. The guest token is obtained from `POST /1.1/guest/activate.json`. Both are needed for unauthenticated API calls.

**Rate limits**: Guest tokens have lower limits (50 req/15min for timelines, 150/15min for profiles). Auth tokens have higher limits. The script handles rate limiting automatically by sleeping until the reset.

**QueryId stability**: Twitter GraphQL endpoints include a `queryId` hash in the URL. These change when Twitter deploys new JS bundles, but have been stable for months at a time. If you get 404 errors, see "Updating QueryIds" below.

---

## Prerequisites

- **Node.js 22+** (uses built-in `fetch`, `WebSocket`)
- **Chrome with remote debugging** — ONLY for `auth` / `search` commands
  - Must be logged in to `https://x.com`
  - Start with: `google-chrome --remote-debugging-port=9333`
  - The script also checks port 9222 (default Playwright/Electron port)
- **curl** — NOT needed (pure Node.js fetch)

### Check Node version
```bash
node --version  # need 22+
```

---

## Quick Start (No Login)

```bash
cd skills/twitter/tweet-scraper/scripts

# Get user profile
node tweet-scraper.mjs profile NASA

# Get 50 tweets from a user
node tweet-scraper.mjs tweets elonmusk --count=50

# Get a single tweet by ID
node tweet-scraper.mjs tweet 2037551448439787917

# Output as JSON
node tweet-scraper.mjs tweets NASA --count=20 --output=json > nasa-tweets.json
```

---

## Setup for Search

### Step 1: Ensure Chrome is running and logged in

```bash
# If Chrome is not running with debugging:
google-chrome --remote-debugging-port=9333 &
# Then navigate to https://x.com and log in manually
```

### Step 2: Extract session

```bash
node tweet-scraper.mjs auth
```

This opens `https://x.com` in the existing Chrome and extracts your auth cookies.
Session saved to: `~/.local/share/showrun/data/twitter/session.json`

### Step 3: Verify

```bash
node tweet-scraper.mjs check-session
```

Expected output:
```
Full auth session active
Extracted: 2026-03-28T...
Features: profile, tweets, tweet lookup, search
```

---

## Usage

### User Profile

```bash
node tweet-scraper.mjs profile <username>
node tweet-scraper.mjs profile @NASA           # @ prefix stripped automatically
node tweet-scraper.mjs profile elonmusk --output=json
```

Returns: `id`, `screen_name`, `name`, `description`, `location`, `website`, `followers_count`, `following_count`, `tweet_count`, `verified`, `created_at`, `profile_image_url`, `profile_banner_url`

### User Tweets (Timeline)

```bash
node tweet-scraper.mjs tweets <username> [--count=N] [--pages=N] [--replies] [--output=json]

node tweet-scraper.mjs tweets NASA                           # 20 latest tweets
node tweet-scraper.mjs tweets NASA --count=100 --pages=5    # 100 tweets, 5 pages
node tweet-scraper.mjs tweets NASA --replies                 # include replies
node tweet-scraper.mjs tweets NASA --output=json > out.json
```

**Pagination**: Each page fetches up to 20 tweets. Use `--pages=N` to fetch multiple pages automatically. The cursor is handled internally.

### Single Tweet

```bash
node tweet-scraper.mjs tweet <tweet_id>
node tweet-scraper.mjs tweet 2037551448439787917 --output=json
```

### Search (requires auth)

```bash
node tweet-scraper.mjs search "<query>" [--count=N] [--pages=N] [--product=Latest|Top|Photos|Videos]

node tweet-scraper.mjs search "climate change"
node tweet-scraper.mjs search "from:NASA" --count=50
node tweet-scraper.mjs search "#AI" --product=Top
node tweet-scraper.mjs search "breaking news" --count=100 --pages=5 --output=json
```

**Product types:**
- `Latest` — chronological (most useful for scraping)
- `Top` — Twitter's relevance-ranked
- `Photos` — photo tweets only
- `Videos` — video tweets only

---

## Output Schema

### Profile object
```json
{
  "id": "11348282",
  "screen_name": "NASA",
  "name": "NASA",
  "description": "Official NASA account...",
  "location": "",
  "website": "http://www.nasa.gov/",
  "followers_count": 90232134,
  "following_count": 117,
  "tweet_count": 78243,
  "like_count": 16585,
  "listed_count": 96565,
  "verified": false,
  "is_blue_verified": true,
  "created_at": "Wed Dec 19 20:20:32 +0000 2007",
  "profile_image_url": "https://pbs.twimg.com/..._400x400.jpg",
  "profile_banner_url": "https://pbs.twimg.com/..."
}
```

### Tweet object
```json
{
  "id": "2037551448439787917",
  "text": "In just a few days, we'll be sending humans on a flight around the Moon...",
  "created_at": "Fri Mar 27 21:13:18 +0000 2026",
  "lang": "en",
  "author": {
    "id": "11348282",
    "screen_name": "NASA",
    "name": "NASA",
    "verified": false,
    "is_blue_verified": true
  },
  "metrics": {
    "like_count": 9734,
    "retweet_count": 1823,
    "reply_count": 512,
    "quote_count": 243,
    "bookmark_count": 891,
    "view_count": 2350000
  },
  "is_retweet": false,
  "is_reply": false,
  "reply_to_tweet_id": null,
  "reply_to_user": null,
  "conversation_id": "2037551448439787917",
  "hashtags": [],
  "urls": [{"url": "https://t.co/...", "expanded_url": "https://...", "display_url": "..."}],
  "mentions": [],
  "media": [
    {
      "type": "video",
      "url": "https://pbs.twimg.com/...",
      "expanded_url": "https://twitter.com/...",
      "video_info": {"duration_millis": 30000, "variants": [...]}
    }
  ],
  "retweeted_tweet": null
}
```

---

## Data Storage

```
~/.local/share/showrun/data/twitter/
  session.json               Auth cookies + guest token cache
  cache/
    profile-<username>.json  Cached profile
    tweets-<username>.json   Cached tweets
    tweet-<id>.json          Cached single tweet
    search-<query>.json      Cached search results
```

---

## Session Expiry

Twitter sessions last for **months** but can expire. Signs of expiry:
- `SESSION_EXPIRED` error on search
- `HTTP 401` or `HTTP 403` responses

**Fix:**
```bash
node tweet-scraper.mjs auth
```
Make sure Chrome is open and logged in to x.com.

---

## Error Reference

| Error | Meaning | Fix |
|-------|---------|-----|
| `AUTH_REQUIRED` | Search with no session | Run `auth` |
| `SESSION_EXPIRED` | Cookies invalidated | Re-run `auth` |
| `ACCOUNT_SUSPENDED` | Twitter suspended account | Log in with different account |
| `HTTP 429` | Rate limited | Script auto-waits and retries |
| `HTTP 404` on API | QueryId changed | See "Updating QueryIds" |
| `User not found` | Private/deleted account | Use different account |
| Chrome not found | CDP not available | Start Chrome with `--remote-debugging-port=9333` |

---

## Updating QueryIds

If you get HTTP 404 on API calls, Twitter has deployed new JS bundles. Re-extract the queryIds:

```bash
# Find current main JS bundle URL
curl -s "https://x.com" | grep -oP 'https://abs.twimg.com/responsive-web/client-web/main\.[^"]+\.js' | head -1

# Extract queryIds from bundle
curl -s "<bundle_url>" | grep -oP 'queryId:"[^"]*",operationName:"(UserByScreenName|UserTweets|TweetResultByRestId|SearchTimeline|UserByRestId)[^"]*"'
```

Update the `QUERY_IDS` object in `scripts/tweet-scraper.mjs` with the new IDs.

---

## Rate Limiting Strategy

The script handles rate limiting automatically:
1. Detects `429 Too Many Requests` responses
2. Reads `x-rate-limit-reset` header (Unix timestamp)
3. Sleeps until the rate limit window resets + 2s buffer
4. Retries the request

For high-volume scraping:
- Guest tokens: ~50 timeline requests per 15 minutes
- Rotate by getting fresh guest tokens (call `POST /1.1/guest/activate.json` again)
- With auth: higher limits apply

---

## WAF / Bot Detection

Twitter does NOT aggressively block this approach because:
- We use their own Bearer token (same as their web app)
- Guest token flow is how their own mobile apps work
- For auth: we use real Chrome session cookies (indistinguishable from real user)

If blocked:
- Check if Bearer token is still valid (may change with JS bundle updates)
- Reduce request rate
- Use `--output=json` to avoid any extra HTTP calls

---

## Typical Workflows

### Scrape a public figure's tweets
```bash
node tweet-scraper.mjs profile elonmusk
node tweet-scraper.mjs tweets elonmusk --count=200 --pages=10 --output=json > elon.json
```

### Track a keyword (requires auth)
```bash
node tweet-scraper.mjs auth  # one-time setup
node tweet-scraper.mjs search "bitcoin" --count=100 --pages=5 --product=Latest --output=json
```

### Get tweet details
```bash
node tweet-scraper.mjs tweet 2037551448439787917 --output=json
```

### Build a dataset
```bash
for user in NASA SpaceX ESA; do
  node tweet-scraper.mjs tweets $user --count=100 --output=json > "$user-tweets.json"
  sleep 5
done
```
