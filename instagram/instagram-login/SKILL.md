# Instagram Login Skill

Authenticates with Instagram using camoufox-js (anti-detect Firefox) and saves session cookies for all other Instagram scrapers to use.

## Usage

```bash
# Fully automatic (recommended) — needs 5sim API key:
FIVESIM_API_KEY=your_key node instagram-login/scripts/instagram-login.mjs

# With existing credentials:
IG_USERNAME=myuser IG_PASSWORD=mypass node instagram-login/scripts/instagram-login.mjs

# Load from secrets file:
source ~/.openclaw/secrets/5sim.env && node instagram-login/scripts/instagram-login.mjs
```

## How It Works

### Strategy 1: Auto-Registration + 5sim SMS
Attempts to create a fresh Instagram account fully automatically:
1. Navigate to `/accounts/emailsignup/`
2. Fill in generated credentials (email, username, password)
3. When phone verification is hit — uses 5sim API to get a virtual number
4. Submits the number, waits for SMS, extracts and enters the code
5. Saves credentials + session cookies on success

**Required:** `FIVESIM_API_KEY` (from https://5sim.net — costs ~$0.10-0.20 per number)

### Strategy 2: Credential Login
Falls back to `IG_USERNAME` / `IG_PASSWORD` env vars:
1. Navigate to `/accounts/login/`
2. Fill credentials
3. Wait for redirect
4. Capture session cookies

**Required:** `IG_USERNAME` and `IG_PASSWORD` must be set.

## Output

On **success:**
```json
{
  "success": true,
  "username": "myuser",
  "cookieCount": 12,
  "sessionFile": "/home/user/.instagram-session.json"
}
```

On **failure/blocked:**
```json
{
  "error": true,
  "code": "BLOCKED",
  "message": "... explanation and instructions ...",
  "instructions": { "step1": "...", "step2": "...", "step3": "..." }
}
```

## Session File

Cookies are saved to `~/.instagram-session.json`. All other Instagram scrapers load from this file automatically (priority: `IG_COOKIES` env → session file → logged-out mode).

## Setting Up 5sim (Recommended)

1. Sign up at https://5sim.net
2. Top up a few dollars (each number costs ~$0.10-0.20)
3. Get API key from dashboard
4. Save to secrets:
```bash
echo "FIVESIM_API_KEY=your_key_here" > ~/.openclaw/secrets/5sim.env
chmod 600 ~/.openclaw/secrets/5sim.env
```
5. Run:
```bash
source ~/.openclaw/secrets/5sim.env && node instagram-login/scripts/instagram-login.mjs
```

## Setting Up Manual Credentials

After creating an Instagram account manually, save credentials:

```bash
cat > ~/.openclaw/secrets/instagram.env << 'EOF'
IG_USERNAME=yourusername
IG_PASSWORD=yourpassword
EOF
chmod 600 ~/.openclaw/secrets/instagram.env
```

Then run the login skill:
```bash
source ~/.openclaw/secrets/instagram.env && node instagram-login/scripts/instagram-login.mjs
```

## Session Expiry

Instagram sessions last approximately 90 days. The session file is considered valid for 30 days before warnings are shown. If you get `SESSION_EXPIRED` errors from other scrapers, re-run this script.
