#!/usr/bin/env node
/**
 * Exploration script: capture XHR requests when clicking "See all reviews" 
 * and scrolling reviews pane on Google Maps.
 * Run with: node explore-reviews.mjs <placeId>
 */

import { Camoufox } from "camoufox-js";

const placeId = process.argv[2] || "ChIJi4Zj86xP0xQRNsqp2ceMJ38";
const targetUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.error(`Exploring: ${targetUrl}`);

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

    // Track all XHR/Fetch requests
    const requests = [];
    context.on("request", (req) => {
      const url = req.url();
      if (url.includes("google.com") && 
          !url.includes("googleapis.com/maps/api/js") &&
          !url.includes(".css") && !url.includes(".js") &&
          !url.includes(".png") && !url.includes(".jpg") &&
          !url.includes(".woff") && !url.includes("static2") &&
          !url.includes("accounts.google.com")) {
        const type = req.resourceType();
        if (type === "xhr" || type === "fetch" || type === "document") {
          requests.push({ url: url.substring(0, 200), method: req.method(), type });
          console.error(`[${type.toUpperCase()}] ${req.method()} ${url.substring(0, 150)}`);
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

    // Wait for page to load
    await delay(3000);
    
    console.error("\n=== PAGE LOADED ===");
    console.error("URL:", page.url().substring(0, 100));

    // Look for reviews tab button
    const reviewsTabSelector = [
      'button[aria-label*="Reviews for"]',
      'button[aria-label*="Reviews,"]',
      'button[aria-label*="review"]',
    ];
    
    for (const sel of reviewsTabSelector) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.error(`Found reviews tab with selector: ${sel} (${count} matches)`);
        const labels = await page.locator(sel).evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
        console.error("Labels:", labels);
        break;
      }
    }
    
    // Look for "See all reviews" button
    const seeAllReviews = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll('button, a'));
      return allButtons
        .filter(b => {
          const t = b.textContent.trim();
          const l = b.getAttribute('aria-label') || '';
          return (t.includes('review') || l.includes('review')) && t.length < 100;
        })
        .map(b => ({
          tag: b.tagName,
          text: b.textContent.trim().substring(0, 80),
          ariaLabel: b.getAttribute('aria-label'),
          jsaction: b.getAttribute('jsaction'),
        }))
        .slice(0, 20);
    });
    console.error("\n=== Review-related buttons/links ===");
    console.error(JSON.stringify(seeAllReviews, null, 2));
    
    // Look for sort dropdown
    const sortElements = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('[aria-label*="Sort"], [aria-label*="sort"]'));
      return allEls.map(el => ({
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label'),
        text: el.textContent.trim().substring(0, 50),
      }));
    });
    console.error("\n=== Sort elements ===");
    console.error(JSON.stringify(sortElements, null, 2));

    // Click the Reviews tab
    console.error("\n=== Clicking Reviews tab ===");
    try {
      const reviewsTab = page.locator('button[aria-label*="Reviews for"]').first();
      if (await reviewsTab.isVisible({ timeout: 3000 })) {
        await reviewsTab.click();
        console.error("Clicked reviews tab");
        await delay(3000);
      }
    } catch (e) {
      console.error("Could not click reviews tab:", e.message);
    }
    
    // Check current state
    const reviewCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-review-id]')).length;
    });
    console.error(`Reviews in DOM: ${reviewCount}`);
    
    // Scroll the reviews pane
    console.error("\n=== Scrolling reviews pane ===");
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="main"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
      });
      await delay(2000);
      const count = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[data-review-id]')).length;
      });
      console.error(`After scroll ${i+1}: ${count} reviews`);
    }
    
    // Check for pagination token or "More reviews" button
    const paginationInfo = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll('button'));
      const moreBtn = allButtons.filter(b => {
        const t = b.textContent.trim();
        return t.toLowerCase().includes('more') && t.length < 50;
      }).map(b => ({ text: b.textContent.trim(), ariaLabel: b.getAttribute('aria-label') }));
      
      // Check for pagination in URL
      const url = window.location.href;
      
      // Look for nextpagetoken or pagination elements
      const pagEl = document.querySelector('[data-page-token], [jsname="LgbsSe"]');
      
      return { moreButtons: moreBtn.slice(0, 5), url: url.substring(0, 150), pagEl: pagEl ? pagEl.outerHTML.substring(0, 200) : null };
    });
    console.error("\n=== Pagination info ===");
    console.error(JSON.stringify(paginationInfo, null, 2));

    // Check reviews DOM structure
    const reviewStructure = await page.evaluate(() => {
      const reviews = Array.from(document.querySelectorAll('[data-review-id]')).slice(0, 2);
      return reviews.map(r => ({
        reviewId: r.getAttribute('data-review-id'),
        outerHTML: r.outerHTML.substring(0, 500),
      }));
    });
    console.error("\n=== Sample review structure ===");
    console.error(JSON.stringify(reviewStructure, null, 2));

    console.error("\n=== All captured URLs ===");
    requests.forEach(r => console.error(`[${r.type}] ${r.method} ${r.url}`));

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
