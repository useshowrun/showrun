#!/usr/bin/env node

/**
 * Pitchbook authentication via Chrome CDP (preferred), camoufox fallback, or curl import.
 *
 * Usage:
 *   node pitchbook-login.mjs auth                # CDP auto-login (preferred)
 *   node pitchbook-login.mjs curl <file>          # import session from curl string
 *   node pitchbook-login.mjs curl -               # import from stdin
 *   node pitchbook-login.mjs camoufox             # fallback: automated camoufox login
 */

import { resolve } from 'path';
import { readFileSync } from 'fs';
import {
  DATA_DIR,
  cdp,
  doCdpAuth,
  parseCurlString,
  saveSession,
  generateTOTP,
  delay,
  parseFlags,
} from '../../lib/utils.mjs';

// ---------------------------------------------------------------------------
// CDP auto-login: type credentials into Chrome via DevTools Protocol
// ---------------------------------------------------------------------------

async function doCdpLogin() {
  const EMAIL = process.env.PITCHBOOK_EMAIL;
  const PASSWORD = process.env.PITCHBOOK_PASSWORD;
  const OTP_SECRET = process.env.PITCHBOOK_OTP_SECRET;
  const USERNAME = process.env.PITCHBOOK_USERNAME;

  if (!EMAIL || !PASSWORD || !OTP_SECRET || !USERNAME) {
    console.error('Required env vars: PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD, PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME');
    process.exit(1);
  }

  console.log('Finding Pitchbook tab...');
  const list = cdp('list');
  let target;
  for (const line of list.split('\n')) {
    if (line.includes('pitchbook.com')) {
      target = line.trim().split(/\s+/)[0];
      break;
    }
  }

  if (!target) {
    // Use first available tab
    const firstLine = list.split('\n').find(l => l.trim());
    if (firstLine) target = firstLine.trim().split(/\s+/)[0];
  }

  if (!target) {
    console.error('No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?');
    process.exit(1);
  }

  console.log(`Using tab: ${target}`);

  // Navigate to Pitchbook
  console.log('Navigating to my.pitchbook.com...');
  cdp('evalraw', target, 'Page.navigate', JSON.stringify({ url: 'https://my.pitchbook.com' }));
  await delay(10_000);

  // Check if already logged in
  const bodyCheck = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: 'document.body.innerText',
    returnByValue: true,
  }));
  const bodyText = JSON.parse(bodyCheck)?.result?.value || '';

  if (bodyText.includes(USERNAME)) {
    console.log('Already logged in. Capturing headers...');
    doCdpAuth();
    return;
  }

  // Wait for login form
  console.log('Waiting for login form...');
  let formFound = false;
  for (let i = 0; i < 30; i++) {
    const check = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
      expression: 'document.querySelectorAll("input").length',
      returnByValue: true,
    }));
    const count = JSON.parse(check)?.result?.value || 0;
    if (count >= 2) { formFound = true; break; }
    await delay(5_000);
  }

  if (!formFound) {
    // Take screenshot for debugging
    const screenshotResult = cdp('evalraw', target, 'Page.captureScreenshot', JSON.stringify({ format: 'png' }));
    const screenshotData = JSON.parse(screenshotResult)?.data;
    if (screenshotData) {
      const screenshotPath = resolve(DATA_DIR, 'debug-login.png');
      const { writeFileSync: wf } = await import('fs');
      wf(screenshotPath, Buffer.from(screenshotData, 'base64'));
      console.error(`Could not find login form. Screenshot saved to: ${screenshotPath}`);
      console.error('This may be a CAPTCHA. Try: node pitchbook-login.mjs camoufox');
      console.error('Or log in manually and use: node pitchbook-login.mjs curl <file>');
    } else {
      console.error('Could not find login form after 150s.');
      console.error('Try: node pitchbook-login.mjs camoufox');
      console.error('Or log in manually and use: node pitchbook-login.mjs curl <file>');
    }
    process.exit(1);
  }

  await delay(4_000);

  // Type email
  console.log('Typing email...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => { const el = document.querySelector('#email'); if (el) { el.focus(); el.value = ${JSON.stringify(EMAIL)}; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
  }));
  await delay(2_000);

  // Type password
  console.log('Typing password...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => { const el = document.querySelector('#password'); if (el) { el.focus(); el.value = ${JSON.stringify(PASSWORD)}; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
  }));
  await delay(2_000);

  // Click Sign In
  console.log('Clicking Sign In...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In'); if (btn) btn.click(); })()`,
  }));
  await delay(5_000);

  // Check for CAPTCHA or other blockers
  const postClickCheck = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: 'document.body.innerText',
    returnByValue: true,
  }));
  const postClickText = JSON.parse(postClickCheck)?.result?.value || '';

  if (postClickText.toLowerCase().includes('captcha') || postClickText.toLowerCase().includes('verify you are human')) {
    console.error('CAPTCHA detected. CDP login cannot bypass CAPTCHAs.');
    console.error('Try: node pitchbook-login.mjs camoufox');
    console.error('Or log in manually in Chrome, then: node pitchbook-login.mjs curl <file>');
    process.exit(1);
  }

  // Enter TOTP code
  const code = await generateTOTP(OTP_SECRET);
  console.log('Entering TOTP code...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => { const el = document.querySelector('#code'); if (el) { el.focus(); el.value = ${JSON.stringify(code)}; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
  }));
  await delay(4_000);

  // Click Continue
  console.log('Clicking Continue...');
  cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: `(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue'); if (btn) btn.click(); })()`,
  }));
  await delay(20_000);

  // Verify login
  const verifyCheck = cdp('evalraw', target, 'Runtime.evaluate', JSON.stringify({
    expression: 'document.body.innerText',
    returnByValue: true,
  }));
  const verifyText = JSON.parse(verifyCheck)?.result?.value || '';

  if (!verifyText.includes(USERNAME)) {
    console.error(`Login verification failed — "${USERNAME}" not found on page.`);
    console.error('Try: node pitchbook-login.mjs camoufox');
    console.error('Or log in manually and use: node pitchbook-login.mjs curl <file>');
    process.exit(1);
  }

  console.log('Login verified. Capturing headers...');
  doCdpAuth();
}

