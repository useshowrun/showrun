# Reddit API Map

Comprehensive endpoint catalog discovered via CDP network interception on 2026-03-26.
859 network requests intercepted across 12 page types, 391 unique endpoints, 239 parameter fuzzing requests.

---

## Architecture Overview

Reddit runs two API layers side-by-side:

| Layer | Base | Format | Auth | Best For |
|-------|------|--------|------|----------|
| **Old Reddit JSON API** | `www.reddit.com/*.json` | JSON | None (public) or OAuth bearer | Data extraction, scraping, CLI tools |
| **Shreddit (new frontend)** | `www.reddit.com/svc/shreddit/*` | HTML partials + GraphQL | Session cookies + JWT + CSRF | Mutations, authenticated actions |

The old `.json` API is the primary target for taskpack scripts. Append `.json` to any Reddit page URL for structured JSON. The shreddit layer returns HTML fragments (not JSON) for feeds and uses GraphQL for mutations.

---

## Authentication

### Method 1: Anonymous (Old JSON API)

No auth needed for public content. Just include a User-Agent header:

```bash
curl -s 'https://www.reddit.com/r/programming.json' \
  -H 'User-Agent: showrun/1.0 (by /u/youruser)'
```

Rate limit: ~10 req/min. Requests without User-Agent get 429'd immediately.

### Method 2: Cookie Auth (via CDP)

Extract cookies from an open Reddit tab:

```bash
node cdp.mjs evalraw <target> Network.getCookies '{"urls":["https://www.reddit.com"]}'
```

Key cookies:

| Cookie | Purpose |
|--------|---------|
| `reddit_session` | Primary session cookie |
| `token_v2` | OAuth-like token |
| `csrf_token` | 32-char hex CSRF token |
| `loid` | User/device identifier |
| `session_tracker` | Active session tracking |
| `edgebucket` | CDN routing |

### Method 3: JWT Bearer (Shreddit API)

Obtain a 24h RS256 JWT by POSTing the CSRF token:

```bash
curl -s 'https://www.reddit.com/svc/shreddit/token' \
  -X POST -H 'Content-Type: application/json' \
  -H 'Cookie: <session cookies>' \
  -d '{"csrf_token":"<32-char hex from csrf_token cookie>"}'
```

Response: `{"token": "eyJhbGciOiJSUzI1NiI..."}` (24h expiry)

JWT payload fields: `sub`, `exp`, `iat`, `jti`, `cid` (client ID), `lid` (user ID, t2_ prefix), `at` (auth type), `scp` (base64 scopes).

### Method 4: OAuth API

Some `oauth.reddit.com` endpoints accept cookie auth directly; others need the bearer token:

| Endpoint | Cookies Only | Bearer Required |
|----------|-------------|-----------------|
| `/api/v1/me` | Yes | No |
| `/best` | Yes | No |
| `/r/{sub}/hot` | Yes | No |
| `/api/v1/me/prefs` | No | Yes |
| `/api/v1/me/karma` | No | Yes |
| `/api/v1/me/friends` | No | Yes |
| `/subreddits/mine/subscriber` | No | Yes |

### Legacy Auth Headers (Old API Mutations)

| Header | Format | Purpose |
|--------|--------|---------|
| `X-Modhash` | 48-char hex | CSRF for old API writes |
| `X-Signature-v2` | `key=RedditFrontend3, mac={hex}` | Request signing |
| `X-Requested-With` | `XMLHttpRequest` | XHR marker |

---

## Rate Limits

| Access Method | Limit | Headers |
|---------------|-------|---------|
| Anonymous (no auth) | ~10 req/min | `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` |
| Cookie auth | ~30 req/min | Same headers |
| OAuth bearer | ~100 req/min | Same headers |

On 429: check `x-ratelimit-reset` (seconds until window resets). Wait that + 1s buffer.

**Recommended safe rate**: 1 req/2s anonymous, 1 req/s authenticated.

