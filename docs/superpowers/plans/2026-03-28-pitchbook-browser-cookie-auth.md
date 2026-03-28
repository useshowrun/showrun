# Pitchbook Browser Cookie Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual auth flows with automatic browser cookie extraction — users just log in to Pitchbook in their browser and the skills work.

**Architecture:** `getAuth()` in `lib/utils.mjs` gains a fallback chain: cached session.json → browser cookie extraction → structured error for the agent. `execCurl()` gains auto-retry on 401 (re-extract cookies, retry once). The `@mherod/get-cookie` npm package handles cross-browser, cross-OS cookie extraction.

**Tech Stack:** Node.js 22+, `@mherod/get-cookie` (npm), SQLite (via better-sqlite3, bundled with get-cookie)

---

## File Structure

```
skills/pitchbook/
├── lib/utils.mjs                    # MODIFY — new getAuth(), extractBrowserCookies(), auto-retry
├── pitchbook-login/
│   └── scripts/pitchbook-login.mjs  # MODIFY — add "browser" command
├── SKILL.md                         # MODIFY — simplify setup docs
```

No new files. All changes are modifications to existing files.

---

### Task 1: Install `@mherod/get-cookie` dependency

**Files:**
- Modify: `skills/pitchbook/` (install to data dir)

- [ ] **Step 1: Install the package**

```bash
cd ~/.local/share/showrun/data/pitchbook
npm install @mherod/get-cookie 2>&1
```

Expected: Package installs with `better-sqlite3` (native addon) and other deps. Should complete without errors.

- [ ] **Step 2: Verify it works**

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/skills/pitchbook
node -e "
const { getCookie } = await import('$HOME/.local/share/showrun/data/pitchbook/node_modules/@mherod/get-cookie/dist/index.js');
const cookies = await getCookie({ domain: 'google.com' });
console.log('get-cookie works, found', cookies.length, 'cookies');
"
```

Expected: Prints a count (may be 0 if no Google cookies, but no errors).

- [ ] **Step 3: Commit**

No files to commit — the dependency is in the user's data dir (gitignored), not in the repo.

---

### Task 2: Add `extractBrowserCookies()` and `validateSession()` to utils.mjs

**Files:**
- Modify: `skills/pitchbook/lib/utils.mjs` (add two new functions after `saveSession`)

- [ ] **Step 1: Add `extractBrowserCookies()` function**

Insert after the `saveSession` function (after line 135 in current utils.mjs):

```javascript
// ---------------------------------------------------------------------------
// Browser cookie extraction
// ---------------------------------------------------------------------------

