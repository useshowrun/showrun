# Rightmove Agent Skills

Scrape Rightmove (rightmove.co.uk) for UK property listings using pure HTTP — no browser required.

## Key Insights

Rightmove serves **server-rendered HTML** with embedded JSON in two formats:

1. **Search pages** (`/property-for-sale/find.html?...`):
   - Next.js SSR: `__NEXT_DATA__` JSON embedded in `<script id="__NEXT_DATA__">` tag
   - `props.pageProps.searchResults.properties` contains full listing data (25 per page)
   - Paginate with `&index=0`, `&index=24`, `&index=48`, etc.

2. **Listing detail pages** (`/properties/<id>`):
   - Legacy SSR: `window.PAGE_MODEL = {...}` embedded in HTML `<script>` tag
   - `propertyData` contains all fields: description, images, floorplans, tenure, stations, etc.

3. **Location resolution**:
   - Fetch `/property-for-sale/{Location}.html` → Rightmove resolves place name → embeds locationIdentifier in `__NEXT_DATA__`
   - Invalid locations return HTTP 307 → page-not-found

4. **No authentication required** for public listings — pure HTTPS with standard headers.

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [rightmove-search](rightmove-search/SKILL.md) | `rightmove-search/scripts/rightmove-search.mjs` | Search properties by location + filters |
| [rightmove-listing](rightmove-listing/SKILL.md) | `rightmove-listing/scripts/rightmove-listing.mjs` | Full details for a single property |

## Typical Workflow

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/rightmove

# Search for 2-3 bed houses for sale in Edinburgh under £500k
node rightmove-search/scripts/rightmove-search.mjs Edinburgh --min-beds 2 --max-beds 3 --max-price 500000 --property-type house

# Search for rental flats in Manchester under £1500/month
node rightmove-search/scripts/rightmove-search.mjs Manchester --type rent --max-beds 2 --max-price 1500 --property-type flat

# Get full details for a property
node rightmove-listing/scripts/rightmove-listing.mjs 87729723
node rightmove-listing/scripts/rightmove-listing.mjs "https://www.rightmove.co.uk/properties/87729723"
```

## URL Patterns

| Page | URL Format |
|------|------------|
| Location resolution (sale) | `/property-for-sale/{City}.html` |
| Location resolution (rent) | `/property-to-rent/{City}.html` |
| Search (sale) | `/property-for-sale/find.html?searchType=SALE&locationIdentifier=REGION^ID&...` |
| Search (rent) | `/property-to-rent/find.html?searchType=RENT&locationIdentifier=REGION^ID&...` |
| Listing detail | `/properties/{propertyId}` |

## Filter Parameters

| Parameter | Values | Description |
|-----------|--------|-------------|
| `locationIdentifier` | `REGION^87490` | Location ID (resolved automatically) |
| `minPrice` / `maxPrice` | integer (£) | Price range |
| `minBedrooms` / `maxBedrooms` | integer | Bedroom count |
| `propertyTypes` | comma-separated | `detached`, `semi-detached`, `terraced`, `flat`, `bungalow`, `studio`, `land`, etc. |
| `radius` | float (miles) | Search radius |
| `index` | 0, 24, 48, ... | Pagination offset |

## Rate Limiting

Rightmove does not aggressively rate-limit basic HTTP requests.
Use a 500ms delay between paginated requests. Avoid concurrent requests.