---

## Endpoints by Category

### 1. Feed / Listing (Old JSON API) -- Primary Target

All listing endpoints share identical parameters and response shape. Append `.json` to any Reddit URL.

#### Parameters (universal across all listings)

| Parameter | Type | Default | Range | Purpose |
|-----------|------|---------|-------|---------|
| `limit` | int | 25 | 1-100 | Items per page |
| `after` | string | null | fullname `t3_xxx` | Next page cursor |
| `before` | string | null | fullname | Previous page cursor |
| `count` | int | 0 | 0+ | Offset hint (informational) |
| `sort` | enum | hot | hot, new, top, controversial, rising | Sort order |
| `t` | enum | day | hour, day, week, month, year, all | Time filter (for top/controversial) |
| `raw_json` | int | 0 | 1 | Unescape HTML entities |
| `sr_detail` | bool | false | true | Inline subreddit metadata |
| `show` | string | - | all | Show hidden/filtered content |

#### Response Shape (Listing)

```json
{
  "kind": "Listing",
  "data": {
    "after": "t3_abc123",
    "before": null,
    "dist": 25,
    "children": [
      { "kind": "t3", "data": { "title": "...", "author": "...", "score": 42, ... } }
    ]
  }
}
```

#### Type Prefixes

| Prefix | Type | Returned By |
|--------|------|-------------|
| `t1` | Comment | `/r/{sub}/comments.json` |
| `t2` | User | `/user/{name}/about.json` |
| `t3` | Link/Post | All feed endpoints |
| `t5` | Subreddit | `/r/{sub}/about.json`, autocomplete |

#### Endpoints

```bash
# Homepage feed
curl -s 'https://www.reddit.com/.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit listing (any sort)
curl -s 'https://www.reddit.com/r/programming.json?sort=top&t=week&limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit top posts this week
curl -s 'https://www.reddit.com/r/programming/top.json?t=week&limit=100&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit new posts
curl -s 'https://www.reddit.com/r/programming/new.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit rising
curl -s 'https://www.reddit.com/r/programming/rising.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Paginated (page 2)
curl -s 'https://www.reddit.com/r/programming.json?limit=25&after=t3_abc123&count=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# With inline subreddit details
curl -s 'https://www.reddit.com/.json?limit=10&sr_detail=true&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Recent comments in subreddit
curl -s 'https://www.reddit.com/r/programming/comments.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'
```

### 2. Post / Comments

```bash
# Post with comment tree (returns [post_listing, comments_listing])
curl -s 'https://www.reddit.com/r/programming/comments/POST_ID.json?raw_json=1&sort=best' \
  -H 'User-Agent: showrun/1.0'

# Comment sort options: best, top, new, controversial, old, qa
# limit parameter controls comment depth/count
```

**Response**: Array of two Listings -- `[post_listing, comments_listing]`. Comments are nested via `replies` field (recursive Listing structure).

### 3. Search

```bash
# Global search
curl -s 'https://www.reddit.com/search.json?q=javascript&sort=relevance&t=month&limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit-scoped search
curl -s 'https://www.reddit.com/r/programming/search.json?q=python&restrict_sr=on&sort=top&t=year&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Search by type
curl -s 'https://www.reddit.com/search.json?q=javascript&type=link&raw_json=1' \
  -H 'User-Agent: showrun/1.0'
# type values: link (posts), comment, sr (subreddits), user
```

Additional search sort values: `relevance` (default), `comments`.

### 4. Subreddit Info

```bash
# Subreddit metadata (subscribers, description, rules, etc.)
curl -s 'https://www.reddit.com/r/programming/about.json?raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit rules
curl -s 'https://www.reddit.com/r/programming/about/rules.json?raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Wiki page
curl -s 'https://www.reddit.com/r/programming/wiki/index.json?raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Subreddit autocomplete
curl -s 'https://www.reddit.com/api/subreddit_autocomplete_v2.json?query=prog&include_over_18=false&raw_json=1' \
  -H 'User-Agent: showrun/1.0'
```

