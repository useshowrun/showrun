# linkedin-msg

Send LinkedIn messages from the terminal. No browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch` and `crypto`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](../chrome-cdp/) skill (only for `auth` step)

## Setup

One-time authentication — extracts session cookies from an open LinkedIn tab in Chrome:

```bash
node scripts/linkedin-msg.mjs auth
```

This saves your LinkedIn session to disk. After auth, Chrome is no longer needed.

## Usage

### Send a message

```bash
# By LinkedIn URL
node scripts/linkedin-msg.mjs send https://linkedin.com/in/emrahyalaz "Hello!"

# By vanity name
node scripts/linkedin-msg.mjs send emrahyalaz "Hello from CLI"

# By profile URN
node scripts/linkedin-msg.mjs send urn:li:fsd_profile:ACoAAAB0OpgBZOZ1m040shN_2CxvGsj7uzP70Dc "Hello!"

# By URN ID (ACoA prefix auto-detected)
node scripts/linkedin-msg.mjs send ACoAAAB0OpgBZOZ1m040shN_2CxvGsj7uzP70Dc "Hello!"
```

### Show help

```bash
node scripts/linkedin-msg.mjs
```

## How it works

1. **`auth`** — Connects to Chrome via CDP, extracts all LinkedIn cookies (including httpOnly `li_at`) using `Network.getCookies`, fetches your own profile URN via the `/me` API, and saves everything locally.

2. **`send`** — Two API calls, no browser:
   - **Resolve profile**: Calls `voyagerIdentityDashProfiles` with the vanity name to get the recipient's `fsd_profile` URN. Skipped if a URN is provided directly.
   - **Send message**: POSTs to `voyagerMessagingDashMessengerMessages?action=createMessage` with `hostRecipientUrns` — LinkedIn auto-finds or creates the conversation thread.

## Data storage

All data is stored in:

```
~/.local/share/showrun/data/linkedin-msg/
├── session.json     # Auth cookies, CSRF token, your profile URN
└── profiles.json    # Cached vanity name → URN mappings
```

- `session.json` contains your LinkedIn session cookies. LinkedIn sessions typically last ~1 year. Re-run `auth` if you get 401/403 errors.
- `profiles.json` caches profile URN lookups so repeated messages to the same person skip the resolve step.

## Session expiry

If you see `Failed (HTTP 401)` or `Failed (HTTP 403)`, your session has expired. Open LinkedIn in Chrome and re-run:

```bash
node scripts/linkedin-msg.mjs auth
```
