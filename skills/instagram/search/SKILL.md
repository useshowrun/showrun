---
name: instagram-search
description: "Instagram top search — find users, hashtags, and places by free-text query."
---

# instagram-search

Search Instagram for users, hashtags, and places.

## Prerequisites

- Node.js 22+
- Session captured via the `instagram-user` skill — `auth` is shared.

## Usage

### Blended search

    node scripts/instagram-search.mjs top <query>

Returns up to 5–10 results in each of `users`, `hashtags`, and `places`.

### Scoped search

    node scripts/instagram-search.mjs users <query>
    node scripts/instagram-search.mjs hashtags <query>
    node scripts/instagram-search.mjs places <query>

Each scope returns a larger set of just that result type.

## How it works

Calls `GET /api/v1/web/search/topsearch/?context=<blended|user|hashtag|place>&query=<q>` with the shared session cookies.
