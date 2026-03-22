#!/usr/bin/env node
/**
 * Exploration script 3: Parse listugcposts URL params and response structure
 * to understand how to paginate reviews.
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.error(`Analyzing review XHR pagination: ${targetUrl}`);

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

    // Capture listugcposts request+response in detail
    const capturedRequests = [];
    
    context.on("request", (req) => {
      const url = req.url();
      if (url.includes("listugcposts")) {
        capturedRequests.push({ url, headers: req.headers() });
        console.error(`\n=== REQUEST to listugcposts ===`);
        console.error(`URL: ${url}`);
        // Decode the pb parameter
        const pbMatch = url.match(/pb=([^&]+)/);
        if (pbMatch) {
          const decoded = decodeURIComponent(pbMatch[1]);
          console.error(`pb param decoded: ${decoded}`);
        }
      }
    });
    
    context.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("listugcposts")) {
        const body = await resp.text();
        console.error(`\n=== RESPONSE from listugcposts ===`);
        console.error(`Status: ${resp.status()}`);
        // Strip the leading )]}' prefix
        const json = body.replace(/^\)\]\}'\s*/, "");
        try {
          const data = JSON.parse(json);
          console.error(`\nStructure of response:`);
          console.error(`data[0] = ${JSON.stringify(data[0])}`);
          console.error(`data[1] (pagination token) = ${JSON.stringify(data[1])}`);
          console.error(`data[2] = array? ${Array.isArray(data[2])} length: ${Array.isArray(data[2]) ? data[2].length : 'N/A'}`);
          
          if (Array.isArray(data[2])) {
            console.error(`\nFirst review (data[2][0]):`);
            const firstReview = data[2][0];
            console.error(`  Length: ${firstReview.length}`);
            console.error(`  [0] = ${JSON.stringify(firstReview[0])}`); // review id?
            console.error(`  [1] = ${JSON.stringify(firstReview[1])?.substring(0, 200)}`); // metadata?
            
            // Try to find the review text, rating, author
            const reviewStr = JSON.stringify(firstReview);
            
            // Look for star rating (typically 1-5)
            const ratingMatches = reviewStr.match(/\[([1-5])\]/g);
            console.error(`  Possible ratings: ${ratingMatches?.join(', ')}`);
            
            // Look for text-like strings (>20 chars)
            const textMatches = reviewStr.match(/"([^"]{20,100})"/g);
            console.error(`  Long text snippets: ${JSON.stringify(textMatches?.slice(0, 5))}`);
          }
          
          // Check full structure
          console.error(`\nFull response keys (data length): ${Array.isArray(data) ? data.length : 'not array'}`);
          if (Array.isArray(data)) {
            data.forEach((item, i) => {
              if (item !== null && i < 5) {
                const type = Array.isArray(item) ? `array[${item.length}]` : typeof item;
                console.error(`  data[${i}] = ${type}: ${JSON.stringify(item)?.substring(0, 100)}`);
              }
            });
          }
        } catch (e) {
          console.error(`Could not parse JSON: ${e.message}`);
          console.error(`Raw body first 500: ${body.substring(0, 500)}`);
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

    // Click reviews tab to trigger the XHR
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

    // Now scroll to trigger more loading
    console.error("\n=== Scrolling to trigger page 2 ===");
    for (let i = 0; i < 5; i++) {
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
      if (capturedRequests.length > 1) break; // Got second page
    }

    console.error(`\nTotal listugcposts requests captured: ${capturedRequests.length}`);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
