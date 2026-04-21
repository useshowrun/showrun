# yahoofinance-search

Search Yahoo Finance for symbols, quotes, news, and ticker lookups across all asset types.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance visited in Chrome (to have cookies)

## Setup

```bash
node yahoofinance-search.mjs auth
```

## Usage

```bash
# Search for symbols and news
node yahoofinance-search.mjs search "Apple"
node yahoofinance-search.mjs search "Tesla" --quotes=5 --news=3

# Lookup tickers by type
node yahoofinance-search.mjs lookup "AAPL"
node yahoofinance-search.mjs lookup "Bitcoin" --type=cryptocurrency --count=10
node yahoofinance-search.mjs lookup "SPY" --type=etf
node yahoofinance-search.mjs lookup "Gold" --type=future
```

## Commands

### search

Search Yahoo Finance for matching quotes and related news articles.

```bash
node yahoofinance-search.mjs search <query> [--quotes=8] [--news=8]
```

Returns `{quotes: [{symbol, shortname, exchange, quoteType, score}], news: [{title, publisher, link, providerPublishTime}]}`

### lookup

Lookup financial instruments by query and asset type.

```bash
node yahoofinance-search.mjs lookup <query> [--type=all] [--count=25]
```

Types: `all`, `equity`, `mutualfund`, `etf`, `index`, `future`, `currency`, `cryptocurrency`

Returns `[{symbol, shortName, exchange, quoteType, regularMarketPrice, ...}]`

## Account tier

Both commands (`search`, `lookup`) work on the free Yahoo Finance account.

## How it works

1. `auth` — Extracts cookies from Chrome via CDP, then fetches a crumb token from Yahoo Finance API
2. `search` — Calls `GET https://query2.finance.yahoo.com/v1/finance/search` with query and crumb
3. `lookup` — Calls `GET https://query1.finance.yahoo.com/v1/finance/lookup` with query, type filter, and crumb

## Data storage

```
~/.local/share/showrun/data/yahoofinance-search/
├── session.json     Auth cookies & crumb
└── cache/           Cached search/lookup result JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors. The crumb and cookies may expire after some time.
