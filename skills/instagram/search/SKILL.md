---
name: instagram-search
description: "Instagram top search — find users, hashtags, and places by free-text query."
---

# instagram-search

Search Instagram for users, hashtags, and places.

## Prerequisites

- Node.js 22+
- [chrome-cdp](../../chrome-cdp) skill installed, plus a logged-in instagram.com tab in the CDP-connected Chrome. Requests run inside that tab (see `instagram-user` → How it works).

## Usage

### Blended search

    node scripts/instagram-search.mjs top <query>

Returns the search box's results: `users`, `hashtags` and `places`. On web, blended results are almost always users only.

### Scoped search

    node scripts/instagram-search.mjs users <query>
    node scripts/instagram-search.mjs hashtags <query>
    node scripts/instagram-search.mjs places <query>

User hits carry `id`, `username`, `full_name`, `is_verified`, `profile_pic_url`, `social_context` (e.g. "136K followers") and `position`. The web search query does not return `is_private` or `follower_count`; those keys are `null`. Ids from `top`/`users` are cached, so a follow-up `instagram-user lookup` skips the profile-page request.

Hashtag hits carry `id`, `name`, `media_count` and `subtitle` (e.g. "2.6M posts").

Place hits come from Instagram's location search and carry `name`, `address`, `lat`, `lng` and `facebook_places_id`. There is no Instagram location pk on this surface, so `id` is `null`. Results are biased towards the viewer's location.

## How it works

Runs inside the logged-in Chrome tab via `../_shared/instagram-fetch.mjs`:

- `top` / `users` / `hashtags`: GraphQL `PolarisSearchBoxRefetchableQuery`, the query the instagram.com search box sends. It resolves to `xdt_api__v1__fbsearch__topsearch_connection` with `data = { context: blended|user|hashtag, query, include_reel: "true", rank_token: "", search_session_id: <uuid>, search_surface: "web_top_search" }`.
- `places`: GraphQL `PolarisAPILocationSearchQuery` (`ig_place_search`) with `request = { search_query, latitude: null, longitude: null }`. Topsearch rejects `context: "location"` with a server `field_exception`, and blended results rarely include places on web.

doc_ids and tokens are read from the live page (see `instagram-user` SKILL.md). The old REST endpoint `GET /api/v1/web/search/topsearch/` returns 404.
