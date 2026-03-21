#!/usr/bin/env node
/**
 * Instagram Seed Session
 *
 * Seeds a camoufox browser profile with Instagram cookies from the session file.
 * Run this ONCE after getting fresh cookies from your browser.
 * After seeding, camoufox will launch already logged in — no verification needed.
 *
 * Usage:
 *   node instagram-seed-session.mjs
 *
 * Env vars:
 *   IG_SESSION_FILE   Path to session JSON (default: ~/.instagram-session.json)
 *   IG_PROFILE_DIR    Browser profile dir (default: ~/.instagram-browser-profile)
 */

import { Camoufox } from "camoufox-js";
import fs from "fs";
import path from "path";
import os from "os";

const SESSION_FILE = process.env.IG_SESSION_FILE || path.join(os.homedir(), ".openclaw/secrets/instagram-session.json");
const PROFILE_DIR = process.env.IG_PROFILE_DIR || path.join(os.homedir(), ".instagram-browser-profile");

const log = (...args) => console.error("[ig-seed]", ...args);
function emitResult(obj) { process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n"); }

async function main() {
  // Load session
  if (!fs.existsSync(SESSION_FILE)) {
    emitResult({ error: true, code: "NO_SESSION", message: `Session file not found: ${SESSION_FILE}` });
    return;
  }

  const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  log(`Loaded session for @${session.username}`);

  // Ensure profile dir exists
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`Profile dir: ${PROFILE_DIR}`);

  // Launch camoufox with persistent profile
  log("Launching camoufox...");
  const context = await Camoufox({
    headless: "virtual",
    user_data_dir: PROFILE_DIR,
    locale: "en-US",
    timezoneId: "Europe/Istanbul",
  });

  try {
    // Inject all cookies into the browser context
    log(`Injecting ${session.cookies.length} cookies...`);
    const cookies = session.cookies.map(c => ({
      name: c.name,
      value: decodeURIComponent(c.value), // decode URL-encoded values
      domain: c.domain || ".instagram.com",
      path: c.path || "/",
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || "Lax",
    }));

    await context.addCookies(cookies);
    log("Cookies injected.");

    // Navigate to Instagram to verify + let browser persist the session
    const page = await context.newPage();
    log("Navigating to Instagram to verify session...");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const url = page.url();
    log(`Current URL: ${url}`);

    const allCookies = await context.cookies("https://www.instagram.com");
    const sessionCookie = allCookies.find(c => c.name === "sessionid");

    if (sessionCookie && !url.includes("/accounts/login")) {
      log("✅ Session seeded and verified! Camoufox profile is now logged in.");
      emitResult({
        success: true,
        username: session.username,
        profileDir: PROFILE_DIR,
        cookieCount: allCookies.length,
        message: "Profile seeded. Future camoufox launches with this profile will be logged in automatically.",
      });
    } else {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      log(`Session not active after seeding. URL: ${url}`);
      emitResult({
        error: true,
        code: "SESSION_INVALID",
        message: "Cookies injected but session is not active — cookies may be expired. Get fresh cookies from browser.",
        url,
        bodyText,
      });
    }

    await page.close();
  } finally {
    await context.close();
  }
}

main().catch(err => {
  emitResult({ error: true, code: "UNEXPECTED_ERROR", message: err.message });
});
