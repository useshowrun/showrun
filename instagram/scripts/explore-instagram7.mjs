/**
 * Instagram - try scraping via page navigation (DOM-based approach)
 * Also test what happens when we visit the profile page directly
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

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

    const capturedApiCalls = [];
    const page = await context.newPage();

    // Capture all API calls and responses
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/v1/') && !url.includes('.js') && !url.includes('.css')) {
        try {
          const body = await response.text();
          if (!body.startsWith('<!DOCTYPE') && body.length > 10) {
            capturedApiCalls.push({ url: url.substring(0, 200), status: response.status(), body: body.substring(0, 500) });
            process.stderr.write(`[API] [${response.status()}] ${url.substring(0, 100)}\n`);
          }
        } catch {}
      }
    });

    // Visit instagram.com profile directly (not home first)
    process.stderr.write("=== Direct navigate to natgeo profile ===\n");
    await page.goto("https://www.instagram.com/natgeo/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(8000);

    const title = await page.title();
    process.stderr.write(`Title: ${title}\n`);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    process.stderr.write(`Body text: ${bodyText}\n`);

    process.stderr.write(`\nAll captured API calls:\n`);
    for (const call of capturedApiCalls) {
      process.stderr.write(`\n[${call.status}] ${call.url}\n${call.body.substring(0,300)}\n---\n`);
    }

    // Check what the page renders
    const pageContent = await page.evaluate(() => {
      // Find all article elements or link elements
      const articles = Array.from(document.querySelectorAll('article, a[href*="/p/"], a[href*="/reel/"]'));
      return articles.map(el => ({
        tag: el.tagName,
        href: el.getAttribute('href')?.substring(0, 100),
        text: el.innerText?.substring(0, 50),
      })).slice(0, 20);
    });
    process.stderr.write(`\nPage links: ${JSON.stringify(pageContent, null, 2)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
