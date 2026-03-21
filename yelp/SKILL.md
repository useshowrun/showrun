# Yelp Scraper

Yelp business scraper. Provides two skills:

## Skills

### [yelp-search](yelp-search/SKILL.md)
Search for businesses on Yelp by keyword and location (typeahead GQL strategy).

```bash
QUERY="coffee" LOCATION="San Francisco, CA" \
  node yelp-search/scripts/yelp-search.mjs
```

### [yelp-business](yelp-business/SKILL.md)
Get detailed info about a specific Yelp business.

```bash
SLUG="sightglass-coffee-san-francisco-7" \
  node yelp-business/scripts/yelp-business.mjs
```

## Setup

### Proxy (required)

Yelp is protected by [DataDome](https://datadome.co/) bot detection.
A **residential IP** is required to bypass it.

The skills use a SOCKS5 proxy configured via `SOCKS5_PROXY` env var.
Default: `127.0.0.1:11091`

The residential proxy is a Python SOCKS5 server running on the desktop machine
(192.168.1.11) that relays traffic through a residential IP (`enp38s0` interface).

To verify/start the SSH tunnel:
```bash
ssh -f -N karacasoft@192.168.1.11 -L 127.0.0.1:11091:127.0.0.1:18081
```

### Node modules

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/yelp
# node_modules should already be symlinked from booking/
ls node_modules/camoufox-js
```

## Anti-bot strategy (2026-03-21 findings)

DataDome uses browser fingerprinting and JS challenges to block bots.

### What works:
- **Homepage** → passes DataDome JS challenge (auto-solved by camoufox + residential IP)
- **Business pages** (`/biz/*`) → accessible after homepage warmup
- **typeahead GQL** (`searchSuggestFrontend`) → returns business slugs + addresses
- **GQL batch API** (`/gql/batch`) → rich structured data from biz pages

### What is blocked:
- **Search page** (`/search?...`) → DataDome visual captcha block (persistent per IP)
  - Even with residential proxy, this endpoint triggers "You have been blocked | Yelp"
  - Block hash (`hsh=3BD2468BAE4D73BEA0B5DE8314D745`) is IP-fingerprint-based
  - The `/search` endpoint has stricter protection than `/biz/*`

### Search workaround:
Instead of navigating to `/search`, the `yelp-search` skill types the query
into the homepage search box. This triggers `searchSuggestFrontend` GQL calls
which return `type:"business"` suggestions with Yelp slugs.

### IP rate limits:
DataDome tracks request frequency per IP. After ~5-10 requests in quick succession:
- `/biz/` pages start getting blocked (30-60 min cooldown needed)
- After heavy use, `/biz/` stays blocked for hours

**Recommendation**: Max 3-4 requests per session, 5+ minute gap between sessions.

## Stable selectors used

| Element | Selector |
|---------|----------|
| Search query input | `input#search_description` |
| Hidden location field | `input[name="find_loc"]` |
| Business links | `a[href*="/biz/"]` |
| Star ratings | `[aria-label*="star"]` |
| Category links | `a[href^="/c/"]` |
| Business address | `address` |
| Phone | `a[href^="tel:"]` |
| Structured data | `script[type="application/ld+json"]` |

Never use obfuscated CSS class names — they change on every Yelp deploy.

## Known limitations

- **Search results**: Returns ~5-10 businesses from typeahead (not full paginated search)
  - Yelp Fusion API supports full search but requires API key
- **IP rate limiting**: DataDome blocks IPs after heavy use; needs cool-down periods
- **Reviews**: Only first page (10 reviews) from GQL
- **Website URL**: Extracted from GQL `businessUrl.url`; may be null for some businesses