export async function extractBrowserCookies() {
  let getCookie;
  try {
    const mod = await import(resolve(DATA_DIR, 'node_modules/@mherod/get-cookie/dist/index.js'));
    getCookie = mod.getCookie;
  } catch {
    return { ok: false, error: 'BROWSER_EXTRACT_UNAVAILABLE', message: 'Browser cookie extraction not available. Install: cd ~/.local/share/showrun/data/pitchbook && npm install @mherod/get-cookie' };
  }

  let cookies;
  try {
    cookies = await getCookie({ domain: 'pitchbook.com' });
  } catch (err) {
    return { ok: false, error: 'COOKIE_ACCESS_DENIED', message: `Could not read browser cookies: ${err.message}` };
  }

  if (!cookies || cookies.length === 0) {
    return { ok: false, error: 'NO_SESSION', message: '[AUTH_ERROR] NO_SESSION: No Pitchbook session found in any browser. Please log in to my.pitchbook.com in your browser.' };
  }

  // Build cookie string from extracted cookies
  const cookieStr = cookies
    .filter(c => c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) {
    return { ok: false, error: 'NO_SESSION', message: '[AUTH_ERROR] NO_SESSION: Browser cookies found but none had values. Please log in to my.pitchbook.com in your browser.' };
  }

  // Check for critical cookies
  const hasSession = cookieStr.includes('SESSION=');
  if (!hasSession) {
    return { ok: false, error: 'NO_SESSION', message: '[AUTH_ERROR] NO_SESSION: No Pitchbook SESSION cookie found. Please log in to my.pitchbook.com in your browser.' };
  }

  const headers = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.5',
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'dnt': '1',
  };

  return { ok: true, headers, cookie: cookieStr };
}
```

- [ ] **Step 2: Add `validateSession()` function**

Insert right after `extractBrowserCookies`:

```javascript
export function validateSession(auth) {
  try {
    checkCurl();
    const args = [
      'https://my.pitchbook.com/web-api/users/me/general',
      ...buildCurlHeaders(auth, 'https://my.pitchbook.com/dashboard/private', false),
      '-s', '-w', '\n%{http_code}',
    ];
    const cmd = args.map(shellQuote).join(' ');
    const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 15_000 });
    const lines = output.trimEnd().split('\n');
    const statusCode = parseInt(lines.pop(), 10);
    return statusCode >= 200 && statusCode < 400;
  } catch {
    return false;
  }
}
```

Note: `buildCurlHeaders` and `shellQuote` are already defined in utils.mjs (they're module-level functions, not exported but accessible within the file).

- [ ] **Step 3: Test extraction manually**

```bash
cd skills/pitchbook && node -e "
import { extractBrowserCookies } from './lib/utils.mjs';
const result = await extractBrowserCookies();
console.log('ok:', result.ok);
if (result.ok) {
  console.log('cookie length:', result.cookie.length);
  console.log('has SESSION:', result.cookie.includes('SESSION='));
} else {
  console.log('error:', result.error);
  console.log('message:', result.message);
}
"
```

Expected: Either `ok: true` with cookies (if user has Pitchbook open in browser) or `ok: false` with a clear error code.

- [ ] **Step 4: Commit**

```bash
git add skills/pitchbook/lib/utils.mjs
git commit -m "feat: add browser cookie extraction and session validation to pitchbook utils"
```

---

### Task 3: Modify `getAuth()` to auto-extract from browser

**Files:**
- Modify: `skills/pitchbook/lib/utils.mjs` (replace `getAuth` function)

- [ ] **Step 1: Replace `getAuth()` with async version**

Replace the existing `getAuth` function (lines 119-128) with:

```javascript
export async function getAuth() {
  // 1. Try cached session.json first
  const cached = loadJson(SESSION_FILE);
  if (cached.cookie) {
    return cached;
  }

  // 2. Try browser cookie extraction
  console.error('No cached session. Attempting browser cookie extraction...');
  const extracted = await extractBrowserCookies();

  if (!extracted.ok) {
    console.error(extracted.message);
    process.exit(1);
  }

  // 3. Validate the extracted session
  const auth = { headers: extracted.headers, cookie: extracted.cookie, extractedAt: new Date().toISOString(), source: 'browser' };

  console.error('Validating session...');
  const valid = validateSession(auth);
  if (!valid) {
    console.error('[AUTH_ERROR] SESSION_EXPIRED: Browser cookies found but session is expired. Please refresh my.pitchbook.com in your browser and log in again.');
    process.exit(1);
  }

  // 4. Save for future use
  saveJson(SESSION_FILE, auth);
  console.error('Session extracted from browser and saved.');
  return auth;
}
```

- [ ] **Step 2: Update all skill scripts to await getAuth()**

Since `getAuth()` is now async, every call site needs `await`. Search for `getAuth()` in all skill scripts and add `await`:

In each of these files, change `const auth = getAuth();` to `const auth = await getAuth();`:
- `skills/pitchbook/pitchbook-search/scripts/pitchbook-search.mjs`
- `skills/pitchbook/pitchbook-company/scripts/pitchbook-company.mjs`
- `skills/pitchbook/pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs`
- `skills/pitchbook/pitchbook-mna-comps/scripts/pitchbook-mna-comps.mjs`
- `skills/pitchbook/pitchbook-investors/scripts/pitchbook-investors.mjs`
- `skills/pitchbook/pitchbook-valuations/scripts/pitchbook-valuations.mjs`
- `skills/pitchbook/pitchbook-hover/scripts/pitchbook-hover.mjs`
- `skills/pitchbook/pitchbook-market-maps/scripts/pitchbook-market-maps.mjs`
- `skills/pitchbook/pitchbook-advanced-search/scripts/pitchbook-advanced-search.mjs`

For each file: `const auth = getAuth();` → `const auth = await getAuth();`

Also make the wrapping function async if it isn't already. For example in pitchbook-search.mjs, `function doSearch(...)` → `async function doSearch(...)`.

- [ ] **Step 3: Test the full flow**

```bash
cd skills/pitchbook
# Delete cached session to force browser extraction
rm -f ~/.local/share/showrun/data/pitchbook/session.json

