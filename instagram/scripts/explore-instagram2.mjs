/**
 * Instagram API exploration - try different approaches for public data
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({
    headless: true,
    humanize: 1,
    screen: { minWidth: 1280, minHeight: 800 },
  });

  const allRequests = [];

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Capture ALL instagram.com requests
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.includes('instagram.com')) {
        allRequests.push({
          method: req.method(),
          url: url.substring(0, 250),
        });
      }
      await route.continue();
    });

    const allResponses = [];
    const page = await context.newPage();

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('instagram.com') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.ico')) {
        try {
          const status = response.status();
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('text')) {
            const body = await response.text();
            allResponses.push({ url: url.substring(0, 200), status, body: body.substring(0, 800) });
          }
        } catch {}
      }
    });

    // Try approach 1: embed URL
    process.stderr.write("=== Test 1: Embed URL ===\n");
    await page.goto("https://www.instagram.com/p/C1234567890/embed/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);
    let body = await page.evaluate(() => document.body.innerText.substring(0, 200));
    process.stderr.write(`Body: ${body}\n`);

    // Try approach 2: oembed API
    process.stderr.write("\n=== Test 2: oEmbed API ===\n");
    await page.goto("https://www.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/C1234567890/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);
    body = await page.evaluate(() => document.body.innerText.substring(0, 500));
    process.stderr.write(`OEmbed: ${body}\n`);

    // Try approach 3: web_profile_info
    process.stderr.write("\n=== Test 3: web_profile_info ===\n");
    await page.goto("https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);
    body = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    process.stderr.write(`Profile API: ${body}\n`);

    // Try approach 4: graphql query
    process.stderr.write("\n=== Test 4: GraphQL ===\n");
    await page.goto("https://www.instagram.com/graphql/query/?query_hash=d4d88dc1500312af6f937f7b804c68c3&variables=%7B%22user_id%22%3A%2225025320%22%2C%22include_chaining%22%3Atrue%7D", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);
    body = await page.evaluate(() => document.body.innerText.substring(0, 500));
    process.stderr.write(`GraphQL: ${body}\n`);

    // Try approach 5: hashtag graphql
    process.stderr.write("\n=== Test 5: Hashtag GraphQL ===\n");
    const vars = encodeURIComponent(JSON.stringify({tag_name: "photography", first: 12}));
    await page.goto(`https://www.instagram.com/graphql/query/?query_hash=9b498c08113f1e09617a1703c22b2f32&variables=${vars}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(2000);
    body = await page.evaluate(() => document.body.innerText.substring(0, 500));
    process.stderr.write(`Hashtag GraphQL: ${body}\n`);

    // Responses summary
    process.stderr.write("\n=== All JSON Responses ===\n");
    for (const r of allResponses) {
      process.stderr.write(`\n[${r.status}] ${r.url}\n${r.body}\n---\n`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
