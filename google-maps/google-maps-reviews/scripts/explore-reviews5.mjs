#!/usr/bin/env node
/**
 * Exploration script 5: Find star rating in the listugcposts response.
 * Print item[1] full structure for 3 reviews.
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

    let firstReviewData = null;
    let firstRequestUrl = null;
    let paginationToken = null;
    
    context.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("listugcposts") && !firstReviewData) {
        firstRequestUrl = url;
        const body = await resp.text();
        const json = body.replace(/^\)\]\}'\s*/, "");
        const data = JSON.parse(json);
        paginationToken = data[1];
        firstReviewData = data[2];
      }
    });

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    await delay(2000);
    try {
      const btn = page.locator('button[aria-label*="Accept all"], form[action*="consent"] button').first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await delay(2000);
      }
    } catch {}

    await delay(3000);

    try {
      const reviewsTab = page.locator('button[aria-label*="Reviews for"]').first();
      if (await reviewsTab.isVisible({ timeout: 3000 })) {
        await reviewsTab.click();
        await delay(4000);
      }
    } catch {}

    if (!firstReviewData) {
      console.error("No data captured");
      return;
    }

    // Print full item[1] for first 3 reviews with all positions
    for (let i = 0; i < Math.min(3, firstReviewData.length); i++) {
      const reviewItem = firstReviewData[i];
      const item = reviewItem[0]; // main review data
      const reviewId = item[0];
      const meta = item[1]; // the big metadata array
      
      console.error(`\n\n====== REVIEW ${i} (${reviewId}) ======`);
      console.error(`item[1] (meta) ALL positions:`);
      if (Array.isArray(meta)) {
        meta.forEach((v, idx) => {
          const s = JSON.stringify(v);
          if (v !== null && s) {
            console.error(`  [${idx}]: ${s.substring(0, 300)}`);
          }
        });
      }
      
      console.error(`\nitem[0] (top level) positions after [0] and [1]:`);
      for (let k = 2; k < item.length; k++) {
        const v = item[k];
        if (v !== null && v !== undefined) {
          console.error(`  item[${k}]: ${JSON.stringify(v).substring(0, 300)}`);
        }
      }
    }
    
    // Also look at the full raw review for first review
    console.error(`\n\nFULL RAW first review (reviewItem[0]):\n${JSON.stringify(firstReviewData[0][0], null, 2).substring(0, 3000)}`);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
