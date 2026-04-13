# Pitchbook Browser Cookie Auth

## Problem

Current Pitchbook auth requires technical setup: editing `.env` files with credentials, running camoufox/CDP login commands, managing session expiry manually. Non-technical users (e.g., a financial advisor) can't use the skills without developer assistance.

## Solution

Extract Pitchbook session cookies directly from the user's browser. The user logs in to my.pitchbook.com in their normal browser — the skills automatically find and use that session. No credentials, no commands, no config files.

## Auth Flow

```
Agent calls skill
  → getAuth() checks session.json (cached session)
    → Valid? Use it.
    → Missing/expired?
      → extractBrowserCookies("pitchbook.com")
        → Found valid cookies? Save to session.json, use them.
        → No cookies found?
          → Return { error: "NO_SESSION", message: "..." }
          → Agent asks user: "Please log in to my.pitchbook.com in your browser and let me know when you're done"
          → User says "done"
          → Agent retries → getAuth() extracts fresh cookies → works
```

## Cookie Extraction

### Method

Use the `@mherod/get-cookie` npm package. It handles:
- Firefox (plain SQLite, no encryption)
- Chrome/Chromium (AES encryption with OS keyring)
- Brave, Edge, Vivaldi (same as Chrome)
- Safari (macOS Keychain)
- Cross-platform: Linux, macOS, Windows

### What We Extract

From the browser's cookie store, filter for `domain = pitchbook.com`:

**Required cookies:**
- `SESSION` — Java session ID (the primary auth token)
- `cf_clearance` — Cloudflare WAF clearance

**Also captured (if present):**
- `auth0` / `auth0_compat` — Auth0 SSO token
- `pbCust` — Customer identifier
- `did` / `did_compat` — Device identifier
- `__cf_bm` — Cloudflare bot management
- `place_id`, `sourceType` — Tracking cookies

### Session Construction

After extracting cookies, build session.json:

```json
{
  "headers": {
    "user-agent": "<from browser or sensible default>",
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.5",
    "x-requested-with": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "dnt": "1"
  },
  "cookie": "SESSION=...; cf_clearance=...; ...",
  "extractedAt": "2026-03-28T...",
  "source": "browser"
}
```

The `user-agent` should match the browser the cookies came from. The `@mherod/get-cookie` package or browser detection can provide this. Alternatively, use the user-agent from the most recent Chrome/Firefox version as a sensible default.

### Session Validation

After extracting cookies, validate with a cheap API call:

```
GET /web-api/users/me/general
```

- 200 → session is valid, save and proceed
- 401/403 → cookies are expired, return NO_SESSION error

This prevents saving stale cookies that would fail on the actual request.

## Auto-Retry on 401

When any `curlGet` or `curlPost` call returns 401/403, instead of `process.exit(1)`:

1. Attempt browser cookie re-extraction
2. If new valid cookies found → retry the failed request once
3. If still failing → return structured error for the agent to handle

This handles mid-operation session expiry transparently.

### Implementation in utils.mjs

```
execCurl(args)
  → HTTP 401/403?
    → extractBrowserCookies()
    → Validate new session
    → If valid: update auth in memory, retry request
    → If invalid: throw SessionExpiredError (not process.exit)
```

## Error Handling

Scripts no longer call `process.exit(1)` for auth failures. Instead, they output structured messages that an AI agent can act on:

| Error Code | When | Agent Action |
|------------|------|-------------|
| `NO_SESSION` | No browser cookies found | Ask user to log in to my.pitchbook.com |
| `SESSION_EXPIRED` | Cookies exist but 401 on validation | Ask user to refresh their Pitchbook tab |
| `BROWSER_NOT_FOUND` | No supported browser installed | Tell user which browsers are supported |
| `COOKIE_ACCESS_DENIED` | OS permissions block cookie reading | Guide user through permissions |

Output format (stderr):
```
[AUTH_ERROR] NO_SESSION: No Pitchbook session found in any browser. Please log in to my.pitchbook.com in your browser.
```

## What Changes

### `lib/utils.mjs`

- `getAuth()` → tries session.json first, then browser cookie extraction, returns structured errors instead of `process.exit(1)`
- `extractBrowserCookies(domain)` → new function, uses `@mherod/get-cookie`
- `validateSession(auth)` → new function, tests session with cheap API call
- `execCurl()` → catches 401, attempts auto-retry with fresh cookies
- `saveSession()` → unchanged

### `pitchbook-login/scripts/pitchbook-login.mjs`

- Add `browser` command for explicit cookie extraction (agent can call it)
- Existing `auth`, `camoufox`, `curl` commands remain as developer tools
- Default (no args) help text updated to recommend browser method

### All skill scripts

- No changes needed — they call `getAuth()` which handles everything
- They should handle the new error return gracefully (not crash on structured error)

### New dependency

- `@mherod/get-cookie` installed in the pitchbook data directory or as a project dependency

### SKILL.md updates

- Parent SKILL.md: simplify Setup section to "Log in to my.pitchbook.com in your browser. That's it."
- Remove .env setup instructions from the critical path (move to "Developer options" section)
- Remove camoufox/CDP from the primary workflow

## What Doesn't Change

- `curlGet`, `curlPost` — same interface, same curl-based HTTP
- Session.json format — same structure, just populated differently
- Cache files — same paths, same format
- All 10 skill scripts — completely untouched

## Security

- No credentials stored anywhere — no .env, no config files
- No credentials pass through the AI agent's context
- Cookies are read-only from the browser's own store
- session.json has the same security posture as before (local file with cookies)
- Browser cookie databases are already accessible to the local user

## Constraints

- User must have Pitchbook open in a browser on the same machine
- Browser should ideally be closed when reading cookies (Firefox WAL lock), OR the package handles this
- Session still expires in ~30 minutes — auto-retry handles this transparently
- If user logs out of Pitchbook in browser, cookies become invalid

## Testing Plan

1. Log in to Pitchbook in Firefox → run any skill → should work without setup
2. Log in to Pitchbook in Chrome → same test
3. No browser session → skill should output NO_SESSION message
4. Session expires mid-operation → auto-retry should re-extract and continue
5. Test on Linux, macOS (if available)
