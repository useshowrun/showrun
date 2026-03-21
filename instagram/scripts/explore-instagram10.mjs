/**
 * Explore full profile API response to see what post data is embedded
 */

import { Camoufox } from "camoufox-js";

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await Camoufox({ headless: true, humanize: 1, screen: { minWidth: 1280, minHeight: 800 } });

  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();

    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);

    const cookies = await context.cookies("https://www.instagram.com");
    const csrf = cookies.find(c => c.name === 'csrftoken')?.value;

    // Get full profile response
    const fullProfile = await page.evaluate(async (csrf) => {
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
      return await resp.json();
    }, csrf);

    const user = fullProfile.data?.user;
    if (!user) {
      process.stderr.write(`No user: ${JSON.stringify(fullProfile)}\n`);
      return;
    }
    
    // Show all top-level user keys
    process.stderr.write(`User keys: ${Object.keys(user).join('\n  ')}\n`);
    
    // Check for timeline media
    const timeline = user.edge_owner_to_timeline_media;
    process.stderr.write(`\ntimeline: ${JSON.stringify(timeline)?.substring(0, 2000) || 'null'}\n`);
    
    // Check edge_felix_video_timeline (videos/reels)
    const reels = user.edge_felix_video_timeline;
    process.stderr.write(`\nreels edge: ${JSON.stringify(reels)?.substring(0, 500) || 'null'}\n`);

    // Check all 'edge_' fields
    const edgeFields = Object.keys(user).filter(k => k.startsWith('edge_'));
    for (const f of edgeFields) {
      const v = user[f];
      if (v && typeof v === 'object') {
        process.stderr.write(`\n${f}: count=${v.count}, edges=${v.edges?.length || 'no edges'}\n`);
        if (v.edges?.length > 0) {
          process.stderr.write(`  First edge keys: ${Object.keys(v.edges[0]).join(', ')}\n`);
          process.stderr.write(`  First edge node keys: ${Object.keys(v.edges[0].node || {}).join(', ')}\n`);
        }
      }
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => process.stderr.write(`FATAL: ${e.message}\n`));
