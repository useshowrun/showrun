#!/usr/bin/env node
/**
 * Exploration script 6: Find review text location in listugcposts response.
 * Uses JSON.stringify to print the full first review item, searching for text.
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Recursively search for a value in a nested structure
function findInStructure(obj, searchStr, path = "") {
  if (typeof obj === 'string' && obj.includes(searchStr)) {
    console.error(`FOUND at ${path}: ${obj.substring(0, 100)}`);
    return true;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findInStructure(v, searchStr, `${path}[${i}]`));
  }
  return false;
}

// Print structure with type info for each position
function printStructure(obj, path = "", maxDepth = 6, depth = 0) {
  if (depth >= maxDepth) return;
  if (obj === null) {
    console.error(`${path} = null`);
    return;
  }
  if (typeof obj === 'string') {
    console.error(`${path} = "${obj.substring(0, 80)}"`);
  } else if (typeof obj === 'number') {
    console.error(`${path} = ${obj}`);
  } else if (Array.isArray(obj)) {
    console.error(`${path} = array[${obj.length}]`);
    obj.forEach((v, i) => {
      if (v !== null || depth < 3) {
        printStructure(v, `${path}[${i}]`, maxDepth, depth + 1);
      }
    });
  } else if (typeof obj === 'boolean') {
    console.error(`${path} = ${obj}`);
  }
}

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

    // Review item structure (reviewItem = data[2][0]):
    // reviewItem is an array with 3 elements: [mainBlock, secondBlock, thirdBlock]
    // We know:
    //   mainBlock[0] = reviewId (string)
    //   mainBlock[1] = meta (array of 16 items, [0]=featureId, [2]=ts, [4]=authorInfo, [6]=relativeTime)
    //   mainBlock[2] = [ratingArr, null, photosArr] -> ratingArr = [4] or [5]
    //   mainBlock[3] = owner response data?
    //   mainBlock[4] = links
    //   mainBlock[5] = tracking id
    
    // reviewItem[1] and [2] = ???
    
    console.error(`\n=== First review item structure (3 top-level elements) ===`);
    console.error(`reviewItem.length = ${firstReviewData[0].length}`);
    
    firstReviewData[0].forEach((el, i) => {
      console.error(`\nreviewItem[${i}]: ${el === null ? 'null' : Array.isArray(el) ? `array[${el.length}]` : typeof el + '=' + String(el).substring(0, 50)}`);
    });
    
    // Search for the review text in the first review
    const reviewText1 = "In another review"; // We know this is in the first review
    console.error(`\n=== Searching for review text "${reviewText1}" ===`);
    findInStructure(firstReviewData[0], reviewText1, "reviewItem[0]");
    
    // Search for owner response text
    const ownerResponseText = "Thank you very much";
    console.error(`\n=== Searching for owner response "${ownerResponseText}" ===`);
    findInStructure(firstReviewData[0], ownerResponseText, "reviewItem[0]");
    
    // Also look at the second reviewItem
    console.error(`\n=== Second review item structure ===`);
    firstReviewData[1].forEach((el, i) => {
      console.error(`reviewItem2[${i}]: ${el === null ? 'null' : Array.isArray(el) ? `array[${el.length}]` : typeof el + '=' + String(el).substring(0, 50)}`);
    });
    
    // Search in second review for text
    const r2text = "özgür emrah"; // author's name
    findInStructure(firstReviewData[1], r2text, "reviewItem2");
    
    // Look at the FULL first review using printStructure
    console.error(`\n=== Full structure of firstReviewData[0] ===`);
    printStructure(firstReviewData[0], "r", 7);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
