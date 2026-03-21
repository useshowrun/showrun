/**
 * Instagram API exploration - testing web_profile_info with proper headers
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

    // First, get cookies by visiting instagram home
    process.stderr.write("Getting cookies from instagram home...\n");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrfToken = cookies.find(c => c.name === 'csrftoken')?.value;
    process.stderr.write(`CSRF token: ${csrfToken}\n`);

    // All responses from API calls
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/v1/') || url.includes('web_profile') || url.includes('/graphql/')) {
        try {
          const body = await response.text();
          process.stderr.write(`\n[${response.status()}] ${url.substring(0,150)}\n${body.substring(0,800)}\n---\n`);
        } catch {}
      }
    });

    // Try web_profile_info with proper x-ig-app-id header
    // App ID 936619743392459 is the web client app ID
    // Or try 1217981644879628 for the web app
    process.stderr.write("\n=== Test: web_profile_info via fetch in page context ===\n");

    const result = await page.evaluate(async (csrf) => {
      // Use Instagram's own fetch from the page context
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      };
      
      try {
        const resp = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', {
          headers,
          credentials: 'include',
        });
        const text = await resp.text();
        return { status: resp.status, body: text.substring(0, 2000) };
      } catch(e) {
        return { error: e.message };
      }
    }, csrfToken);

    process.stderr.write(`Result: ${JSON.stringify(result, null, 2)}\n`);

    // Also try the user search
    process.stderr.write("\n=== Test: user search ===\n");
    const result2 = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      };
      try {
        const resp = await fetch('https://www.instagram.com/api/v1/web/search/topsearch/?context=user&query=natgeo&rank_token=&include_reel=true', {
          headers,
          credentials: 'include',
        });
        const text = await resp.text();
        return { status: resp.status, body: text.substring(0, 2000) };
      } catch(e) {
        return { error: e.message };
      }
    }, csrfToken);
    process.stderr.write(`Search result: ${JSON.stringify(result2, null, 2)}\n`);

    // Try hashtag search
    process.stderr.write("\n=== Test: hashtag search ===\n");
    const result3 = await page.evaluate(async (csrf) => {
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      };
      try {
        const resp = await fetch('https://www.instagram.com/api/v1/tags/search/?q=photography', {
          headers,
          credentials: 'include',
        });
        const text = await resp.text();
        return { status: resp.status, body: text.substring(0, 2000) };
      } catch(e) {
        return { error: e.message };
      }
    }, csrfToken);
    process.stderr.write(`Hashtag search: ${JSON.stringify(result3, null, 2)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
