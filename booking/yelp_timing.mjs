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

// Track ALL DataDome API calls and search responses
const datadomeEvents = [];
let searchResponseStatus = null;

context.on('response', async (response) => {
  const url = response.url();
  
  if (url.includes('api-js.datadome.co/js/')) {
    const body = await response.text().catch(() => '');
    const event = {
      time: Date.now(),
      url: url.substring(0, 60),
      status: body.includes('"status":200') ? 200 : (body.includes('"status":') ? parseInt(body.match(/"status":(\d+)/)?.[1] || '0') : 0),
      hasCookie: body.includes('datadome=')
    };
    datadomeEvents.push(event);
    process.stderr.write('DD event: ' + JSON.stringify(event) + '\n');
  }
  
  if (url.includes('yelp.com/search')) {
    searchResponseStatus = response.status();
    process.stderr.write('SEARCH RESP: ' + response.status() + ' ' + url.substring(0, 80) + '\n');
  }
});

const page = await context.newPage();

process.stderr.write('=== Loading homepage ===\n');
const startTime = Date.now();
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {});
process.stderr.write('Homepage loaded in: ' + (Date.now() - startTime) + 'ms\n');

// Wait for first DD validation
await new Promise(r => {
  const check = () => {
    if (datadomeEvents.length > 0 || Date.now() - startTime > 20000) r();
    else setTimeout(check, 200);
  };
  check();
});

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');
process.stderr.write('Time since start: ' + (Date.now() - startTime) + 'ms\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) {
  process.stderr.write('BLOCKED on homepage\n');
  process.exit(1);
}

// Set find_loc
await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });

const descInput = await page.$('#search_description');
await descInput.click();
await new Promise(r => setTimeout(r, 500));
await descInput.type('coffee', { delay: 100 });
await new Promise(r => setTimeout(r, 800));

process.stderr.write('\n=== Submitting search ===\n');
process.stderr.write('Time before submit: ' + (Date.now() - startTime) + 'ms\n');

const submitBtn = await page.$('button[type="submit"]');
const box = await submitBtn.boundingBox();
await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 10 });
await new Promise(r => setTimeout(r, 400));
await page.mouse.click(box.x + box.width/2, box.y + box.height/2);

// Wait for navigation AND second DD validation
const searchNavPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});

// Also wait for DD events to settle (second validation for search URL)
let ddCountAtSubmit = datadomeEvents.length;
await searchNavPromise;
process.stderr.write('Navigation done. Time: ' + (Date.now() - startTime) + 'ms\n');

// Wait for any new DD events
await new Promise(r => setTimeout(r, 10000)); // Extra long wait for second DD validation

process.stderr.write('After extra wait. Time: ' + (Date.now() - startTime) + 'ms\n');
process.stderr.write('DD events total: ' + datadomeEvents.length + '\n');
process.stderr.write('New DD events since submit: ' + (datadomeEvents.length - ddCountAtSubmit) + '\n');
process.stderr.write('Search response status: ' + searchResponseStatus + '\n');

const searchTitle = await page.title();
process.stderr.write('Search title: ' + searchTitle + '\n');

if (!(searchTitle.length < 25 && searchTitle.includes('yelp.com'))) {
  process.stderr.write('SUCCESS!\n');
  
  const results = await page.evaluate(() => {
    const results = [];
    const bizLinks = Array.from(document.querySelectorAll('a[href*="/biz/"]'));
    const seen = new Set();
    for (const link of bizLinks) {
      const href = link.getAttribute('href') || '';
      const slug = href.split('/biz/')[1]?.split('?')[0];
      if (!slug || seen.has(slug) || slug.match(/^[A-Z0-9_-]{15,}$/)) continue;
      seen.add(slug);
      let el = link;
      while (el && el.tagName !== 'LI') el = el.parentElement;
      if (!el) continue;
      const ratingEl = el.querySelector('[aria-label*="star"]');
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const rankMatch = text.match(/^(\d+)\.\s+(.+?)\s+\d+\.\d/);
      results.push({ 
        rank: rankMatch ? parseInt(rankMatch[1]) : results.length + 1, 
        name: rankMatch ? rankMatch[2] : (link.textContent || '').trim().substring(0, 60), 
        slug, 
        rating: ratingEl?.getAttribute('aria-label') 
      });
      if (results.length >= 5) break;
    }
    return results;
  });
  process.stderr.write('Results: ' + JSON.stringify(results, null, 2) + '\n');
}

await browser.close();
