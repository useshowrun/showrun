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
await page.goto('https://www.yelp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {});
await new Promise(r => setTimeout(r, 5000));

const homeTitle = await page.title();
process.stderr.write('Home: ' + homeTitle + '\n');

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

// DOM analysis
const domAnalysis = await page.evaluate(() => {
  // 1. Find all <li> elements with business links
  const allLis = Array.from(document.querySelectorAll('li'));
  const bizLis = allLis.filter(li => {
    const link = li.querySelector('a[href*="/biz/"]');
    const linkText = (link?.textContent || '').trim();
    // Must have a business link with real text
    return link && linkText.length > 2 && linkText !== 'Order';
  });
  
  process.stderr?.write?.('Business LIs: ' + bizLis.length + '\n');
  
  // 2. Get top 3 with their structure
  const top3 = bizLis.slice(0, 3).map(li => {
    const link = li.querySelector('a[href*="/biz/"]');
    const ratingEl = li.querySelector('[aria-label*="star"]');
    return {
      href: link?.getAttribute('href')?.substring(0, 80),
      linkText: (link?.textContent || '').trim().substring(0, 60),
      rating: ratingEl?.getAttribute('aria-label'),
      text: (li.textContent || '').replace(/\s+/g, ' ').substring(0, 200)
    };
  });
  
  // 3. ALL links to /biz/
  const allBizLinks = Array.from(document.querySelectorAll('a[href*="/biz/"]'))
    .map(a => ({
      href: a.getAttribute('href')?.substring(0, 80),
      text: (a.textContent || '').trim().substring(0, 50),
      parentTag: a.parentElement?.tagName,
      parentClass: (a.parentElement?.className || '').substring(0, 40)
    }))
    .filter(a => a.text.length > 2 && a.text !== 'Order');
  
  // 4. Data-testid survey on the page
  const testIds = {};
  Array.from(document.querySelectorAll('[data-testid]')).forEach(el => {
    const id = el.getAttribute('data-testid');
    if (!testIds[id]) testIds[id] = { tag: el.tagName, text: (el.textContent || '').replace(/\s+/g, ' ').substring(0, 60) };
  });
  
  return {
    bizLiCount: bizLis.length,
    top3,
    bizLinkCount: allBizLinks.length,
    bizLinks: allBizLinks.slice(0, 10),
    testIdCount: Object.keys(testIds).length,
    testIds: Object.entries(testIds).slice(0, 20).map(([k,v]) => ({ id: k, ...v }))
  };
});

process.stderr.write('\nDOM analysis:\n' + JSON.stringify(domAnalysis, null, 2) + '\n');

// 5. Also check GQL batches for search results
process.stderr.write('\nGQL batches: ' + gqlBodies.length + '\n');
for (const body of gqlBodies) {
  try {
    const parsed = JSON.parse(body);
    for (const item of parsed) {
      if (item?.data?.searchPageProps || item?.data?.search || item?.data?.searchBusiness) {
        process.stderr.write('Search GQL found!\n');
        process.stderr.write(JSON.stringify(item.data, null, 2).substring(0, 2000) + '\n');
      }
    }
  } catch {}
}

// 6. Look for search results in another form - businesses might be in a different structure
const altSearch = await page.evaluate(() => {
  // Look for any element with "1." "2." "3." pattern
  const text = document.body.textContent || '';
  const rankMatch = text.match(/1\.\s+(\w[\w\s&]+?)\s+\d+\.\d/);
  
  // Look for H3 elements with business names
  const h3s = Array.from(document.querySelectorAll('h3, h4')).map(h => ({
    tag: h.tagName,
    text: (h.textContent || '').trim().substring(0, 60),
    parentClass: (h.parentElement?.className || '').substring(0, 40)
  }));
  
  // Look for the search result list container
  const searchSection = document.querySelector('[data-testid="search-results"]') || 
    document.querySelector('ul[class*="list"]') ||
    document.querySelector('div[class*="results"]');
  
  return {
    rankMatchInText: rankMatch ? rankMatch[0] : null,
    h3s: h3s.slice(0, 10),
    searchSection: searchSection ? { tag: searchSection.tagName, class: (searchSection.className || '').substring(0, 50) } : null
  };
});

process.stderr.write('\nAlt search:\n' + JSON.stringify(altSearch, null, 2) + '\n');

await browser.close();
