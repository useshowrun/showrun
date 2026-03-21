import { Camoufox } from 'camoufox-js';
import { writeFileSync } from 'fs';

const browser = await Camoufox({ 
  headless: true, 
  humanize: 1,
  screen: { minWidth: 1280, minHeight: 900 },
  firefoxUserPrefs: {
    'network.proxy.type': 1,
    'network.proxy.socks': '127.0.0.1',
    'network.proxy.socks_port': 11091,
    'network.proxy.socks_version': 5,
    'network.proxy.socks_remote_dns': true,
  }
});

const context = await browser.newContext({ 
  locale: 'en-US',
  timezoneId: 'America/New_York',
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
});

const gqlBodies = [];
context.on('response', async (response) => {
  if (response.url() === 'https://www.yelp.com/gql/batch') {
    try {
      const body = await response.text();
      if (body.length > 200) gqlBodies.push(body);
    } catch {}
  }
});

const page = await context.newPage();
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');
if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) { process.exit(1); }

await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });
const descInput = await page.$('#search_description');
const descBox = await descInput.boundingBox();
await page.mouse.move(descBox.x + 100, descBox.y + 12, { steps: 8 });
await page.mouse.click(descBox.x + 100, descBox.y + 12);
await new Promise(r => setTimeout(r, 500));
await descInput.type('coffee', { delay: 120 });
await new Promise(r => setTimeout(r, 1000));

gqlBodies.length = 0; // Clear to only capture search page GQL

const submitBtn = await page.$('button[type="submit"]');
const submitBox = await submitBtn.boundingBox();
await page.mouse.move(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2, { steps: 12 });
await new Promise(r => setTimeout(r, 500));
await page.mouse.click(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2);
await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => {});
await new Promise(r => setTimeout(r, 8000));

const searchTitle = await page.title();
process.stderr.write('Search: ' + searchTitle + '\n');

if (searchTitle.length < 25 && searchTitle.includes('yelp.com')) { 
  process.stderr.write('BLOCKED\n');
  process.exit(1);
}

process.stderr.write('\nSEARCH GQL batches: ' + gqlBodies.length + '\n');
gqlBodies.forEach((body, i) => {
  const filename = `/tmp/yelp_search_gql_${i}.json`;
  writeFileSync(filename, body);
  process.stderr.write(`Batch ${i}: ${body.length} bytes → ${filename}\n`);
});

// Quick analysis - find search results
for (const body of gqlBodies) {
  try {
    const parsed = JSON.parse(body);
    for (const item of parsed) {
      const d = item?.data || {};
      const keys = Object.keys(d);
      if (keys.some(k => k.includes('search') || k.includes('Search'))) {
        process.stderr.write('\nSearch-related GQL item keys: ' + keys.join(', ') + '\n');
        process.stderr.write(JSON.stringify(d).substring(0, 1000) + '\n');
      }
    }
  } catch {}
}

// Also get the full page HTML
const html = await page.content();
writeFileSync('/tmp/yelp_search_page.html', html);
process.stderr.write('\nPage HTML saved (' + html.length + ' bytes)\n');

await browser.close();
