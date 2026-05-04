---
name: yahoofinance-markets
description: "Fetch market summary (major indices with prices and changes) and market status (open/close times, timezone) from Yahoo Finance."
---

# yahoofinance-markets

Fetch market summary (major indices with prices and changes) and market status (open/close times, timezone) from Yahoo Finance.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome (logged in or with cookies)

## Setup

```bash
node yahoofinance-markets.mjs auth
```

## Usage

```bash
# Market summary — major indices with price, change, % change
node yahoofinance-markets.mjs summary
node yahoofinance-markets.mjs summary --market=us_market
node yahoofinance-markets.mjs summary --market=gb_market
node yahoofinance-markets.mjs summary --market=jp_market

# Market status — open time, close time, timezone, current state
node yahoofinance-markets.mjs status
node yahoofinance-markets.mjs status --market=us_market
node yahoofinance-markets.mjs status --market=hk_market
```

## Markets

Common market identifiers: `us_market`, `gb_market`, `de_market`, `fr_market`, `jp_market`, `hk_market`, `ca_market`, `au_market`

## How it works

1. `auth` — Extracts cookies from Chrome via CDP, fetches crumb from Yahoo Finance API
2. `summary` — GET `/v6/finance/quote/marketSummary` with fields shortName, regularMarketPrice, regularMarketChange, regularMarketChangePercent
3. `status` — GET `/v6/finance/markettime` for market open/close times and timezone info

## Data storage

```
~/.local/share/showrun/data/yahoofinance-markets/
├── session.json     Auth cookies & crumb
└── cache/           Cached API responses
```

## Session expiry

Re-run `auth` on 401/403 errors.
