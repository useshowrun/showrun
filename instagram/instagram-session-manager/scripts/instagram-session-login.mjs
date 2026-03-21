#!/usr/bin/env node
/**
 * Instagram Persistent Session Login
 *
 * Launches camoufox with a FIXED browser profile saved to disk.
 * Instagram will see the same "device" on every run.
 * 
 * First run: logs in, handles verification code interactively
 * Subsequent runs: reuses saved profile (no login needed)
 *
 * Usage:
 *   node instagram-session-login.mjs
 *   # If verification code needed:
 *   IG_VERIFY_CODE=123456 node instagram-session-login.mjs
 *
 * Env vars:
 *   IG_USERNAME       Instagram username
 *   IG_PASSWORD       Instagram password
 *   IG_VERIFY_CODE    Verification code (if prompted)
 *   IG_PROFILE_DIR    Browser profile dir (default: ~/.instagram-browser-profile)
 */

import { Camoufox } from "camoufox-js";
import fs from "fs";
import path from "path";
import os from "os";

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const IG_VERIFY_CODE = process.env.IG_VERIFY_CODE;
const PROFILE_DIR = process.env.IG_PROFILE_DIR || path.join(os.homedir(), ".instagram-browser-profile");
const SESSION_FILE = path.join(os.homedir(), ".instagram-session.json");

const log = (...args) => console.error("[ig-session]", ...args);
const delay = ms => new Promise(r => setTimeout(r, ms));

function emitResult(obj) {
  process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

function saveSession(cookies, username) {
  const session = { username, cookies, savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  log(`Session saved to ${SESSION_FILE}`);
}

async function main() {
  // Ensure profile dir exists
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`Using browser profile: ${PROFILE_DIR}`);

  log("Launching camoufox with persistent profile...");
  // With user_data_dir, Camoufox returns a BrowserContext directly (not a Browser)
  const context = await Camoufox({
    headless: "virtual",
    user_data_dir: PROFILE_DIR,
    locale: "en-US",
    timezoneId: "Europe/Istanbul",
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await context.newPage();

    // Check if already logged in
    log("Checking login state...");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);

    const url = page.url();
    const cookies = await context.cookies("https://www.instagram.com");
    const sessionCookie = cookies.find(c => c.name === "sessionid");

    if (sessionCookie) {
      log("✅ Already logged in! Saving session...");
      saveSession(cookies, IG_USERNAME || "curiosity.byte");
      emitResult({ success: true, alreadyLoggedIn: true, username: IG_USERNAME, cookieCount: cookies.length });
      await context.close();
      return;
    }

    // Handle verification code page
    if (url.includes("codeentry") || url.includes("challenge") || url.includes("auth_platform")) {
      log("On verification page...");

      if (!IG_VERIFY_CODE) {
        // Pause and wait for code to be provided via env
        log("⚠️  Verification code required. Re-run with IG_VERIFY_CODE=<code>");
        emitResult({ error: true, code: "VERIFY_CODE_REQUIRED", message: "Instagram requires a verification code. Re-run with IG_VERIFY_CODE=<code> env var." });
        await context.close();
        return;
      }

      await submitCode(page, IG_VERIFY_CODE);
      await delay(4000);

      const finalCookies = await context.cookies("https://www.instagram.com");
      const finalSession = finalCookies.find(c => c.name === "sessionid");
      if (finalSession) {
        saveSession(finalCookies, IG_USERNAME || "curiosity.byte");
        emitResult({ success: true, username: IG_USERNAME, cookieCount: finalCookies.length });
      } else {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
        emitResult({ error: true, code: "CODE_FAILED", message: "Code submitted but session not established", bodyText });
      }
      await context.close();
      return;
    }

    // Need to log in
    if (!IG_USERNAME || !IG_PASSWORD) {
      emitResult({ error: true, code: "NO_CREDENTIALS", message: "Not logged in and IG_USERNAME/IG_PASSWORD not set" });
      await context.close();
      return;
    }

    log("Navigating to login page...");
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);

    // Fill login form
    log("Filling credentials...");
    const usernameField = page.locator('input[name="username"], input[type="text"], input[aria-label*="username"], input[aria-label*="email"]');
    await usernameField.first().fill(IG_USERNAME);
    await delay(600);

    const passwordField = page.locator('input[name="password"], input[type="password"]');
    await passwordField.first().fill(IG_PASSWORD);
    await delay(600);

    // Submit
    const submitBtn = page.locator('[role="button"]:has-text("Log in"), button[type="submit"], button:has-text("Log in")');
    if (await submitBtn.count() > 0) {
      await submitBtn.first().click();
    } else {
      await passwordField.first().press("Enter");
    }
    await delay(5000);

    const postLoginUrl = page.url();
    log(`Post-login URL: ${postLoginUrl}`);

    // Verification code required
    if (postLoginUrl.includes("codeentry") || postLoginUrl.includes("challenge") || postLoginUrl.includes("auth_platform")) {
      if (!IG_VERIFY_CODE) {
        log("⚠️  Verification code required!");
        emitResult({ error: true, code: "VERIFY_CODE_REQUIRED", message: "Instagram sent a verification code. Re-run with IG_VERIFY_CODE=<code> env var." });
        await context.close();
        return;
      }
      await submitCode(page, IG_VERIFY_CODE);
      await delay(4000);
    }

    // Check session
    const finalCookies = await context.cookies("https://www.instagram.com");
    const finalSession = finalCookies.find(c => c.name === "sessionid");

    if (finalSession) {
      saveSession(finalCookies, IG_USERNAME);
      log("✅ Login successful!");
      emitResult({ success: true, username: IG_USERNAME, cookieCount: finalCookies.length, sessionFile: SESSION_FILE });
    } else {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      log(`Login failed. Page: ${bodyText.substring(0, 100)}`);
      emitResult({ error: true, code: "LOGIN_FAILED", message: "Login did not result in session", bodyText });
    }

    await context.close();
  } finally {
    await context.close();
  }
}

async function submitCode(page, code) {
  log(`Submitting code: ${code}`);
  const codeInput = page.locator('input[inputmode="numeric"], input[type="number"], input[name="verificationCode"], input[aria-label*="code"], input[placeholder*="code"]');
  if (await codeInput.count() > 0) {
    await codeInput.first().fill(code);
    await delay(400);
  } else {
    await page.keyboard.type(code);
    await delay(400);
  }

  const confirmBtn = page.locator('[role="button"]:has-text("Confirm"), [role="button"]:has-text("Submit"), [role="button"]:has-text("Next"), button[type="submit"]');
  if (await confirmBtn.count() > 0) {
    await confirmBtn.first().click();
  } else {
    await page.keyboard.press("Enter");
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
