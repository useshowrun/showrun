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
      if (body.length > 300) gqlBodies.push(body);
    } catch {}
  }
});

const page = await context.newPage();
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

gqlBodies.length = 0;
await page.goto('https://www.yelp.com/biz/sightglass-coffee-san-francisco-7', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 8000));

// Save all GQL batches to files
gqlBodies.forEach((body, i) => {
  const filename = '/tmp/yelp_gql_batch_' + i + '.json';
  writeFileSync(filename, body);
  process.stderr.write('Saved ' + filename + ' (' + body.length + ' bytes)\n');
});

await browser.close();
