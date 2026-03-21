#!/usr/bin/env node
/**
 * Upload Instagram profile picture via camoufox remote server + playwright-core.
 *
 * Requires camoufox Python server running at ws://localhost:19222/camoufox
 * Start it with: /home/karacasoft/.openclaw/.venv/bin/python3 /tmp/camoufox-server.py &
 *
 * Usage:
 *   node instagram-upload-pfp.mjs --image /path/to/image.png
 *
 * Flow:
 *   1. Navigate to /accounts/edit/
 *   2. Click avatar button → opens menu (Upload Photo / Remove Current Photo / Cancel)
 *   3. Click "Upload Photo" → triggers native file chooser
 *   4. Set the image file
 *   5. If a crop dialog appears, confirm it
 */

import { firefox } from "playwright-core";
import fs from "fs";
import os from "os";
import path from "path";
import { parseArgs } from "util";

const WS_ENDPOINT = "ws://localhost:19222/camoufox";
const SESSION_FILE = path.join(os.homedir(), ".instagram-session.json");

const log = (...a) => console.error("[ig-upload-pfp]", ...a);
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitResult = obj => process.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");

async function main() {
  const { values } = parseArgs({
    options: { image: { type: "string" } },
    strict: false,
  });

  if (!values.image || !fs.existsSync(values.image)) {
    emitResult({ error: true, code: "NO_IMAGE", message: "Provide --image /path/to/image.png (file must exist)" });
    return;
  }

  if (!fs.existsSync(SESSION_FILE)) {
    emitResult({ error: true, code: "NO_SESSION", message: "Run instagram-login first." });
    return;
  }

  const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

  log("Connecting to camoufox server...");
  const browser = await firefox.connect(WS_ENDPOINT);
  log("Connected. Version:", browser.version());

  const context = await browser.newContext();
  await context.addCookies(session.cookies.map(c => ({
    ...c,
    domain: c.domain || ".instagram.com",
    path: c.path || "/",
  })));

  try {
    const page = await context.newPage();

    log("Navigating to /accounts/edit/...");
    await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "networkidle", timeout: 30000 });
    await delay(2000);

    if (page.url().includes("/accounts/login")) {
      emitResult({ error: true, code: "SESSION_EXPIRED", message: "Not logged in — re-run instagram-login." });
      return;
    }

    // Step 1: Click the avatar to open the menu
    log("Clicking avatar to open photo menu...");
    await page.locator("button:has(img[alt='Change profile photo'])").first().click();
    await delay(1500);

    // Step 2: Click "Upload Photo" — triggers native file chooser
    log("Clicking Upload Photo...");
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10000 }),
      page.locator("button:has-text('Upload Photo')").click(),
    ]);

    log("File chooser open — setting image:", values.image);
    await fileChooser.setFiles(values.image);
    await delay(4000);

    // Step 3: Confirm crop dialog if it appears
    let confirmed = false;
    for (const label of ["Done", "Apply", "Confirm", "Next", "Save"]) {
      const btn = page.locator(`button:has-text('${label}')`);
      if (await btn.count() > 0) {
        log(`Crop dialog found — clicking "${label}"...`);
        await btn.first().click();
        confirmed = true;
        await delay(3000);
        break;
      }
    }

    await page.screenshot({ path: "/tmp/pfp-result.png" });
    log("Screenshot saved: /tmp/pfp-result.png");

    emitResult({ success: true, cropConfirmed: confirmed, screenshot: "/tmp/pfp-result.png" });
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch(err => emitResult({ error: true, code: "UNEXPECTED_ERROR", message: err.message }));
