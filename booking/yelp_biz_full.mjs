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

// Load homepage first to establish DataDome session
process.stderr.write('Loading homepage...\n');
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));
const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');

if (homeTitle.length < 25 && homeTitle.includes('yelp.com')) {
  process.stderr.write('BLOCKED on homepage\n');
  process.exit(1);
}

// Navigate to biz page
process.stderr.write('\nLoading biz page...\n');
gqlBodies.length = 0;
await page.goto('https://www.yelp.com/biz/sightglass-coffee-san-francisco-7', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 8000));

const bizTitle = await page.title();
process.stderr.write('Biz: ' + bizTitle + '\n');

if (!bizTitle.includes('yelp.com') || bizTitle.length > 25) {
  // Extract JSON-LD
  const jsonLd = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(s => { try { return JSON.parse(s.textContent || ''); } catch { return null; } })
      .filter(Boolean);
  });
  process.stderr.write('\nJSON-LD: ' + JSON.stringify(jsonLd, null, 2).substring(0, 2000) + '\n');
  
  // Extract DOM data
  const domData = await page.evaluate(() => {
    const name = document.querySelector('h1')?.textContent?.trim();
    const ratingEl = document.querySelector('[aria-label*="star"]');
    const addressEl = document.querySelector('address');
    const phoneLink = document.querySelector('a[href^="tel:"]');
    const hoursTable = document.querySelector('table');
    const hours = hoursTable ? Array.from(hoursTable.querySelectorAll('tr')).map(tr => {
      const cells = Array.from(tr.querySelectorAll('th, td')).map(c => c.textContent?.trim());
      return cells.length >= 2 ? { day: cells[0], hours: cells[1] } : null;
    }).filter(Boolean) : [];
    const photos = Array.from(document.querySelectorAll('img[src*="bphoto"]')).map(i => i.src).slice(0, 3);
    
    // Reviews
    const reviewItems = Array.from(document.querySelectorAll('[data-testid*="review"]'));
    const reviews = reviewItems.slice(0, 5).map(r => {
      const ratingEl = r.querySelector('[aria-label*="star"]');
      const textEl = r.querySelector('p, [class*="comment"]');
      return {
        rating: ratingEl?.getAttribute('aria-label'),
        text: textEl?.textContent?.replace(/\s+/g, ' ').substring(0, 200)
      };
    });
    
    return { name, rating: ratingEl?.getAttribute('aria-label'), address: addressEl?.textContent?.trim(), phone: phoneLink?.href?.replace('tel:', ''), hours, photos, reviews };
  });
  process.stderr.write('\nDOM data: ' + JSON.stringify(domData, null, 2) + '\n');
  
  // GQL
  process.stderr.write('\nGQL batches: ' + gqlBodies.length + '\n');
  if (gqlBodies.length > 0) {
    const largest = gqlBodies.reduce((a, b) => a.length > b.length ? a : b);
    process.stderr.write('Largest (' + largest.length + '):\n' + largest.substring(0, 3000) + '\n');
  }
}

await browser.close();
