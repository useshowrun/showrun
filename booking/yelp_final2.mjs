import { Camoufox } from 'camoufox-js';

const SOCKS5_PROXY = '127.0.0.1:11091';

const browser = await Camoufox({ 
  headless: true, 
  humanize: 1,
  screen: { minWidth: 1280, minHeight: 900 },
  firefoxUserPrefs: {
    'network.proxy.type': 1,
    'network.proxy.socks': SOCKS5_PROXY.split(':')[0],
    'network.proxy.socks_port': parseInt(SOCKS5_PROXY.split(':')[1]),
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

await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => {});
await new Promise(r => setTimeout(r, 2000));

process.stderr.write('Loading Yelp homepage...\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'load', timeout: 45000 }).catch(e => {});

// Wait for DataDome to fully establish session
await new Promise(r => setTimeout(r, 10000));

// Do natural mouse behavior
await page.mouse.move(400, 300, { steps: 5 });
await new Promise(r => setTimeout(r, 500));
await page.mouse.move(640, 400, { steps: 8 });
await new Promise(r => setTimeout(r, 500));

const homeTitle = await page.title();
process.stderr.write('Home title: ' + homeTitle + '\n');

if (homeTitle.includes('yelp.com') && homeTitle.length < 25) {
  process.stderr.write('BLOCKED\n');
  await browser.close();
  process.exit(1);
}

// Set find_loc via JS
await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });

// Type in search description
const descBox = await (await page.$('#search_description')).boundingBox();
await page.mouse.move(descBox.x + 100, descBox.y + 24, { steps: 8 });
await new Promise(r => setTimeout(r, 400));
await page.mouse.click(descBox.x + 100, descBox.y + 24);
await new Promise(r => setTimeout(r, 600));
await page.keyboard.type('coffee', { delay: 150 });
await new Promise(r => setTimeout(r, 1500));

// Click submit
const submitBox = await (await page.$('button[type="submit"]')).boundingBox();
await page.mouse.move(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2, { steps: 12 });
await new Promise(r => setTimeout(r, 500));
await page.mouse.click(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2);
await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => {});
await new Promise(r => setTimeout(r, 8000));

const searchTitle = await page.title();
process.stderr.write('Search title: ' + searchTitle + '\n');

if (searchTitle.includes('yelp.com') && searchTitle.length < 25) {
  process.stderr.write('BLOCKED on search\n');
} else {
  process.stderr.write('SUCCESS!\n');
}

await browser.close();
