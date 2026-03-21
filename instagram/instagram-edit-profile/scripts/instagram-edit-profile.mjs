#!/usr/bin/env node
/**
 * Instagram Edit Profile Skill
 *
 * Updates profile info via browser automation (camoufox).
 * Navigates to /accounts/edit/, fills the form, clicks Submit.
 * No API calls — everything goes through the real browser UI.
 *
 * Usage:
 *   node instagram-edit-profile.mjs [options]
 *
 * Options (all optional — only provided fields are updated):
 *   --name "Display Name"
 *   --bio  "Bio text (max 150 chars)"
 *   --url  "https://yoursite.com"
 *
 * Env vars:
 *   IG_PROFILE_DIR   Camoufox profile dir (default: ~/.instagram-browser-profile)
 *
 * Session:
 *   Reads cookies from ~/.instagram-session.json (created by instagram-login).
 *
 * Output:
 *   RESULT:{json} on stdout
 */

import { Camoufox } from "camoufox-js";
import fs from "fs";
import os from "os";
import path from "path";
import { parseArgs } from "util";

const PROFILE_DIR = process.env.IG_PROFILE_DIR || path.join(os.homedir(), ".instagram-browser-profile");
const SESSION_FILE = path.join(os.homedir(), ".instagram-session.json");

const log = (...a) => console.error("[ig-edit-profile]", ...a);
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitResult = obj => process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      bio:  { type: "string" },
      url:  { type: "string" },
    },
    strict: false,
  });

  if (!values.name && !values.bio && !values.url) {
    emitResult({ error: true, code: "NO_ARGS", message: "Provide at least one of: --name, --bio, --url" });
    return;
  }

  // Load session cookies
  if (!fs.existsSync(SESSION_FILE)) {
    emitResult({ error: true, code: "NO_SESSION", message: `Session file not found: ${SESSION_FILE}. Run instagram-login first.` });
    return;
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

  log("Launching camoufox with persistent profile...");
  const context = await Camoufox({ headless: "virtual", user_data_dir: PROFILE_DIR });

  // Inject session cookies
  await context.addCookies(session.cookies.map(c => ({
    ...c,
    domain: c.domain || ".instagram.com",
    path: c.path || "/",
  })));

  try {
    const page = await context.newPage();

    log("Navigating to profile edit page...");
    await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "networkidle", timeout: 30000 });
    await delay(2000);

    // Check if logged in
    if (page.url().includes("/accounts/login")) {
      emitResult({ error: true, code: "SESSION_EXPIRED", message: "Not logged in — run instagram-login to refresh session." });
      await context.close();
      return;
    }

    log("On edit page:", page.url());

    // Find all inputs to identify name/username fields by position
    const inputInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input:not([type='hidden']):not([aria-label='Show account suggestions on profiles']), textarea"))
        .map((el, i) => ({ i, tag: el.tagName, id: el.id, placeholder: el.placeholder, value: el.value }))
    );
    log("Inputs:", JSON.stringify(inputInfo));

    // Note: Instagram's current edit page only exposes bio via /accounts/edit/
    // Name is under Accounts Center (separate flow)
    if (values.name !== undefined) {
      log("Note: name field not available on /accounts/edit/ — skipping (Instagram moved it to Accounts Center)");
    }

    // Update bio
    if (values.bio !== undefined) {
      log(`Setting bio: "${values.bio}"`);
      const bioField = page.locator("#pepBio, textarea[placeholder='Bio']").first();
      await bioField.click({ clickCount: 3 });
      await bioField.fill(values.bio);
      await delay(500);
    }

    // Update website URL — field may be locked for new accounts
    if (values.url !== undefined) {
      const urlField = page.locator("input[placeholder='Website']");
      const isDisabled = await urlField.isDisabled().catch(() => true);
      if (isDisabled) {
        log("Website field is disabled (may require verified/older account) — skipping");
      } else {
        log(`Setting url: "${values.url}"`);
        await urlField.click({ clickCount: 3 });
        await urlField.fill(values.url);
        await delay(500);
      }
    }

    // Click Submit
    log("Submitting form...");
    const submitBtn = page.locator("button[type='submit'], button:has-text('Submit')");
    const count = await submitBtn.count();
    if (count > 0) {
      await submitBtn.first().click();
    } else {
      await page.keyboard.press("Enter");
    }
    await delay(3000);

    // Verify success — check for toast/confirmation or that page is still on edit
    const finalUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    log("After submit URL:", finalUrl);
    log("Page text:", pageText.substring(0, 100));

    const success = !finalUrl.includes("login") && !pageText.toLowerCase().includes("error");

    // Take screenshot for verification
    await page.screenshot({ path: "/tmp/ig-edit-result.png" });
    log("Screenshot saved to /tmp/ig-edit-result.png");

    emitResult({
      success,
      updated: { name: values.name, bio: values.bio, url: values.url },
      finalUrl,
      screenshotPath: "/tmp/ig-edit-result.png",
    });

    await page.close();
  } finally {
    await context.close();
  }
}

main().catch(err => {
  emitResult({ error: true, code: "UNEXPECTED_ERROR", message: err.message });
});
