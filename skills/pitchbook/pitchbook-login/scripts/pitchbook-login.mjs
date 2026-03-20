#!/usr/bin/env node

/**
 * Automated Pitchbook login using camoufox (anti-detect Firefox).
 *
 * Prerequisites:
 *   - Environment variables: PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD,
 *     PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME
 *
 * Usage:
 *   node pitchbook-login.mjs
 */

import { launch } from "camoufox";
import {
  generateTOTP,
  saveSession,
  delay,
  emitResult,
  emitError,
  log,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

const EMAIL = process.env.PITCHBOOK_EMAIL;
const PASSWORD = process.env.PITCHBOOK_PASSWORD;
const OTP_SECRET = process.env.PITCHBOOK_OTP_SECRET;
const USERNAME = process.env.PITCHBOOK_USERNAME;

if (!EMAIL || !PASSWORD || !OTP_SECRET || !USERNAME) {
  emitError(
    "MISSING_ENV",
    "Required env vars: PITCHBOOK_EMAIL, PITCHBOOK_PASSWORD, PITCHBOOK_OTP_SECRET, PITCHBOOK_USERNAME"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Launching camoufox browser...");
  const browser = await launch({ headless: false });

  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    // Navigate to Pitchbook
    log("Navigating to my.pitchbook.com...");
    await page.goto("https://my.pitchbook.com");

    // Wait for email field (retry up to 30× with 5s sleep)
    let loginOpened = false;
    for (let i = 0; i < 30; i++) {
      try {
        const emailField = page.locator('input[type="email"]');
        if ((await emailField.count()) > 0) {
          loginOpened = true;
          break;
        }
      } catch {
        // ignore
      }
      await delay(5_000);
    }

    if (!loginOpened) {
      emitError("LOGIN_FORM_NOT_FOUND", "Could not find email field after 150s");
    }

    await delay(4_000);

    // Type email
    log("Typing email...");
    await page.getByLabel("email").type(EMAIL, { delay: 300 });
    await delay(4_000);

    // Type password
    log("Typing password...");
    await page.getByLabel("password").type(PASSWORD, { delay: 300 });
    await delay(4_000);

    // Click Sign In
    log("Clicking Sign In...");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await delay(5_000);

    // Generate and enter TOTP
    const code = generateTOTP(OTP_SECRET);
    log("Entering TOTP code...");
    await page.locator("#code").type(code, { delay: 100 });
    await delay(4_000);

    // Click Continue
    log("Clicking Continue...");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await delay(20_000);

    // Verify login
    const bodyText = await page.textContent("body");
    if (!bodyText.includes(USERNAME)) {
      emitError(
        "LOGIN_FAILED",
        `Login verification failed — "${USERNAME}" not found on page`
      );
    }
    log("Login verified — found username on page");

    // Capture headers by triggering a search
    let capturedHeaders = null;

    page.on("request", (request) => {
      if (request.url().includes("web-api/general-search/search/mixed")) {
        capturedHeaders = request.headers();
      }
    });

    // Type into search to trigger API call
    log("Triggering search to capture headers...");
    const searchInput = page.locator("#general-search-input");
    await searchInput.clear();
    await delay(500);
    await searchInput.type("fal", { delay: 100 });

    // Wait for the request to be captured
    for (let i = 0; i < 60; i++) {
      if (capturedHeaders) break;
      await delay(500);
    }

    if (!capturedHeaders) {
      emitError("CAPTURE_FAILED", "Failed to capture search request headers");
    }

    // Clean headers
    delete capturedHeaders["accept-encoding"];
    delete capturedHeaders["content-length"];
    capturedHeaders["dnt"] = "1";

    // Extract cookies
    const browserCookies = await context.cookies("https://my.pitchbook.com");
    const cookieString = browserCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // Save session
    saveSession(capturedHeaders, cookieString, USERNAME);

    log("Automated login complete");
    emitResult({ success: true, method: "automated" });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
