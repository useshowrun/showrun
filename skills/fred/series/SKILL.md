# fred-series

St. Louis Fed FRED economic-data API wrapper — 800 K+ macro time series covering interest rates, inflation, GDP, employment, FX, commodities, money supply, financial conditions, sectoral indices, regional data, and more. The canonical free source for U.S. and global macroeconomic statistics. Free API key required (instant signup); no quota beyond 120 req/min.

Wraps `https://api.stlouisfed.org/fred/`. The same data behind `fred.stlouisfed.org` charts.

## Prerequisites

- Node.js 22+ (built-in fetch, stdlib only)
- Free FRED API key

## Setup

Get a free key (instant): <https://fred.stlouisfed.org/docs/api/api_key.html>

Save in either of:

```bash
export FRED_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" > ~/.local/share/showrun/data/fred/token.txt
```

The key is sent as `?api_key=` on every request. Rate limit: **120 req/min** — script self-throttles to ~100/min.

## Usage

```bash
# Series metadata — title, units, frequency, span, last-updated
node scripts/fred.mjs info GDP
node scripts/fred.mjs info UNRATE
node scripts/fred.mjs info CPIAUCSL

# Observations (with ASCII chart). --limit defaults to 100; --from/--to are inclusive.
node scripts/fred.mjs fetch UNRATE --from=2020-01-01
node scripts/fred.mjs fetch GDP --from=2015-01-01 --to=2024-12-31
node scripts/fred.mjs fetch DGS10 --limit=50            # 10-year Treasury yield, 50 latest

# Most recent values (shorthand)
node scripts/fred.mjs recent FEDFUNDS --limit=12        # last 12 months of fed-funds rate

# Search the entire 800K-series catalog
node scripts/fred.mjs search "consumer price" --popularity --limit=10
node scripts/fred.mjs search "manufacturing employment" --limit=20
```

## Output format

```
# FRED — Unemployment Rate  (UNRATE, Monthly, %)
   range: 2020-01-01 → 2025-09-01    n=69    min=3.4  max=14.8

   2020-01-01           3.5  ████
   2020-02-01           3.5  ████
   2020-03-01           4.4  █████
   2020-04-01          14.8  ████████████████████████████████████████
   2020-05-01          13.2  ███████████████████████████████████
   ...
```

```
# FRED search — "consumer price"  (by popularity)
   matches: 4,012    showing 10

   CPIAUCSL             M    Index 1982-1984=10 Consumer Price Index for All Urban Consumers: All Items in U.S. City Average
   CPILFESL             M    Index 1982-1984=10 Consumer Price Index for All Urban Consumers: All Items Less Food and Energy
   ...
```

## Useful series IDs to start

| ID            | What                                        |
|---------------|---------------------------------------------|
| `GDP`         | U.S. nominal GDP, quarterly                 |
| `GDPC1`       | U.S. real GDP (chained 2017$), quarterly    |
| `UNRATE`      | U.S. unemployment rate, monthly             |
| `CPIAUCSL`    | U.S. CPI all items, monthly                 |
| `CPILFESL`    | U.S. core CPI (ex food & energy), monthly   |
| `FEDFUNDS`    | Fed funds effective rate, monthly           |
| `DGS10`       | 10-year Treasury yield, daily               |
| `DGS2`        | 2-year Treasury yield, daily                |
| `T10Y2Y`      | 10y minus 2y spread (yield-curve proxy)     |
| `DTWEXBGS`    | Trade-weighted USD index (broad), daily     |
| `DEXUSEU`     | USD/EUR exchange rate, daily                |
| `WTISPLC`     | WTI crude oil price, monthly                |
| `M2SL`        | M2 money stock, monthly                     |
| `PAYEMS`      | Total nonfarm payrolls, monthly             |
| `RSAFS`       | Advance retail-sales total, monthly         |
| `HOUST`       | Housing starts, monthly                     |
| `STLFSI4`     | St. Louis Fed financial-stress index, weekly|

`search` for anything else.

## Data layout

All state under `~/.local/share/showrun/data/fred/cache/`:

- `info-{series-id}.json` — series metadata (24 h TTL)
- `obs-{series-id}-{from}-{to}-{limit}.json` — observation values (12 h TTL)
- `search-{slug}-{limit}-{rel|pop}.json` — search results (24 h TTL)

Delete a cache file to force refresh.

## API notes

- **Base**: `https://api.stlouisfed.org/fred/`
- **Series metadata**: `GET /series?series_id={id}` — `{ seriess: [{ id, title, units, units_short, frequency, frequency_short, observation_start, observation_end, last_updated, seasonal_adjustment, notes }] }`
- **Observations**: `GET /series/observations?series_id={id}&observation_start=YYYY-MM-DD&observation_end=...&limit=N&sort_order=asc|desc` — `{ observations: [{ date, value, ... }] }`. Missing values are encoded as `"."`; the script filters them out.
- **Search**: `GET /series/search?search_text={query}&order_by=popularity|search_rank|title|...&sort_order=desc&limit=N`
- **Required params**: every request needs `api_key=` and `file_type=json`. The script appends both automatically.
- **Reference**: <https://fred.stlouisfed.org/docs/api/fred/>

## Known pitfalls

- **Series IDs are case-sensitive in URLs**, but the script uppercases for safety. `gdp`, `Gdp`, and `GDP` all work; the canonical is `GDP`.
- **Frequencies vary wildly.** A series can be Daily (`D`), Weekly (`W`), Monthly (`M`), Quarterly (`Q`), Annual (`A`), or special (`SA` for semiannual). Long Daily series produce thousands of observations — use `--limit=` or `--from=` to constrain.
- **Missing values (`.`) are common** in older or revised series — the script silently filters them. If a chart looks suspiciously sparse, check the underlying observations JSON.
- **Vintages.** FRED stores both the *current* values and the original *vintages* (the value as it was reported at a given moment in history — important for studying real-time policy decisions). The default endpoint returns *current* values; this script doesn't expose vintages — use the FRED ALFRED API directly if you need that.
- **`recent` is just `fetch --limit=N` with `sort_order=desc` then re-sorted ascending** for the chart — they share the cache layout.
- **Non-US data.** FRED hosts foreign data too (BOE bank rate, ECB rates, OECD series, BIS, World Bank), but coverage thins outside the U.S. Use `search` to find what's available; if nothing shows up, try World Bank or OECD APIs (future skills).
