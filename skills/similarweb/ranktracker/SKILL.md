# similarweb-ranktracker

Search rank tracking from SimilarWeb: list campaigns, view rank distribution over time, and track per-keyword daily SERP positions.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

```bash
node similarweb-ranktracker.mjs auth
```

Reuses session from `similarweb-website` if available.

## Usage

```bash
# List all campaigns (your campaigns + built-in demos)
node similarweb-ranktracker.mjs campaigns

# Campaign details: tracked keywords, competitors, tags
node similarweb-ranktracker.mjs details hubspot

# Daily rank distribution (positions 1, 2-3, 4-10, 11-30, >30) per site
node similarweb-ranktracker.mjs ranks hubspot

# Per-keyword daily position trends sorted by volume
node similarweb-ranktracker.mjs keywords hubspot --count=10
```

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise extracts cookies from Chrome.

2. **campaigns** -- Calls `GET /api/rankTracker/campaigns`. Lists user campaigns, shared campaigns, and 3 built-in demo campaigns (Ray-Ban/Retail, Sixt/Car Rental, HubSpot/Software).

3. **details** -- Calls `GET /api/rankTracker/[demo/]campaign/<id>`. Returns campaign config: main site, competitors, all tracked keywords with tag categories, scraping configurations.

4. **ranks** -- Calls `GET /api/rankTracker/[demo/]reports/overviewReport/RankDistribution`. Returns daily position distribution for the main site and all competitors: how many keywords rank in position 1, 2-3, 4-10, 11-30, >30 each day.

5. **keywords** -- Calls `GET /api/rankTracker/[demo/]reports/keywordsTrendReport/TrendTable`. Returns per-keyword daily SERP positions with search volume. Shows position movement over the last month.

## Campaign argument

Accepts either a demo name or a campaign GUID:
- `hubspot`, `sixt`, `rayban` — built-in demo campaigns
- `1badc5b5-b010-...` — campaign GUID from the `campaigns` command

## Data storage

```
~/.local/share/showrun/data/similarweb-ranktracker/
  session.json                          # Auth cookies
  cache/
    campaigns.json
    campaign-1badc5b5.json
    ranks-1badc5b5.json
    keywords-1badc5b5.json
```

## Session expiry

If API calls return 401/403, re-run:
```bash
node similarweb-ranktracker.mjs auth
```
