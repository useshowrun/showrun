---
name: instagram-user
description: "Instagram profile lookup (bio, links, follower counts, category, contacts parsed from the bio), posts, reels, highlights, tagged posts, stories, followers and following lists."
---

# instagram-user

Instagram profile lookup, timeline browsing, and relationship listing.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill installed
- Chrome (CDP-connected) with a **logged-in instagram.com tab**. Every request runs inside that tab; nothing is sent from Node with copied cookies.

## Setup

No session capture is needed. To check that the tab is found and logged in (no network request):

    node scripts/instagram-user.mjs auth

## Usage

### Lookup profile by handle

    node scripts/instagram-user.mjs lookup <username>

Returns: id, username, full_name, biography, bio_links, external_url, followers/following/posts counts, profile_pic_url (HD), is_private, is_verified, is_business_account, is_professional_account, account_type (`personal`/`business`/`creator`), category_name, business_address (street/city/zip when the account set one), pronouns, clips_count, fbid.

Contact info: Instagram's web API no longer returns the contact-button fields (business/public email, phone, WhatsApp). They are mobile-app only now. `business_email`, `business_phone_number`, `public_email` and `public_phone_number` are therefore always `null`. Instead, the script parses what the account wrote in its biography, bio links and website into:

- `bio_emails`: email addresses
- `bio_phone_numbers`: phone numbers (9–15 digits, as written, including numbers taken from WhatsApp links)
- `bio_whatsapp_links`: `wa.me` / `api.whatsapp.com` / `chat.whatsapp.com` links, each as `{ url, phone }`

Always `null` on web: `highlight_reel_count` (use `highlights`), `business_category_name`, `has_channel`.

### Lookup profile by numeric ID

    node scripts/instagram-user.mjs lookup-id <id>

Same output as `lookup`.

### Recent posts

    node scripts/instagram-user.mjs posts <username|id> [--count=12] [--cursor=X]

Returns post objects with caption, like/comment counts, media URLs, carousel items, location, and a `nextCursor` for pagination. Pinned posts come first.

### Recent reels

    node scripts/instagram-user.mjs reels <username|id> [--count=12] [--cursor=X]

Returns reel objects from the profile's Reels tab: code, URL, play/like/comment counts, thumbnail. The web grid query has no caption, `taken_at` or video URL. Use `instagram-post info <code>` for those.

### Highlights tray

    node scripts/instagram-user.mjs highlights <username|id>

Lists permanent highlight reels (id, title, cover image). `media_count` / `created_at` are not exposed on web (`null`).

### Tagged posts

    node scripts/instagram-user.mjs tagged <username|id> [--count=12] [--cursor=X]

Posts the user is tagged in.

### Active stories

    node scripts/instagram-user.mjs stories <username|id>

Currently active 24h stories. Returns an empty array if there are none. This only reads the reel; it does not send the separate "seen" mutation.

### Followers / following

    node scripts/instagram-user.mjs followers <username|id> [--count=25] [--cursor=X]
    node scripts/instagram-user.mjs following <username|id> [--count=25] [--cursor=X]

Each returns up to ~50 users per page with `nextCursor`. Instagram ignores `--count` here and heavily limits these lists for large accounts.

## How it works

All requests go through [`../_shared/instagram-fetch.mjs`](../_shared/instagram-fetch.mjs), which runs `fetch(..., { credentials: 'include' })` inside the instagram.com tab via `cdp eval`. Chrome supplies the cookies from its own jar and handles `Set-Cookie`, so there is never a second session racing the browser's. That parallel-cookie-jar pattern is what got LinkedIn sessions killed.

| Command | Request |
|---|---|
| `lookup` | `GET /<username>/` (HTML, read `"profile_id"`) → GraphQL `PolarisProfilePageContentQuery {id}` |
| `lookup-id` | GraphQL `PolarisProfilePageContentQuery {id}` |
| `posts` | GraphQL `PolarisProfilePostsQuery {data, username, after?, first?}` |
| `reels` | GraphQL `PolarisProfileReelsTabContentQuery` (page 1) / `..._connection` (with `--cursor`) |
| `highlights` | GraphQL `PolarisProfileStoryHighlightsTrayContentQuery {user_id}` |
| `tagged` | GraphQL `PolarisProfileTaggedTabContentQuery {count, user_id, after?, first?}` |
| `stories` | GraphQL `PolarisStoriesV3ReelPageStandaloneQuery {reel_ids_arr}` |
| `followers` / `following` | `GET /api/v1/friendships/<id>/{followers,following}/` |

The old JSON endpoints `/api/v1/users/web_profile_info/` and `/api/v1/users/<id>/info/` now answer every web request with HTTP 429 and an HTML "Page Not Found" body. That is an endpoint block, not an account rate limit. `/api/v1/clips/user/`, `/api/v1/usertags/<id>/feed/` and `/api/v1/feed/reels_media/` are also gone for web clients. Username → id resolution therefore loads the profile page HTML (the same request a browser makes) and caches the id in `cache/user-ids.json`, so repeat lookups cost one request.

GraphQL requests are built the way the web app builds them, from live page state:

- **doc_id**: `require('<Query>_instagramRelayOperation')` from the page's module registry. A table of fallback doc_ids captured on 2026-10-30 is used only when the module is not loaded in the tab. The Reels/Tagged tab queries are only bundled after such a tab has been opened, so they usually run on the fallback.
- **`__relay_internal__pv__*` variables**: evaluated from the query's `providedVariables` in the page (fallback values captured alongside the doc_ids).
- **form params**: `require('getAsyncParams')('POST')`, which provides `fb_dtsg`, `lsd`, `jazoest`, `__dyn`, `__csr`, `__hs`, `__rev`, `__spin_*` and the rest, plus `av`.
- **headers**: `X-CSRFToken` from the `csrftoken` cookie, `X-FB-LSD`, `X-IG-App-ID` (`CurrentUserInitialData.APP_ID`), `X-ASBD-ID` (`BDHeaderConfig.ASBD_ID`), `X-FB-Friendly-Name`.

Set `INSTAGRAM_DEBUG=1` to log the doc_id each call used and whether it came from the page or the fallback. If a fallback doc_id goes stale, open the matching profile tab in Chrome once: the page will then provide the current id.

## Pacing and stop signals

Requests are spaced at least `INSTAGRAM_MIN_INTERVAL_MS` apart (default 5000 ms), across processes, using `~/.local/share/showrun/data/instagram/.last-request`. A `lookup` of an uncached handle makes 2 requests.

The scripts exit with `STOP: ...` on a JSON rate-limit response ("Please wait a few minutes"), a checkpoint/challenge, a `require_login` response or a redirect to the login page. When that happens, do not retry. Let the account rest and check the Chrome tab.

## Data storage

    ~/.local/share/showrun/data/instagram/
    ├── .last-request                      # pacing timestamp
    └── cache/
        ├── user-ids.json                  # username -> numeric id
        ├── user-<handle>.json
        ├── posts-<handle>-<ts>.json
        ├── reels-<userId>-<ts>.json
        └── …

`session.json` (cookies copied by the old `auth`) is no longer read by any Instagram skill and can be deleted.
