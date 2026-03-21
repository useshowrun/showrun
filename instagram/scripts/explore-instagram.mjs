/**
 * Instagram API exploration script.
 * Navigates to a profile and captures all API calls made.
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  const apiCalls = [];
  const cookies = {};

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Intercept requests to capture headers
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.includes('instagram.com') && (
        url.includes('/api/v1/') || 
        url.includes('/graphql') || 
        url.includes('web_profile') ||
        url.includes('?__a=1') ||
        url.includes('&__a=1')
      )) {
        apiCalls.push({
          method: req.method(),
          url: url.substring(0, 300),
          headers: req.headers(),
          postData: req.postData() ? req.postData().substring(0, 500) : null,
        });
      }
      await route.continue();
    });

    // Capture responses
    const responses = {};
    
    const page = await context.newPage();

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('instagram.com') && (
        url.includes('/api/v1/') || url.includes('/graphql') || url.includes('web_profile')
      )) {
        try {
          const body = await response.text();
          responses[url.substring(0, 200)] = {
            status: response.status(),
            body: body.substring(0, 1000),
          };
        } catch {}
      }
    });

    process.stderr.write("=== Navigating to instagram.com home ===\n");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(3000);

    const instaCookies = await context.cookies("https://www.instagram.com");
    process.stderr.write(`\nCookies after home: ${instaCookies.map(c=>c.name).join(', ')}\n`);

    process.stderr.write("\n=== Navigating to instagram profile (instagram official) ===\n");
    await page.goto("https://www.instagram.com/instagram/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);

    const title = await page.title();
    process.stderr.write(`Title: ${title}\n`);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    process.stderr.write(`Body: ${bodyText}\n`);

    process.stderr.write("\n=== API Calls Captured ===\n");
    for (const call of apiCalls) {
      process.stderr.write(`\n[${call.method}] ${call.url}\n`);
      const importantHeaders = {};
      for (const key of ['x-ig-app-id', 'x-csrftoken', 'x-asbd-id', 'x-ig-www-claim', 'x-requested-with', 'cookie', 'user-agent']) {
        if (call.headers[key]) importantHeaders[key] = call.headers[key].substring(0, 100);
      }
      process.stderr.write(`  Headers: ${JSON.stringify(importantHeaders)}\n`);
      if (call.postData) process.stderr.write(`  PostData: ${call.postData}\n`);
    }

    process.stderr.write("\n=== Responses ===\n");
    for (const [url, resp] of Object.entries(responses)) {
      process.stderr.write(`\n[${resp.status}] ${url}\n${resp.body}\n`);
    }

    // Try navigating to a hashtag
    process.stderr.write("\n=== Navigating to hashtag ===\n");
    await page.goto("https://www.instagram.com/explore/tags/photography/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(4000);

    const hashtagBody = await page.evaluate(() => document.body.innerText.substring(0, 300));
    process.stderr.write(`Hashtag body: ${hashtagBody}\n`);

    process.stderr.write("\n=== All API Calls (total) ===\n");
    for (const call of apiCalls) {
      process.stderr.write(`[${call.method}] ${call.url.substring(0, 150)}\n`);
    }

    // Check final cookies
    const finalCookies = await context.cookies("https://www.instagram.com");
    process.stderr.write(`\nFinal cookies: ${finalCookies.map(c=>`${c.name}=${c.value.substring(0,20)}`).join('\n  ')}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
