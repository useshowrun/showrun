/**
 * Instagram - test navigating to profile page with fresh browser and network interception
 * to capture what data is returned by the page itself
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({
    headless: false, // show browser for debugging
    humanize: 1,
    screen: { minWidth: 1440, minHeight: 900 },
  });

  const capturedData = {};

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await context.newPage();

    // Capture network responses
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/v1/') && response.status() === 200) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const body = await response.text();
            capturedData[url] = body.substring(0, 2000);
            process.stderr.write(`[CAPTURED] [200] ${url.substring(0,120)}\n`);
          }
        } catch {}
      }
    });

    // Navigate directly to natgeo profile 
    process.stderr.write("Navigating to natgeo profile...\n");
    await page.goto("https://www.instagram.com/natgeo/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(8000);

    const title = await page.title();
    process.stderr.write(`Title: ${title}\n`);

    // Check if login wall or profile
    const isLoginWall = await page.evaluate(() => {
      return document.body.innerText.includes('Log into Instagram') || 
             document.body.innerText.includes('Log In');
    });
    process.stderr.write(`Login wall: ${isLoginWall}\n`);

    if (!isLoginWall) {
      // Try to find post links
      const postLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
        return links.map(l => l.href).slice(0, 12);
      });
      process.stderr.write(`Post links: ${JSON.stringify(postLinks)}\n`);
    }

    // Show all captured data
    process.stderr.write("\n=== Captured API data ===\n");
    for (const [url, data] of Object.entries(capturedData)) {
      process.stderr.write(`\n${url}:\n${data}\n---\n`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
