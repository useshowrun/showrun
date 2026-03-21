/**
 * Instagram - test shortcode_media and other post detail APIs
 * Also test if pagination of profile posts works without login
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));
const IG_APP_ID = '936619743392459';

async function igFetch(page, url, csrf, referer = 'https://www.instagram.com/') {
  return page.evaluate(async ({ url, csrf, referer, appId }) => {
    const resp = await fetch(url, {
      headers: {
        'x-ig-app-id': appId,
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': referer,
      },
      credentials: 'include',
    });
    return { status: resp.status, text: await resp.text() };
  }, { url, csrf, referer, appId: IG_APP_ID });
}

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrf = cookies.find(c => c.name === 'csrftoken')?.value;

    // Get profile
    const profR = await igFetch(page, 'https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', csrf);
    const prof = JSON.parse(profR.text);
    const user = prof.data.user;
    const posts = user.edge_owner_to_timeline_media.edges;
    const endCursor = user.edge_owner_to_timeline_media.page_info.end_cursor;
    const shortcode = posts[0].node.shortcode;
    const mediaId = posts[0].node.id;

    process.stderr.write(`First post shortcode: ${shortcode}, id: ${mediaId}\n`);
    await delay(2000);

    // Test media_v2/shortcode
    process.stderr.write("\n=== Test: media by shortcode ===\n");
    const sc1R = await igFetch(page, `https://www.instagram.com/api/v1/media/shortcode/${shortcode}/`, csrf);
    process.stderr.write(`Shortcode API: ${sc1R.status}\n${sc1R.text.substring(0, 200)}\n`);

    await delay(2000);

    // Test media info by id
    process.stderr.write("\n=== Test: media info by id ===\n");
    const mi1R = await igFetch(page, `https://www.instagram.com/api/v1/media/${mediaId}/info/`, csrf);
    process.stderr.write(`Media info: ${mi1R.status}\n${mi1R.text.substring(0, 200)}\n`);

    await delay(2000);

    // Test comments
    process.stderr.write("\n=== Test: comments ===\n");
    const commR = await igFetch(page, `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true`, csrf);
    process.stderr.write(`Comments: ${commR.status}\n${commR.text.substring(0, 200)}\n`);

    await delay(2000);

    // Test p/{shortcode} for post details via HTML JSON
    process.stderr.write("\n=== Test: post page HTML has JSON data? ===\n");
    const postPageR = await igFetch(page, `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, csrf);
    process.stderr.write(`Post page JSON: ${postPageR.status}\n${postPageR.text.substring(0, 300)}\n`);

    await delay(2000);

    // Test pagination: try the same endpoint with ?max_id=cursor
    process.stderr.write("\n=== Test: Pagination with end cursor ===\n");
    const page2R = await igFetch(page, 
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo&max_id=${encodeURIComponent(endCursor)}`,
      csrf
    );
    process.stderr.write(`Pagination: ${page2R.status}\n${page2R.text.substring(0, 300)}\n`);

    await delay(2000);

    // Test a search API for users 
    process.stderr.write("\n=== Test: User search ===\n");
    const searchR = await igFetch(page, 
      'https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=photography&rank_token=&include_reel=true',
      csrf
    );
    process.stderr.write(`Search: ${searchR.status}\n${searchR.text.substring(0, 300)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
