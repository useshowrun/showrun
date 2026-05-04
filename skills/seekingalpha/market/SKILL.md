---
name: seekingalpha-market
description: "Market indices, top movers, trending stocks, ETF performance tables, top dividend yields, and top-rated stocks from Seeking Alpha."
---

# seekingalpha-market

Market indices, top movers, trending stocks, ETF performance tables, top dividend yields, and top-rated stocks from Seeking Alpha.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/) (only for `auth`)
- A Seeking Alpha account (free or premium) with an active session in Chrome

## Setup
```bash
node seekingalpha-market.mjs auth
```
Open seekingalpha.com in Chrome and log in before running auth. This extracts session cookies (including PerimeterX tokens) via CDP.

## Usage

### Global Market Indices
```bash
node seekingalpha-market.mjs indices
```
Returns index groups (US, World, Bonds, Commodities, Forex, Crypto) with each ticker's name. Also includes market open/close status. Price data for index tickers (DJI, SP500, etc.) is not available through the SA symbol_data API; regular stock tickers do get price enrichment.

### Top Day Movers
```bash
node seekingalpha-market.mjs movers
```
Returns today's top gainers, top losers, most active stocks, cryptocurrencies, SP500 gainers, and SP500 losers. Each stock includes price and market cap from the symbol_data API.

### Trending Stocks
```bash
node seekingalpha-market.mjs trending
```
Returns stocks currently trending on Seeking Alpha with price, market cap, and dividend yield.

### Top Dividend Yielding Stocks
```bash
node seekingalpha-market.mjs top-yielding
```
Returns the top dividend yielding stocks grouped by index (sp500, cap400, cap600). Each stock includes forward dividend yield, price, and market cap.

### Top-Rated Stocks by Market Cap
```bash
node seekingalpha-market.mjs top-rated
node seekingalpha-market.mjs top-rated --cap=mid
node seekingalpha-market.mjs top-rated --cap=small
```
Returns top quant-rated stocks filtered by market cap (large, mid, or small). Defaults to large cap. Each stock includes quant rating score, rating label (bullish/very_bullish/neutral/bearish), market cap, exchange, price, and rating change history.

### ETF Performance Tables
```bash
node seekingalpha-market.mjs tables                    # List all 18 categories
node seekingalpha-market.mjs tables key_markets        # Key Market Data
node seekingalpha-market.mjs tables sectors             # US and Global sector ETFs
node seekingalpha-market.mjs tables crypto              # Cryptocurrency prices
node seekingalpha-market.mjs tables bonds               # Bond ETFs
node seekingalpha-market.mjs tables aristocrats          # Dividend Aristocrats
```
Returns ETF performance data organized into sections. Each category contains one or more sections (e.g. "Key Market Data" has U.S. Equities, US Equity Sectors, Global Equities, Bonds, Commodities, Currencies, etc.). Each ticker includes price, market cap, dividend yield, alias name, and sector (when available).

**Available categories** (18 total): `key_markets`, `bonds`, `commodities`, `countries`, `currencies`, `dividends`, `emerging_markets`, `global_and_regions`, `growth_vs_value`, `market_cap`, `real_estate`, `sectors`, `strategies`, `smart_beta`, `themes_and_subsectors`, `cryptocurrency`, `dividend_aristocrats`, `dividend_champions`

**Short aliases**: `key`, `bond`, `commodity`, `country`, `currency`/`forex`/`fx`, `dividend`, `emerging`/`em`, `global`/`regions`, `growth`/`value`, `cap`, `realestate`/`reit`, `sector`, `strategy`, `beta`, `themes`/`subsectors`, `crypto`, `aristocrats`, `champions`

## How it works

1. **auth** -- Uses CDP to extract cookies (including PerimeterX `_pxvid`/`pxcts` tokens) from an open Seeking Alpha tab in Chrome. Saves them to `session.json`.
2. **indices** -- Calls `GET /api/v3/global_indices?include=tickers` to get index groups with their constituent tickers. Enriches with `GET /api/v3/symbol_data` for price data where available.
3. **movers** -- Calls `GET /api/v3/day_watch?sort=ext_percent_change` which returns a single object with `top_gainers`, `top_losers`, `most_active`, `cryptocurrencies`, `sp500_gainers`, `sp500_losers` arrays. Enriches each stock with price data from `symbol_data`.
4. **trending** -- Calls `GET /api/v3/homepage_cards/trending_stocks` which returns a plain JSON array (not JSONAPI). Enriches with price data.
5. **top-yielding** -- Calls `GET /api/v3/homepage_cards/top_yielding_tickers?per_group=10` which returns `{ sp500: [...], cap400: [...], cap600: [...] }`. Each item includes `div_yield_fwd`. Enriches with price data.
6. **top-rated** -- Calls `GET /api/v3/homepage_cards/latest_ratings_by_marketcap` (JSONAPI format). Extracts quant ratings and market cap from `included` metrics, rating labels from `included` tickerChanges. Enriches with price data.
7. **tables** (no args) -- Calls `GET /api/v3/etf_performance_categories` which returns all 18 category names and slugs.
8. **tables \<slug\>** -- Calls `GET /api/v3/etf_performance_categories/<slug>` (JSONAPI format). The response contains `etf_performance_section` entries (each with a name and layout) and `tag` entries (tickers with slug, company, alias_name, div_yield_fwd, sector). Enriches tickers with price data from `symbol_data`. Layouts: `performance` (ETFs), `dividends` (individual stocks with yield and sector), `price` (crypto).

## Data storage

```
~/.local/share/showrun/data/seekingalpha-market/
  session.json          # Auth cookies
  cache/
    indices.json           # Cached indices data
    movers.json            # Cached movers data
    trending.json          # Cached trending stocks
    top-yielding.json      # Cached top yielding stocks
    top-rated-large.json   # Cached top-rated (large cap)
    top-rated-mid.json     # Cached top-rated (mid cap)
    top-rated-small.json   # Cached top-rated (small cap)
    tables-categories.json # Cached table category list
    tables-<slug>.json     # Cached table data per category
```

## Known limitations

- **Index price data unavailable**: The SA `symbol_data` API returns null for index tickers (DJI, SP500, COMP:IND, etc.) and commodities/forex. Only regular equity tickers get price data.
- **No percent change available**: The `symbol_data` API does not return `percentChange`, `lastPrice`, or `volume` fields. Only `price`, `marketCap`, `divYield`, and `eps` are populated. Real-time percent change data may require a separate WebSocket or premium API.
- **Crypto prices unavailable**: Cryptocurrency tickers (BTC-USD, ETH-USD, etc.) are not supported by the `symbol_data` API, so price/marketCap fields return null for crypto tables.

## Session expiry

Sessions typically last days to weeks. If you see 401/403 errors, re-run:
```bash
node seekingalpha-market.mjs auth
```
Make sure you have seekingalpha.com open and logged in in Chrome before re-authenticating.
