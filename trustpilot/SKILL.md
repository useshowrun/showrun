# Trustpilot Scraper

Scrapes business reviews, ratings, and company profiles from Trustpilot.

## Skills

| Skill | Description |
|-------|-------------|
| `trustpilot-search` | Search for businesses by name or domain |
| `trustpilot-business` | Full business details + paginated reviews |

## Quick Start

```bash
cd trustpilot
npm install  # first time only

# Search for businesses
SOCKS5_PROXY=127.0.0.1:11090 node trustpilot-search/scripts/trustpilot-search.mjs '{"query":"amazon"}'

# Get full business details + 40 reviews
SOCKS5_PROXY=127.0.0.1:11090 node trustpilot-business/scripts/trustpilot-business.mjs '{"domain":"amazon.com","maxReviews":40}'
```

## Anti-bot Notes

Trustpilot uses PerimeterX bot detection:

| Endpoint | Protection | Status |
|----------|------------|--------|
| `/search?query=...` | PerimeterX JS challenge | ✅ Auto-solved by camoufox |
| `/review/<domain>` | PerimeterX JS challenge | ✅ Auto-solved by camoufox |
| `/api/consumersitesearch-api/*` | Browser session required | ✅ Auto-intercepted |

**Residential proxy strongly recommended.**
- Set `SOCKS5_PROXY=127.0.0.1:11090` (SSH tunnel to 192.168.1.11:18081)
- Turkish residential IP (188.3.180.188) works reliably

## Data Sources

All data comes from `__NEXT_DATA__` (Next.js SSR JSON embedded in HTML):
- `props.pageProps.businessUnits` — search results
- `props.pageProps.businessUnit` — full business profile
- `props.pageProps.reviews` — 20 reviews per page
- `props.pageProps.filters` — pagination state
- `props.pageProps.sidebarData` — contact info

## Structure

```
trustpilot/
  SKILL.md          ← this file
  package.json
  lib/
    utils.mjs       ← shared browser/data helpers
  trustpilot-search/
    SKILL.md
    scripts/
      trustpilot-search.mjs
  trustpilot-business/
    SKILL.md
    scripts/
      trustpilot-business.mjs
```

## Session Log

### 2026-03-21 (scraper-skill-builder-10 subagent)
- Tested: Amazon (44K reviews, 1.7 trust score), search results
- Confirmed: __NEXT_DATA__ approach works reliably
- PerimeterX bypassed by camoufox fingerprinted Firefox
- 20 reviews per page from __NEXT_DATA__
- Search API also intercepted for additional results
