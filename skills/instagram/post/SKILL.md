---
name: instagram-post
description: "Instagram single-post lookup by shortcode or URL — post info, comments, and recent likers."
---

# instagram-post

Single-post operations on Instagram. Accepts both shortcodes (`DYkCUGmjfMc`) and full post URLs (`https://www.instagram.com/p/DYkCUGmjfMc/`, `/reel/<code>/`, `/tv/<code>/`).

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill installed, plus a logged-in instagram.com tab in the CDP-connected Chrome. Requests run inside that tab (see `instagram-user` → How it works).

## Usage

### Post info

    node scripts/instagram-post.mjs info <shortcode|url>

Returns id, caption (with extracted hashtags + mentions), media URLs, carousel items, like and comment counts, owner, location, and accessibility caption.

### Comments

    node scripts/instagram-post.mjs comments <shortcode|url> [--count=20] [--cursor=X]

Returns comment objects (text, like count, reply count, author) with `nextCursor` for pagination.

### Recent likers

    node scripts/instagram-post.mjs likers <shortcode|url>

Returns the first page of likers (~24). Instagram does not expose deep liker pagination on the web.

## How it works

Instagram post URLs use a base64-encoded `media_id` (the shortcode). The script decodes it to the numeric `media_id` using the alphabet `A–Za–z0–9-_`, then calls:

- `GET /api/v1/media/<media_id>/info/`
- `GET /api/v1/media/<media_id>/comments/`
- `GET /api/v1/media/<media_id>/likers/`

These still answer web clients (verified 2026-10-30). The requests run in-page from the logged-in Chrome tab through `../_shared/instagram-fetch.mjs`, with the browser's own cookies and the live `csrftoken` / app id / ASBD id headers. Nothing is sent from Node. Requests are paced and stop on rate-limit or checkpoint signals (see `instagram-user` SKILL.md).
