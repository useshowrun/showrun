# Instagram Session Manager

Manages a persistent camoufox browser session for Instagram.
All other Instagram skills read cookies from `~/.instagram-session.json`.

## How It Works

```
Browser cookies (from Chrome) 
  → instagram-seed-session.mjs  (inject into camoufox profile, one-time)
  → instagram-persistent-session.mjs  (keep session alive, refresh cookies)
  → ~/.instagram-session.json  (all other scripts read from here)
```

## Setup (One-Time)

### 1. Get fresh cookies from Chrome
Log into Instagram in Chrome, open DevTools → Network → any request → Copy as cURL.
Save the cookie string to `~/.openclaw/secrets/instagram-session.json`:
```json
{
  "username": "curiosity.byte",
  "cookies": [
    {"name": "sessionid", "value": "...", "domain": ".instagram.com", "path": "/"},
    {"name": "csrftoken", "value": "...", "domain": ".instagram.com", "path": "/"},
    {"name": "ds_user_id", "value": "...", "domain": ".instagram.com", "path": "/"},
    {"name": "mid", "value": "...", "domain": ".instagram.com", "path": "/"}
  ]
}
```

### 2. Seed the camoufox profile
```bash
node instagram-session-manager/scripts/instagram-seed-session.mjs
```
This injects the cookies into `~/.instagram-browser-profile/` (fixed fingerprint).

### 3. Start the persistent session
```bash
node instagram-session-manager/scripts/instagram-persistent-session.mjs
```
Runs in foreground. Refreshes `~/.instagram-session.json` every 5 minutes.
Keep it running in a tmux/screen session.

## Session Expiry
Instagram sessions last ~90 days. If the session expires:
1. Get fresh cookies from Chrome again
2. Re-run `instagram-seed-session.mjs`
3. Restart `instagram-persistent-session.mjs`

## Env Vars
| Var | Default | Description |
|-----|---------|-------------|
| `IG_PROFILE_DIR` | `~/.instagram-browser-profile` | Camoufox profile directory |
| `IG_SESSION_FILE` | `~/.instagram-session.json` | Output session file |
| `IG_REFRESH_INTERVAL` | `300000` (5 min) | Cookie refresh interval (ms) |
| `IG_USERNAME` | `curiosity.byte` | Username for session metadata |
