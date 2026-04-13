# pitchbook-login

Authenticate with Pitchbook and save session for API access.

## Setup

1. Run `node scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, launch the dedicated Chrome instance yourself (see chrome-cdp agent guidance for platform-specific binary names)
3. If the user is not logged in, ask them to open `my.pitchbook.com` in Chrome and log in, then retry

## Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in.

## Agent guidance

1. Try `interactive` first
2. If Chrome not reachable, launch dedicated Chrome (see chrome-cdp agent guidance for platform-specific command)
3. If user not logged in, ask them to log in in the Chrome window, then retry
