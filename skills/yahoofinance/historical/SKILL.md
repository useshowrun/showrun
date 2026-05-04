---
name: yahoofinance-historical
description: "Fetch historical price data (OHLCV), dividends, stock splits, and shares outstanding from Yahoo Finance."
---

# yahoofinance-historical

Fetch historical price data (OHLCV), dividends, stock splits, and shares outstanding from Yahoo Finance.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome (no login required, but cookies needed)

## Setup

```bash
node yahoofinance-historical.mjs auth
```

## Usage

```bash
# OHLCV price history
node yahoofinance-historical.mjs prices AAPL
node yahoofinance-historical.mjs prices MSFT --period=1y --interval=1wk
node yahoofinance-historical.mjs prices TSLA --start=2023-01-01 --end=2024-01-01
node yahoofinance-historical.mjs prices SPY --interval=5m --period=5d --prepost

# Dividends
node yahoofinance-historical.mjs dividends AAPL
node yahoofinance-historical.mjs dividends AAPL --period=max

# Stock splits
node yahoofinance-historical.mjs splits AAPL
node yahoofinance-historical.mjs splits AAPL --period=max

# Shares outstanding
node yahoofinance-historical.mjs shares AAPL
node yahoofinance-historical.mjs shares AAPL --start=2020-01-01 --end=2024-01-01
```

## How it works

1. `auth` -- Extracts cookies from Chrome via CDP, fetches crumb from `/v1/test/getcrumb`, saves session.json
2. `prices` -- GET `/v8/finance/chart/{symbol}` with range/period1+period2, interval, events params. Parses `chart.result[0].timestamp` + `chart.result[0].indicators.quote[0]` (open, high, low, close, volume)
3. `dividends` -- Same chart endpoint with `events=div`. Parses `chart.result[0].events.dividends`
4. `splits` -- Same chart endpoint with `events=split`. Parses `chart.result[0].events.splits`
5. `shares` -- GET `/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}` with `type=quarterlySharesOutstanding,annualSharesOutstanding`. Parses `timeseries.result[].quarterlySharesOutstanding` and `annualSharesOutstanding`

Period options: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max

Interval options: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo

Note: Intraday intervals (1m-90m) are limited to the last 60 days of data.

## Data storage

```
~/.local/share/showrun/data/yahoofinance-historical/
├── session.json     Auth cookies, crumb & user-agent
└── cache/           Cached JSON responses
```

## Session expiry

Re-run `auth` on 401/403 errors.
