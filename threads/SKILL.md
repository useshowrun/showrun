# Threads Scraper

Scrape Threads (threads.net) for profile info, posts, and replies.

## Status: ❌ BLOCKED — requires authenticated session

Threads redirects all profile/post requests to `/login/` for unauthenticated users,
even with camoufox headless Firefox. Both the web API and page navigation are blocked.

### Block details
- Direct HTTP → 302 redirect to threads.com/login/
- camoufox navigation → redirected to threads.com/login/ (returns 200 but shows login page)
- Web API (`/api/graphql`, `/api/v1/`) → 0 results or auth error
- No public anonymous access to profile or post data

### Bypass
Set `THREADS_COOKIE` env var to a valid Threads session cookie:
```
THREADS_COOKIE="sessionid=<your-session-id>; csrftoken=<token>; ds_user_id=<user-id>"
```
Extract from browser DevTools → Application → Cookies → threads.net after logging in.

## Skills

- `threads-profile` — get profile info + recent posts for a username
- `threads-post` — get a single post + replies by URL

## Usage

```bash
THREADS_COOKIE="..." node threads-profile/scripts/threads-profile.mjs zuck --max-posts 10
THREADS_COOKIE="..." node threads-post/scripts/threads-post.mjs "https://www.threads.net/@zuck/post/abc123"
```

## Output format
`RESULT:{json}` on stdout, logs on stderr.
