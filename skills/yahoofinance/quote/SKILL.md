# yahoofinance-quote

Fetch detailed stock/ticker data from Yahoo Finance including price summary, company profile, key statistics, holders, analyst estimates, calendar events, ESG scores, and news.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome (logged in or at least visited)

## Setup

```bash
node yahoofinance-quote.mjs auth
```

## Usage

```bash
# View current price, market data, key metrics
node yahoofinance-quote.mjs view AAPL

# Company profile, description, officers
node yahoofinance-quote.mjs profile AAPL

# Key statistics: valuation, profitability, balance sheet, share stats
node yahoofinance-quote.mjs statistics AAPL

# Holders: institutional, mutual fund, insider
node yahoofinance-quote.mjs holders AAPL

# Analysis: earnings estimates, EPS trend, recommendations, upgrades/downgrades
node yahoofinance-quote.mjs analysis AAPL

# Calendar: next earnings date, dividends, SEC filings
node yahoofinance-quote.mjs calendar AAPL

# ESG / Sustainability scores
node yahoofinance-quote.mjs sustainability MSFT

# Latest news
node yahoofinance-quote.mjs news GOOG
node yahoofinance-quote.mjs news GOOG --count=20
```

## How it works

1. `auth` -- Extracts cookies from Chrome via CDP (Network.getCookies for yahoo.com domains), then fetches a crumb token from `/v1/test/getcrumb`. Saves session.json with cookies, crumb, and userAgent.
2. `view`, `profile`, `statistics`, `holders`, `analysis`, `calendar`, `sustainability` -- Fetch data from `GET /v10/finance/quoteSummary/{symbol}?modules=...&crumb=...` with the appropriate module set.
3. `news` -- Fetches news via `POST /xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin` with ticker in the request body.

### quoteSummary modules used per command

| Command        | Modules                                                                                                              |
|----------------|----------------------------------------------------------------------------------------------------------------------|
| view           | summaryDetail, price, quoteType, defaultKeyStatistics, financialData                                                 |
| profile        | assetProfile                                                                                                         |
| statistics     | defaultKeyStatistics, financialData                                                                                  |
| holders        | majorHoldersBreakdown, institutionOwnership, fundOwnership, insiderHolders, insiderTransactions, netSharePurchaseActivity |
| analysis       | earningsTrend, earningsHistory, recommendationTrend, upgradeDowngradeHistory                                         |
| calendar       | calendarEvents, secFilings                                                                                           |
| sustainability | esgScores                                                                                                            |

## Data storage

```
~/.local/share/showrun/data/yahoofinance-quote/
├── session.json     Auth cookies, crumb, userAgent
└── cache/           Cached API response JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors. The crumb and cookies can expire; the script will print a clear message when re-authentication is needed.
