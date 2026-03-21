/**
 * Test hashtag scraping - intercept graphql calls to get post data
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    // Capture graphql responses with post data
    const graphqlResponses = [];
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('/api/graphql')) {
        try {
          const body = await resp.text();
          if (body.includes('shortcode') || body.includes('display_url') || body.includes('thumbnail') || 
              body.includes('media') || body.includes('media_shortcode')) {
            graphqlResponses.push({ url: url.substring(0,100), body: body.substring(0, 3000) });
            process.stderr.write(`[GQL HIT] ${url.substring(0,80)}\n`);
          }
        } catch {}
      }
    });

    // Navigate to hashtag
    process.stderr.write("Navigating to hashtag...\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await delay(8000);

    // Get post links
    const postLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
      return links.map(l => ({
        href: l.href,
        src: l.querySelector('img')?.src?.substring(0, 120),
        alt: l.querySelector('img')?.alt?.substring(0, 80),
      })).slice(0, 20);
    });
    process.stderr.write(`\nPost links: ${postLinks.length}\n`);
    for (const l of postLinks.slice(0, 5)) {
      process.stderr.write(`  ${l.href}\n  img: ${l.src}\n  alt: ${l.alt}\n`);
    }

    // See if there are video elements with data
    const videos = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      return vids.map(v => ({
        src: v.src?.substring(0, 100),
        poster: v.poster?.substring(0, 100),
      }));
    });
    process.stderr.write(`\nVideo elements: ${videos.length}\n`);

    // Check the DOM for post card data
    const postCards = await page.evaluate(() => {
      // Find all article elements
      const articles = Array.from(document.querySelectorAll('article, div[role="button"], ._aagw'));
      return articles.slice(0, 5).map(el => ({
        tag: el.tagName,
        classes: el.className.substring(0, 60),
        innerHTML: el.innerHTML?.substring(0, 300),
      }));
    });
    process.stderr.write(`\nPost cards: ${postCards.length}\n`);

    process.stderr.write(`\n=== GraphQL responses with post data ===\n`);
    for (const r of graphqlResponses) {
      process.stderr.write(`\n${r.url}\n${r.body.substring(0, 1000)}\n---\n`);
    }

    // Scroll to see if more posts load
    process.stderr.write("\n=== Scrolling to load more ===\n");
    await page.evaluate(() => window.scrollTo(0, 2000));
    await delay(3000);

    const postLinksAfterScroll = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
      return links.map(l => l.href).slice(0, 30);
    });
    process.stderr.write(`Post links after scroll: ${postLinksAfterScroll.length}\n`);
    for (const l of postLinksAfterScroll.slice(0, 5)) {
      process.stderr.write(`  ${l}\n`);
    }

    process.stderr.write(`\nTotal GQL responses with data: ${graphqlResponses.length}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
