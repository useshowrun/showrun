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

// Wait for DataDome validation
let ddValidated = false;
const ddPromise = new Promise((resolve) => {
  context.on('response', async (response) => {
    const url = response.url();
    if (url.includes('api-js.datadome.co/js/') && !ddValidated) {
      const body = await response.text().catch(() => '');
      if (body.includes('"status":200') && body.includes('datadome=')) {
        ddValidated = true;
        process.stderr.write('DD validated!\n');
        resolve();
      }
    }
  });
});

const page = await context.newPage();

process.stderr.write('Loading homepage...\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {});
await Promise.race([ddPromise, new Promise(r => setTimeout(r, 15000))]);

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');
process.stderr.write('DD validated: ' + ddValidated + '\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) {
  process.stderr.write('BLOCKED\n');
  process.exit(1);
}

// DO NOT do mouse moves or scrolling - just submit immediately
process.stderr.write('Setting find_loc...\n');
await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });

const descInput = await page.$('#search_description');
await descInput.click();
await new Promise(r => setTimeout(r, 400));
await descInput.type('coffee', { delay: 100 });
await new Promise(r => setTimeout(r, 600));

process.stderr.write('Submitting...\n');
const submitBtn = await page.$('button[type="submit"]');
const submitBox = await submitBtn.boundingBox();
await page.mouse.move(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2, { steps: 10 });
await new Promise(r => setTimeout(r, 400));
await page.mouse.click(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2);

await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const searchTitle = await page.title();
process.stderr.write('Search: ' + searchTitle.substring(0, 80) + '\n');
process.stderr.write('Success: ' + (!(searchTitle.length < 25 && searchTitle.includes('yelp.com'))) + '\n');

await browser.close();
