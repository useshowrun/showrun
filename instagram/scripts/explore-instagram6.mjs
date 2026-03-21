/**
 * Instagram API exploration - examine full feed response and hashtag via page DOM
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

    const page = await context.newPage();

    process.stderr.write("Getting cookies...\n");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrfToken = cookies.find(c => c.name === 'csrftoken')?.value;

    // Capture network response bodies
    const capturedResponses = {};
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/v1/feed/user/') || url.includes('/api/v1/users/web_profile_info')) {
        try {
          const body = await response.text();
          capturedResponses[url] = body.substring(0, 5000);
          process.stderr.write(`\n[CAPTURED] ${url.substring(0,100)}\n`);
        } catch {}
      }
    });

    // Get full feed response
    process.stderr.write("\n=== Get feed for natgeo ===\n");
    const feedData = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      };
      const resp = await fetch('https://www.instagram.com/api/v1/feed/user/787132/?count=3', {
        headers, credentials: 'include'
      });
      const json = await resp.json();
      return JSON.stringify(json);
    }, csrfToken);
    
    // The full feed response
    const feedObj = JSON.parse(feedData);
    process.stderr.write(`Feed keys: ${Object.keys(feedObj).join(', ')}\n`);
    process.stderr.write(`Items count: ${feedObj.items?.length}\n`);
    
    if (feedObj.items && feedObj.items.length > 0) {
      const post = feedObj.items[0];
      process.stderr.write(`\nFirst post keys: ${Object.keys(post).join(', ')}\n`);
      process.stderr.write(`\nPost: ${JSON.stringify({
        id: post.id,
        pk: post.pk,
        media_type: post.media_type, // 1=photo, 2=video, 8=carousel
        caption: post.caption?.text?.substring(0, 100),
        like_count: post.like_count,
        comment_count: post.comment_count,
        taken_at: post.taken_at,
        code: post.code, // shortcode for URL
        user: { id: post.user?.id, username: post.user?.username },
        image_versions: post.image_versions2?.candidates?.[0]?.url?.substring(0,80),
        video_url: post.video_url?.substring(0, 80),
        carousel_media_count: post.carousel_media_count,
      }, null, 2)}\n`);
    }
    
    // Test hashtag scraping via DOM on the hashtag page
    process.stderr.write("\n=== Navigate to hashtag page - extract DOM ===\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);

    // Check what's in the DOM 
    const htmlSnippet = await page.evaluate(() => {
      return document.documentElement.innerHTML.substring(0, 3000);
    });
    process.stderr.write(`HTML snippet: ${htmlSnippet.substring(0,1000)}\n`);

    // Check for shared_data or window data
    const sharedData = await page.evaluate(() => {
      try {
        // Look for __additionalData or window._sharedData
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        const texts = scripts.map(s => s.textContent.substring(0, 200));
        return texts;
      } catch(e) { return e.message; }
    });
    process.stderr.write(`\nJSON scripts: ${JSON.stringify(sharedData).substring(0,1000)}\n`);

    // Try __additionalDataLoaded or window._sharedData
    const windowData = await page.evaluate(() => {
      try {
        if (window._sharedData) return JSON.stringify(window._sharedData).substring(0, 500);
        if (window.__additionalData) return JSON.stringify(window.__additionalData).substring(0, 500);
        return 'no window data';
      } catch(e) { return e.message; }
    });
    process.stderr.write(`Window data: ${windowData}\n`);

    // Extract post data from the hashtag page using modern API
    const hashtagData = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/explore/tags/photography/',
      };
      
      // Try tags info endpoint
      const r1 = await fetch('https://www.instagram.com/api/v1/tags/web_info/?tag_name=photography', {
        headers, credentials: 'include'
      });
      const t1 = await r1.text();

      // Try reels/clips API
      const r2 = await fetch('https://www.instagram.com/api/v1/clips/hashtag/?hashtag=photography&count=12', {
        headers, credentials: 'include'
      });
      const t2 = await r2.text();

      return {
        web_info: { status: r1.status, body: t1.substring(0, 500) },
        clips: { status: r2.status, body: t2.substring(0, 500) },
      };
    }, csrfToken);
    process.stderr.write(`Hashtag API: ${JSON.stringify(hashtagData, null, 2)}\n`);

    // Navigate to a post page
    process.stderr.write("\n=== Navigate to actual post page ===\n");
    // Use a real natgeo post shortcode from the feed data we already got
    if (feedObj.items && feedObj.items.length > 0) {
      const code = feedObj.items[0].code;
      process.stderr.write(`Post code: ${code}\n`);
      
      if (code) {
        await page.goto(`https://www.instagram.com/p/${code}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await delay(3000);
        const postBody = await page.evaluate(() => document.body.innerText.substring(0, 500));
        process.stderr.write(`Post page: ${postBody}\n`);

        // Try post API
        const postData = await page.evaluate(async ({ csrf, code }) => {
          const headers = {
            'x-ig-app-id': '936619743392459',
            'x-csrftoken': csrf,
            'x-requested-with': 'XMLHttpRequest',
            'accept': 'application/json',
            'referer': `https://www.instagram.com/p/${code}/`,
          };
          
          const r = await fetch(`https://www.instagram.com/api/v1/media/${code}/info/`, {
            headers, credentials: 'include'
          });
          return { status: r.status, body: (await r.text()).substring(0, 500) };
        }, { csrf: csrfToken, code });
        process.stderr.write(`Post API: ${JSON.stringify(postData, null, 2)}\n`);
      }
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
