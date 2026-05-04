---
name: similarweb-website
description: "Website traffic analytics from SimilarWeb: overview, traffic engagement, marketing channels, audience geography, referrals, similar sites, search traffic, keywords, social traffic, display advertising, and ad publishers."
---

# similarweb-website

Website traffic analytics from SimilarWeb: overview, traffic engagement, marketing channels, audience geography, referrals, similar sites, search traffic, keywords, social traffic, display advertising, and ad publishers.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

Open SimilarWeb Pro in Chrome and log in, then run:

```bash
node similarweb-website.mjs auth
```

This extracts all cookies (including the AWS WAF token required for API access) from your Chrome session.

## Usage

```bash
# Site overview: visits, rank, category, description, year founded, employees
node similarweb-website.mjs overview google.com

# Traffic & engagement: visits, bounce rate, pages/visit, duration, device split, ranks
node similarweb-website.mjs traffic google.com
node similarweb-website.mjs traffic google.com --country=840

# Marketing channel breakdown (direct, organic search, paid search, social, referrals, email, display)
node similarweb-website.mjs channels google.com
node similarweb-website.mjs channels google.com --country=840

# Top countries by traffic share with engagement metrics
node similarweb-website.mjs geography google.com
node similarweb-website.mjs geography google.com --count=20

# Top referring domains with traffic share
node similarweb-website.mjs referrals google.com
node similarweb-website.mjs referrals google.com --country=840

# Similar/competing websites with global rank
node similarweb-website.mjs similar google.com
node similarweb-website.mjs similar google.com --count=50

# Organic/paid search traffic volume by month
node similarweb-website.mjs search-traffic google.com
node similarweb-website.mjs search-traffic google.com --country=840

# Keyword count, brand split, rank distribution
node similarweb-website.mjs keywords google.com
node similarweb-website.mjs keywords google.com --country=840

# Social traffic by platform (YouTube, LinkedIn, Reddit, etc.)
node similarweb-website.mjs social google.com
node similarweb-website.mjs social google.com --country=840

# Display advertising summary + ad campaigns
node similarweb-website.mjs display google.com
node similarweb-website.mjs display google.com --country=840

# Ad publisher breakdown (impressions, visits, spend share)
node similarweb-website.mjs ads google.com
node similarweb-website.mjs ads google.com --country=840
```

Domain input accepts `google.com`, `www.google.com`, or full URLs like `https://google.com/search`.

Country codes: 999 = Worldwide (default), 840 = US, 826 = UK, 276 = Germany, 392 = Japan.

## How it works

1. **auth** -- Uses CDP to extract all cookies from a Chrome tab open to pro.similarweb.com. Stores the full cookie string (including the AWS WAF token and SGTOKEN cookies required for API access).

2. **overview** -- Calls `GET /api/WebsiteOverview/getheader`. Returns title, description, category, global ranking, category ranking, monthly visits, year founded, employee range, and highest traffic country.

3. **traffic** -- Makes 3 parallel widgetApi calls: `EngagementOverview/Table` for visits/bounce/duration/pages, `EngagementDesktopVsMobileVisits/PieChart` for device split, and `WebRanks/SingleMetric` for global/country/category ranks.

4. **channels** -- Calls `widgetApi/MarketingMixTotal/TrafficSourcesOverview/PieChart`. Returns per-channel traffic breakdown (Direct, Organic Search, Paid Search, Social, Referrals, Email, Display Ads) with total/desktop/mobile splits.

5. **geography** -- Calls `widgetApi/WebsiteGeographyExtended/GeographyExtended/Table`. Returns top countries with traffic share, engagement metrics (pages/visit, duration, bounce rate), and country rank.

6. **referrals** -- Calls `GET /api/websiteanalysis/GetTrafficSourcesTotalReferralsTable`. Returns top referring domains with traffic share, visit counts, category, rank, and month-over-month change.

7. **similar** -- Calls `GET /api/WebsiteOverview/getsimilarsites`. Returns competing domains with their global rank.

8. **search-traffic** -- Calls `GET /api/searchoverview/overview/traffic`. Returns monthly graph data for total search visits, organic visits, and paid visits.

9. **keywords** -- Makes 3 parallel calls for keyword counts, branded vs non-branded traffic split, and Top 3 vs Rest-to-100 keyword ranking.

10. **social** -- Calls `GET /api/websiteanalysis/GetTrafficSocial`. Returns total social volume, per-platform breakdown, and monthly volume trends.

11. **display** -- Makes 2 parallel calls: `AdIntelligence/Advertiser/summary` for campaign/creative counts, and `AdIntelligence/Advertiser/Campaigns/Data` for individual ad campaigns with landing pages and activity dates.

12. **ads** -- Calls `GET /api/AdIntelligence/Advertiser/Publishers/breakdown`. Returns ad publisher records with impressions share, visits share, spend share, category, and rank.

## Data storage

```
~/.local/share/showrun/data/similarweb-website/
  session.json                    # Auth cookies
  cache/
    google_com-overview.json      # Cached command outputs
    google_com-traffic.json
    google_com-channels.json
    google_com-geography.json
    google_com-referrals.json
    google_com-similar.json
    google_com-search-traffic.json
    google_com-keywords.json
    google_com-social.json
    google_com-display.json
    google_com-ads.json
```

## Session expiry

SimilarWeb sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node similarweb-website.mjs auth
```

Make sure you have an active SimilarWeb Pro tab open in Chrome when running auth. The AWS WAF token (`aws-waf-token`) and session cookies (`.SGTOKEN.SIMILARWEB.COM`, `.DEVICETOKEN.SIMILARWEB.COM`) are all essential for API access. Every API request also sends custom headers (`X-Requested-With`, `X-Sw-Page`, `X-Sw-Page-View-Id`) to pass AWS WAF protection.
