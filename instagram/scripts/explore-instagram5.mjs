/**
 * Instagram API exploration - get full data structures
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

    // Get profile + posts full data
    const fullData = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      };

      // Get profile
      const profResp = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', {
        headers, credentials: 'include'
      });
      const profData = await profResp.json();
      const userId = profData?.data?.user?.id;

      // Get posts
      const feedResp = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/?count=3`, {
        headers, credentials: 'include'
      });
      const feedData = await feedResp.json();

      return {
        profile: {
          id: profData?.data?.user?.id,
          username: profData?.data?.user?.username,
          full_name: profData?.data?.user?.full_name,
          biography: profData?.data?.user?.biography,
          followers: profData?.data?.user?.edge_followed_by?.count,
          following: profData?.data?.user?.edge_follow?.count,
          is_verified: profData?.data?.user?.is_verified,
          is_private: profData?.data?.user?.is_private,
          profile_pic_url: profData?.data?.user?.profile_pic_url,
          external_url: profData?.data?.user?.external_url,
          post_count: profData?.data?.user?.edge_owner_to_timeline_media?.count,
        },
        feed: feedData,
        firstPost: feedData?.items?.[0] ? JSON.stringify(feedData.items[0]).substring(0, 3000) : null,
      };
    }, csrfToken);

    process.stderr.write(`Profile: ${JSON.stringify(fullData.profile, null, 2)}\n`);
    process.stderr.write(`\nFirst post keys: ${Object.keys(JSON.parse(fullData.firstPost || '{}')).join(', ')}\n`);
    process.stderr.write(`\nFirst post: ${fullData.firstPost}\n`);
    
    // Also test topsearch 
    process.stderr.write("\n=== Test: Top search (full_name approach) ===\n");
    const searchData = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/explore/',
        'origin': 'https://www.instagram.com',
      };
      // Try topsearch from within /explore context
      const resp = await fetch('https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=natgeo&rank_token=&include_reel=true', {
        headers, credentials: 'include'
      });
      const text = await resp.text();
      return { status: resp.status, body: text.substring(0, 1000) };
    }, csrfToken);
    process.stderr.write(`Search: ${JSON.stringify(searchData, null, 2)}\n`);

    // Test hashtag sections via navigate to explore/tags first
    process.stderr.write("\n=== Test: Navigate to hashtag page and get data ===\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);
    
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    process.stderr.write(`Hashtag page title: ${title}\n`);
    process.stderr.write(`Body: ${bodyText}\n`);

    // Try API from hashtag page context
    const hashData = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/explore/tags/photography/',
      };
      
      const results = {};
      
      // Try sections endpoint  
      try {
        const r1 = await fetch('https://www.instagram.com/api/v1/tags/photography/sections/', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'max_id=&page=1&surface=grid&count=12&tab=top',
          credentials: 'include'
        });
        const t1 = await r1.text();
        results.sections = { status: r1.status, body: t1.substring(0, 500) };
      } catch(e) { results.sections_err = e.message; }

      // Try graphql approach
      try {
        const vars = encodeURIComponent(JSON.stringify({tag_name: 'photography', first: 12}));
        const r2 = await fetch(`https://www.instagram.com/graphql/query/?query_hash=9b498c08113f1e09617a1703c22b2f32&variables=${vars}`, {
          headers, credentials: 'include'
        });
        const t2 = await r2.text();
        results.graphql = { status: r2.status, body: t2.substring(0, 500) };
      } catch(e) { results.graphql_err = e.message; }

      return results;
    }, csrfToken);
    process.stderr.write(`Hashtag data: ${JSON.stringify(hashData, null, 2)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
