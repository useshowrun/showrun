#!/usr/bin/env node

/**
 * Pitchbook authentication — capture session headers from Chrome (CDP),
 * parse a "Copy as cURL" string from the browser, or automated login via camoufox.
 *
 * Usage:
 *   node pitchbook-login.mjs auth              # CDP capture (preferred)
 *   node pitchbook-login.mjs auth --cdp-url=…  # custom CDP endpoint
 *   node pitchbook-login.mjs curl <file>        # parse curl string from file
 *   node pitchbook-login.mjs curl -             # parse curl string from stdin
 *   node pitchbook-login.mjs auto              # automated camoufox login
 */

import { resolve } from 'path';
import { readFileSync } from 'fs';
import {
  DATA_DIR,
  doCdpAuth,
  parseCurlString,
  saveSession,
  generateTOTP,
  delay,
  parseFlags,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// Import session from a curl string
// ---------------------------------------------------------------------------

function doCurlImport(source) {
  let curlStr;

  if (source === '-') {
    // Read from stdin
    try {
      curlStr = readFileSync('/dev/stdin', 'utf8');
    } catch {
      console.error('Failed to read from stdin.');
      process.exit(1);
    }
  } else {
    // Read from file
    const filePath = resolve(process.cwd(), source);
    try {
      curlStr = readFileSync(filePath, 'utf8');
    } catch {
      console.error(`Cannot read file: ${filePath}`);
      process.exit(1);
    }
  }

  if (!curlStr.trim()) {
    console.error('Empty curl string.');
    process.exit(1);
  }

  const { headers, cookies } = parseCurlString(curlStr);

  if (!cookies) {
    console.error('No cookies found in the curl string — session will likely not work.');
    console.error('Make sure you copied a request to my.pitchbook.com that includes cookies.');
    process.exit(1);
  }

  saveSession(headers, cookies);
  console.log('Session imported from curl string.');

  const headerCount = Object.keys(headers).length;
  const cookieCount = cookies.split(';').filter(s => s.trim()).length;
  console.log(`  Headers: ${headerCount}, Cookies: ${cookieCount}`);
}

// ---------------------------------------------------------------------------
// Automated login via camoufox
// ---------------------------------------------------------------------------

async function doAutoLogin() {
  const EMAIL = process.env.PITCHBOOK_EMAIL;
  const PASSWORD = process.env.PITCHBOOK_PASSWORD;
  const OTP_SECRET = process.env.PITCHBOOK_OTP_SECRET;
  const USERNAME = process.env.PITCHBOOK_USERNAME;

  if (!EMAIL || !PASSWORD || !OTP_SECRET || !USERNAME) {
    console.error('Required env vars: PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD, PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME');
    process.exit(1);
  }

  const { Camoufox } = await import(resolve(DATA_DIR, 'node_modules/camoufox-js/dist/index.js'));

  console.log('Launching camoufox browser...');
  const browser = await Camoufox({ headless: false });

  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    console.log('Navigating to my.pitchbook.com...');
    await page.goto('https://my.pitchbook.com');

    let loginOpened = false;
    for (let i = 0; i < 30; i++) {
      try {
        const inputs = page.locator('input');
        if ((await inputs.count()) >= 2) { loginOpened = true; break; }
      } catch { /* ignore */ }
      await delay(5_000);
    }

    if (!loginOpened) {
      const screenshotPath = resolve(DATA_DIR, 'debug-login.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`Could not find login form after 150s. Screenshot saved to: ${screenshotPath}`);
      process.exit(1);
    }

    await delay(4_000);

    console.log('Typing email...');
    await page.locator('#email').fill(EMAIL);
    await delay(2_000);

    console.log('Typing password...');
    await page.locator('#password').fill(PASSWORD);
    await delay(2_000);

    console.log('Clicking Sign In...');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await delay(5_000);

    const code = await generateTOTP(OTP_SECRET);
    console.log('Entering TOTP code...');
    await page.locator('#code').type(code, { delay: 100 });
    await delay(4_000);

    console.log('Clicking Continue...');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await delay(20_000);

    const bodyText = await page.textContent('body');
    if (!bodyText.includes(USERNAME)) {
      console.error(`Login verification failed — "${USERNAME}" not found on page`);
      process.exit(1);
    }
    console.log('Login verified — found username on page');

    let capturedHeaders = null;
    page.on('request', (request) => {
      if (request.url().includes('web-api/general-search/search/mixed')) {
        capturedHeaders = request.headers();
      }
    });

    console.log('Triggering search to capture headers...');
    const searchInput = page.locator('#general-search-input');
    await searchInput.clear();
    await delay(500);
    await searchInput.type('fal', { delay: 100 });

    for (let i = 0; i < 60; i++) {
      if (capturedHeaders) break;
      await delay(500);
    }

    if (!capturedHeaders) {
      console.error('Failed to capture search request headers');
      process.exit(1);
    }

    delete capturedHeaders['accept-encoding'];
    delete capturedHeaders['content-length'];
    capturedHeaders['dnt'] = '1';

    const browserCookies = await context.cookies('https://my.pitchbook.com');
    const cookieString = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

    saveSession(capturedHeaders, cookieString);
    console.log('Automated login complete');
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;
const { flags, positional } = parseFlags(args);

switch (command) {
  case 'auth': {
    const cdpUrl = flags['cdp-url'] || process.env.CHROME_CDP_URL || 'http://localhost:9222';
    await doCdpAuth(cdpUrl);
    break;
  }
  case 'curl': {
    const source = positional[0];
    if (!source) {
      console.error('Usage:');
      console.error('  node pitchbook-login.mjs curl <file>    # read curl string from file');
      console.error('  node pitchbook-login.mjs curl -         # read from stdin');
      console.error('');
      console.error('How to get the curl string:');
      console.error('  1. Open my.pitchbook.com in Chrome, log in');
      console.error('  2. Open DevTools (F12) → Network tab');
      console.error('  3. Right-click any request to my.pitchbook.com → Copy → Copy as cURL');
      console.error('  4. Save to a file and pass it here, or pipe via stdin');
      process.exit(1);
    }
    doCurlImport(source);
    break;
  }
  case 'auto':
    await doAutoLogin();
    break;
  default:
    console.log(`pitchbook-login

Authenticate with Pitchbook and save session for API access.

Commands:
  auth [--cdp-url=URL]   Capture headers from running Chrome via CDP (preferred, ~10s)
  curl <file>            Import session from a "Copy as cURL" string saved to a file
  curl -                 Import session from a "Copy as cURL" string via stdin
  auto                   Automated login via camoufox (~60-90s)

Auth methods (fastest to slowest):
  1. curl   — Copy any Pitchbook API request as cURL from browser DevTools, paste to file
  2. auth   — Automatic CDP capture from running Chrome (requires --remote-debugging-port)
  3. auto   — Full automated browser login (requires camoufox + env vars)

Prerequisites for auth:
  Chrome launched with: google-chrome --remote-debugging-port=9222
  User is logged into Pitchbook in the browser

Prerequisites for curl:
  1. Open my.pitchbook.com in Chrome and log in
  2. Open DevTools (F12) → Network tab
  3. Right-click any request to my.pitchbook.com → Copy → Copy as cURL
  4. Save to a file: pbpaste > /tmp/pb-curl.txt  (macOS)
  5. Run: node pitchbook-login.mjs curl /tmp/pb-curl.txt

Prerequisites for auto:
  Env vars: PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD, PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME
  npm packages: cd ~/.local/share/showrun/data/pitchbook && npm init -y && npm install camoufox otpauth`);
}
