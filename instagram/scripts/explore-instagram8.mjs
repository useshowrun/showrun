/**
 * Instagram - test full scraping workflow fresh session
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

const IG_APP_ID = '936619743392459';

async function igFetch(page, url, csrfToken, referer = 'https://www.instagram.com/', method = 'GET', body = null) {
  return page.evaluate(async ({ url, csrf, referer, method, body, appId }) => {
    const headers = {
      'x-ig-app-id': appId,
      'x-csrftoken': csrf,
      'x-requested-with': 'XMLHttpRequest',
      'accept': 'application/json',
      'referer': referer,
    };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    const opts = { headers, credentials: 'include', method };
    if (body) opts.body = body;
    const resp = await fetch(url, opts);
    const text = await resp.text();
    return { status: resp.status, text };
  }, { url, csrf: csrfToken, referer, method, body, appId: IG_APP_ID });
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

    const page = await context.newPage();

    process.stderr.write("Getting cookies by visiting instagram home...\n");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrfToken = cookies.find(c => c.name === 'csrftoken')?.value;
    process.stderr.write(`CSRF: ${csrfToken}\n`);
    process.stderr.write(`Cookies: ${cookies.map(c=>c.name).join(', ')}\n`);

    await delay(2000);

    // Step 1: Get profile
    process.stderr.write("\n=== Step 1: Profile ===\n");
    const profR = await igFetch(page, 'https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', csrfToken);
    process.stderr.write(`Status: ${profR.status}\n`);
    
    if (profR.status === 200) {
      const prof = JSON.parse(profR.text);
      const user = prof.data.user;
      process.stderr.write(`Profile: ${user.username} (${user.id}), ${user.edge_followed_by.count} followers\n`);
      
      const userId = user.id;
      await delay(3000);

      // Step 2: Get posts
      process.stderr.write("\n=== Step 2: User feed ===\n");
      const feedR = await igFetch(page, `https://www.instagram.com/api/v1/feed/user/${userId}/?count=6`, csrfToken);
      process.stderr.write(`Feed status: ${feedR.status}\n`);
      
      if (feedR.status === 200) {
        const feed = JSON.parse(feedR.text);
        process.stderr.write(`Feed keys: ${Object.keys(feed).join(', ')}\n`);
        process.stderr.write(`Items: ${feed.items?.length}\n`);
        
        if (feed.items?.length > 0) {
          const post = feed.items[0];
          process.stderr.write(`\nPost keys: ${Object.keys(post).join(', ')}\n`);
          process.stderr.write(`Post sample: ${JSON.stringify({
            pk: post.pk,
            code: post.code,
            media_type: post.media_type, // 1=photo, 2=video, 8=carousel
            taken_at: post.taken_at,
            like_count: post.like_count,
            comment_count: post.comment_count,
            play_count: post.play_count,
            caption: post.caption?.text?.substring(0, 100),
            image: post.image_versions2?.candidates?.[0]?.url?.substring(0, 80),
            video_url: post.video_url?.substring(0, 80),
            carousel_count: post.carousel_media_count,
            user: { username: post.user?.username, id: post.user?.id },
            hashtags: post.caption?.text?.match(/#\w+/g)?.slice(0,5),
          }, null, 2)}\n`);
          
          await delay(3000);

          // Step 3: Get post details via shortcode
          process.stderr.write("\n=== Step 3: Post details via media info ===\n");
          const mediaR = await igFetch(page, `https://www.instagram.com/api/v1/media/${post.pk}/info/`, csrfToken);
          process.stderr.write(`Media info status: ${mediaR.status}\n${mediaR.text.substring(0, 300)}\n`);

          await delay(2000);

          // Step 4: Get comments 
          process.stderr.write("\n=== Step 4: Post comments ===\n");
          const commR = await igFetch(page, `https://www.instagram.com/api/v1/media/${post.pk}/comments/?can_support_threading=true&permalink_enabled=false`, csrfToken);
          process.stderr.write(`Comments status: ${commR.status}\n${commR.text.substring(0, 500)}\n`);
        }
      } else {
        process.stderr.write(`Feed failed: ${feedR.text.substring(0, 200)}\n`);
      }
    } else {
      process.stderr.write(`Profile failed: ${profR.text.substring(0, 200)}\n`);
    }

    // Test hashtag - try navigating to it in the browser first
    await delay(3000);
    process.stderr.write("\n=== Step 5: Hashtag via navigate ===\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);
    
    const hashCookies = await context.cookies("https://www.instagram.com");
    const newCsrf = hashCookies.find(c => c.name === 'csrftoken')?.value;
    
    // Now try APIs from this page context
    const hashR = await igFetch(page, 
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo',
      newCsrf || csrfToken,
      'https://www.instagram.com/explore/tags/photography/'
    );
    process.stderr.write(`Hashtag page profile API: ${hashR.status}\n${hashR.text.substring(0,200)}\n`);

    // Try to get hashtag posts via tag API
    const tagR = await igFetch(page,
      'https://www.instagram.com/api/v1/tags/web_info/?tag_name=photography',
      newCsrf || csrfToken,
      'https://www.instagram.com/explore/tags/photography/'
    );
    process.stderr.write(`\nTag info: ${tagR.status}\n${tagR.text.substring(0,500)}\n`);

    // Try hashtag feed
    const tagFeedR = await igFetch(page,
      'https://www.instagram.com/api/v1/feed/tag/?tag_name=photography',
      newCsrf || csrfToken,
      'https://www.instagram.com/explore/tags/photography/'
    );
    process.stderr.write(`\nTag feed: ${tagFeedR.status}\n${tagFeedR.text.substring(0,500)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