# Run a skill — should auto-extract from browser
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 2>&1
```

Expected: Prints "No cached session. Attempting browser cookie extraction..." then "Validating session..." then "Session extracted from browser and saved." then the SpaceX hover card data.

If no browser session exists, it should print the `[AUTH_ERROR] NO_SESSION` message and exit.

- [ ] **Step 4: Test with cached session (second run)**

```bash
# Run again — should use cached session.json (no extraction message)
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 2>&1
```

Expected: No extraction messages — goes straight to the API call.

- [ ] **Step 5: Commit**

```bash
git add skills/pitchbook/lib/utils.mjs skills/pitchbook/pitchbook-*/scripts/*.mjs
git commit -m "feat: getAuth() auto-extracts browser cookies when session.json missing"
```

---

### Task 4: Add auto-retry on 401 in `execCurl()`

**Files:**
- Modify: `skills/pitchbook/lib/utils.mjs` (replace `execCurl`, `curlGet`, `curlPost`)

- [ ] **Step 1: Replace `execCurl()` with retry-aware version**

Replace the existing `execCurl` function (lines 180-209) and the `curlGet`/`curlPost` functions with:

```javascript
function execCurlRaw(args) {
  const fullArgs = [CURL_BINARY, ...args, '-s', '-w', '\n%{http_code}'];
  const cmd = fullArgs.map(shellQuote).join(' ');

  const output = execSync(cmd, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 60_000,
  });

  const lines = output.trimEnd().split('\n');
  const statusCode = parseInt(lines.pop(), 10);
  const body = lines.join('\n');

  return { statusCode, body };
}

function parseResponse(body) {
  if (body.includes('"loginUrl"') || body.includes('/login')) {
    return { _sessionExpired: true };
  }
  try {
    return JSON.parse(body);
  } catch {
    return { _raw: body };
  }
}

// Auth state held in module scope for retry
let _currentAuth = null;

export function setCurrentAuth(auth) {
  _currentAuth = auth;
}

async function execCurl(args, auth, url, referer, isPost, postBody) {
  const { statusCode, body } = execCurlRaw(args);

  // If 401/403, attempt auto-retry with fresh browser cookies
  if (statusCode === 401 || statusCode === 403) {
    console.error(`Session expired (HTTP ${statusCode}). Attempting browser cookie refresh...`);

    const extracted = await extractBrowserCookies();
    if (extracted.ok) {
      const newAuth = { headers: extracted.headers, cookie: extracted.cookie, extractedAt: new Date().toISOString(), source: 'browser-retry' };
      const valid = validateSession(newAuth);

      if (valid) {
        // Save new session and retry
        saveJson(SESSION_FILE, newAuth);
        _currentAuth = newAuth;
        console.error('Session refreshed. Retrying request...');

        const retryArgs = isPost
          ? [url, ...buildCurlHeaders(newAuth, referer, true), '--data-raw', postBody]
          : [url, ...buildCurlHeaders(newAuth, referer, false)];
        const retry = execCurlRaw(retryArgs);

        if (retry.statusCode === 401 || retry.statusCode === 403) {
          console.error('[AUTH_ERROR] SESSION_EXPIRED: Session still expired after refresh. Please log in to my.pitchbook.com in your browser.');
          process.exit(1);
        }

        const parsed = parseResponse(retry.body);
        if (parsed._sessionExpired) {
          console.error('[AUTH_ERROR] SESSION_EXPIRED: Login redirect detected. Please log in to my.pitchbook.com in your browser.');
          process.exit(1);
        }
        return parsed;
      }
    }

    console.error('[AUTH_ERROR] SESSION_EXPIRED: Could not refresh session. Please log in to my.pitchbook.com in your browser.');
    process.exit(1);
  }

  const parsed = parseResponse(body);
  if (parsed._sessionExpired) {
    console.error('[AUTH_ERROR] SESSION_EXPIRED: Login redirect detected. Please log in to my.pitchbook.com in your browser.');
    process.exit(1);
  }

  return parsed;
}

export async function curlGet(url, auth, referer) {
  const args = [url, ...buildCurlHeaders(auth, referer, false)];
  return execCurl(args, auth, url, referer, false, null);
}

export async function curlPost(url, auth, body, referer) {
  const postBody = JSON.stringify(body);
  const args = [url, ...buildCurlHeaders(auth, referer, true), '--data-raw', postBody];
  return execCurl(args, auth, url, referer, true, postBody);
}
```

- [ ] **Step 2: Update all call sites to await curlGet/curlPost**

Since `curlGet` and `curlPost` are now async, update all callers. In each skill script, add `await` before `curlGet(...)` and `curlPost(...)` calls. Also make the parent functions async if not already.

Files to update (same 9 scripts as Task 3 step 2):
- `pitchbook-search.mjs`: `curlPost(...)` → `await curlPost(...)`
- `pitchbook-company.mjs`: `curlGet(...)` → `await curlGet(...)`
- `pitchbook-deal-feed.mjs`: `curlPost(...)` → `await curlPost(...)`
- `pitchbook-mna-comps.mjs`: `curlGet(...)` → `await curlGet(...)`
- `pitchbook-investors.mjs`: `curlPost(...)` → `await curlPost(...)`
- `pitchbook-valuations.mjs`: `curlPost(...)` → `await curlPost(...)`
- `pitchbook-hover.mjs`: `curlGet(...)` → `await curlGet(...)`
- `pitchbook-market-maps.mjs`: `curlPost(...)` → `await curlPost(...)`
- `pitchbook-advanced-search.mjs`: both `curlGet(...)` and `curlPost(...)` → `await`

- [ ] **Step 3: Test auto-retry**

```bash
cd skills/pitchbook

# Corrupt the session to simulate expiry
node -e "
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
const f = homedir() + '/.local/share/showrun/data/pitchbook/session.json';
const s = JSON.parse(readFileSync(f, 'utf8'));
s.cookie = 'SESSION=expired; cf_clearance=invalid';
writeFileSync(f, JSON.stringify(s, null, 2));
console.log('Session corrupted');
"

# Run a skill — should auto-retry with browser cookies
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 2>&1
```

Expected: "Session expired (HTTP 401). Attempting browser cookie refresh..." → "Session refreshed. Retrying request..." → SpaceX data.

- [ ] **Step 4: Commit**

```bash
git add skills/pitchbook/lib/utils.mjs skills/pitchbook/pitchbook-*/scripts/*.mjs
git commit -m "feat: auto-retry on 401 with browser cookie re-extraction"
```

---

### Task 5: Add `browser` command to pitchbook-login.mjs

**Files:**
- Modify: `skills/pitchbook/pitchbook-login/scripts/pitchbook-login.mjs`

- [ ] **Step 1: Add the browser command**

In the CLI switch statement (around line 347), add a new case before `default`:

```javascript
  case 'browser': {
    const { extractBrowserCookies, validateSession, saveSession } = await import('../../lib/utils.mjs');
    console.log('Extracting Pitchbook session from browser cookies...');
    const result = await extractBrowserCookies();
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    const auth = { headers: result.headers, cookie: result.cookie, extractedAt: new Date().toISOString(), source: 'browser' };
    console.log('Validating session...');
    const valid = validateSession(auth);
    if (!valid) {
      console.error('Browser cookies found but session is expired.');
      console.error('Please refresh my.pitchbook.com in your browser and log in again.');
      process.exit(1);
    }
    saveSession(result.headers, result.cookie);
    console.log('Browser cookie extraction complete.');
    break;
  }
```

- [ ] **Step 2: Update the help text**

In the `default` case, update the help text to show `browser` as the first (recommended) method:

```javascript
  default:
    console.log(`pitchbook-login

Authenticate with Pitchbook and save session for API access.

Commands:
  browser                Extract session from browser cookies (recommended)
  auth                   CDP auto-login via Chrome DevTools Protocol
  curl <file>            Import session from a "Copy as cURL" string
  curl -                 Import from stdin
  camoufox               Automated login via camoufox anti-detect browser

Auth methods (in order of preference):
  1. browser   — Extracts cookies from your browser (Firefox, Chrome, etc.)
                 Requires: User logged in to my.pitchbook.com in their browser
  2. auth      — Logs in via Chrome CDP (types credentials, handles TOTP)
                 Requires: Chrome with --remote-debugging-port=9222, env vars set
  3. camoufox  — Anti-detect browser login (bypasses some bot detection)
                 Requires: camoufox + otpauth npm packages, env vars set
  4. curl      — User logs in manually, copies request as cURL from DevTools

npm packages (for browser extraction):
  cd ~/.local/share/showrun/data/pitchbook && npm install @mherod/get-cookie

npm packages (for camoufox only):
  cd ~/.local/share/showrun/data/pitchbook && npm install camoufox-js otpauth`);
```

- [ ] **Step 3: Test the browser command**

```bash
cd skills/pitchbook
node pitchbook-login/scripts/pitchbook-login.mjs browser 2>&1
```

Expected: "Extracting Pitchbook session from browser cookies..." → "Validating session..." → "Session saved to: ..." or error if no browser session.

- [ ] **Step 4: Commit**

```bash
git add skills/pitchbook/pitchbook-login/scripts/pitchbook-login.mjs
git commit -m "feat: add 'browser' command to pitchbook-login for cookie extraction"
```

---

### Task 6: Update SKILL.md documentation

**Files:**
- Modify: `skills/pitchbook/SKILL.md`
- Modify: `skills/pitchbook/pitchbook-login/SKILL.md`

- [ ] **Step 1: Update parent SKILL.md setup section**

Replace the current Setup section (everything from `## Setup` up to `### Loading environment variables`) with:

```markdown
## Setup

### Recommended: Browser cookies (zero setup)

Just log in to [my.pitchbook.com](https://my.pitchbook.com) in your browser. The skills will automatically extract your session cookies. No configuration needed.

If a skill reports that no session was found, ask the user to log in to Pitchbook in their browser and try again.

**One-time dependency install:**
```bash
cd ~/.local/share/showrun/data/pitchbook && npm install @mherod/get-cookie
```

### Alternative: Explicit authentication

For power users, headless environments, or when browser cookie extraction isn't available:

#### Method 1: Browser cookie extraction (explicit)

```bash
node pitchbook-login/scripts/pitchbook-login.mjs browser
```

#### Method 2: CDP auto-login

Requires Chrome with CDP and env vars set. Fully automated — types credentials and handles TOTP:

```bash
google-chrome --remote-debugging-port=9222
node pitchbook-login/scripts/pitchbook-login.mjs auth
```

#### Method 3: Camoufox (if CAPTCHA blocks CDP)

```bash
node pitchbook-login/scripts/pitchbook-login.mjs camoufox
```

#### Method 4: Copy as cURL (manual fallback)

```bash
node pitchbook-login/scripts/pitchbook-login.mjs curl /tmp/pb-curl.txt
```

**Agent guidance:** Skills automatically extract browser cookies — no auth commands needed in normal use. If auto-extraction fails, ask the user to log in to my.pitchbook.com in their browser and let you know when they're done, then retry. Only use explicit auth commands (browser, auth, camoufox, curl) as fallbacks.
```

Keep the rest of the parent SKILL.md unchanged (Loading environment variables, Environment variables table, Available skills, etc.).

- [ ] **Step 2: Update pitchbook-login SKILL.md**

Read `skills/pitchbook/pitchbook-login/SKILL.md` and add the `browser` command as the first method documented, before `auth`.

- [ ] **Step 3: Commit**

```bash
git add skills/pitchbook/SKILL.md skills/pitchbook/pitchbook-login/SKILL.md
git commit -m "docs: update auth docs to recommend browser cookie extraction"
```

---

### Task 7: End-to-end test

- [ ] **Step 1: Clean slate test**

```bash
cd skills/pitchbook

# Remove cached session
rm -f ~/.local/share/showrun/data/pitchbook/session.json

# Run deal-feed — should auto-extract from browser
node pitchbook-deal-feed/scripts/pitchbook-deal-feed.mjs feed --limit=2 2>&1
sleep 8

# Run hover — should use cached session (no extraction)
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 2>&1
sleep 8

# Run investors — should use cached session
node pitchbook-investors/scripts/pitchbook-investors.mjs active --days=30 2>&1
```

Expected: First call shows extraction messages, subsequent calls go straight to API.

- [ ] **Step 2: Test auto-retry**

```bash
# Corrupt session
node -e "
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
const f = homedir() + '/.local/share/showrun/data/pitchbook/session.json';
const s = JSON.parse(readFileSync(f, 'utf8'));
s.cookie = 'SESSION=expired';
writeFileSync(f, JSON.stringify(s, null, 2));
"

# Run skill — should auto-retry
node pitchbook-valuations/scripts/pitchbook-valuations.mjs multiples 2>&1
```

Expected: "Session expired (HTTP 401). Attempting browser cookie refresh..." → succeeds.

- [ ] **Step 3: Test no-session error**

```bash
# Remove session AND ensure no browser cookies (close browser or use a domain with no cookies)
rm -f ~/.local/share/showrun/data/pitchbook/session.json

# This should fail gracefully with AUTH_ERROR message
node pitchbook-hover/scripts/pitchbook-hover.mjs get 46488-07 2>&1
```

Expected: `[AUTH_ERROR] NO_SESSION: No Pitchbook session found in any browser. Please log in to my.pitchbook.com in your browser.`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify browser cookie auth end-to-end"
```

---

## Testing Protocol

For each test:
1. **Wait 8 seconds** between API calls
2. **Check stderr** for auth messages (extraction, validation, retry)
3. **Verify cache files** are written to `~/.local/share/showrun/data/pitchbook/cache/`
4. **If no browser session available**, test that error messages are clear and actionable
