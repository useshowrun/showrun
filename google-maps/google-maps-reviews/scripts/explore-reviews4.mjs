#!/usr/bin/env node
/**
 * Exploration script 4: Parse review data structure from listugcposts response
 * and manually replay with pagination token.
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a single review from the listugcposts response data structure.
 * data[2][i] is an array of 3 items:
 *   [0] = main review data array
 *   [1] = photos array (or null)
 *   [2] = null
 */
function parseReview(reviewItem) {
  try {
    const item = reviewItem[0]; // main review data
    if (!item || !Array.isArray(item)) return null;
    
    const reviewId = item[0]; // e.g. "ChdDSUhNMG9nS0VJQ0FnSUNQdFo3bXhBRRAB"
    
    // Author data is nested: item[1][4][5] or similar
    // item[1] = [placeFeatureId, null, timestamp1, timestamp2, authorArray]
    const authorData = item[1];
    let authorName = null, avatarUrl = null, profileUrl = null, contributorId = null;
    let localGuide = false, reviewCount = null;
    
    if (Array.isArray(authorData) && authorData[4]) {
      const authorInfo = authorData[4]; // [null, null, [profileUrl], null, null, [name, avatarUrl, [profileUrl], contributorId, null, reviewCount, photoCount, null, [0,3,1], 1, ["X reviews"...]]]
      if (Array.isArray(authorInfo) && authorInfo[5]) {
        const nameData = authorInfo[5];
        if (Array.isArray(nameData)) {
          authorName = nameData[0];
          avatarUrl = nameData[1];
          if (Array.isArray(nameData[2])) profileUrl = nameData[2][0];
          contributorId = nameData[3];
          // nameData[5] = reviewCount (number), nameData[6] = photoCount
          reviewCount = nameData[5];
          // Local Guide: nameData[8] or similar
          // [0,3,1] appears to mean [isLocalGuide, level, ?]
          const lgData = nameData[8];
          if (Array.isArray(lgData) && lgData[0] === 0) localGuide = lgData[1] > 0;
          // Or check for "Local Guide" in nameData[10] (the review count string)
          const reviewCountStr = Array.isArray(nameData[10]) ? nameData[10][0] : null;
          if (reviewCountStr && typeof reviewCountStr === 'string') {
            // Parse "185 reviews" or "Local Guide · 185 reviews"
            const m = reviewCountStr.match(/(\d[\d,]*)\s+reviews?/i);
            if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
            if (reviewCountStr.includes('Local Guide')) localGuide = true;
          }
        }
      }
    }
    
    // relativeTime: item[1][7] or similar
    let relativeTime = null;
    if (Array.isArray(authorData)) {
      relativeTime = authorData[7] || null; // "a year ago"
      if (typeof relativeTime !== 'string') relativeTime = null;
    }
    
    // Rating: look in item data - it's nested deep
    // Based on the response, rating seems to be in item[2] which is a "guided reviews" block
    // Actually let me look at item[1][4][5][...] for star count
    // The rating (1-5) appears in authorData at specific position
    // From earlier analysis: [null,null,["https://...profileUrl"],null,null,["name","avatarUrl",["profileUrl"],"id",null,8,10,null,[0,3,1],1,["8 reviews",...]]]
    // item[1] = [featureId, null, ts1, ts2, [null,null,[profileUrl],null,null,[name,avatar,profile,id,null,reviewCount,photoCount,null,[lgInfo],localGuideLevel,[countStr]]]]
    
    // Rating is in a different part - let me check item[0] more carefully
    // Actually from the response JSON, rating appears in the large block with "GUIDED_DINING" etc.
    // Let me look for starRating in the structure
    // In the detailed output: item[1][4] = [null,null,["reviews/..."],null,null,[name,avatar,...],"a_year_ago",...star...]
    // Actually item[1] = [featureId, null, ts1, ts2, authorArrayWithNull...?]

    // Let me use a different approach - star rating in item[0][2][0][1] area?
    // Actually looking at the response: 
    // reviewItem[0][0] = reviewId
    // reviewItem[0][1] = [featureId, null, ts1, ts2, [null,null,[profileUrl],null,null,authorArr], null, "relTime", ...]
    // reviewItem[0][2] - photos array
    
    // Looking more carefully: data[2][i] has 3 elements: [mainBlock, photoBlock, null]
    // mainBlock[0] = reviewId
    // mainBlock[1] = [featureId, null, ts1, ts2, reviewerInfo, null, relativeTime, ...]
    //   where reviewerInfo = [null, null, [profileReviewsUrl], null, null, [name, avatar, [profileUrl], id, null, reviewCount, photoCount, null, [lgArr], guideLevel, [countStrArr]]]
    
    // Where is the rating? Let me look at index positions more carefully
    // From the raw data I need to find "4" or "5" star rating
    // In item[1]: positions after relativeTime (index 7) might include rating
    
    // Let me try to extract rating from guided review aspects or from a known position
    let rating = null;
    
    // The star rating in Google's internal format - typically at item[1][12] or somewhere after relativeTime
    // Based on the structure: reviewerInfo is at item[1][4], after that we have:
    // item[1][5] = null, item[1][6] = ? , item[1][7] = relativeTime
    // item[1][10] or [1][11] might be star rating  
    // Let's look at what ["Google","https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png",null,null,5]
    // That 5 at the end might be... the platform? Or rating?
    // Actually the 4 stars is probably in the guided review block
    // Let's check reviewItem[2] - the third element of the review tuple
    
    const reviewText = null; // Will be extracted below
    
    // DEBUG: print the raw structure
    console.error(`\n=== Review ${reviewId} structure ===`);
    console.error(`item[1] length: ${Array.isArray(authorData) ? authorData.length : 'not array'}`);
    if (Array.isArray(authorData)) {
      authorData.forEach((v, i) => {
        if (v !== null && i < 20) {
          const repr = JSON.stringify(v);
          if (repr && repr.length > 2) {
            console.error(`  item[1][${i}] = ${repr.substring(0, 200)}`);
          }
        }
      });
    }
    
    return { reviewId, authorName, avatarUrl, profileUrl, contributorId, localGuide, reviewCount, relativeTime };
  } catch (e) {
    console.error(`Error parsing review: ${e.message}`);
    return null;
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
        console.error(`\nCaptured first page. Pagination token: ${paginationToken?.substring(0, 50)}...`);
        console.error(`Reviews in first page: ${firstReviewData?.length}`);
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

    if (!firstReviewData || firstReviewData.length === 0) {
      console.error("No review data captured");
      return;
    }

    // Parse first 3 reviews to understand structure
    console.error("\n=== Parsing reviews to understand structure ===");
    for (let i = 0; i < Math.min(3, firstReviewData.length); i++) {
      const r = parseReview(firstReviewData[i]);
      console.error(`Review ${i}: ${JSON.stringify(r, null, 2)}`);
    }
    
    // Now let's check the 3rd element of a review (the extended data with text/rating)
    console.error("\n=== Detailed review item[0] structure (positions) ===");
    const sampleReview = firstReviewData[0];
    console.error(`sampleReview length: ${sampleReview.length}`);
    sampleReview.forEach((el, i) => {
      if (el !== null) {
        console.error(`sampleReview[${i}] = ${JSON.stringify(el)?.substring(0, 400)}`);
      } else {
        console.error(`sampleReview[${i}] = null`);
      }
    });
    
    // Now try to fetch page 2 using the pagination token
    if (paginationToken && firstRequestUrl) {
      console.error(`\n=== Fetching page 2 with token ===`);
      
      // Parse the original URL to modify the pb param
      const urlObj = new URL(firstRequestUrl);
      const pb = decodeURIComponent(urlObj.searchParams.get('pb'));
      console.error(`Original pb: ${pb}`);
      
      // Replace !2s (empty token) with !2s<token>
      const newPb = pb.replace(/!2m2!1i(\d+)!2s/, `!2m2!1i$1!2s${paginationToken}`);
      console.error(`New pb: ${newPb}`);
      
      urlObj.searchParams.set('pb', newPb);
      const page2Url = urlObj.toString();
      
      // Fetch using page's context (to inherit cookies/auth)
      const page2Response = await page.evaluate(async (url) => {
        const resp = await fetch(url);
        return await resp.text();
      }, page2Url);
      
      const json2 = page2Response.replace(/^\)\]\}'\s*/, "");
      const data2 = JSON.parse(json2);
      console.error(`\nPage 2 response:`);
      console.error(`  data2[0] = ${JSON.stringify(data2[0])}`);
      console.error(`  data2[1] (next token) = ${JSON.stringify(data2[1])?.substring(0, 80)}...`);
      console.error(`  data2[2] (reviews) length = ${Array.isArray(data2[2]) ? data2[2].length : 'N/A'}`);
      
      if (Array.isArray(data2[2]) && data2[2].length > 0) {
        const firstId2 = data2[2][0][0][0];
        console.error(`  First review ID on page 2: ${firstId2}`);
      }
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