// ---------------------------------------------------------------------------
// Import session from a curl string
// ---------------------------------------------------------------------------

function doCurlImport(source) {
  let curlStr;

  if (source === '-') {
    try {
      curlStr = readFileSync('/dev/stdin', 'utf8');
    } catch {
      console.error('Failed to read from stdin.');
      process.exit(1);
    }
  } else {
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
// Camoufox fallback (anti-detect browser for CAPTCHA scenarios)
// ---------------------------------------------------------------------------

async function doCamoufoxLogin() {
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
      console.error('Log in manually and use: node pitchbook-login.mjs curl <file>');
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
    page.on('request', async (request) => {
      if (request.url().includes('web-api/general-search/search/mixed')) {
        capturedHeaders = await request.allHeaders();
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
    console.log('Camoufox login complete');
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
  case 'auth':
    await doCdpLogin();
    break;
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
  case 'camoufox':
    await doCamoufoxLogin();
    break;
  default:
    console.log(`pitchbook-login

Authenticate with Pitchbook and save session for API access.

Commands:
  auth                   CDP auto-login via Chrome DevTools Protocol (preferred)
  curl <file>            Import session from a "Copy as cURL" string saved to a file
  curl -                 Import session from a "Copy as cURL" string via stdin
  camoufox               Fallback: automated login via camoufox anti-detect browser

Auth methods (in order of preference):
  1. auth      — Logs in via Chrome CDP (types credentials, handles TOTP automatically)
                 Requires: Chrome with --remote-debugging-port=9222, env vars set
  2. camoufox  — Anti-detect browser login (bypasses some bot detection)
                 Use when auth fails due to CAPTCHA
                 Requires: camoufox + otpauth npm packages in data dir, env vars set
  3. curl      — User logs in manually, copies a request as cURL from DevTools
                 Use when both auth and camoufox fail

Env vars (for auth and camoufox):
  PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD, PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME

npm packages (for camoufox only):
  cd ~/.local/share/showrun/data/pitchbook && npm init -y && npm install camoufox-js otpauth`);
}
