# Pitchbook Login

Authenticate with Pitchbook and capture session headers for API access.

## Methods

### 1. CDP Header Capture (Preferred)

Captures auth headers from a **running Chrome browser** via Chrome DevTools Protocol. The user logs in manually (handling CAPTCHAs, 2FA themselves) and this script grabs the live session.

**Prerequisites:**
- Chrome launched with `--remote-debugging-port=9222`
- User is already logged into Pitchbook in the browser

**Usage:**
```bash
node pitchbook-login/scripts/pitchbook-capture-headers.mjs [--cdp-url http://localhost:9222]
```

**How it works:**
1. Connects to Chrome via CDP
2. Finds a Pitchbook tab (or navigates to one)
3. Types into the search bar to trigger an API request
4. Captures the request headers and cookies
5. Saves session to `~/.pitchbook-session.json`

**Speed:** ~10 seconds

### 2. Automated Login (Fallback)

Full automated login using **camoufox** (anti-detect Firefox). Handles email, password, and TOTP 2FA automatically.

**Prerequisites (env vars):**
- `PITCHBOOK_EMAIL` — login email
- `PITCHBOOK_PASSWORD` — password
- `PITCHBOOK_OTP_SECRET` — TOTP base32 secret for 2FA
- `PITCHBOOK_USERNAME` — display name on Pitchbook (used to verify login success)

**Usage:**
```bash
node pitchbook-login/scripts/pitchbook-login.mjs
```

**Speed:** ~60-90 seconds

## Session Expiry

Captured headers expire after ~30 minutes (Pitchbook aggressively manages sessions). On expiry:
1. Re-run CDP capture if Chrome is still running with a valid Pitchbook session
2. If the browser session is also dead, the user must re-log in manually, then re-run CDP capture
3. Or use the automated login fallback

## Output

Both methods save to `~/.pitchbook-session.json` and emit:
```json
{"success": true, "method": "cdp|automated"}
```

## Error Codes

| Code | Meaning |
|------|---------|
| `CDP_CONNECT_FAILED` | Cannot reach Chrome CDP endpoint |
| `CAPTURE_TIMEOUT` | Search request not intercepted within 30s |
| `MISSING_ENV` | Required environment variables not set |
| `LOGIN_FORM_NOT_FOUND` | Could not find email field on login page |
| `LOGIN_FAILED` | Username not found on page after login |
| `CAPTURE_FAILED` | Could not capture headers from search request |
