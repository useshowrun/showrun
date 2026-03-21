/**
 * Instagram - test pagination and extract post structure fully
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));
const IG_APP_ID = '936619743392459';

async function igFetch(page, url, csrf) {
  return page.evaluate(async ({ url, csrf, appId }) => {
    const resp = await fetch(url, {
      headers: {
        'x-ig-app-id': appId,
        'x-csrftoken': csrf,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json',
        'referer': 'https://www.instagram.com/',
      },
      credentials: 'include',
    });
    return { status: resp.status, text: await resp.text() };
  }, { url, csrf, appId: IG_APP_ID });
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
    process.stderr.write(`CSRF: ${csrf}\n`);

    // Page 1
    process.stderr.write("\n=== Page 1 ===\n");
    const p1R = await igFetch(page, 'https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', csrf);
    const p1 = JSON.parse(p1R.text);
    const user = p1.data.user;
    const p1Posts = user.edge_owner_to_timeline_media.edges;
    const p1Cursor = user.edge_owner_to_timeline_media.page_info.end_cursor;
    process.stderr.write(`Page 1 posts: ${p1Posts.length}, cursor: ${p1Cursor.substring(0,30)}...\n`);
    const p1Ids = p1Posts.map(e => e.node.shortcode);
    process.stderr.write(`P1 IDs: ${p1Ids.join(', ')}\n`);

    await delay(3000);

    // Page 2
    process.stderr.write("\n=== Page 2 (pagination) ===\n");
    const p2R = await igFetch(page, `https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo&max_id=${encodeURIComponent(p1Cursor)}`, csrf);
    const p2 = JSON.parse(p2R.text);
    const p2Posts = p2.data.user.edge_owner_to_timeline_media.edges;
    const p2Cursor = p2.data.user.edge_owner_to_timeline_media.page_info.end_cursor;
    const p2HasNext = p2.data.user.edge_owner_to_timeline_media.page_info.has_next_page;
    process.stderr.write(`Page 2 posts: ${p2Posts.length}, has_next: ${p2HasNext}, cursor: ${p2Cursor?.substring(0,30)}...\n`);
    const p2Ids = p2Posts.map(e => e.node.shortcode);
    process.stderr.write(`P2 IDs: ${p2Ids.join(', ')}\n`);

    // Verify they're different
    const overlap = p1Ids.filter(id => p2Ids.includes(id));
    process.stderr.write(`Overlap: ${overlap.length} (should be 0)\n`);

    await delay(3000);

    // Page 3
    process.stderr.write("\n=== Page 3 ===\n");
    const p3R = await igFetch(page, `https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo&max_id=${encodeURIComponent(p2Cursor)}`, csrf);
    const p3 = JSON.parse(p3R.text);
    const p3Posts = p3.data?.user?.edge_owner_to_timeline_media?.edges;
    process.stderr.write(`Page 3 posts: ${p3Posts?.length}\n`);

    // Now examine full post node structure
    process.stderr.write("\n=== Full post node structure ===\n");
    const node = p1Posts[0].node;
    process.stderr.write(JSON.stringify(node, null, 2).substring(0, 3000) + "\n");

    // Check video post too
    process.stderr.write("\n=== Video post ===\n");
    const videoPost = p1Posts.find(e => e.node.is_video);
    if (videoPost) {
      const vn = videoPost.node;
      process.stderr.write(JSON.stringify({
        id: vn.id,
        shortcode: vn.shortcode,
        is_video: vn.is_video,
        typename: vn.__typename,
        video_url: vn.video_url?.substring(0,80),
        dash_info: vn.dash_info,
        video_view_count: vn.video_view_count,
        play_count: vn.play_count,
      }, null, 2) + "\n");
    }

    // Check carousel
    const carouselPost = p1Posts.find(e => e.node.__typename === 'GraphSidecar');
    if (carouselPost) {
      process.stderr.write("\n=== Carousel post ===\n");
      const cn = carouselPost.node;
      process.stderr.write(JSON.stringify({
        id: cn.id,
        shortcode: cn.shortcode,
        typename: cn.__typename,
        edge_sidecar_to_children: cn.edge_sidecar_to_children,
      }, null, 2) + "\n");
    } else {
      process.stderr.write("\nNo carousel in first page.\n");
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
