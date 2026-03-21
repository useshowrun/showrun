/**
 * Test DOM-based profile scraping and also check if there's an
 * __initialData or similar containing post data in the page source
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    // Capture responses to find data scripts
    const dataScripts = [];
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('instagram.com') && !url.includes('.js') && !url.includes('.css') && 
          !url.includes('.png') && !url.includes('.ico') && !url.includes('.jpg')) {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text/html')) {
          try {
            const body = await resp.text();
            if (body.includes('edge_owner_to_timeline_media') || body.includes('shortcode')) {
              dataScripts.push({ url: url.substring(0,150), body: body.substring(0,2000) });
              process.stderr.write(`[FOUND DATA] ${url.substring(0,100)}\n`);
            }
          } catch {}
        }
      }
    });

    // Navigate directly to profile
    process.stderr.write("Navigating to natgeo profile page...\n");
    await page.goto("https://www.instagram.com/natgeo/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(8000);

    const title = await page.title();
    process.stderr.write(`Title: ${title}\n`);

    // Check for window._sharedData or similar
    const embeddedData = await page.evaluate(() => {
      // Check all script tags for JSON data
      const scripts = Array.from(document.querySelectorAll('script'));
      const jsonScripts = [];
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.includes('edge_owner_to_timeline_media') || t.includes('shortcode') || 
            t.includes('profile_pic_url') || t.includes('biography')) {
          jsonScripts.push(t.substring(0, 500));
        }
      }
      return jsonScripts;
    });
    process.stderr.write(`\nScript tags with data: ${embeddedData.length}\n`);
    for (const s of embeddedData.slice(0, 3)) {
      process.stderr.write(`${s.substring(0, 200)}\n---\n`);
    }

    // Check page source for JSON data
    const src = await page.content();
    const hasProfileData = src.includes('edge_owner_to_timeline_media');
    const hasSharedData = src.includes('_sharedData');
    process.stderr.write(`\nPage source has edge_owner_to_timeline_media: ${hasProfileData}\n`);
    process.stderr.write(`Page source has _sharedData: ${hasSharedData}\n`);

    // Find script with require([ patterns
    const requireScripts = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts
        .filter(s => s.src === '' && (s.textContent.includes('"require"') || s.textContent.includes('shortcode')))
        .map(s => s.textContent.substring(0, 300));
    });
    process.stderr.write(`\nRequire scripts (${requireScripts.length}):\n`);
    for (const s of requireScripts.slice(0, 3)) {
      process.stderr.write(`${s}\n---\n`);
    }

    // Show data scripts captured via network
    process.stderr.write(`\nData scripts from network: ${dataScripts.length}\n`);
    for (const s of dataScripts.slice(0, 2)) {
      process.stderr.write(`${s.url}\n${s.body.substring(0, 500)}\n---\n`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
