---
name: similarweb-compare
description: "Side-by-side domain comparison using SimilarWeb Pro: engagement metrics, traffic channels, device split, rankings, and more."
---

# similarweb-compare

Side-by-side domain comparison using SimilarWeb Pro: engagement metrics, traffic channels, device split, rankings, and more.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

```bash
node similarweb-compare.mjs auth
```

Reuses session from `similarweb-website` if available, otherwise extracts cookies from Chrome.

## Usage

```bash
# Full engagement comparison (2-5 domains)
node similarweb-compare.mjs compare chatgpt.com claude.ai
node similarweb-compare.mjs compare amazon.com ebay.com walmart.com --country=840
node similarweb-compare.mjs compare github.com gitlab.com bitbucket.org

# Marketing channel comparison (2-5 domains)
node similarweb-compare.mjs channels chatgpt.com claude.ai grok.com
node similarweb-compare.mjs channels spotify.com apple.com --country=826
```

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise connects to Chrome via CDP and extracts SimilarWeb session cookies.

2. **compare** -- Makes 4 parallel API calls for all domains at once:
   - `WebsiteOverview/getheader` for title, category, year founded, employees
   - `AssetsCompare/Overview/Table` for engagement metrics (visits, unique users, visits/user, bounce rate, pages/visit, duration, page views)
   - `EngagementDesktopVsMobileVisits/Table` for device split (desktop vs mobile share)
   - `WebRanksCountry/Table` for global, country, and category rankings

3. **channels** -- Calls `MarketingMixTotal/TrafficSourcesOverview/PieChart` with all domains. Returns per-domain breakdown of traffic channels (Direct, Organic Search, Paid Search, Social, Referrals, Email, Display Ads) with visit counts and share percentages.

## Data storage

```
~/.local/share/showrun/data/similarweb-compare/
  session.json                                    # Auth cookies
  cache/
    compare-chatgpt_com-vs-claude_ai.json         # Cached comparisons
    channels-chatgpt_com-vs-claude_ai.json
```

## Session expiry

If API calls return 401/403, re-run `node similarweb-compare.mjs auth` with an active SimilarWeb session in Chrome.
