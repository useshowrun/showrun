---
name: instagram-msg
description: "Instagram DM operations — inbox, single-thread history, and send. Send drives the live Chrome tab via CDP; inbox and thread use the read-only web API."
---

# instagram-msg

Instagram direct-message operations.

## Prerequisites

- Node.js 22+
- Session captured via the `instagram-user` skill — `auth` is shared.
- For `send`: [chrome-cdp](../../chrome-cdp) skill installed, plus an instagram.com tab open in the CDP-connected Chrome (the script opens one automatically if missing).

## Usage

### List conversations

    node scripts/instagram-msg.mjs inbox [--count=20] [--cursor=X] [--pending]

`--pending` lists the message-requests bucket instead of the primary inbox. Returns thread summaries with `thread_id`, `users`, `last_activity_at`, `has_unread`, and a `last_message` preview. Cached to `~/.local/share/showrun/data/instagram/cache/{inbox,pending_inbox}.json`.

### View messages in a thread

    node scripts/instagram-msg.mjs thread <thread_id> [--count=20] [--cursor=X]

Returns the message history with sender_id, text, timestamps, reactions, and replied-to references.

### Send a DM

    node scripts/instagram-msg.mjs send <username|user_id|thread_id> "text"

Target auto-detection: a numeric string ≥14 digits is treated as a thread_id, ≤12 digits as a user_id, anything non-numeric as a username (resolved via the profile endpoint).

On success returns `{ ok: true, thread_id, item_id, timestamp, composer_cleared: true }`. On failure `ok` is false and a warning is printed.

## Why `send` drives the UI instead of POSTing JSON

Instagram retired the public `POST /api/v1/direct_v2/threads/broadcast/text/` endpoint for the web client. Even with a valid `sessionid`, `csrftoken`, `x-ig-app-id`, `x-asbd-id`, and a replayed `x-ig-www-claim`, the request returns HTML (the login page) instead of JSON, and the server's anti-abuse layer flags repeated failed POSTs as suspicious — escalating to a soft logout after a handful of attempts. Web DM send is now carried over a WebSocket (Mercury/Polaris) with tokens we can't reliably replay from Node.

The working alternative is to drive the live Chrome tab via CDP:

1. Navigate to the target's profile (or `/direct/t/<thread_id>/` for an existing thread).
2. Click the profile-level "Message" button (skipped for thread targets — the URL itself opens the composer).
3. Wait for the `div[contenteditable=true]` composer, click it to focus, `Input.insertText` the message, then `Input.dispatchKeyEvent` Enter.
4. Verify via the inbox API that a new message with our text and `sender_id` appears in the matching thread.

This is brittle (any IG DOM change can break it) but it's the only path that ships real messages without burning the session.

## Gotchas

- **Target must allow DMs from you.** If the profile shows no "Message" button (Instagram hides it when the user doesn't accept DMs from your relationship tier), `send` will fail fast with a clear error. Follow them first if mutual-follow unlocks DMs, or send through an existing thread instead.
- **Rate-limit yourself.** UI-driven sends look more like real activity than REST POSTs, but rapid back-to-back sends still trip anti-abuse. Pace runs at minutes-apart, not seconds.
- **The composer takes a beat to render** after navigation; the script polls for up to 12s.
- **The inbox API can lag the WebSocket send by a few seconds**; the script polls inbox for up to 6s before reporting success. If you see `ok: false` with `composer_cleared: true`, the send likely landed and the inbox just hadn't caught up — re-run `inbox` after a few seconds to confirm.

## Data storage

    ~/.local/share/showrun/data/instagram/
    ├── session.json                # Shared with all instagram skills
    └── cache/
        ├── inbox.json
        ├── pending_inbox.json
        └── thread-<thread_id>-<ts>.json
