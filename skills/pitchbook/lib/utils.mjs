import { resolve } from 'path';
import { execSync } from 'child_process';
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

/**
 * Check that curl is installed and supports HTTP/2.
 * Prints install suggestions and exits if requirements are not met.
 */
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

/**
 * Parse a curl command string (from browser DevTools "Copy as cURL") and
 * extract headers and cookies into a session object.
 *
 * Accepts the raw curl string — handles both single-quoted and double-quoted
 * header values, backslash line continuations, and -b / --cookie flags.
 */
export function parseCurlString(curlStr) {
  // Normalise line continuations
  const normalized = curlStr.replace(/\\\n/g, ' ').replace(/\\\r\n/g, ' ');

  const headers = {};
  let cookies = '';

  // Extract -H / --header values
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

  // Extract -b / --cookie values (separate from -H cookie)
  const cookieRe = /(?:^|\s)(?:-b|--cookie)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
  while ((m = cookieRe.exec(normalized)) !== null) {
    const val = (m[1] || m[2] || m[3] || '').replace(/\\"/g, '"');
    if (val && !val.includes('=') && existsSync(val)) continue; // skip cookie jar files
    if (val) cookies = val;
  }

  // Clean up headers we don't want to replay
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

export function getAuth() {
  const auth = loadJson(SESSION_FILE);
  if (!auth.cookie) {
    console.error('No auth found. Run one of:');
    console.error('  node pitchbook-login/scripts/pitchbook-login.mjs auth     (CDP capture)');
    console.error('  node pitchbook-login/scripts/pitchbook-login.mjs curl     (paste curl from browser)');
    process.exit(1);
  }
  return auth;
}

export function saveSession(headers, cookies) {
  const session = { headers, cookie: cookies, extractedAt: new Date().toISOString() };
  saveJson(SESSION_FILE, session);
  console.log(`Session saved to: ${SESSION_FILE}`);
  return session;
}

// ---------------------------------------------------------------------------
// curl-based HTTP helpers
// ---------------------------------------------------------------------------

function buildCurlHeaders(auth, referer, isPost = false) {
  const h = auth.headers || {};
  const args = [];

  if (h['user-agent']) args.push('-H', `user-agent: ${h['user-agent']}`);
  args.push('-H', 'accept: application/json');
  if (h['accept-language']) args.push('-H', `accept-language: ${h['accept-language']}`);
  if (referer) args.push('-H', `referer: ${referer}`);
  if (h['x-requested-with']) args.push('-H', `x-requested-with: ${h['x-requested-with']}`);

  if (isPost) {
    args.push('-H', 'content-type: application/json');
    args.push('-H', 'origin: https://my.pitchbook.com');
  }

  if (h['alt-used']) args.push('-H', `alt-used: ${h['alt-used']}`);
  if (h['connection']) args.push('-H', `connection: ${h['connection']}`);

  // Cookies
  args.push('-b', auth.cookie);

  // Security headers
  args.push('-H', 'sec-fetch-dest: empty');
  args.push('-H', 'sec-fetch-mode: cors');
  args.push('-H', 'sec-fetch-site: same-origin');
  args.push('-H', 'dnt: 1');

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

function execCurl(args) {
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

  if (statusCode === 401 || statusCode === 403) {
    console.error(`Session expired (HTTP ${statusCode}). Run auth again.`);
    process.exit(1);
  }

  if (body.includes('"loginUrl"') || body.includes('/login')) {
    console.error('Session expired (login redirect). Run auth again.');
    process.exit(1);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { _raw: body, _statusCode: statusCode };
  }
}

export function curlGet(url, auth, referer) {
  const args = [url, ...buildCurlHeaders(auth, referer, false)];
  return execCurl(args);
}

export function curlPost(url, auth, body, referer) {
  const args = [url, ...buildCurlHeaders(auth, referer, true), '--data-raw', JSON.stringify(body)];
  return execCurl(args);
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

export async function cdpConnect(cdpUrl = 'http://localhost:9222') {
  const resp = await fetch(`${cdpUrl}/json`);
  const tabs = await resp.json();

  const tab = tabs.find(t => t.url && t.url.includes('my.pitchbook.com')) || tabs[0];
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new Error('No debuggable tab found via CDP');
  }

  console.log('Connecting to tab:', tab.title || tab.url);

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let msgId = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id !== undefined && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  });

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return { ws, send, tab };
}

export async function doCdpAuth(cdpUrl = 'http://localhost:9222') {
  console.log('Connecting to Chrome CDP at', cdpUrl);

  let connection;
  try {
    connection = await cdpConnect(cdpUrl);
  } catch (err) {
    console.error(`Cannot connect to Chrome CDP at ${cdpUrl}. Is Chrome running with --remote-debugging-port=9222? (${err.message})`);
    process.exit(1);
  }

  const { ws, send, tab } = connection;

  try {
    await send('Network.enable');

    if (!tab.url || !tab.url.includes('my.pitchbook.com')) {
      console.log('No Pitchbook tab found, navigating to my.pitchbook.com');
      await send('Page.navigate', { url: 'https://my.pitchbook.com' });
      await delay(10_000);
    }

    let capturedHeaders = null;

    const headerPromise = new Promise((resolve) => {
      ws.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        if (
          data.method === 'Network.requestWillBeSent' &&
          data.params?.request?.url?.includes('web-api/general-search/search/mixed')
        ) {
          capturedHeaders = data.params.request.headers;
          resolve(capturedHeaders);
        }
      });
    });

    console.log('Triggering search request to capture headers...');

    await send('Runtime.evaluate', {
      expression: `document.querySelector('#general-search-input')?.focus()`,
    });
    await delay(500);

    await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('#general-search-input');
        if (el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true})); }
      })()`,
    });
    await delay(500);

    for (const char of 'fal') {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}`,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`,
      });
      await delay(200);
    }

    const timeoutPromise = delay(30_000).then(() => null);
    const headers = await Promise.race([headerPromise, timeoutPromise]);

    if (!headers) {
      console.error('Timed out waiting for search API request. Is the user logged into Pitchbook?');
      process.exit(1);
    }

    const cookieResult = await send('Network.getCookies', {
      urls: ['https://my.pitchbook.com'],
    });
    const cookies = (cookieResult.result?.cookies || [])
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const cleanHeaders = { ...headers };
    delete cleanHeaders['accept-encoding'];
    delete cleanHeaders['content-length'];
    cleanHeaders['dnt'] = '1';

    saveSession(cleanHeaders, cookies);
    console.log('Headers captured successfully');
  } finally {
    ws.close();
  }
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