### 5. User Info

```bash
# User profile (public)
curl -s 'https://www.reddit.com/user/spez/about.json?raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# User's posts
curl -s 'https://www.reddit.com/user/spez/submitted.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# User's comments
curl -s 'https://www.reddit.com/user/spez/comments.json?limit=25&raw_json=1' \
  -H 'User-Agent: showrun/1.0'

# Current user info (requires auth)
curl -s 'https://oauth.reddit.com/api/v1/me' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'

# Current user trophies (requires bearer)
curl -s 'https://oauth.reddit.com/api/v1/me/trophies' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'

# Current user karma breakdown (requires bearer)
curl -s 'https://oauth.reddit.com/api/v1/me/karma' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'

# Subscribed subreddits (requires bearer)
curl -s 'https://oauth.reddit.com/subreddits/mine/subscriber?limit=100' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'

# Best posts for user (requires cookies or bearer)
curl -s 'https://oauth.reddit.com/best?limit=25&raw_json=1' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'
```

### 6. GraphQL (Shreddit Internal)

**Endpoint**: `POST https://www.reddit.com/svc/shreddit/graphql`
**Introspection**: Disabled (returns 500)
**Auth**: Required (session cookies + CSRF in body)

```bash
# GraphQL request format
curl -s 'https://www.reddit.com/svc/shreddit/graphql' \
  -X POST -H 'Content-Type: application/json' \
  -H 'Cookie: <session cookies>' \
  -d '{
    "operation": "TrophyCategories",
    "variables": {"name":"spez","trophyImageMaxWidth":100,"includeRepeatableAchievements":true},
    "csrf_token": "<csrf_token cookie value>"
  }'
```

#### Discovered Operations

| Operation | Purpose | Key Variables |
|-----------|---------|---------------|
| `ExposeVariant` | A/B experiment tracking | `experimentName`, `variant`, `experimentVersion` |
| `CreateCaptchaToken` | Register reCAPTCHA token | `token` |
| `UserCommunityAchievements` | User trophies per subreddit | `username`, `subredditId` (t5_), `imageMaxWidth` |
| `TrophyCategories` | Full trophy listing | `name`, `trophyImageMaxWidth`, `includeRepeatableAchievements` |

Note: Many more GQL operations exist but were not triggered during this discovery session. Schema must be discovered through traffic interception, not introspection.

### 7. Messaging (Auth Required)

```bash
# Inbox page (returns HTML -- use old API alternatives below)
# https://www.reddit.com/message/inbox/

# Old API inbox (if available)
curl -s 'https://oauth.reddit.com/message/inbox?limit=25' \
  -H 'Authorization: Bearer <token>' \
  -H 'User-Agent: showrun/1.0'

# Notification badges
curl -s 'https://www.reddit.com/api/badge_indicators/v1?embedded=true' \
  -H 'Cookie: <session cookies>' \
  -H 'X-Modhash: <modhash>' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: showrun/1.0'
```

### 8. Shreddit Feed Endpoints (HTML Partials -- CDP Only)

These return HTML fragments, not JSON. Use only through CDP browser automation.

| Endpoint | Auth | Pagination |
|----------|------|------------|
| `/svc/shreddit/feeds/home-feed` | Required | cursor (base64 `t3_` ID) |
| `/svc/shreddit/feeds/popular-feed` | Optional | cursor |
| `/svc/shreddit/feeds/all-feed` | Optional | cursor |
| `/svc/shreddit/community-more-posts/{sort}/` | Optional | cursor + `name={subreddit}` |
| `/svc/shreddit/profiles/profile_overview-more-posts/{sort}/` | Optional | cursor + `name={user}` |
| `/svc/shreddit/comments/r/{sub}/{postId}` | Optional | n/a |

