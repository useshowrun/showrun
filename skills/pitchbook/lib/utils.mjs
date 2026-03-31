import { resolve, dirname } from 'path';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Data storage
// ---------------------------------------------------------------------------

export const DATA_DIR = resolve(homedir(), '.local/share/showrun/data/pitchbook');
export const SESSION_FILE = resolve(DATA_DIR, 'session.json');
export const CACHE_DIR = resolve(DATA_DIR, 'cache');

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadJson(filePath) {
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function saveJson(filePath, data) {
  ensureDir(resolve(filePath, '..'));
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// curl detection & validation
// ---------------------------------------------------------------------------

const CURL_BINARY = process.env.CURL_BINARY || 'curl';

export function checkCurl() {
  let versionOutput;
  try {
    versionOutput = execSync(`${CURL_BINARY} --version`, { encoding: 'utf8', timeout: 5_000 });
  } catch {
    console.error(`curl not found at "${CURL_BINARY}".`);
    printCurlInstallHelp();
    process.exit(1);
  }

  const firstLine = versionOutput.split('\n')[0] || '';
  const hasHttp2 = /\bHTTP2\b/i.test(versionOutput) || /\bhttp2\b/.test(versionOutput);

  if (!hasHttp2) {
    console.error(`curl found (${firstLine}) but HTTP/2 support is missing.`);
    console.error('Pitchbook requires curl with HTTP/2. Install an updated version:\n');
    printCurlInstallHelp();
    process.exit(1);
  }

  return { binary: CURL_BINARY, version: firstLine };
}

function printCurlInstallHelp() {
  const platform = process.platform;
  if (platform === 'darwin') {
    console.error('  macOS (Homebrew):  brew install curl');
    console.error('  Then set:          export CURL_BINARY=/opt/homebrew/opt/curl/bin/curl');
  } else if (platform === 'linux') {
    console.error('  Debian/Ubuntu:     sudo apt-get install -y curl');
    console.error('  Fedora/RHEL:       sudo dnf install -y curl');
    console.error('  Arch:              sudo pacman -S curl');
  } else {
    console.error('  Install curl with HTTP/2 support for your platform.');
  }
  console.error('\n  Or set CURL_BINARY env var to point to a compatible curl binary.');
}

// ---------------------------------------------------------------------------
// curl string parser (browser "Copy as cURL")
// ---------------------------------------------------------------------------

export function parseCurlString(curlStr) {
  const normalized = curlStr.replace(/\\\n/g, ' ').replace(/\\\r\n/g, ' ');

  const headers = {};
  let cookies = '';

  const headerRe = /(?:^|\s)(?:-H|--header)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m;
  while ((m = headerRe.exec(normalized)) !== null) {
    const val = (m[1] || m[2] || m[3] || '').replace(/\\"/g, '"');
    const colonIdx = val.indexOf(':');
    if (colonIdx === -1) continue;
    const key = val.substring(0, colonIdx).trim().toLowerCase();
    const value = val.substring(colonIdx + 1).trim();
    if (key === 'cookie') {
      cookies = value;
    } else {
      headers[key] = value;
    }
  }

  const cookieRe = /(?:^|\s)(?:-b|--cookie)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
  while ((m = cookieRe.exec(normalized)) !== null) {
    const val = (m[1] || m[2] || m[3] || '').replace(/\\"/g, '"');
    if (val && !val.includes('=') && existsSync(val)) continue;
    if (val) cookies = val;
  }

  delete headers['accept-encoding'];
  delete headers['content-length'];
  headers['dnt'] = '1';

  if (!cookies) {
    console.error('Warning: no cookies found in the curl string. Session may not work.');
  }

  return { headers, cookies };
}

// ---------------------------------------------------------------------------
// Auth / session
// ---------------------------------------------------------------------------

export async function getAuth() {
  // 1. Try cached session.json
  const cached = loadJson(SESSION_FILE);
  if (cached.cookie) {
    return cached;
  }

  // 2. Try CDP auth (connect to Chrome via chrome-cdp)
  console.error('No cached session. Attempting CDP cookie capture...');
  try {
    doCdpAuth();
    const auth = loadJson(SESSION_FILE);
    if (auth.cookie) {
      console.error('Session captured from Chrome via CDP.');
      return auth;
    }
  } catch (e) {
    console.error(`CDP auth failed: ${e.message}`);
  }

  console.error('[AUTH_ERROR] No session found. Run: node pitchbook-login/scripts/pitchbook-login.mjs interactive');
  process.exit(1);
}

export function saveSession(headers, cookies) {
  const session = { headers, cookie: cookies, extractedAt: new Date().toISOString() };
  saveJson(SESSION_FILE, session);
  console.log(`Session saved to: ${SESSION_FILE}`);
  return session;
}

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

  const cookieStr = cookies
    .filter(c => c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr || !cookieStr.includes('SESSION=')) {
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

export function validateSession(auth) {
  try {
    const args = [
      CURL_BINARY,
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

// ---------------------------------------------------------------------------
// curl-based HTTP helpers
// ---------------------------------------------------------------------------

function buildCurlHeaders(auth, referer, isPost = false) {
  const h = auth.headers || {};
  const args = [];

  // Replay all captured headers — matching the reference implementation.
  // Skip headers that are set per-request or handled separately.
  const skipForGet = new Set(['referer', 'content-type', 'origin', 'cookie']);
  const skipForPost = new Set(['cookie']);

  const skip = isPost ? skipForPost : skipForGet;

  for (const [key, value] of Object.entries(h)) {
    if (skip.has(key.toLowerCase())) continue;
    args.push('-H', `${key}: ${value}`);
  }

  // Per-request headers
  if (referer) args.push('-H', `referer: ${referer}`);
  if (isPost) {
    args.push('-H', 'content-type: application/json');
    args.push('-H', 'origin: https://my.pitchbook.com');
  }

  // Cookies — use top-level cookie string
  args.push('-b', auth.cookie);

  // TLS + HTTP/2
  args.push('--tlsv1.3', '--http2');

  return args;
}

function shellQuote(s) {
  if (/[\s'"\\&|;$`!{}()*?<>]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}

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

async function execCurl(args, url, referer, isPost, postBody) {
  const { statusCode, body } = execCurlRaw(args);

  if (statusCode === 401 || statusCode === 403) {
    console.error(`Session expired (HTTP ${statusCode}). Attempting browser cookie refresh...`);
    const extracted = await extractBrowserCookies();
    if (extracted.ok) {
      const newAuth = { headers: extracted.headers, cookie: extracted.cookie, extractedAt: new Date().toISOString(), source: 'browser-retry' };
      const valid = validateSession(newAuth);
      if (valid) {
        saveJson(SESSION_FILE, newAuth);
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
  return execCurl(args, url, referer, false, null);
}

export async function curlPost(url, auth, body, referer) {
  const postBody = JSON.stringify(body);
  const args = [url, ...buildCurlHeaders(auth, referer, true), '--data-raw', postBody];
  return execCurl(args, url, referer, true, postBody);
}

// ---------------------------------------------------------------------------
// CDP integration (chrome-cdp skill, same pattern as LinkedIn skills)
// ---------------------------------------------------------------------------

function findCdpScript() {
  const candidates = [
    resolve(homedir(), '.claude/skills/chrome-cdp/scripts/cdp.mjs'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../chrome-cdp/scripts/cdp.mjs'),
  ];
  return process.env.CDP_SCRIPT || candidates.find(p => existsSync(p))
    || (() => { throw new Error('chrome-cdp skill not found. Install it or set CDP_SCRIPT env var.'); })();
}

export function cdp(...args) {
  return execFileSync('node', [findCdpScript(), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

/**
 * Capture session headers from a running Chrome browser via CDP.
 * Requires Chrome with --remote-debugging-port=9222 and a Pitchbook tab open.
 * Triggers a search request to capture all request headers including auth tokens.
 */
export function doCdpAuth() {
  console.log('Finding Pitchbook tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('my.pitchbook.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }
  if (!target) throw new Error('No Pitchbook tab found. Open my.pitchbook.com in Chrome first.');

  console.log(`Using tab: ${target}`);

  // Enable network interception
  cdp('evalraw', target, 'Network.enable', '{}');

  // Trigger a search by typing into the search bar
  console.log('Triggering search request to capture headers...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => {
      const el = document.querySelector('#general-search-input');
      if (el) { el.focus(); el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true})); }
    })()`,
  }));

  // Type "fal" to trigger search API call
  for (const char of 'fal') {
    cdp('evalraw', target, 'Input.dispatchKeyEvent', JSON.stringify({
      type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}`,
    }));
    cdp('evalraw', target, 'Input.dispatchKeyEvent', JSON.stringify({
      type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`,
    }));
  }

  // Wait and capture — poll for the search request in network logs
  // Since we can't easily listen for events via execFileSync, use getCookies + page headers approach
  // Get cookies via CDP
  const cookieRaw = cdp('evalraw', target, 'Network.getCookies',
    JSON.stringify({ urls: ['https://my.pitchbook.com'] }));
  const { cookies } = JSON.parse(cookieRaw);
  const cookieStr = cookies
    .filter(c => c.domain.includes('pitchbook.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) throw new Error('No cookies found. Is the user logged into Pitchbook?');

  // Get user-agent and other headers by evaluating in page context
  const uaRaw = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: 'navigator.userAgent',
    returnByValue: true,
  }));
  const userAgent = JSON.parse(uaRaw)?.result?.value || '';

  const headers = {
    'user-agent': userAgent,
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.5',
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'dnt': '1',
  };

  saveSession(headers, cookieStr);
  console.log('Headers captured via CDP');
}

// ---------------------------------------------------------------------------
// TOTP (requires otpauth package)
// ---------------------------------------------------------------------------

export async function generateTOTP(base32Secret) {
  const OTPAuth = await import(resolve(DATA_DIR, 'node_modules/otpauth/dist/otpauth.esm.js'));
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) flags[match[1]] = match[2];
    else positional.push(arg);
  }
  return { flags, positional };
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
