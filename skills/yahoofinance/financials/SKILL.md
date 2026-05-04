---
name: yahoofinance-financials
description: "Fetch income statement, balance sheet, and cash flow data from Yahoo Finance via the fundamentals timeseries API."
---

# yahoofinance-financials

Fetch income statement, balance sheet, and cash flow data from Yahoo Finance via the fundamentals timeseries API.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance visited in Chrome (no login required, but cookies must exist)

## Setup

```bash
node yahoofinance-financials.mjs auth
```

## Usage

```bash
# Income statement (annual by default)
node yahoofinance-financials.mjs income AAPL
node yahoofinance-financials.mjs income AAPL --period=quarterly
node yahoofinance-financials.mjs income AAPL --period=trailing

# Balance sheet
node yahoofinance-financials.mjs balance MSFT
node yahoofinance-financials.mjs balance MSFT --period=quarterly

# Cash flow statement
node yahoofinance-financials.mjs cashflow GOOG
node yahoofinance-financials.mjs cashflow GOOG --period=trailing

# Show help
node yahoofinance-financials.mjs
```

## How it works

1. `auth` -- Extracts cookies from Chrome via CDP, then fetches a crumb from `https://query1.finance.yahoo.com/v1/test/getcrumb`
2. `income` / `balance` / `cashflow` -- Calls `GET https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}` with all known field keys for the requested statement type, prefixed with the period type (annual/quarterly/trailing)
3. The `type=` parameter contains the full list of 90-120+ field names per statement to maximize data coverage
4. Response is parsed from `timeseries.result[]` where each element contains date-value pairs
5. A curated subset of key fields is displayed as a table; the full dataset is cached

## Commands

| Command | Description |
|---------|-------------|
| `auth` | Extract cookies from Chrome and fetch crumb |
| `income <SYMBOL> [--period=...]` | Income statement (annual, quarterly, trailing) |
| `balance <SYMBOL> [--period=...]` | Balance sheet (annual, quarterly) |
| `cashflow <SYMBOL> [--period=...]` | Cash flow statement (annual, quarterly, trailing) |

## Data storage

```
~/.local/share/showrun/data/yahoofinance-financials/
├── session.json     Auth cookie & crumb
└── cache/           Financial statement JSON files
    ├── AAPL-income-annual.json
    ├── MSFT-balance-quarterly.json
    └── GOOG-cashflow-trailing.json
```

## Session expiry

Re-run `auth` on 401/403 errors.
