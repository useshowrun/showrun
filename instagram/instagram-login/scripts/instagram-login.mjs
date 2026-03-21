#!/usr/bin/env node

/**
 * Instagram Login Skill
 *
 * Authenticates with Instagram using camoufox-js and saves session cookies
 * to ~/.instagram-session.json for use by other Instagram scrapers.
 *
 * Strategy:
 *  1. Try to create a fresh Instagram account automatically (emailsignup flow)
 *  2. If auto-registration fails (phone verification, CAPTCHA, etc.):
 *     Fall back to IG_USERNAME / IG_PASSWORD env vars for manual-credential login
 *  3. On success: save session cookies to ~/.instagram-session.json
 *  4. On failure: emit BLOCKED with instructions for Mahmut
 *
 * Usage:
 *   node instagram-login.mjs
 *
 * Env vars:
 *   FIVESIM_API_KEY — 5sim.net API key (enables auto SMS verification for new accounts)
 *   IG_USERNAME  — Instagram username or email (used if auto-registration fails)
 *   IG_PASSWORD  — Instagram password (used if auto-registration fails)
 *
 * Output:
 *   RESULT:{json} on stdout, logs to stderr
 *
 * After success, all Instagram scrapers will automatically use the saved session.
 */

import { Camoufox } from "camoufox-js";
import {
  emitResult,
  emitError,
  log,
  delay,
  saveSession,
  createIgBrowser,
  createIgContext,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const FIVESIM_API_KEY = process.env.FIVESIM_API_KEY;

const LOGIN_URL = "https://www.instagram.com/accounts/login/";
const HOME_URL = "https://www.instagram.com/";
const SIGNUP_URL = "https://www.instagram.com/accounts/emailsignup/";

// ---------------------------------------------------------------------------
// Helper: check if we're logged in (look for user avatar or profile nav)
// ---------------------------------------------------------------------------

async function isLoggedIn(page) {
  try {
    const url = page.url();
    // If we're still on the login page, not logged in
    if (url.includes("/accounts/login/") || url.includes("/accounts/emailsignup/")) {
      return false;
    }

    // Check for presence of avatar/profile nav item (stable: nav [role=main] or nav with aria-label)
    const navLinks = await page.locator('nav a[href*="/"]').count();
    if (navLinks > 2) {
      // Check for "new post" button or account avatar which only appear when logged in
      const text = await page.evaluate(() => document.body.innerText.substring(0, 500));
      // Logged-out pages always show "Log in" / "Sign up"
      if (!text.includes("Log in") && !text.includes("Log In")) {
        return true;
      }
    }

    // Check for ds_user_id cookie (set when logged in)
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5sim.net SMS API helpers
// ---------------------------------------------------------------------------

const FIVESIM_BASE = "https://5sim.net/v1";

async function fiveSimRequest(path, method = "GET") {
  const { default: https } = await import("https");
  return new Promise((resolve, reject) => {
    const url = new URL(FIVESIM_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${FIVESIM_API_KEY}`,
        Accept: "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fiveSimBuyNumber(country = "any", operator = "any") {
  // Buy a virtual number for Instagram
  log(`5sim: Buying number (country=${country}, operator=${operator})...`);
  const result = await fiveSimRequest(`/user/buy/activation/${country}/${operator}/instagram`);
  if (result.id) {
    log(`5sim: Got number +${result.phone} (order id: ${result.id})`);
    return result; // { id, phone, operator, country, ... }
  }
  throw new Error(`5sim buy number failed: ${JSON.stringify(result)}`);
}

async function fiveSimWaitForSms(orderId, timeoutMs = 120000) {
  // Poll for incoming SMS (max 2 min)
  log(`5sim: Waiting for SMS on order ${orderId}...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fiveSimRequest(`/user/check/${orderId}`);
    if (result.sms && result.sms.length > 0) {
      const text = result.sms[0].text;
      log(`5sim: SMS received: ${text}`);
      // Extract 6-digit code
      const match = text.match(/\b(\d{6})\b/);
      if (match) return match[1];
      throw new Error(`SMS received but no 6-digit code found: ${text}`);
    }
    if (result.status === "CANCELED" || result.status === "TIMEOUT") {
      throw new Error(`5sim order ${result.status}`);
    }
    await delay(5000); // Poll every 5s
  }
  throw new Error("5sim: SMS wait timeout (2 min)");
}

async function fiveSimCancelOrder(orderId) {
  try {
    await fiveSimRequest(`/user/cancel/${orderId}`, "GET");
    log(`5sim: Order ${orderId} cancelled`);
  } catch (e) {
    log(`5sim: Could not cancel order ${orderId}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Auto-registration (create a fresh account)
// ---------------------------------------------------------------------------

async function tryAutoRegister(browser) {
  log("=== Strategy 1: Attempting auto-registration ===");

  const context = await createIgContext(browser);
  const page = await context.newPage();

  try {
    log(`Navigating to signup page: ${SIGNUP_URL}`);
    await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    // Check for login redirect (already handled by Instagram)
    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    // Generate random credentials for a throwaway account
    const ts = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const generatedEmail = `testuser${ts}@tempmail.plus`;
    const generatedUsername = `user_${randomSuffix}_${ts % 100000}`;
    const generatedPassword = `Passw0rd_${randomSuffix}!`;
    const generatedFullName = "Test User";

    log(`Generated credentials: email=${generatedEmail}, username=${generatedUsername}`);

    // Wait for signup form
    const emailField = page.locator('input[name="emailOrPhone"], input[name="email"]');
    const emailVisible = await emailField.count();
    if (emailVisible === 0) {
      log("Signup form not found — Instagram may have redirected or blocked");
      await context.close();
      return null;
    }

    // Fill email/phone
    log("Filling email...");
    await emailField.first().fill(generatedEmail);
    await delay(500);

    // Fill full name
    const nameField = page.locator('input[name="fullName"]');
    if (await nameField.count() > 0) {
      log("Filling full name...");
      await nameField.fill(generatedFullName);
      await delay(500);
    }

    // Fill username
    const usernameField = page.locator('input[name="username"]');
    if (await usernameField.count() > 0) {
      log("Filling username...");
      await usernameField.fill(generatedUsername);
      await delay(1000); // Let username availability check run
    }

    // Fill password
    const passwordField = page.locator('input[name="password"]');
    if (await passwordField.count() > 0) {
      log("Filling password...");
      await passwordField.fill(generatedPassword);
      await delay(500);
    }

    // Click Sign Up / Next button
    log("Clicking Sign Up button...");
    const signupBtn = page.locator('button[type="submit"]');
    if (await signupBtn.count() > 0) {
      await signupBtn.click();
      await delay(4000);
    } else {
      log("No submit button found on signup form");
      await context.close();
      return null;
    }

    // Check what happened after clicking signup
    const postSignupUrl = page.url();
    log(`Post-signup URL: ${postSignupUrl}`);

    // Check for phone verification requirement
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    log(`Page text after signup: ${bodyText.substring(0, 300)}`);

    if (
      bodyText.toLowerCase().includes("phone") ||
      bodyText.toLowerCase().includes("verify your number") ||
      bodyText.toLowerCase().includes("confirm your number") ||
      postSignupUrl.includes("phone")
    ) {
      if (!FIVESIM_API_KEY) {
        log("Instagram requires phone verification but FIVESIM_API_KEY is not set — blocked");
        await context.close();
        return null;
      }

      log("Phone verification required — using 5sim to get a virtual number...");
      let fiveSimOrder = null;
      try {
        fiveSimOrder = await fiveSimBuyNumber("any", "any");
        const phone = fiveSimOrder.phone; // e.g. "14155552671"

        // Fill in phone number
        log(`Entering phone number: +${phone}`);
        const phoneField = page.locator('input[name="phone"], input[type="tel"], input[placeholder*="phone"], input[placeholder*="Phone"]');
        if (await phoneField.count() === 0) {
          log("Phone input field not found on page");
          await fiveSimCancelOrder(fiveSimOrder.id);
          await context.close();
          return null;
        }
        await phoneField.first().fill(phone);
        await delay(1000);

        // Submit phone
        const submitBtn = page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Send")');
        if (await submitBtn.count() > 0) {
          await submitBtn.first().click();
          await delay(3000);
        }

        // Wait for SMS code
        const smsCode = await fiveSimWaitForSms(fiveSimOrder.id);
        log(`Got SMS code: ${smsCode}`);

        // Enter the code
        const codeField = page.locator('input[name="verificationCode"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"]');
        if (await codeField.count() > 0) {
          await codeField.first().fill(smsCode);
          await delay(500);
          const confirmBtn = page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Confirm")');
          if (await confirmBtn.count() > 0) {
            await confirmBtn.first().click();
            await delay(4000);
          }
        } else {
          log("Code input field not found after SMS received");
          await fiveSimCancelOrder(fiveSimOrder.id);
          await context.close();
          return null;
        }

        // Check if we got past phone verification
        const afterPhoneUrl = page.url();
        const afterPhoneText = await page.evaluate(() => document.body.innerText.substring(0, 500));
        log(`After phone verification URL: ${afterPhoneUrl}`);
        log(`After phone verification text: ${afterPhoneText.substring(0, 200)}`);

      } catch (e) {
        log(`5sim phone verification failed: ${e.message}`);
        if (fiveSimOrder) await fiveSimCancelOrder(fiveSimOrder.id);
        await context.close();
        return null;
      }
    }

    if (
      bodyText.toLowerCase().includes("captcha") ||
      bodyText.toLowerCase().includes("unusual activity") ||
      bodyText.toLowerCase().includes("suspicious")
    ) {
      log("CAPTCHA or suspicious activity detected — auto-registration blocked");
      await context.close();
      return null;
    }

    // Check for birthday / age verification step
    if (postSignupUrl.includes("birthday") || bodyText.toLowerCase().includes("birthday")) {
      log("Birthday verification step detected...");

      // Fill in a birthday (18+ years ago)
      const monthSelect = page.locator('select[title="Month:"]');
      const daySelect = page.locator('select[title="Day:"]');
      const yearSelect = page.locator('select[title="Year:"]');

      if (await monthSelect.count() > 0) {
        await monthSelect.selectOption("6"); // June
        await daySelect.selectOption("15");
        await yearSelect.selectOption("1995");
        await delay(1000);

        const nextBtn = page.locator('button:has-text("Next")');
        if (await nextBtn.count() > 0) {
          await nextBtn.click();
          await delay(3000);
        }
      }
    }

    // Check if we reached email verification step
    const newUrl = page.url();
    const newBodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    log(`After signup steps URL: ${newUrl}`);
    log(`Body text: ${newBodyText.substring(0, 300)}`);

    if (
      newBodyText.toLowerCase().includes("confirmation code") ||
      newBodyText.toLowerCase().includes("verify your email") ||
      newBodyText.toLowerCase().includes("enter the code") ||
      newUrl.includes("confirm")
    ) {
      log("Email verification required — auto-registration needs email access (not implemented)");
      // We can't complete email verification without access to the email
      await context.close();
      return null;
    }

    // If we somehow ended up logged in, grab the cookies
    const cookies = await context.cookies(HOME_URL);
    const hasSessionCookie = cookies.some((c) => c.name === "ds_user_id" || c.name === "sessionid");

    if (hasSessionCookie) {
      log("Auto-registration successful! Session cookies captured.");
      await context.close();
      return {
        cookies,
        username: generatedUsername,
        password: generatedPassword,
        email: generatedEmail,
      };
    }

    log("Auto-registration did not complete to a logged-in state");
    await context.close();
    return null;
  } catch (err) {
    log(`Auto-registration error: ${err.message}`);
    try { await context.close(); } catch {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Login with provided credentials (IG_USERNAME + IG_PASSWORD)
// ---------------------------------------------------------------------------

async function tryCredentialLogin(browser) {
  log("=== Strategy 2: Login with credentials ===");

  if (!IG_USERNAME || !IG_PASSWORD) {
    log("IG_USERNAME and IG_PASSWORD not set — cannot use credential login");
    return null;
  }

  log(`Using credentials: username=${IG_USERNAME}`);

  const context = await createIgContext(browser);
  const page = await context.newPage();

  try {
    log(`Navigating to ${LOGIN_URL}...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    // Wait for login form
    log("Waiting for login form...");
    const usernameSelectors = [
      'input[name="username"]',
      'input[aria-label="Mobile number, username or email"]',
      'input[aria-label*="username"]',
      'input[aria-label*="email"]',
      'input[type="text"]',
    ];
    let loginFormFound = false;
    let usernameSelector = null;
    for (let i = 0; i < 20; i++) {
      for (const sel of usernameSelectors) {
        const field = page.locator(sel);
        if (await field.count() > 0) {
          loginFormFound = true;
          usernameSelector = sel;
          log(`Login form found after ${i * 2}s using selector: ${sel}`);
          break;
        }
      }
      if (loginFormFound) break;
      await delay(2000);
    }

    if (!loginFormFound) {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      log(`Login form not found. Page text: ${bodyText}`);
      await context.close();
      return null;
    }

    // Fill username
    log("Filling username...");
    await page.locator(usernameSelector).first().fill(IG_USERNAME);
    await delay(800);

    // Fill password
    const passwordSelectors = ['input[name="password"]', 'input[type="password"]', 'input[aria-label*="password"]', 'input[aria-label*="Password"]'];
    let passwordSelector = 'input[name="password"]';
    for (const sel of passwordSelectors) {
      if (await page.locator(sel).count() > 0) { passwordSelector = sel; break; }
    }
    log("Filling password...");
    await page.locator(passwordSelector).first().fill(IG_PASSWORD);
    await delay(800);

    // Click Log In
    log("Clicking Log In...");
    const submitBtnSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Log In")',
      '[role="button"]:has-text("Log in")',
      'div[role="button"]:has-text("Log in")',
    ];
    let submitBtn = null;
    for (const sel of submitBtnSelectors) {
      const btn = page.locator(sel);
      if (await btn.count() > 0) { submitBtn = btn.first(); log(`Submit button found: ${sel}`); break; }
    }
    // Press Enter on password field — most natural way to submit
    log("Submitting via Enter key on password field...");
    await page.locator(passwordSelector).first().press("Enter");
    await delay(5000);

    // Check for errors
    const postLoginUrl = page.url();
    log(`Post-login URL: ${postLoginUrl}`);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    log(`Post-login text: ${bodyText.substring(0, 200)}`);

    // Check for 2FA / challenge
    if (
      postLoginUrl.includes("/challenge/") ||
      bodyText.toLowerCase().includes("suspicious login attempt") ||
      bodyText.toLowerCase().includes("unusual login")
    ) {
      log("Instagram is showing a security challenge — cannot proceed automatically");
      await context.close();
      return null;
    }

    // Check for wrong password
    if (
      bodyText.toLowerCase().includes("incorrect password") ||
      bodyText.toLowerCase().includes("password you entered is incorrect") ||
      bodyText.toLowerCase().includes("wrong password")
    ) {
      log("Wrong password — login failed");
      await context.close();
      return null;
    }

    // Wait a bit more for redirect
    await delay(3000);

    // Check if logged in by looking for session cookie
    const cookies = await context.cookies(HOME_URL);
    const sessionCookie = cookies.find((c) => c.name === "sessionid" || c.name === "ds_user_id");

    if (!sessionCookie) {
      log("No session cookie found after login — login may have failed");

      // Double-check: navigate to home and see if logged in
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(2000);

      const homeBodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      if (homeBodyText.includes("Log in") || homeBodyText.includes("Log In")) {
        log("Still on logged-out state after login attempt");
        await context.close();
        return null;
      }
    }

    // Get all cookies after potential redirect
    const finalCookies = await context.cookies(HOME_URL);
    const hasAuth = finalCookies.some((c) => c.name === "sessionid" || c.name === "ds_user_id");

    if (!hasAuth) {
      log("Login did not result in authenticated session");
      await context.close();
      return null;
    }

    log(`Login successful! ${finalCookies.length} cookies captured.`);
    await context.close();

    return {
      cookies: finalCookies,
      username: IG_USERNAME,
    };
  } catch (err) {
    log(`Credential login error: ${err.message}`);
    try { await context.close(); } catch {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Instagram Login Skill");
  log("=====================");
  log("Launching camoufox-js (anti-detect Firefox)...");

  const browser = await createIgBrowser(Camoufox);

  try {
    let loginResult = null;

    // Strategy 1: Auto-registration (create fresh account)
    loginResult = await tryAutoRegister(browser);

    if (loginResult) {
      log("Auto-registration succeeded!");
      log(`Account credentials (save these!): ${loginResult.username} / ${loginResult.password}`);

      // Save credentials to secrets file for future use
      const secretsPath = `${process.env.HOME}/.openclaw/secrets/instagram.env`;
      const secretsContent = `IG_USERNAME=${loginResult.username}\nIG_PASSWORD=${loginResult.password}\nIG_EMAIL=${loginResult.email}\n`;
      try {
        const fs = await import("fs");
        fs.writeFileSync(secretsPath, secretsContent, { mode: 0o600 });
        log(`Credentials saved to ${secretsPath}`);
      } catch (e) {
        log(`Warning: Could not save credentials to ${secretsPath}: ${e.message}`);
      }
    } else {
      log("Auto-registration failed or blocked. Trying credential login...");

      // Strategy 2: Credential login
      loginResult = await tryCredentialLogin(browser);
    }

    if (!loginResult) {
      // Both strategies failed — emit BLOCKED
      emitResult({
        error: true,
        code: "BLOCKED",
        message: [
          "Instagram login could not be completed automatically.",
          "",
          "Reasons auto-registration failed:",
          "  - Instagram requires phone verification for new accounts",
          "  - FIVESIM_API_KEY not set (or 5sim API call failed)",
          "  - CAPTCHA detected",
          "  - Email verification required (inbox not accessible)",
          "",
          "Reasons credential login failed:",
          "  - IG_USERNAME / IG_PASSWORD env vars not set, OR",
          "  - Wrong password, OR",
          "  - Instagram is showing a security challenge (2FA, suspicious login)",
          "",
          "Action required from Mahmut:",
          "  Option A — Use 5sim for fully automatic account creation:",
          "    1. Sign up at https://5sim.net and top up a few dollars",
          "    2. Get API key from dashboard",
          "    3. Save to ~/.openclaw/secrets/5sim.env as FIVESIM_API_KEY=<key>",
          "    4. Re-run: FIVESIM_API_KEY=<key> node instagram-login/scripts/instagram-login.mjs",
          "",
          "  Option B — Create account manually:",
          "    1. Create an Instagram account at https://www.instagram.com/accounts/emailsignup/",
          "    2. Set IG_USERNAME and IG_PASSWORD in ~/.openclaw/secrets/instagram.env",
          "    3. Re-run: node instagram-login/scripts/instagram-login.mjs",
          "",
          "  Option C — Use existing browser cookies:",
          "    Export browser cookies as JSON array to IG_COOKIES env var.",
        ].join("\n"),
        instructions: {
          step1: "Create account at https://www.instagram.com/accounts/emailsignup/",
          step2: "Set env vars: IG_USERNAME=<username> IG_PASSWORD=<password>",
          step3: "Re-run: node instagram-login/scripts/instagram-login.mjs",
        },
      });
      return;
    }

    // Save session
    saveSession(loginResult.cookies, loginResult.username);

    log(`\n✅ Login successful!`);
    log(`Username: @${loginResult.username}`);
    log(`Cookies saved to: ~/.instagram-session.json`);
    log(`All Instagram scrapers will now use this session automatically.`);

    emitResult({
      success: true,
      username: loginResult.username,
      cookieCount: loginResult.cookies.length,
      sessionFile: `${process.env.HOME}/.instagram-session.json`,
      note: "Session cookies saved. All Instagram scrapers will load these automatically. Re-run this script if you get SESSION_EXPIRED errors.",
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
