/**
 * Instagram API exploration - deeper API testing from page context
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

    // Visit home to get cookies
    process.stderr.write("Getting cookies...\n");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrfToken = cookies.find(c => c.name === 'csrftoken')?.value;
    process.stderr.write(`CSRF token: ${csrfToken}\n`);

    // All API responses captured
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/v1/') || url.includes('/graphql/')) {
        try {
          const body = await response.text();
          if (!body.includes('<!DOCTYPE')) {
            process.stderr.write(`\n[${response.status()}] ${url.substring(0,200)}\n${body.substring(0,500)}\n---\n`);
          }
        } catch {}
      }
    });

    // Test getting user ID from profile
    process.stderr.write("\n=== Test: Get NatGeo full profile ===\n");
    const profileResult = await page.evaluate(async (csrf) => {
      const resp = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', {
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-csrftoken': csrf,
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json',
          'referer': 'https://www.instagram.com/',
        },
        credentials: 'include',
      });
      const data = await resp.json();
      return { status: resp.status, userId: data?.data?.user?.id, username: data?.data?.user?.full_name };
    }, csrfToken);
    process.stderr.write(`Profile: ${JSON.stringify(profileResult)}\n`);

    const userId = profileResult.userId;
    process.stderr.write(`User ID: ${userId}\n`);

    // Now test getting posts by user
    process.stderr.write("\n=== Test: User posts (media) ===\n");
    const postsResult = await page.evaluate(async ({ csrf, userId }) => {
      // Try multiple known endpoints for user media
      const endpoints = [
        `https://www.instagram.com/api/v1/feed/user/${userId}/?count=12`,
        `https://www.instagram.com/api/v1/feed/user/natgeo/?count=12`,
        `https://www.instagram.com/graphql/query/?query_hash=f2405b236d85e8296cf30347c9f08c2a&variables=${encodeURIComponent(JSON.stringify({id: userId, first: 12}))}`,
      ];
      
      const results = [];
      for (const url of endpoints) {
        try {
          const resp = await fetch(url, {
            headers: {
              'x-ig-app-id': '936619743392459',
              'x-csrftoken': csrf,
              'x-requested-with': 'XMLHttpRequest',
              'accept': 'application/json',
              'referer': 'https://www.instagram.com/',
            },
            credentials: 'include',
          });
          const text = await resp.text();
          results.push({ url: url.substring(0, 100), status: resp.status, body: text.substring(0, 300) });
        } catch(e) {
          results.push({ url: url.substring(0, 100), error: e.message });
        }
      }
      return results;
    }, { csrf: csrfToken, userId });

    for (const r of postsResult) {
      process.stderr.write(`\n${JSON.stringify(r, null, 2)}\n`);
    }

    // Test hashtag
    process.stderr.write("\n=== Test: Hashtag info ===\n");
    const hashtagResult = await page.evaluate(async (csrf) => {
      const urls = [
        `https://www.instagram.com/api/v1/tags/info/?tag_name=photography`,
        `https://www.instagram.com/api/v1/tags/photography/sections/?max_id=&page=1&surface=grid&count=48`,
        `https://www.instagram.com/api/v1/feed/tag/?tag_name=photography&count=12`,
      ];
      const results = [];
      for (const url of urls) {
        try {
          const resp = await fetch(url, {
            headers: {
              'x-ig-app-id': '936619743392459',
              'x-csrftoken': csrf,
              'x-requested-with': 'XMLHttpRequest',
              'accept': 'application/json',
              'referer': 'https://www.instagram.com/',
            },
            credentials: 'include',
          });
          const text = await resp.text();
          results.push({ url: url.substring(0, 100), status: resp.status, body: text.substring(0, 500) });
        } catch(e) {
          results.push({ url: url.substring(0, 100), error: e.message });
        }
      }
      return results;
    }, csrfToken);

    for (const r of hashtagResult) {
      process.stderr.write(`\n${JSON.stringify(r, null, 2)}\n`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
