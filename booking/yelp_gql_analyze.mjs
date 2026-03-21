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

process.stderr.write('GQL batches: ' + gqlBodies.length + '\n');

// Find the LARGEST GQL batch (this is the main business data batch)
const sorted = [...gqlBodies].sort((a, b) => b.length - a.length);
const largest = sorted[0];

if (largest) {
  // Parse the JSON
  const parsed = JSON.parse(largest);
  process.stderr.write('Parsed array length: ' + parsed.length + '\n');
  
  // Find the business data object
  const bizObj = parsed.find(p => p?.data?.business?.name);
  if (bizObj) {
    const biz = bizObj.data.business;
    
    // Print the full business object keys
    process.stderr.write('\nBusiness keys: ' + Object.keys(biz).join(', ') + '\n');
    
    // Print address info
    process.stderr.write('\nAddress: ' + JSON.stringify(biz.location) + '\n');
    
    // Print hours
    process.stderr.write('\nHours: ' + JSON.stringify(biz.operationHours || biz.hours || 'not found') + '\n');
    
    // Print contact info
    process.stderr.write('\nPhone: ' + JSON.stringify(biz.phone) + '\n');
    process.stderr.write('\nWebsite: ' + JSON.stringify(biz.website || biz.websiteUrl) + '\n');
    
    // Print categories
    process.stderr.write('\nCategories: ' + JSON.stringify(biz.categories) + '\n');
    
    // Print sample reviews
    process.stderr.write('\nSample review: ' + JSON.stringify(biz.reviews?.edges?.[0]?.node) + '\n');
    
    // Print all top-level business keys with their data
    const fullBiz = JSON.stringify(biz, null, 2);
    process.stderr.write('\n\nFull business data (' + fullBiz.length + ' chars):\n');
    process.stderr.write(fullBiz.substring(0, 5000) + '\n');
  }
  
  // Also check for other interesting objects
  for (const item of parsed.slice(0, 5)) {
    if (item?.data && !item.data.business) {
      const keys = Object.keys(item.data || {});
      process.stderr.write('\nOther GQL item keys: ' + keys.join(', ') + '\n');
    }
  }
}

await browser.close();