Required headers: `accept: text/vnd.reddit.partial+html, text/html;q=0.9`
Pagination params: `after` (base64 cursor), `distance`, `feedLength`, `navigationSessionId`

### 9. Media (No Auth)

| Domain | Pattern | Content |
|--------|---------|---------|
| `i.redd.it` | `/{id}.{png\|jpg}` | Reddit-hosted images |
| `preview.redd.it` | `/{slug}.jpeg` | Resized image previews |
| `external-preview.redd.it` | `/{slug}.jpeg` | Proxied external thumbnails |
| `v.redd.it` | `/{id}/CMAF_{quality}.mp4` | Video segments (480, 720) |
| `v.redd.it` | `/{id}/CMAF_AUDIO_128.mp4` | Audio track |
| `v.redd.it` | `/{id}/HLSPlaylist.m3u8` | HLS adaptive playlist |
| `packaged-media.redd.it` | `/{id}/pb/m2-res_{res}.mp4` | Packaged video |

---

## Telemetry Endpoints (Skip)

These are tracking/analytics -- not useful for data extraction:

| Endpoint | Domain | Purpose |
|----------|--------|---------|
| `POST /svc/shreddit/events` | www.reddit.com | View/click tracking (extremely high frequency) |
| `POST /svc/shreddit/perfMetrics` | www.reddit.com | Web vitals |
| `GET /svc/shreddit/update-recaptcha` | www.reddit.com | reCAPTCHA token refresh (bot detection) |
| `POST /track` | alb.reddit.com | Encrypted ad tracking |
| `GET /skatepark` | alb.reddit.com | Ad tracking pixel |
| `POST /reports` | w3-reporting.reddit.com | W3C CSP/NEL reports |
| `POST /o418887/api/5810803/envelope/` | error-tracking.reddit.com | Sentry errors |

---

## WAF / Bot Detection

### Observations

- **No PerimeterX/WAF blocks** observed during 239 fuzzer requests + 391 intercepted endpoints
- reCAPTCHA Enterprise tokens are refreshed on every page navigation via `CreateCaptchaToken` GraphQL mutation and `/svc/shreddit/update-recaptcha`
- The recaptcha `k` parameter decodes from base64 to `{page}|{trigger}|{uuid}` format

### What Triggers Blocks

- Missing or empty `User-Agent` header -> immediate 429
- Generic bot User-Agent -> throttled aggressively
- Very high request rate without auth -> 429 with rate limit headers
- HTML 403 responses containing `px-captcha` in the body indicate PerimeterX challenge

### CDP-Only Endpoints (flagged for browser automation)

These endpoints return HTML partials or require browser-specific signing and should be accessed via CDP only:

| Endpoint | Reason |
|----------|--------|
| `/svc/shreddit/feeds/*` | Returns HTML partials, not JSON |
| `/svc/shreddit/partial/{hash}/*` | Requires HMAC signature (`sig=v1.{base64}`) + deployment-specific hash |
| `/svc/shreddit/comments/r/{sub}/{id}` | Returns HTML partial comment tree |
| `/svc/shreddit/graphql` | Requires CSRF + session, schema undocumented |
| `/svc/shreddit/events` | Requires Thrift-like encoding format |
| `/api/comment.json` | Requires X-Modhash + X-Signature-v2 (signing key: `RedditFrontend3`) |

---

## Recommended Scraping Strategy

### For Data Extraction (taskpack scripts)

Use the **Old JSON API** exclusively -- it's stable, returns clean JSON, works anonymously, and supports all standard listing parameters:

1. **Auth**: Start anonymous. If you need user-specific data, extract cookies via CDP `Network.getCookies` then use OAuth bearer.
2. **Pagination**: Use `after` cursor from `data.after`. Loop until `data.after` is `null`.
3. **Always pass**: `?raw_json=1` (clean text) + `User-Agent` header.
4. **Rate limit**: 1 request per 2 seconds anonymous, 1 per second with auth. Check `x-ratelimit-remaining` header.
5. **Data enrichment**: Use `sr_detail=true` to inline subreddit metadata (avoids extra lookups).

