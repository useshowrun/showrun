#!/usr/bin/env node

/**
 * Capture Pitchbook auth headers from a running Chrome browser via CDP.
 *
 * Prerequisites:
 *   - Chrome launched with: google-chrome --remote-debugging-port=9222
 *   - User is already logged into Pitchbook in the browser
 *
 * Usage:
 *   node pitchbook-capture-headers.mjs [--cdp-url http://localhost:9222]
 */

import {
  cdpConnect,
  saveSession,
  delay,
  emitResult,
  emitError,
  log,
} from "../../lib/utils.mjs";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let cdpUrl = process.env.CHROME_CDP_URL || "http://localhost:9222";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cdp-url" && args[i + 1]) {
    cdpUrl = args[++i];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Connecting to Chrome CDP at", cdpUrl);

  let connection;
  try {
    connection = await cdpConnect(cdpUrl);
  } catch (err) {
    emitError(
      "CDP_CONNECT_FAILED",
      `Cannot connect to Chrome CDP at ${cdpUrl}. Is Chrome running with --remote-debugging-port=9222? (${err.message})`
    );
  }

  const { ws, send, tab } = connection;

  try {
    // Enable Network domain to capture requests
    await send("Network.enable");

    // If not on a Pitchbook page, navigate there
    if (!tab.url || !tab.url.includes("my.pitchbook.com")) {
      log("No Pitchbook tab found, navigating to my.pitchbook.com");
      await send("Page.navigate", { url: "https://my.pitchbook.com" });
      await delay(10_000);
    }

    // Set up a listener for the search API request
    let capturedHeaders = null;

    const headerPromise = new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        if (
          data.method === "Network.requestWillBeSent" &&
          data.params?.request?.url?.includes(
            "web-api/general-search/search/mixed"
          )
        ) {
          capturedHeaders = data.params.request.headers;
          resolve(capturedHeaders);
        }
      });
    });

    // Trigger a search request by typing into the search bar
    log("Triggering search request to capture headers...");

    // Focus the search input
    await send("Runtime.evaluate", {
      expression: `document.querySelector('#general-search-input')?.focus()`,
    });
    await delay(500);

    // Clear any existing text
    await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('#general-search-input');
        if (el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true})); }
      })()`,
    });
    await delay(500);

    // Type "fal" character by character
    for (const char of "fal") {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
        code: `Key${char.toUpperCase()}`,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: char,
        code: `Key${char.toUpperCase()}`,
      });
      await delay(200);
    }

    // Wait for the search request (timeout 30s)
    const timeoutPromise = delay(30_000).then(() => null);
    const headers = await Promise.race([headerPromise, timeoutPromise]);

    if (!headers) {
      emitError(
        "CAPTURE_TIMEOUT",
        "Timed out waiting for search API request. Is the user logged into Pitchbook?"
      );
    }

    // Get cookies via CDP
    const cookieResult = await send("Network.getCookies", {
      urls: ["https://my.pitchbook.com"],
    });
    const cookies = (cookieResult.result?.cookies || [])
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // Clean headers
    const cleanHeaders = { ...headers };
    delete cleanHeaders["accept-encoding"];
    delete cleanHeaders["content-length"];
    cleanHeaders["dnt"] = "1";

    // Save session
    saveSession(cleanHeaders, cookies);

    log("Headers captured successfully");
    emitResult({ success: true, method: "cdp" });
  } finally {
    // Do NOT close the browser — it's the user's session
    ws.close();
  }
}

main().catch((err) => {
  emitError("UNEXPECTED_ERROR", err.message);
});
