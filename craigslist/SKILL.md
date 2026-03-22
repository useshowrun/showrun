# Craigslist Agent Skills

Scrape Craigslist listings by city and category using pure HTTP — no browser required.

## Key Insights

Craigslist serves **server-rendered HTML** with embedded **LD+JSON structured data**:

1. **Search page**: `https://{city}.craigslist.org/search/{category}?query=...`
   - Returns up to 120 listings per page (paginate with `&start=N`)
   - HTML `<li>` tags contain: title, price, location, listing URL
   - `<script id="ld_searchpage_results">` LD+JSON: images, lat/lng — keyed by listing title
   - Combined by title-matching for accurate data alignment

2. **Listing detail page**: `https://{city}.craigslist.org/{sub}/{cat}/d/{slug}/{id}.html`
   - LD+JSON `<script type="application/ld+json">` with @type="Product": title, description, price, location, images
   - `<div class="attrgroup">` sections: labeled attributes (make, model, condition, etc.)
   - `<span class="attr important">`: summary text (e.g., "3BR / 1Ba" for housing)
   - `<time datetime="...">` elements: posted and updated dates

3. **No authentication required** — all public listings accessible with basic HTTP + gzip decompression

4. **City subdomains**: `sfbay`, `newyork`, `chicago`, `losangeles`, `seattle`, `boston`, `london`, `sydney`, etc.

5. **Common category codes**:
   - `sss` = for sale (all), `hhh` = housing, `jjj` = jobs, `ggg` = gigs
   - `svc` = services, `ccc` = community, `bik` = bicycles, `pet` = pets
   - `mob` = mobile phones, `fud` = food+drink, `for` = free stuff

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [craigslist-search](craigslist-search/SKILL.md) | `craigslist-search/scripts/craigslist-search.mjs` | Search listings by city + category |
| [craigslist-listing](craigslist-listing/SKILL.md) | `craigslist-listing/scripts/craigslist-listing.mjs` | Get full details for a single listing |

## Typical Workflow

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/craigslist

# Search for bicycles for sale in SF Bay Area
node craigslist-search/scripts/craigslist-search.mjs sfbay sss --query bicycle --max 10

# Search for apartments in New York with price filter
node craigslist-search/scripts/craigslist-search.mjs newyork hhh --query apartment --min-price 2000 --max-price 4000

# Search for developer jobs in Chicago
node craigslist-search/scripts/craigslist-search.mjs chicago jjj --query developer

# Get full details for a listing
node craigslist-listing/scripts/craigslist-listing.mjs "https://sfbay.craigslist.org/nby/bik/d/petaluma-retrospec-sully-bmx-kruiser/7912241254.html"
```

## Rate Limiting

Craigslist does not aggressively rate-limit basic HTTP requests from server IPs.
Use reasonable delays between bulk requests. Avoid hammering with concurrent requests.
