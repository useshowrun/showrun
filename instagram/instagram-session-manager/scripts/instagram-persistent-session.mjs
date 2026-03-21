#!/usr/bin/env node
/**
 * Instagram Persistent Session Manager
 *
 * Launches a long-running camoufox instance with a fixed browser profile.
 * All other Instagram scripts connect to this running session via a shared
 * cookie export — no repeated logins needed.
 *
 * Workflow:
 *   1. First time: run instagram-seed-session.mjs to pre-load cookies
 *   2. Then run this script — it launches camoufox already logged in
 *   3. Periodically refreshes and saves cookies to ~/.instagram-session.json
 *   4. All other scripts just read from the session file
 *
 * Usage:
 *   node instagram-persistent-session.mjs
 *   # Runs indefinitely. Kill with Ctrl+C or SIGTERM.
 *
 * Env vars:
 *   IG_PROFILE_DIR      Browser profile dir (default: ~/.instagram-browser-profile)
 *   IG_SESSION_FILE     Where to save refreshed cookies (default: ~/.instagram-session.json)
 *   IG_REFRESH_INTERVAL Cookie refresh interval in ms (default: 300000 = 5 min)
 *   IG_USERNAME         Username (for session file metadata)
 */

import { Camoufox } from "camoufox-js";
import fs from "fs";
import path from "path";
import os from "os";

const PROFILE_DIR = process.env.IG_PROFILE_DIR || path.join(os.homedir(), ".instagram-browser-profile");
const SESSION_FILE = process.env.IG_SESSION_FILE || path.join(os.homedir(), ".instagram-session.json");
const REFRESH_INTERVAL = parseInt(process.env.IG_REFRESH_INTERVAL || "300000");
const IG_USERNAME = process.env.IG_USERNAME || "curiosity.byte";

const log = (...args) => console.error(`[ig-session ${new Date().toISOString()}]`, ...args);

function saveCookies(cookies) {
  const session = {
    username: IG_USERNAME,
    savedAt: new Date().toISOString(),
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    headers: {
      "user-agent": "Instagram 319.0.0.0.6 Android",
      "x-ig-app-id": "936619743392459",
      "x-csrftoken": cookies.find(c => c.name === "csrftoken")?.value || "",
    },
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  log(`Session saved (${cookies.length} cookies) → ${SESSION_FILE}`);
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`Starting persistent session | profile: ${PROFILE_DIR}`);

  const context = await Camoufox({
    headless: "virtual",
    user_data_dir: PROFILE_DIR,
    locale: "en-US",
    timezoneId: "Europe/Istanbul",
    viewport: { width: 1280, height: 800 },
  });

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    try {
      const cookies = await context.cookies("https://www.instagram.com");
      saveCookies(cookies);
    } catch {}
    try { await context.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Verify logged in
  const page = await context.newPage();
  log("Checking session...");
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const url = page.url();
  if (url.includes("/accounts/login")) {
    log("❌ Not logged in! Run instagram-seed-session.mjs first with valid cookies.");
    await context.close();
    process.exit(1);
  }

  log(`✅ Logged in! URL: ${url}`);

  // Initial cookie save
  const initialCookies = await context.cookies("https://www.instagram.com");
  saveCookies(initialCookies);
  log(`Session active. Refreshing cookies every ${REFRESH_INTERVAL / 1000}s`);

  await page.close();

  // Periodic cookie refresh loop
  while (true) {
    await new Promise(r => setTimeout(r, REFRESH_INTERVAL));
    try {
      // Visit Instagram to keep session alive
      const refreshPage = await context.newPage();
      await refreshPage.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = refreshPage.url();
      if (currentUrl.includes("/accounts/login")) {
        log("⚠️  Session expired during refresh!");
        await refreshPage.close();
        break;
      }

      const cookies = await context.cookies("https://www.instagram.com");
      saveCookies(cookies);
      await refreshPage.close();
      log("Session refreshed ✅");
    } catch (e) {
      log(`Refresh error: ${e.message}`);
    }
  }

  log("Session ended.");
  await context.close();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
