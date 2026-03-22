#!/usr/bin/env node
/**
 * Exploration script 2: Deeply analyze the listugcposts XHR endpoint
 * to understand pagination tokens and response structure.
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.error(`Exploring reviews XHR: ${targetUrl}`);

  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Capture ALL listugcposts responses
    const reviewResponses = [];
    context.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("listugcposts") || url.includes("review")) {
        try {
          const body = await resp.text();
          console.error(`\n=== RESPONSE from ${url.substring(0, 100)} ===`);
          console.error(`Status: ${resp.status()}`);
          console.error(`Body (first 2000 chars):\n${body.substring(0, 2000)}`);
          reviewResponses.push({ url: url.substring(0, 200), body });
        } catch (e) {
          console.error(`Could not get body: ${e.message}`);
        }
      }
    });

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Handle consent
    await delay(2000);
    try {
      const btn = page.locator('button[aria-label*="Accept all"], form[action*="consent"] button').first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await delay(2000);
      }
    } catch {}

    await delay(3000);

    // Click reviews tab
    try {
      const reviewsTab = page.locator('button[aria-label*="Reviews for"]').first();
      if (await reviewsTab.isVisible({ timeout: 3000 })) {
        await reviewsTab.click();
        console.error("\nClicked reviews tab");
        await delay(4000);
      }
    } catch (e) {
      console.error("Could not click reviews tab:", e.message);
    }

    // Check how many reviews we have now 
    const currentCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-review-id]')).filter(
        el => !el.parentElement || !el.parentElement.closest('[data-review-id]')
      ).length;
    });
    console.error(`\nReviews in DOM after tab click: ${currentCount}`);

    // Now scroll to trigger more loading
    console.error("\n=== Scrolling to trigger more review loads ===");
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const main = document.querySelector('[role="main"]');
        if (main) main.scrollTop = main.scrollHeight;
      });
      await delay(3000);
      const count = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[data-review-id]')).filter(
          el => !el.parentElement || !el.parentElement.closest('[data-review-id]')
        ).length;
      });
      console.error(`After scroll ${i+1}: ${count} reviews`);
    }

    // Check for sort button and try different sort
    console.error("\n=== Trying sort button ===");
    const sortBtn = page.locator('button[aria-label="Sort reviews"]').first();
    if (await sortBtn.isVisible({ timeout: 3000 })) {
      await sortBtn.click();
      await delay(2000);
      // Look for sort options
      const sortOptions = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li'));
        return items.map(el => ({ text: el.textContent.trim(), role: el.getAttribute('role') })).filter(x => x.text.length < 50 && x.text.length > 1);
      });
      console.error("Sort options:", JSON.stringify(sortOptions, null, 2));
      
      // Click "Newest" sort option
      const newestOption = page.locator('[role="menuitem"]:has-text("Newest"), [role="option"]:has-text("Newest"), li:has-text("Newest")').first();
      if (await newestOption.isVisible({ timeout: 2000 })) {
        await newestOption.click();
        console.error("Clicked Newest sort");
        await delay(3000);
      }
    }

    // Print all captured review responses
    console.error(`\n=== Total review responses captured: ${reviewResponses.length} ===`);
    reviewResponses.forEach((r, i) => {
      console.error(`\n--- Response ${i+1} ---`);
      console.error(`URL: ${r.url}`);
      // Parse the response to look for pagination tokens
      const body = r.body;
      // Look for pagination token patterns
      const tokenMatches = body.match(/"([A-Za-z0-9+/=_-]{20,}?)"/g);
      console.error(`Body length: ${body.length}`);
      console.error(`First 500 chars: ${body.substring(0, 500)}`);
    });

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
