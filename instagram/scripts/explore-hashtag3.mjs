/**
 * Test hashtag scraping - extract from video elements and find shortcodes
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    // Intercept ALL graphql calls to see what's being requested/returned
    const graphqlCalls = [];
    await context.route('**/api/graphql', async (route) => {
      const req = route.request();
      const postData = req.postData();
      graphqlCalls.push({ 
        method: req.method(),
        postData: postData?.substring(0, 500),
        headers: {
          'x-fb-friendly-name': req.headers()['x-fb-friendly-name'],
          'x-csrftoken': req.headers()['x-csrftoken'],
          'x-ig-app-id': req.headers()['x-ig-app-id'],
        },
      });
      await route.continue();
    });

    const graphqlResps = [];
    page.on('response', async (resp) => {
      if (resp.url().includes('/api/graphql')) {
        try {
          const body = await resp.text();
          graphqlResps.push(body.substring(0, 2000));
        } catch {}
      }
    });

    process.stderr.write("Navigating to hashtag...\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await delay(8000);

    // Examine video elements - they should have data attributes
    const videoData = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      return vids.map(v => ({
        src: v.src?.substring(0, 150),
        poster: v.poster?.substring(0, 150),
        dataset: JSON.stringify(v.dataset),
        parent_href: v.closest('a')?.href,
        parent_classes: v.closest('a')?.className,
        grandparent: v.parentElement?.parentElement?.innerHTML?.substring(0, 200),
      })).slice(0, 3);
    });
    process.stderr.write(`\nVideo elements: ${JSON.stringify(videoData, null, 2)}\n`);

    // Look for any anchors with href containing reels/posts
    const allLinks = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a'));
      return all
        .filter(a => a.href && (a.href.includes('/reel/') || a.href.includes('/p/')))
        .map(a => a.href)
        .slice(0, 20);
    });
    process.stderr.write(`\nAll reel/post links: ${JSON.stringify(allLinks)}\n`);

    // Check for data in the page's HTML scripts 
    const jsData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const t = s.textContent;
        if (t && (t.includes('"shortcode"') || t.includes('"media_shortcode"'))) {
          return t.substring(0, 2000);
        }
      }
      return null;
    });
    process.stderr.write(`\nScript with shortcode: ${jsData?.substring(0, 500) || 'none'}\n`);

    // Show all GraphQL calls
    process.stderr.write(`\n=== GraphQL calls (${graphqlCalls.length}) ===\n`);
    for (const c of graphqlCalls) {
      process.stderr.write(`\nFriendly name: ${c.headers['x-fb-friendly-name']}\nPostData: ${c.postData?.substring(0,200)}\n`);
    }

    process.stderr.write(`\n=== GraphQL responses (${graphqlResps.length}) ===\n`);
    for (const r of graphqlResps.slice(0, 5)) {
      process.stderr.write(`\n${r.substring(0, 400)}\n---\n`);
    }

    // Look for HashtagTopMediaFeed data
    const hashtagData = graphqlResps.find(r => r.includes('hashtag'));
    if (hashtagData) {
      process.stderr.write(`\nHashtag data found: ${hashtagData.substring(0, 1000)}\n`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