### For Mutations (votes, comments, messages)

Use **CDP browser automation** -- the old mutation API requires request signing (`X-Signature-v2` with HMAC key `RedditFrontend3`) and Thrift-like body encoding. Easier to drive through the browser.

### For Real-Time Feed Monitoring

Use the **Shreddit feed endpoints via CDP** -- navigate to the page, intercept the HTML partials, parse the web component attributes for post data.

---

## Key Fields Reference

### Post (t3) -- Top 20 Fields

`title`, `author`, `author_fullname`, `selftext`, `score`, `ups`, `downs`, `upvote_ratio`, `num_comments`, `created_utc`, `subreddit`, `subreddit_name_prefixed`, `permalink`, `url`, `thumbnail`, `link_flair_text`, `is_self`, `over_18`, `saved`, `hidden`

### Comment (t1) -- Top 20 Fields

`author`, `author_fullname`, `body`, `body_html`, `score`, `ups`, `downs`, `created_utc`, `link_title`, `link_author`, `subreddit`, `permalink`, `parent_id`, `depth`, `replies` (nested Listing), `is_submitter`, `edited`, `gilded`, `saved`, `collapsed`

### Subreddit (t5) -- Top 20 Fields

`display_name`, `display_name_prefixed`, `title`, `public_description`, `subscribers`, `active_user_count`, `created_utc`, `over18`, `icon_img`, `banner_img`, `primary_color`, `community_icon`, `header_img`, `description`, `wiki_enabled`, `allow_galleries`, `submit_text`, `lang`, `url`, `subreddit_type`

### User (t2) -- Top 20 Fields

`name`, `id`, `created_utc`, `link_karma`, `comment_karma`, `total_karma`, `is_gold`, `is_mod`, `verified`, `has_verified_email`, `icon_img`, `snoovatar_img`, `subreddit` (profile sub), `is_employee`, `is_blocked`, `accept_pms`, `awardee_karma`, `awarder_karma`, `pref_show_snoovatar`, `has_subscribed`

---

## Domains Summary

| Domain | Purpose | Auth | JSON API |
|--------|---------|------|----------|
| `www.reddit.com` | Main web app + all APIs | Varies | Yes (`.json` suffix) |
| `oauth.reddit.com` | OAuth REST API | Bearer/Cookie | Yes |
| `i.redd.it` | Reddit-hosted images | No | N/A |
| `preview.redd.it` | Image thumbnails | No | N/A |
| `external-preview.redd.it` | External link previews | No | N/A |
| `v.redd.it` | Video (CMAF/HLS) | No | N/A |
| `packaged-media.redd.it` | Packaged video | No | N/A |
| `www.redditstatic.com` | Static assets (JS/CSS) | No | N/A |
| `alb.reddit.com` | Ad/tracking beacons | No | N/A |
| `w3-reporting.reddit.com` | CSP/NEL reports | No | N/A |
| `error-tracking.reddit.com` | Sentry | No | N/A |
| `embed.reddit.com` | Embedded widgets | No | N/A |

---

## Discovery Artifacts

Raw data from the discovery session:

```
/tmp/discovery/
  endpoints.jsonl              859 entries, 391 unique endpoints (1.38 MB)
  api-map.json                 Structured endpoint catalog (38 KB)
  parameter-tests.json         Fuzzer results for 20 endpoints (57 KB)
  reddit-session.json          Extracted cookies + Matrix tokens
  reddit-auth.json             Auth credentials (cookies, JWT, CSRF)
  schema-analysis.md           Human-readable schema analysis
  fuzzer-results.md            Parameter testing report
  interceptor-v2.mjs           CDP network interception script
  fuzzer-v2.mjs                Reusable parameter fuzzer script
```
