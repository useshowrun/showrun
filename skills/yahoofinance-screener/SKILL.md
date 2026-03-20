# yahoofinance-screener

Screen stocks and mutual funds using Yahoo Finance's screener API with predefined or custom queries.

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance open in Chrome (for cookie extraction)

## Setup

```bash
node yahoofinance-screener.mjs auth
```

## Usage

```bash
# Run a predefined screen (most active stocks)
node yahoofinance-screener.mjs predefined most_actives

# Predefined screen with pagination
node yahoofinance-screener.mjs predefined day_gainers --count=10 --offset=0

# Custom search: stocks up more than 3% in the US
node yahoofinance-screener.mjs search --query='[{"op":"gt","field":"percentchange","val":3},{"op":"eq","field":"region","val":"us"}]'

# Custom search with sorting
node yahoofinance-screener.mjs search --query='[{"op":"btwn","field":"peratio.lasttwelvemonths","val":[0,20]},{"op":"gte","field":"epsgrowth.lasttwelvemonths","val":25}]' --sort=percentchange --asc

# Custom search for mutual funds
node yahoofinance-screener.mjs search --query='[{"op":"is-in","field":"performanceratingoverall","val":[4,5]}]' --type=MUTUALFUND

# List all available screener fields
node yahoofinance-screener.mjs fields
```

## How it works

1. `auth` — Extracts cookies from your Chrome Yahoo Finance tab via CDP, then fetches a crumb token from the Yahoo API
2. `predefined` — GETs from `/v1/finance/screener/predefined/saved` with predefined query name, count, and offset
3. `search` — POSTs to `/v1/finance/screener` with a custom query body containing operators and operands
4. `fields` — Prints all available screener fields grouped by category

## Predefined screens

- `most_actives` — Most actively traded stocks
- `day_gainers` — Stocks with biggest gains today
- `day_losers` — Stocks with biggest losses today
- `most_shorted_stocks` — Most shorted stocks
- `aggressive_small_caps` — Aggressive small cap stocks
- `undervalued_growth_stocks` — Undervalued growth stocks
- `undervalued_large_caps` — Undervalued large cap stocks
- `small_cap_gainers` — Small cap gainers
- `growth_technology_stocks` — Growth technology stocks
- `top_mutual_funds` — Top mutual funds
- `high_yield_bond` — High yield bond funds
- `portfolio_anchors` — Portfolio anchor funds
- `solid_large_growth_funds` — Solid large growth funds
- `solid_midcap_growth_funds` — Solid midcap growth funds
- `conservative_foreign_funds` — Conservative foreign funds

## Query filter format

Each filter is an object with `op`, `field`, and `val`:
```json
{"op": "gt", "field": "percentchange", "val": 3}
```

Available operators: `gt`, `lt`, `gte`, `lte`, `btwn`, `eq`, `is-in`

For `btwn`, pass an array of two values:
```json
{"op": "btwn", "field": "peratio.lasttwelvemonths", "val": [0, 20]}
```

For `is-in`, pass an array of values:
```json
{"op": "is-in", "field": "exchange", "val": ["NMS", "NYQ"]}
```

## Data storage

```
~/.local/share/showrun/data/yahoofinance-screener/
├── session.json     Auth cookies & crumb
└── cache/           Screener result JSON files
```

## Session expiry

Sessions expire periodically. Re-run `auth` when you get 401/403 errors.
