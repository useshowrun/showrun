/**
 * Instagram - test pagination for posts and check post structure
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

    // Get profile with 12 posts
    const profR = await igFetch(page, 'https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo', csrf);
    const prof = JSON.parse(profR.text);
    const user = prof.data.user;
    const timeline = user.edge_owner_to_timeline_media;
    
    process.stderr.write(`Posts from profile: ${timeline.edges.length}\n`);
    process.stderr.write(`Has next: ${timeline.page_info.has_next_page}\n`);
    process.stderr.write(`End cursor: ${timeline.page_info.end_cursor}\n`);
    
    // Show a post to understand structure
    const post = timeline.edges[0].node;
    process.stderr.write(`\nPost: ${JSON.stringify({
      id: post.id,
      shortcode: post.shortcode,
      is_video: post.is_video,
      typename: post.__typename,
      taken_at: post.taken_at_timestamp,
      url: `https://www.instagram.com/p/${post.shortcode}/`,
      display_url: post.display_url?.substring(0,80),
      thumbnail_src: post.thumbnail_src?.substring(0,80),
      caption: post.edge_media_to_caption?.edges?.[0]?.node?.text?.substring(0, 100),
      likes: post.edge_liked_by?.count,
      comments: post.edge_media_to_comment?.count,
      location: post.location,
    }, null, 2)}\n`);

    // Now test pagination via GraphQL
    // The old query_hash is deprecated, but let's try the end_cursor pagination
    await delay(2000);
    
    process.stderr.write("\n=== Test pagination via GraphQL query ===\n");
    const endCursor = timeline.page_info.end_cursor;
    const vars = encodeURIComponent(JSON.stringify({
      id: user.id,
      first: 12,
      after: endCursor,
    }));
    
    // Try both known query hashes for user media
    const queryHashes = [
      'f2405b236d85e8296cf30347c9f08c2a',
      'e769aa130647d2354c40ea6a439bfc08',
      '003056d32c2554def87228bc3fd9668a',
      'be13233562af2d229b089a7f29fbedbe',
    ];
    
    for (const qh of queryHashes) {
      const url = `https://www.instagram.com/graphql/query/?query_hash=${qh}&variables=${vars}`;
      const r = await igFetch(page, url, csrf);
      process.stderr.write(`\n[${r.status}] hash=${qh}: ${r.text.substring(0, 100)}\n`);
      await delay(1000);
    }

    // Try newer doc_id approach
    process.stderr.write("\n=== Test newer GraphQL query ===\n");
    const docIds = ['17888483320059182', '17851374694183129', '18111879894004360'];
    for (const docId of docIds) {
      const url = `https://www.instagram.com/graphql/query/?doc_id=${docId}&variables=${vars}`;
      const r = await igFetch(page, url, csrf);
      process.stderr.write(`\n[${r.status}] doc_id=${docId}: ${r.text.substring(0, 150)}\n`);
      await delay(1000);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
