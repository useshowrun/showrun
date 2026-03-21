/**
 * Test hashtag scraping - check what's available on the hashtag page
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    // Capture ALL responses
    const apiResponses = [];
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('instagram.com') && !url.includes('.js') && !url.includes('.css') &&
          !url.includes('.png') && !url.includes('.ico') && !url.includes('.jpg') && !url.includes('.woff')) {
        try {
          const body = await resp.text();
          if (body.length > 50 && !body.startsWith('<!DOCTYPE')) {
            apiResponses.push({ url: url.substring(0,200), status: resp.status(), body: body.substring(0, 800) });
            process.stderr.write(`[RESP] ${resp.status()} ${url.substring(0,100)}\n`);
          }
        } catch {}
      }
    });

    // Navigate to hashtag
    process.stderr.write("Navigating to hashtag page...\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await delay(5000);

    const title = await page.title();
    process.stderr.write(`Title: ${title}\n`);

    // Check for links to posts
    const postLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
      return links.map(l => ({
        href: l.href,
        src: l.querySelector('img')?.src?.substring(0, 100),
      })).slice(0, 12);
    });
    process.stderr.write(`\nPost links found: ${postLinks.length}\n`);
    for (const l of postLinks.slice(0, 3)) {
      process.stderr.write(`  ${l.href}\n`);
    }

    // Check for image elements
    const images = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="cdninstagram"], img[src*="cdninstagram"]'));
      return imgs.map(img => ({
        src: img.src?.substring(0, 100),
        alt: img.alt?.substring(0, 50),
      })).slice(0, 5);
    });
    process.stderr.write(`\nImages found: ${images.length}\n`);

    // Show all captured responses
    process.stderr.write(`\n=== All JSON/text responses ===\n`);
    for (const r of apiResponses) {
      process.stderr.write(`\n[${r.status}] ${r.url}\n${r.body.substring(0,300)}\n---\n`);
    }

    // Check page source for data
    const src = await page.content();
    const hasShortcode = src.includes('shortcode');
    const hasEdge = src.includes('edge_owner');
    process.stderr.write(`\nPage has shortcode: ${hasShortcode}\n`);
    process.stderr.write(`Page has edge_owner: ${hasEdge}\n`);

    // Try to navigate to Instagram explore (not tags)
    process.stderr.write("\n=== Try explore/top page ===\n");
    await page.goto("https://www.instagram.com/explore/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(4000);
    const exploreTitle = await page.title();
    process.stderr.write(`Explore title: ${exploreTitle}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
