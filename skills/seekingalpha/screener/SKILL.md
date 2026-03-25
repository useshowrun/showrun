# seekingalpha-screener

Stock and ETF screener for Seeking Alpha — list saved screeners, run them, browse available filters, and access the built-in "Top Rated Stocks" screener.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/) (only for `auth`)
- Seeking Alpha account (logged in via Chrome)

## Setup
```bash
node seekingalpha-screener.mjs auth
```
Open seekingalpha.com in Chrome first, then run `auth` to extract session cookies.

## Usage

### List saved screeners
```bash
node seekingalpha-screener.mjs list
node seekingalpha-screener.mjs list --type=stock
node seekingalpha-screener.mjs list --type=etf
```

### Run a saved screener
```bash
node seekingalpha-screener.mjs run 96793299
node seekingalpha-screener.mjs run 96793299 --page=2
```

### List available filter fields
```bash
node seekingalpha-screener.mjs filters
node seekingalpha-screener.mjs filters --type=stock
node seekingalpha-screener.mjs filters --type=etf
```

### Top Rated Stocks (built-in screener)
```bash
node seekingalpha-screener.mjs top-stocks
node seekingalpha-screener.mjs top-stocks --page=2
```

## How it works

1. **auth** — Connects to Chrome via CDP, extracts all seekingalpha.com cookies (including PerimeterX bot-protection cookies), saves to session file.
2. **list** — `GET /api/v3/screeners?type={stock|etf}` — returns saved screener names, IDs, filter counts, results counts, and descriptions.
3. **run** — Three-step process:
   - `GET /api/v3/screeners/{id}?lang=en` to fetch the screener configuration (filters as object, sort, columnOrder).
   - `POST /api/v3/screener_results` with the config as JSON body to execute the screener.
   - Then batch-fetches metrics (`GET /api/v3/metrics`) and grades (`GET /api/v3/ticker_metric_grades?filter[algos]=main_quant`) for all result tickers. These APIs use JSONAPI relational format with `included` arrays for metric_type-to-field-name mapping.
   - Returns: ticker, company name, exchange, quant/author/sell-side ratings, market cap, P/E, dividend yield, revenue growth, EPS growth (diluted YoY), 1Y price return, and letter grades (value/growth/profitability/momentum/EPS revisions).
4. **filters** — `GET /api/v3/screener_filters?type={type}&variation=show` — returns a plain JSON array (not JSONAPI) of filter groups, each containing filter field definitions with types, options, and value ranges. Returns both grouped and flat views.
5. **top-stocks** — Runs the built-in "Top Rated Stocks" screener (ID: 96793299) using the same `run` flow.

## Data storage
```
~/.local/share/showrun/data/seekingalpha-screener/
  session.json              Auth cookies
  cache/
    screeners-stock.json    Cached screener list (stock)
    screeners-etf.json      Cached screener list (etf)
    screener-{id}-p{n}.json Cached screener results
    filters-stock.json      Cached filter definitions
    filters-etf.json        Cached ETF filter definitions
```

## Session expiry

Sessions typically last days to weeks. If you see "Session expired or blocked" errors, re-run:
```bash
node seekingalpha-screener.mjs auth
```
