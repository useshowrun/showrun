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

// Track all yelp.com/search requests
context.on('response', (response) => {
  const url = response.url();
  if (url.includes('yelp.com/search') || url.includes('datadome')) {
    process.stderr.write(`RESP: ${response.status()} ${url.substring(0, 80)}\n`);
  }
});

const page = await context.newPage();

// Step 1: Load homepage and wait for DataDome to validate
process.stderr.write('Loading homepage...\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'networkidle', timeout: 45000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) {
  process.stderr.write('BLOCKED\n');
  process.exit(1);
}

// Check the datadome cookie
const cookies = await context.cookies(['https://www.yelp.com']);
const ddCookie = cookies.find(c => c.name === 'datadome');
process.stderr.write('DD cookie: ' + (ddCookie ? ddCookie.value.substring(0, 40) : 'NOT FOUND') + '\n');

// Step 2: Try direct navigation to search URL (now that we have DD cookie)
process.stderr.write('\nDirect nav to search...\n');
await page.goto('https://www.yelp.com/search?find_desc=coffee&find_loc=San+Francisco%2C+CA', 
  { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const searchTitle = await page.title();
process.stderr.write('Search: ' + searchTitle + '\n');

if (!(searchTitle.length < 25 && searchTitle.includes('yelp.com'))) {
  process.stderr.write('SUCCESS!\n');
} else {
  // Maybe the interstitial is being shown and we need to wait for it to resolve
  const currentUrl = page.url();
  process.stderr.write('Blocked. URL: ' + currentUrl + '\n');
  
  // Wait for the interstitial to resolve
  process.stderr.write('Waiting for interstitial (30s)...\n');
  await new Promise(r => setTimeout(r, 30000));
  
  const finalTitle = await page.title();
  const finalUrl = page.url();
  process.stderr.write('Final title: ' + finalTitle + '\n');
  process.stderr.write('Final URL: ' + finalUrl + '\n');
}

await browser.close();
