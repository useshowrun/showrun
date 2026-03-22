# seekingalpha-symbol

Stock and ETF data from Seeking Alpha: ratings, financials, earnings, dividends, valuation, growth, profitability, momentum, peers, news, and analysis.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A Seeking Alpha account (free or premium — premium unlocks more data)

## Setup

Open Seeking Alpha in Chrome and log in, then run:

```bash
node seekingalpha-symbol.mjs auth
```

This extracts all cookies (including PerimeterX bot-protection cookies) from your Chrome session. No CSRF token is needed.

## Usage

```bash
# Overview: price, ratings, key metrics, insider activity
node seekingalpha-symbol.mjs summary AAPL

# Quant/author/sell-side ratings with 3-month and 6-month history
node seekingalpha-symbol.mjs ratings AAPL

# Financial statements (income, balance sheet, cash flow)
node seekingalpha-symbol.mjs financials AAPL
node seekingalpha-symbol.mjs financials AAPL --type=balance --period=quarterly
node seekingalpha-symbol.mjs financials AAPL --type=cashflow --period=annual

# EPS and revenue estimates, surprises, revisions
node seekingalpha-symbol.mjs earnings AAPL

# Dividend yield, growth, safety, payout history
node seekingalpha-symbol.mjs dividends AAPL

# Valuation multiples with sector grades
node seekingalpha-symbol.mjs valuation AAPL

# Revenue, EPS, EBITDA growth rates with grades
node seekingalpha-symbol.mjs growth AAPL

# Margins, ROE, ROA with grades
node seekingalpha-symbol.mjs profitability AAPL

# Price performance and momentum grades
node seekingalpha-symbol.mjs momentum AAPL

# Similar stocks with comparison metrics
node seekingalpha-symbol.mjs peers AAPL

# Ticker-specific news
node seekingalpha-symbol.mjs news AAPL --count=20

# Analysis articles with author and sentiment
node seekingalpha-symbol.mjs analysis AAPL --count=5
```

Ticker input accepts uppercase (`AAPL`), lowercase (`aapl`), or full URLs (`https://seekingalpha.com/symbol/AAPL`).

## How it works

1. **auth** — Uses CDP to extract all cookies from a Chrome tab open to seekingalpha.com. Stores the full cookie string (including PerimeterX cookies required for API access) and the `user_cookie_key` for account endpoints.

2. **summary** — Calls `/api/v3/metrics` for price/market cap/PE/volume, `/api/v3/symbols/{slug}/rating/periods` for quant/author/sell-side ratings, and `/api/v3/symbols/{slug}/insiders_sell_buy` for insider activity. Returns a consolidated overview.

3. **ratings** — Calls `/api/v3/symbols/{slug}/rating/periods` with periods 0, 3, 6 to get current ratings plus 3-month and 6-month history for quant, authors, and sell-side analysts.

4. **financials** — Calls `/api/v3/symbols/{slug}/fundamentals_metrics` with `statement_type` (income-statement, balance-sheet, cash-flow-statement) and `period_type` (annual, quarterly). Returns line items with multi-period values.

5. **earnings** — Calls `/api/v3/symbol_data/estimates` for EPS and revenue actuals vs. consensus estimates, plus revision trends (7d, 30d, 90d).

6. **dividends** — Calls `/api/v3/metrics` for yield/payout/growth fields, `/api/v3/ticker_metric_grades` for dividend grades, and `/api/v3/symbols/{slug}/dividend_history` for 5-year payout history.

7. **valuation** — Calls `/api/v3/metrics`, `/api/v3/ticker_metric_grades`, and `/api/v3/symbols/{slug}/sector_metrics` for P/E, EV/EBITDA, P/S, PEG, and other multiples with letter grades and sector medians.

8. **growth** — Same triple-fetch pattern (metrics + grades + sector) for revenue, EPS, EBITDA, and FCF growth rates at 1Y, 3Y, 5Y, and forward horizons.

9. **profitability** — Same triple-fetch pattern for gross/EBITDA/operating/net margins, ROE, ROA, ROIC, ROCE.

10. **momentum** — Calls metrics + grades for 1W through 10Y price performance, relative performance, beta, and volatility.

11. **peers** — Calls `/api/v3/symbols/{slug}/suggested?source_type=peers_similarities` for peer list, then fetches comparison metrics (price, market cap, P/E, dividend yield, revenue growth, EPS growth) for all peers in a single batch call.

12. **news** — Calls `/api/v3/symbols/{slug}/news?filter[category]=news_card` with JSON:API includes for author and ticker data.

13. **analysis** — Calls `/api/v3/symbols/{slug}/analysis` with JSON:API includes for author, tickers, and sentiment data. Sentiments are deduplicated per article (e.g., "bullish", "bearish").

## Data storage

```
~/.local/share/showrun/data/seekingalpha-symbol/
  session.json              # Auth cookies + user_cookie_key
  cache/
    aapl-summary.json       # Cached command outputs
    aapl-ratings.json
    aapl-financials-income-annual.json
    aapl-earnings.json
    aapl-dividends.json
    aapl-valuation.json
    aapl-growth.json
    aapl-profitability.json
    aapl-momentum.json
    aapl-peers.json
    aapl-news.json
    aapl-analysis.json
```

## Session expiry

Seeking Alpha sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-symbol.mjs auth
```

Make sure you have an active Seeking Alpha tab open in Chrome when running auth. The PerimeterX cookies are essential — without them, API calls will be blocked.
