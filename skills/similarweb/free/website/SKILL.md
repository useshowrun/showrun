---
name: similarweb-free-website
description: "Website traffic analytics from a SimilarWeb FREE account: overview, traffic & engagement, weekly visit trend, marketing channels, audience geography, similar sites, referrals, social traffic, and display advertising. Covers a single most-recent month, worldwide."
---

# similarweb-free-website

Website traffic analytics available to a **free / expired-trial** SimilarWeb account. This is the free-tier counterpart of `similarweb-website` (which needs a SimilarWeb Pro plan).

What the free tier gives you:
- A **single most recent complete month** of data (SimilarWeb data lags ~1 month).
- **Worldwide** figures only — per-country breakdowns require a paid plan.
- Top-N tables (referrals, publishers, etc.) are capped at small page sizes.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A SimilarWeb account (free is fine), logged in at pro.similarweb.com

## Setup

Open SimilarWeb in Chrome and log in, then run:

```bash
node similarweb-free-website.mjs auth
```

This extracts all cookies (including the AWS WAF token) from your Chrome session.

## Usage

```bash
# Site header: title, description, category, global/category rank, related apps
node similarweb-free-website.mjs overview netflix.com

# Traffic & engagement: monthly visits, bounce rate, pages/visit, duration, device split, ranks
node similarweb-free-website.mjs traffic netflix.com

# Weekly visit trend across the month
node similarweb-free-website.mjs visits netflix.com

# Multi-month history — weekly points + monthly rollup (up to 6 months back)
node similarweb-free-website.mjs visits netflix.com --months=6

# Marketing channel breakdown (Direct, Organic/Paid Search, Social, Referrals, Email, Display, Gen AI, ...)
node similarweb-free-website.mjs channels netflix.com

# Top countries by traffic share
node similarweb-free-website.mjs geography netflix.com
node similarweb-free-website.mjs geography netflix.com --count=20

# Similar/competing websites with global rank
node similarweb-free-website.mjs similar netflix.com
node similarweb-free-website.mjs similar netflix.com --count=50

# Incoming + outgoing referral domains and top referring categories
node similarweb-free-website.mjs referrals netflix.com
node similarweb-free-website.mjs referrals netflix.com --count=20

# Social network traffic share (YouTube, Facebook, X, Instagram, ...)
node similarweb-free-website.mjs social netflix.com

# Display ad publishers + ad-driven traffic destinations
node similarweb-free-website.mjs ads netflix.com
```

Domain input accepts `netflix.com`, `www.netflix.com`, or full URLs like `https://netflix.com/browse`.

## Commands

| Command | API endpoint(s) | Returns |
|---|---|---|
| `auth` | CDP cookie extraction | Saves session cookies |
| `overview` | `/api/WebsiteOverview/getheader` | Title, description, category, global & category rank, related mobile apps |
| `traffic` | `widgetApi/WebsiteOverview/{EngagementOverview/Table, EngagementVisits/SingleMetric, WebRanks/SingleMetric, EngagementDesktopVsMobileVisits/PieChart}` | Monthly visits + MoM change, bounce rate, pages/visit, avg duration, page views, desktop/mobile split, ranks |
| `visits` | `widgetApi/WebsiteOverview/EngagementVisits/Graph` | Weekly visit counts within the month, or across N months with `--months=N` (adds a `months` array with monthly totals) |
| `channels` | `widgetApi/MarketingMixTotal/TrafficSourcesOverview/PieChart` | Per-channel visits and share |
| `geography` | `widgetApi/WebsiteGeography/Geography/Table` | Top countries with traffic share and MoM change |
| `similar` | `/api/WebsiteOverview/getsimilarsites` | Competing domains with global rank |
| `referrals` | `widgetApi/WebsiteOverview/{TopReferrals/Table, TrafficDestinationReferrals/Table, TopReferringCategories/Table}` | Incoming + outgoing referral domains, referring categories |
| `social` | `widgetApi/WebsiteOverviewDesktop/TrafficSourcesSocial/PieChart` | Social network traffic share |
| `ads` | `/api/AdIntelligence/Advertiser/Publishers/breakdown` + `widgetApi/WebsiteOverviewDesktop/TrafficDestinationAds/Table` | Ad publishers (impressions/visits/spend share) + ad-driven traffic destinations |

## Free-tier limits

- Most commands cover a **single most recent complete month** (SimilarWeb data lags ~1 month).
- **`visits` is an exception**: pass `--months=N` (1..6) to get weekly points across N months plus a monthly rollup. Free-tier accounts cap the `Graph` endpoint at 6 complete months of history — wider ranges get a `400 "Interval is invalid — Allowed interval is …"` from SimilarWeb. The `SingleMetric` endpoints backing `traffic` and `channels` are stricter still and return HTTP 400 for anything but the single most recent month.
- **Worldwide only.** The `--country` flag exists but non-`999` values require a paid plan.

## Data storage

```
~/.local/share/showrun/data/similarweb-free-website/
  session.json                       # Auth cookies
  cache/
    netflix_com-overview.json        # Cached command outputs
    netflix_com-traffic.json
    netflix_com-visits.json
    netflix_com-channels.json
    netflix_com-geography.json
    netflix_com-similar.json
    netflix_com-referrals.json
    netflix_com-social.json
    netflix_com-ads.json
```

## Session expiry

SimilarWeb sessions last days to weeks. On 401/403 errors, re-run `node similarweb-free-website.mjs auth` with an active SimilarWeb tab open in Chrome. The AWS WAF token (`aws-waf-token`) and session cookies (`.SGTOKEN.SIMILARWEB.COM`) are essential; every request also sends `X-Requested-With`, `X-Sw-Page`, and `X-Sw-Page-View-Id` headers to pass AWS WAF.
