---
name: yahoofinance-etf
description: "Fetch ETF and mutual fund data from Yahoo Finance including holdings, sector weightings, operations, equity/bond metrics."
---

# yahoofinance-etf

Fetch ETF and mutual fund data from Yahoo Finance including holdings, sector weightings, operations, equity/bond metrics.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome

## Setup

```bash
node yahoofinance-etf.mjs auth
```

## Usage

```bash
# Fund overview (name, category, family, net assets, description)
node yahoofinance-etf.mjs view SPY
node yahoofinance-etf.mjs view VFINX

# Top holdings, sector weightings, asset composition
node yahoofinance-etf.mjs holdings QQQ
node yahoofinance-etf.mjs holdings SPY

# Expense ratio, turnover, management fees
node yahoofinance-etf.mjs operations VFINX

# Equity holdings stats (P/E, P/B, P/S, median market cap)
node yahoofinance-etf.mjs equity-holdings SPY

# Bond holdings (maturity, duration, credit quality, ratings)
node yahoofinance-etf.mjs bond-holdings BND
node yahoofinance-etf.mjs bond-holdings AGG
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP, fetches crumb from Yahoo API
2. All commands — Fetch from `GET /v10/finance/quoteSummary/{symbol}?modules=quoteType,summaryProfile,fundProfile,topHoldings`
3. `view` — Parses quoteType + summaryProfile + fundProfile for fund overview
4. `holdings` — Parses topHoldings for holdings list, sector weightings, asset composition
5. `operations` — Parses fundProfile.feesExpensesInvestment for expense/turnover data
6. `equity-holdings` — Parses topHoldings.equityHoldings for valuation metrics
7. `bond-holdings` — Parses topHoldings.bondHoldings + bondRatings for fixed income data

## Data storage

```
~/.local/share/showrun/data/yahoofinance-etf/
├── session.json     Auth cookies & crumb
└── cache/           Fund detail JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
