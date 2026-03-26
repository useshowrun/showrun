# reddit-subreddit

Fetch subreddit info, rules, wiki pages, moderators, and manage subscriptions from the terminal. All API-based -- no browser needed after initial auth.

## Prerequisites

- Node.js 22+ (uses built-in `fetch`)
- Chrome with remote debugging enabled (only for `auth` step)
- [chrome-cdp](https://github.com/nichochar/cdp-taskpacks/tree/main/skills/chrome-cdp) skill (only for `auth` step)

## Setup

One-time authentication -- extracts cookies from an open Reddit tab in Chrome:

```bash
node scripts/reddit-subreddit.mjs auth
```

This saves your cookies to disk. After auth, Chrome is no longer needed for read commands.

## Usage

### View subreddit info

```bash
node scripts/reddit-subreddit.mjs about programming
node scripts/reddit-subreddit.mjs about AskReddit
```

Shows: display name, title, description, subscriber count, active users, creation date, NSFW status, type, language, icon/banner URLs.

### View rules

```bash
node scripts/reddit-subreddit.mjs rules programming
node scripts/reddit-subreddit.mjs rules AskReddit
```

Numbered list of subreddit rules with short name, description, applicability (link/comment/all), and violation reason.

### View wiki

```bash
node scripts/reddit-subreddit.mjs wiki python index
node scripts/reddit-subreddit.mjs wiki python faq
node scripts/reddit-subreddit.mjs wiki learnprogramming
```

Returns wiki page content in Markdown (truncated to 2000 chars if longer), last editor, and revision date. Default page is `index`.

### List moderators

```bash
node scripts/reddit-subreddit.mjs moderators linux
node scripts/reddit-subreddit.mjs moderators programming
```

Shows each moderator's username, permissions, and date they became a mod.

### Search subreddits

```bash
node scripts/reddit-subreddit.mjs search "machine learning"
node scripts/reddit-subreddit.mjs search python --limit=20
```

Uses autocomplete for quick lookups (default). Pass `--limit` greater than 10 to use full search endpoint with more results.

### Subscribe / Unsubscribe

```bash
node scripts/reddit-subreddit.mjs subscribe programming
node scripts/reddit-subreddit.mjs unsubscribe funny
```

Requires auth. Obtains a bearer token via the shreddit token endpoint, then calls the OAuth subscribe API.

### Show help

```bash
node scripts/reddit-subreddit.mjs
```

## How it works

1. **`auth`** -- Connects to Chrome via CDP, finds a Reddit tab, extracts all reddit.com cookies and the CSRF token, saves to disk.

2. **`about`** -- Fetches `/r/{name}/about.json?raw_json=1` (public). Returns the t5 subreddit object with metadata, subscriber count, and active users.

3. **`rules`** -- Fetches `/r/{name}/about/rules.json?raw_json=1` (public). Returns an array of rule objects with short name, description, kind, and violation reason.

4. **`wiki`** -- Fetches `/r/{name}/wiki/{page}.json?raw_json=1` (public). Returns Markdown content, revision date, and last editor. Truncates output to 2000 chars.

5. **`moderators`** -- Fetches `/r/{name}/about/moderators.json?raw_json=1` (public). Returns a listing of t2 users with mod permissions and start date.

6. **`search`** -- Uses `/api/subreddit_autocomplete_v2.json` for quick lookups or `/search.json?type=sr` for larger result sets. Both are public endpoints.

7. **`subscribe`** / **`unsubscribe`** -- Obtains a JWT bearer token via `POST /svc/shreddit/token` using the stored CSRF token, then calls `POST https://oauth.reddit.com/api/subscribe` with `action=sub` or `action=unsub`.

## Data storage

```
~/.local/share/showrun/data/reddit-subreddit/
├── session.json                     # Auth cookies + CSRF token
└── cache/
    ├── about-{name}.json            # Subreddit metadata
    ├── rules-{name}.json            # Subreddit rules
    ├── wiki-{name}-{page}.json      # Wiki page content
    ├── moderators-{name}.json       # Moderator list
    ├── search-{slug}.json           # Autocomplete results
    └── search-{slug}-full.json      # Full search results
```

## Auth vs public endpoints

- **Public (no auth)**: `about`, `rules`, `wiki`, `moderators`, `search`
- **Auth required**: `subscribe`, `unsubscribe`

Public endpoints work without any stored session. Only subscription management needs the cookie + bearer token flow.

## Session expiry

If subscribe/unsubscribe fails with `Auth failed (HTTP 401)`, your session has expired. Open Reddit in Chrome and re-run:

```bash
node scripts/reddit-subreddit.mjs auth
```
