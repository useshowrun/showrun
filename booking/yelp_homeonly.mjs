import { Camoufox } from 'camoufox-js';

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

const page = await context.newPage();

process.stderr.write('Test 1: Homepage\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));
process.stderr.write('Home: ' + await page.title() + '\n');

process.stderr.write('\nTest 2: Category browse page (not search)\n');
await page.goto('https://www.yelp.com/c/san-francisco-ca/coffee', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));
process.stderr.write('Category: ' + await page.title() + '\n');

process.stderr.write('\nTest 3: Business detail page\n');
await page.goto('https://www.yelp.com/biz/sightglass-coffee-san-francisco-7', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));
process.stderr.write('Biz: ' + await page.title() + '\n');

await browser.close();
