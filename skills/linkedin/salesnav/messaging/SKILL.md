---
name: salesnav-messaging
description: "Sales Navigator InMail/messaging — list inbox threads, read conversations, reply to threads, and send new InMails via the Sales Navigator API."
---

# salesnav-messaging

Sales Navigator InMail/messaging — list inbox threads, read conversations, reply to threads, and send new InMails via the Sales Navigator API.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled, and a logged-in `www.linkedin.com/sales/...` tab kept open
- [chrome-cdp skill]
- LinkedIn Sales Navigator subscription

Requests run **inside your Chrome tab** (via CDP), not from Node — this is what lets them past LinkedIn's `sales-api` edge. So a Sales Navigator tab must stay open for **every** command (reads and sends), not just `auth`. If no `/sales/` tab is open, open one (see chrome-cdp "Agent guidance"): `node skills/chrome-cdp/scripts/cdp.mjs open https://www.linkedin.com/sales/home`.

## Setup

One-time auth — open Sales Navigator in Chrome, then:

```bash
node salesnav-messaging.mjs auth
```

## Usage

```bash
# List inbox threads (default: 20 most recent)
node salesnav-messaging.mjs inbox

# List more threads
node salesnav-messaging.mjs inbox --count=50

# List sent or archived messages
node salesnav-messaging.mjs inbox --filter=SENT
node salesnav-messaging.mjs inbox --filter=ARCHIVED

# Paginate (use cursor from previous response)
node salesnav-messaging.mjs inbox --page=1710000000000

# View a specific thread with all messages
node salesnav-messaging.mjs thread <threadId>

# Send a reply (use --dry-run first to verify)
node salesnav-messaging.mjs send <threadId> --body="Thanks for connecting!" --dry-run
node salesnav-messaging.mjs send <threadId> --body="Thanks for connecting!"

# Send a new InMail (use --dry-run first to verify)
node salesnav-messaging.mjs new-inmail urn:li:fs_salesProfile:ACwAAA... --subject="Quick question" --body="Hi..." --dry-run
node salesnav-messaging.mjs new-inmail urn:li:fs_salesProfile:ACwAAA... --subject="Quick question" --body="Hi..."

# Get your inbox signature
node salesnav-messaging.mjs signature

# Check online presence
node salesnav-messaging.mjs presence urn:li:fs_salesProfile:ACwAAA...,urn:li:fs_salesProfile:ACwBBB...
```

## How it works

1. **auth** — Uses CDP to find an open Sales Navigator tab, validates the session (`li_at` + `JSESSIONID`), and writes a marker `session.json`. Cookies stay in Chrome — every request (reads and sends) runs in-page with `credentials:'include'`.
2. **inbox** — Calls `GET /sales-api/salesApiMessagingThreads` with filter and pagination params. Returns thread summaries with participant names, last message preview, and unread counts.
3. **thread** — Calls `GET /sales-api/salesApiMessagingThreads/<threadId>` with full decoration. Displays all messages in chronological order.
4. **send** — POSTs to `/sales-api/salesApiMessagingThreads/<threadId>/messages` with a JSON body. This endpoint is **inferred** (not directly observed) — use `--dry-run` first.
5. **new-inmail** — POSTs to `/sales-api/salesApiMessagingThreads` with subject, body, and recipients. This endpoint is **inferred** — use `--dry-run` first.
6. **signature** — Calls `GET /sales-api/salesApiInboxSignature/USER_SIGNATURE`.
7. **presence** — Calls `GET /sales-api/salesApiMessagingPresenceStatuses?ids=List(...)` to check online status.

## Data storage

```
~/.local/share/showrun/data/salesnav-messaging/
  session.json                          Session marker (cookies stay in Chrome)
  cache/
    inbox-inbox-<timestamp>.json        Raw inbox listing responses
    inbox-sent-<timestamp>.json         Raw sent listing responses
    thread-<threadId>-<timestamp>.json  Raw thread data
```

## Session expiry

If you get 401/403 errors, re-run auth:

```bash
node salesnav-messaging.mjs auth
```

## Important notes

- The **send** and **new-inmail** endpoints are inferred from API patterns, not directly observed. They may require adjustments to headers or payload format. Always use `--dry-run` first.
- Thread IDs are obtained from the `inbox` command output.
- Profile URNs (for new InMails) come from search results or thread participant data.
- Cursor-based pagination: the first `inbox` call has no `--page` param; subsequent calls use the `nextPageStartsAt` value from the previous response.
