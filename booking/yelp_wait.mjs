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

// Track interstitial completion - when the yelp.com?dd_referrer= URL loads with 200 after a 403
let searchInterstitialComplete = false;
const searchInterstitialPromise = new Promise((resolve) => {
  // We look for a successful yelp.com/search response (status 200)
  context.on('response', (response) => {
    const url = response.url();
    const status = response.status();
    if (url.includes('yelp.com/search') && status === 200) {
      process.stderr.write('Search loaded with 200! URL: ' + url.substring(0, 80) + '\n');
      searchInterstitialComplete = true;
      resolve();
    }
  });
});

const page = await context.newPage();

process.stderr.write('Loading homepage...\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {});

// Wait for first DD validation
let firstDDPassed = false;
const firstDDPromise = new Promise((resolve) => {
  context.on('response', async (response) => {
    if (response.url().includes('api-js.datadome.co/js/') && !firstDDPassed) {
      const body = await response.text().catch(() => '');
      if (body.includes('"status":200')) {
        firstDDPassed = true;
        resolve();
      }
    }
  });
});

await Promise.race([firstDDPromise, new Promise(r => setTimeout(r, 15000))]);
process.stderr.write('First DD: ' + firstDDPassed + '\n');

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) {
  process.stderr.write('BLOCKED\n');
  process.exit(1);
}

// Set find_loc and submit
await page.evaluate(() => { document.querySelector('input[name="find_loc"]').value = 'San Francisco, CA'; });

const descInput = await page.$('#search_description');
await descInput.click();
await new Promise(r => setTimeout(r, 500));
await descInput.type('coffee', { delay: 100 });
await new Promise(r => setTimeout(r, 800));

process.stderr.write('Submitting...\n');
const submitBtn = await page.$('button[type="submit"]');
const box = await submitBtn.boundingBox();
await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 10 });
await new Promise(r => setTimeout(r, 400));
await page.mouse.click(box.x + box.width/2, box.y + box.height/2);

// Now wait for search interstitial to complete (up to 30 seconds)
process.stderr.write('Waiting for search interstitial to complete...\n');
await Promise.race([
  searchInterstitialPromise,
  new Promise(r => setTimeout(r, 30000))
]);

process.stderr.write('Interstitial complete: ' + searchInterstitialComplete + '\n');

// Wait for page to stabilize
await new Promise(r => setTimeout(r, 5000));

const searchTitle = await page.title();
const searchUrl = page.url();
process.stderr.write('Search title: ' + searchTitle + '\n');
process.stderr.write('Search URL: ' + searchUrl + '\n');

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
        slug 
      });
      if (results.length >= 5) break;
    }
    return results;
  });
  process.stderr.write('Results: ' + JSON.stringify(results, null, 2) + '\n');
} else {
  process.stderr.write('Still blocked. URL: ' + searchUrl + '\n');
  const body = await page.evaluate(() => document.body.innerHTML.substring(0, 200));
  process.stderr.write('Body: ' + body + '\n');
}

await browser.close();
