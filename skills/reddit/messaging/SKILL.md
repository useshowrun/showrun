---
name: reddit-messaging
description: "Reddit private messages + chat from the terminal. Supports both legacy PMs (via OAuth API) and real-time chat (via Matrix protocol). All API-based — no browser needed after initial auth."
---

# reddit-messaging

Reddit private messages + chat from the terminal. Supports both legacy PMs (via OAuth API) and real-time chat (via Matrix protocol). All API-based — no browser needed after initial auth.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)
- Reddit account (messaging requires authentication)
- For chat commands: open `chat.reddit.com` in Chrome at least once before auth

## Setup
One-time auth — extracts session cookies, bearer token, and Matrix chat token:
```bash
node reddit-messaging.mjs auth
```

## Usage

### Send a chat message
```bash
node reddit-messaging.mjs chat anilseyrek "Hey, what's up?"
```

### List chat conversations
```bash
node reddit-messaging.mjs chats
```

### Send a private message
```bash
# Tries legacy PM first; auto-falls back to chat if user has PMs restricted
node reddit-messaging.mjs send username "Subject line" "Message body text"
```

### View inbox
```bash
node reddit-messaging.mjs inbox
node reddit-messaging.mjs inbox --limit=10
node reddit-messaging.mjs inbox --after=t4_xxx
```

### View unread messages
```bash
node reddit-messaging.mjs unread
```

### View sent messages
```bash
node reddit-messaging.mjs sent
```

### Mark as read
```bash
node reddit-messaging.mjs read t4_abc123
```

### Reply to a message
```bash
node reddit-messaging.mjs reply t4_abc123 "Reply text here"
```

## How it works

1. **auth** — Connects to Chrome via CDP, extracts Reddit cookies + `token_v2` cookie as bearer token + Matrix chat credentials from localStorage. Saves session to disk.
2. **chat** — Resolves the recipient's Reddit user ID (t2_xxx), creates a direct-message room via Matrix `createRoom` (or reuses existing), sends via `PUT /rooms/{roomId}/send/m.room.message/{txnId}`.
3. **chats** — Calls Matrix `joined_rooms`, then for each room fetches state (members) and last message.
4. **send** — POSTs to `oauth.reddit.com/api/compose` (legacy PM). If the user has PMs restricted (`RESTRICTED_TO_PM` error), automatically falls back to the `chat` command.
5. **inbox** — Calls `oauth.reddit.com/message/inbox` with bearer auth. Returns Listing of messages.
6. **unread** — Same as inbox but filtered via `/message/unread` endpoint.
7. **sent** — Fetches `/message/sent` for outgoing messages.
8. **read** — POSTs to `/api/read_message` to mark a message as read.
9. **reply** — POSTs to `/api/comment` with the message's thing_id and reply text.

## Data storage
```
~/.local/share/showrun/data/reddit-messaging/
  session.json                      Auth cookies, bearer, Matrix token
  cache/
    inbox-<timestamp>.json          Inbox messages
    unread-<timestamp>.json         Unread messages
    sent-<timestamp>.json           Sent messages
    chats-<timestamp>.json          Chat room listing
```

## Session expiry
If you get 401/403 errors, re-run:
```bash
node reddit-messaging.mjs auth
```
Bearer tokens and Matrix tokens may expire after 24 hours. Open `chat.reddit.com` in Chrome before re-auth to refresh the Matrix token.
