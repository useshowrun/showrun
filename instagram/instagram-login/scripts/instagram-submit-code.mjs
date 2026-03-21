#!/usr/bin/env node
/**
 * Submit Instagram verification code to an existing session.
 * Uses the persistent browser profile from instagram-login.
 *
 * Usage:
 *   IG_VERIFY_CODE=123456 node instagram-submit-code.mjs
 */

import { Camoufox } from "camoufox-js";
import { emitResult, log, delay, saveSession, createIgBrowser, createIgContext } from "../../lib/utils.mjs";

const CODE = process.env.IG_VERIFY_CODE;
if (!CODE) {
  console.error("IG_VERIFY_CODE not set");
  process.exit(1);
}

async function main() {
  log(`Submitting verification code: ${CODE}`);
  const browser = await createIgBrowser(Camoufox);

  try {
    const context = await createIgContext(browser);
    const page = await context.newPage();

    // Navigate to the code entry page
    log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);

    const url = page.url();
    log(`Current URL: ${url}`);

    // If we're on the code entry page
    if (url.includes("codeentry") || url.includes("challenge") || url.includes("auth_platform")) {
      log("On verification page, submitting code...");

      const codeInput = page.locator('input[name="verificationCode"], input[aria-label*="code"], input[aria-label*="Code"], input[placeholder*="code"], input[placeholder*="Code"], input[type="number"], input[inputmode="numeric"]');
      
      if (await codeInput.count() > 0) {
        await codeInput.first().fill(CODE);
        await delay(500);

        const confirmBtn = page.locator('button[type="submit"], button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Next"), [role="button"]:has-text("Confirm"), [role="button"]:has-text("Submit")');
        if (await confirmBtn.count() > 0) {
          await confirmBtn.first().click();
          await delay(4000);
        } else {
          await page.keyboard.press("Enter");
          await delay(4000);
        }
      } else {
        log("Code input not found, trying to type directly...");
        await page.keyboard.type(CODE);
        await delay(500);
        await page.keyboard.press("Enter");
        await delay(4000);
      }
    } else {
      log(`Not on code entry page (URL: ${url}), trying to find code input anywhere...`);
      const codeInput = page.locator('input[inputmode="numeric"], input[type="number"]');
      if (await codeInput.count() > 0) {
        await codeInput.first().fill(CODE);
        await delay(500);
        await page.keyboard.press("Enter");
        await delay(4000);
      }
    }

    const finalUrl = page.url();
    log(`Final URL: ${finalUrl}`);

    const cookies = await context.cookies("https://www.instagram.com");
    const sessionCookie = cookies.find(c => c.name === "sessionid" || c.name === "ds_user_id");

    if (sessionCookie) {
      saveSession(cookies, "curiosity.byte");
      log("✅ Session saved successfully!");
      emitResult({ success: true, username: "curiosity.byte", cookieCount: cookies.length, sessionFile: `${process.env.HOME}/.instagram-session.json` });
    } else {
      log(`No session cookie found. Final URL: ${finalUrl}`);
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      log(`Page text: ${bodyText}`);
      emitResult({ error: true, code: "NO_SESSION", message: "Code submitted but no session cookie captured", finalUrl, bodyText });
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
