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
      if (body.length > 500) gqlBodies.push(body);
    } catch {}
  }
});

const page = await context.newPage();

// Test the business detail page directly (without homepage warmup)
process.stderr.write('Loading biz page directly...\n');
await page.goto('https://www.yelp.com/biz/sightglass-coffee-san-francisco-7', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 8000));
process.stderr.write('Biz title: ' + await page.title() + '\n');

// Extract data
const bizDetail = await page.evaluate(() => {
  // JSON-LD
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(s => { try { return JSON.parse(s.textContent || ''); } catch { return null; } })
    .filter(Boolean);
  
  // DOM data
  const name = document.querySelector('h1')?.textContent?.trim();
  const ratingEl = document.querySelector('[aria-label*="star"]');
  const addressEl = document.querySelector('address');
  const phoneLink = document.querySelector('a[href^="tel:"]');
  
  // Hours table
  const hoursTable = document.querySelector('table');
  const hours = hoursTable ? Array.from(hoursTable.querySelectorAll('tr')).map(tr => {
    const cells = Array.from(tr.querySelectorAll('th, td')).map(c => c.textContent?.trim());
    return cells.length >= 2 ? { day: cells[0], hours: cells[1] } : null;
  }).filter(Boolean) : [];
  
  // Data-testid survey
  const testIds = {};
  Array.from(document.querySelectorAll('[data-testid]')).forEach(el => {
    const id = el.getAttribute('data-testid');
    if (!testIds[id]) testIds[id] = (el.textContent || '').replace(/\s+/g, ' ').substring(0, 80);
  });
  
  // Photos
  const photos = Array.from(document.querySelectorAll('img[src*="bphoto"]'))
    .map(i => i.src).slice(0, 5);
  
  return {
    jsonLd,
    name,
    rating: ratingEl?.getAttribute('aria-label'),
    address: addressEl?.textContent?.trim(),
    phone: phoneLink?.href?.replace('tel:', ''),
    hours,
    photos,
    testIds
  };
});

process.stderr.write('\nBiz detail:\n' + JSON.stringify(bizDetail, null, 2) + '\n');

process.stderr.write('\nGQL batches: ' + gqlBodies.length + '\n');
if (gqlBodies.length > 0) {
  const largest = gqlBodies.reduce((a, b) => a.length > b.length ? a : b);
  process.stderr.write('Largest (' + largest.length + '):\n' + largest.substring(0, 2000) + '\n');
}

await browser.close();
