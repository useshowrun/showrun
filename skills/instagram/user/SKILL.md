---
name: instagram-user
description: "Instagram profile lookup (bio, links, follower counts, business info), posts, reels, highlights, tagged posts, stories, followers and following lists."
---

# instagram-user

Instagram profile lookup, timeline browsing, and relationship listing.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with instagram.com logged in (for `auth` command)
- [chrome-cdp](../../chrome-cdp) skill installed

## Setup

One-time authentication — requires an active instagram.com session in Chrome:

    node scripts/instagram-user.mjs auth

## Usage

### Lookup profile by handle

    node scripts/instagram-user.mjs lookup <username>

Returns: id, username, full_name, biography, bio_links, external_url, followers/following/posts counts, profile_pic_url, verification, business info (category, email, phone, address), highlight count.

### Lookup profile by numeric ID

    node scripts/instagram-user.mjs lookup-id <id>

Same output as `lookup`.

### Recent posts

    node scripts/instagram-user.mjs posts <username|id> [--count=12] [--cursor=X]

Returns post objects with caption, like/comment counts, media URLs, carousel items, location, and a `nextCursor` for pagination.

### Recent reels

    node scripts/instagram-user.mjs reels <username|id> [--count=12] [--cursor=X]

Returns reel objects (videos) with caption, play count, video URL.

### Highlights tray

    node scripts/instagram-user.mjs highlights <username|id>

Lists permanent highlight reels (title, media count, cover image). Use highlight `id` to fetch contents via the `instagram-post` skill or `feed/reels_media/?reel_ids=<id>` directly.

### Tagged posts

    node scripts/instagram-user.mjs tagged <username|id> [--count=12] [--cursor=X]

Posts the user is tagged in.

### Active stories

    node scripts/instagram-user.mjs stories <username|id>

Currently active 24h stories. Returns empty array if no active stories.

### Followers / following

    node scripts/instagram-user.mjs followers <username|id> [--count=25] [--cursor=X]
    node scripts/instagram-user.mjs following <username|id> [--count=25] [--cursor=X]

Each returns up to ~50 users per page with `nextCursor`. Note: Instagram heavily limits these for users with large follower counts.

## How it works

1. **`auth`** — Connects to Chrome via CDP, finds an instagram.com tab, extracts cookies (`sessionid`, `csrftoken`, `ds_user_id`, `mid`, `ig_did`, `rur`, `datr`) via `Network.getCookies`, and saves the session to disk.

2. **`lookup` / `lookup-id`** — Calls `/api/v1/users/web_profile_info/?username=…` (or `/api/v1/users/<id>/info/` then resolves to username). Returns a clean profile object.

3. **Timeline endpoints** — Calls the matching internal endpoint:
   - posts: `GET /api/v1/feed/user/<id>/`
   - reels: `POST /api/v1/clips/user/`
   - tagged: `GET /api/v1/usertags/<id>/feed/`
   - highlights: `GET /api/v1/highlights/<id>/highlights_tray/`
   - stories: `GET /api/v1/feed/reels_media/?reel_ids=<id>`

4. **Friendships** — Calls `GET /api/v1/friendships/<id>/{followers,following}/` with cursor pagination via `max_id`.

All requests use the `x-ig-app-id: 936619743392459` header that identifies the web app, plus the `x-csrftoken` and `cookie` headers from the saved session.

## Data storage

    ~/.local/share/showrun/data/instagram/
    ├── session.json                       # Shared across all instagram skills
    └── cache/
        ├── user-<handle>.json
        ├── posts-<userId>-<ts>.json
        ├── reels-<userId>-<ts>.json
        └── …

## Session expiry

Instagram sessions usually last several weeks. If you get 401/403 errors, re-run `auth`.

## Rate limits

Instagram does not publish web-API limits, but `/feed/user/` and `/friendships/.../followers/` are aggressively throttled at scale — back off on 429 and avoid tight loops over large accounts.
