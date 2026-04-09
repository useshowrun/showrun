# pitchbook-login

Authenticate with Pitchbook and save session for API access.

## Setup

### 1. Connect to Chrome

Enable remote debugging in Chrome:
1. Open `chrome://inspect/#remote-debugging` in Chrome
2. Toggle the switch on

**If that doesn't work**, close Chrome and reopen it with:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-pb --no-first-run
```

### 2. Log in and capture session

1. Open `my.pitchbook.com` in Chrome and log in
2. Run:
```bash
node scripts/pitchbook-login.mjs interactive
```

## Session expiry

Sessions expire after ~30 min. If you see `Session expired` or `HTTP 401`, re-run:
```bash
node scripts/pitchbook-login.mjs interactive
```
No re-login needed if Chrome is still logged in to Pitchbook.

## Agent guidance

1. Try `interactive` first
2. If Chrome not reachable, ask user to enable remote debugging at `chrome://inspect/#remote-debugging`
3. If remote debugging toggle doesn't work, ask user to relaunch Chrome with `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-pb`
