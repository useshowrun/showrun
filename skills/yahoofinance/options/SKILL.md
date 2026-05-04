---
name: yahoofinance-options
description: "Fetch options chains (calls and puts) from Yahoo Finance, including expiration dates, strike prices, greeks, and underlying quote data."
---

# yahoofinance-options

Fetch options chains (calls and puts) from Yahoo Finance, including expiration dates, strike prices, greeks, and underlying quote data.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome (no login required, but a session cookie is needed)

## Setup

```bash
node yahoofinance-options.mjs auth
```

## Usage

```bash
# List available expiration dates for a symbol
node yahoofinance-options.mjs expirations AAPL
node yahoofinance-options.mjs expirations TSLA

# Fetch options chain (nearest expiration by default)
node yahoofinance-options.mjs chain AAPL

# Fetch options chain for a specific expiration date
node yahoofinance-options.mjs chain AAPL --date=2026-04-17
node yahoofinance-options.mjs chain TSLA --date=2026-06-19
```

## How it works

1. `auth` — Extracts A3 cookie from Chrome via CDP, then fetches a crumb from Yahoo's `/v1/test/getcrumb` endpoint
2. `expirations` — Calls `GET /v7/finance/options/{symbol}` (no date param) and extracts `optionChain.result[0].expirationDates[]`, converting unix timestamps to YYYY-MM-DD dates
3. `chain` — Calls `GET /v7/finance/options/{symbol}?date={unix_ts}` (or without date for nearest expiration). Returns underlying quote info, calls, and puts with all option fields (strike, bid, ask, volume, open interest, implied volatility, etc.)

## Output format

### expirations
```json
{
  "symbol": "AAPL",
  "expirations": ["2026-03-21", "2026-03-28", "..."],
  "expirationTimestamps": [1774310400, 1774915200, "..."]
}
```

### chain
```json
{
  "symbol": "AAPL",
  "expirationDate": "2026-04-17",
  "underlying": {
    "symbol": "AAPL",
    "shortName": "Apple Inc.",
    "regularMarketPrice": 175.50,
    "..."
  },
  "calls": [
    {
      "contractSymbol": "AAPL260417C00100000",
      "lastTradeDate": "2026-03-19T20:00:00.000Z",
      "strike": 100,
      "lastPrice": 76.50,
      "bid": 75.80,
      "ask": 77.20,
      "volume": 150,
      "openInterest": 1200,
      "impliedVolatility": 0.35,
      "inTheMoney": true,
      "..."
    }
  ],
  "puts": ["..."]
}
```

## Data storage

```
~/.local/share/showrun/data/yahoofinance-options/
├── session.json     Auth cookie & crumb
└── cache/           Cached API responses
```

## Session expiry

Re-run `auth` on 401/403 errors.
