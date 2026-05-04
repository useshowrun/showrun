---
name: seekingalpha-portfolio
description: "View and manage Seeking Alpha portfolios, holdings, and rating change alerts."
---

# seekingalpha-portfolio

View and manage Seeking Alpha portfolios, holdings, and rating change alerts.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- Logged-in Seeking Alpha session in Chrome

## Setup

```bash
node seekingalpha-portfolio.mjs auth
```

Opens a CDP connection to Chrome, extracts cookies (including PerimeterX tokens and `user_cookie_key`), and saves them to `session.json`.

## Usage

### List all portfolios
```bash
node seekingalpha-portfolio.mjs list
```

### View portfolio tickers
```bash
node seekingalpha-portfolio.mjs view <portfolioId>
```
Shows all tickers in a portfolio with symbol, company name, sector, sub-industry, equity type, fund type, country, exchange, currency, and (if available) shares and cost basis.

### Rating change alerts
```bash
node seekingalpha-portfolio.mjs alerts
```
Shows rating change notifications across all portfolios, including previous and new ratings.

## How it works

1. **auth** — Uses CDP `Network.getCookies` to extract the full cookie jar from a Seeking Alpha browser tab. Stores cookies and `user_cookie_key` (the account identifier used in API URLs) in `session.json`.

2. **list** — Calls `GET /api/v3/account/{userKey}/portfolios` with includes for tickers, holdings, sectors, and sub-industries. Resolves JSON:API relationships to build a portfolio summary. Returns portfolio ID, name, watchlist flag, tickers count, and creation date.

3. **view** — Uses the same portfolios endpoint as `list`, then filters to the requested portfolio ID. Resolves each ticker's sector and sub-industry from the JSON:API `included` entities. Country, exchange, and currency come from ticker attributes directly.

4. **alerts** — Calls `GET /api/v3/account/{userKey}/portfolios/all/rating_change_notices?with_dismissed=true`. Returns rating type, previous/new rating values, and dismissal status.

## Data storage

```
~/.local/share/showrun/data/seekingalpha-portfolio/
  session.json              # Auth cookies + userCookieKey
  cache/
    portfolios.json         # Last list result
    portfolio-{id}.json     # Last view result per portfolio
    alerts.json             # Last alerts result
```

## Session expiry

Sessions typically last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-portfolio.mjs auth
```
