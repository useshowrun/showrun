---
name: linkedin-msg
description: "LinkedIn messaging from the terminal — view conversations, read messages, search contacts, and send messages. No browser needed after initial auth."
---

# linkedin-msg

LinkedIn messaging from the terminal — view conversations, read messages, search contacts, and send messages. No browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch` and `crypto`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/pasky/chrome-cdp-skill/tree/main/skills/chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from an open LinkedIn tab in Chrome:

```bash
node scripts/linkedin-msg.mjs auth
```

This saves your LinkedIn session to disk. After auth, Chrome is no longer needed.

## Usage

### List conversations (inbox)

```bash
# Default: 20 conversations from primary inbox
node scripts/linkedin-msg.mjs inbox

# Custom count and category
node scripts/linkedin-msg.mjs inbox --count=50
node scripts/linkedin-msg.mjs inbox --category=INMAIL
```

Output shows participant names, timestamps, unread counts, message previews, and conversation URNs. Results are cached for use with `messages` and `send`.

### View messages in a conversation

```bash
# By conversation URN (from inbox output)
node scripts/linkedin-msg.mjs messages urn:li:msg_conversation:...

# By index from last inbox output (1-based)
node scripts/linkedin-msg.mjs messages 1
```

### Search contacts

```bash
# Find conversations by participant name (case-insensitive, partial match)
node scripts/linkedin-msg.mjs search "John"
node scripts/linkedin-msg.mjs search "Anıl Seyrek"
```

Shows matching conversations with participant names, profile URNs, and conversation URNs.

### Send a message

```bash
# By LinkedIn URL
node scripts/linkedin-msg.mjs send https://linkedin.com/in/emrahyalaz "Hello!"

# By vanity name
node scripts/linkedin-msg.mjs send emrahyalaz "Hello from CLI"

# By person's name (searches conversations as fallback if profile API fails)
node scripts/linkedin-msg.mjs send "Anıl Seyrek" "Hello!"

# By profile URN
node scripts/linkedin-msg.mjs send urn:li:fsd_profile:ACoAAAB0OpgBZOZ1m040shN_2CxvGsj7uzP70Dc "Hello!"

# By URN ID (ACoA prefix auto-detected)
node scripts/linkedin-msg.mjs send ACoAAAB0OpgBZOZ1m040shN_2CxvGsj7uzP70Dc "Hello!"

# Reply to a conversation directly
node scripts/linkedin-msg.mjs send urn:li:msg_conversation:... "Thanks!"
```

The `send` command resolves recipients in this order:
1. Direct URN or conversation URN (if provided)
2. Vanity name → profile API lookup
3. **Fallback**: searches existing conversations by name (handles profiles where the API returns 403)

### Show help

```bash
node scripts/linkedin-msg.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts all LinkedIn cookies (including httpOnly `li_at`) using `Network.getCookies`, fetches your own profile URN via the `/me` API, and saves everything locally.

2. **`inbox`** — Calls the `voyagerMessagingGraphQL` conversations endpoint to list conversations with participant names, timestamps, unread counts, and message previews.

3. **`messages`** — Calls the `voyagerMessagingGraphQL` messages endpoint to fetch all messages in a conversation with sender names and timestamps.

4. **`search`** — Fetches conversations and filters by participant name (case-insensitive partial match). Shows profile URNs for matching participants.

5. **`send`** — Resolves the recipient's profile URN (via profile API or conversation search fallback), then POSTs to `voyagerMessagingDashMessengerMessages?action=createMessage`.

## Data storage

All data is stored in:

```
~/.local/share/showrun/data/linkedin-msg/
├── session.json     # Auth cookies, CSRF token, your profile URN
├── profiles.json    # Cached vanity name → URN mappings
└── cache/
    ├── conversations.json    # Last inbox fetch
    └── messages_*.json       # Cached message threads
```

- `session.json` contains your LinkedIn session cookies. LinkedIn sessions typically last ~1 year. Re-run `auth` if you get 401/403 errors.
- `profiles.json` caches profile URN lookups so repeated messages to the same person skip the resolve step.
- `cache/` stores conversation and message data from recent API calls.

## Session expiry

If you see `Failed (HTTP 401)` or `Failed (HTTP 403)`, your session has expired. Open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-msg.mjs auth
```
