# pitchbook-login

Authenticate with Pitchbook and save session for API access.

## Setup

1. Run `node scripts/pitchbook-login.mjs interactive`
2. If CDP connection fails, launch Chrome yourself with `https://my.pitchbook.com` as the initial URL (see chrome-cdp agent guidance for platform-specific binary names)
3. If CDP is connected but no PitchBook tab is open: `node skills/chrome-cdp/scripts/cdp.mjs open https://my.pitchbook.com`
4. If the user is not logged in, ask them to log in in the Chrome window, then retry

## Session expiry

Sessions expire after ~30 min. Re-run `interactive` on `Session expired` or `HTTP 401`. No re-login needed if Chrome is still logged in.

## Agent guidance

1. Try `interactive` first
2. If Chrome not reachable, launch Chrome with the PitchBook URL as the initial tab (see chrome-cdp agent guidance)
3. If Chrome is running but no PitchBook tab, run `cdp.mjs open https://my.pitchbook.com`
4. If user not logged in, ask them to log in in the Chrome window, then retry
