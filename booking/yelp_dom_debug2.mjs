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
      if (body.length > 500) gqlBodies.push(body);
    } catch {}
  }
});

const page = await context.newPage();
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) { process.exit(1); }

// Set find_loc and search
await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });
const descInput = await page.$('#search_description');
const descBox = await descInput.boundingBox();
await page.mouse.move(descBox.x + 100, descBox.y + 12, { steps: 8 });
await page.mouse.click(descBox.x + 100, descBox.y + 12);
await new Promise(r => setTimeout(r, 500));
await descInput.type('coffee', { delay: 120 });
await new Promise(r => setTimeout(r, 1000));

const submitBtn = await page.$('button[type="submit"]');
const submitBox = await submitBtn.boundingBox();
await page.mouse.move(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2, { steps: 12 });
await new Promise(r => setTimeout(r, 500));
await page.mouse.click(submitBox.x + submitBox.width/2, submitBox.y + submitBox.height/2);
await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => {});
await new Promise(r => setTimeout(r, 6000));

const searchTitle = await page.title();
process.stderr.write('Search: ' + searchTitle + '\n');

if (searchTitle.length < 25 && searchTitle.includes('yelp.com')) { 
  process.stderr.write('BLOCKED\n');
  process.exit(1);
}

// Save the page HTML for offline analysis
const html = await page.content();
writeFileSync('/tmp/yelp_search_page.html', html);
process.stderr.write('Saved page HTML (' + html.length + ' bytes)\n');

// DOM analysis  
const domData = await page.evaluate(() => {
  // Find ALL links to /biz/ with their text
  const bizLinks = Array.from(document.querySelectorAll('a[href*="/biz/"]'));
  const linkData = bizLinks.map(a => ({
    href: (a.getAttribute('href') || '').substring(0, 80),
    text: (a.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 60),
    parentTag: a.parentElement ? a.parentElement.tagName : '',
    grandTag: a.parentElement?.parentElement ? a.parentElement.parentElement.tagName : '',
  }));
  
  // Check all LI elements
  const lis = Array.from(document.querySelectorAll('li')).map(li => {
    const link = li.querySelector('a[href*="/biz/"]');
    return {
      hasLink: !!link,
      linkText: (link?.textContent || '').trim().substring(0, 40),
      liText: (li.textContent || '').replace(/\s+/g, ' ').substring(0, 100),
      liClass: (li.className || '').substring(0, 40)
    };
  }).filter(li => li.hasLink).slice(0, 10);
  
  // Get ALL data-testid values
  const testIds = Array.from(new Set(
    Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid'))
  ));
  
  return { linkData: linkData.slice(0, 15), lis, testIds: testIds.slice(0, 30) };
});

process.stderr.write('\nDOM data:\n' + JSON.stringify(domData, null, 2) + '\n');

// GQL batches for search
process.stderr.write('\nGQL batches: ' + gqlBodies.length + '\n');
gqlBodies.forEach((body, i) => {
  process.stderr.write(`Batch ${i}: ${body.length} bytes\n`);
  try {
    const parsed = JSON.parse(body);
    for (const item of parsed) {
      const d = item?.data || {};
      const keys = Object.keys(d);
      process.stderr.write('  Keys: ' + keys.join(', ') + '\n');
      if (keys.includes('searchResult') || keys.includes('search') || keys.includes('bizList')) {
        process.stderr.write('  ** SEARCH DATA: ' + JSON.stringify(d).substring(0, 500) + '\n');
      }
    }
  } catch {}
});

await browser.close();
