# seekingalpha-comparison

Side-by-side stock comparison from Seeking Alpha: quant grades, key metrics, and company info for 2-10 tickers at once.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A Seeking Alpha account (free or premium — premium unlocks more data)

## Setup

Open Seeking Alpha in Chrome and log in, then run:

```bash
node seekingalpha-comparison.mjs auth
```

This extracts all cookies (including PerimeterX bot-protection cookies) from your Chrome session.

## Usage

```bash
# Compare two stocks
node seekingalpha-comparison.mjs compare AAPL MSFT

# Compare multiple stocks (up to 10)
node seekingalpha-comparison.mjs compare AAPL MSFT NVDA GOOG AMZN
```

Ticker input accepts uppercase (`AAPL`), lowercase (`aapl`), or full URLs (`https://seekingalpha.com/symbol/AAPL`).

## How it works

1. **auth** — Uses CDP to extract all cookies from a Chrome tab open to seekingalpha.com. Stores the full cookie string (including PerimeterX cookies required for API access).

2. **compare** — Makes 3 batch API calls in parallel:
   - `GET /api/v3/metrics?filter[fields]=...&filter[slugs]=aapl,msft,nvda&minified=false` — Fetches market cap, P/E, dividend yield, revenue growth, EPS growth, gross margin, net margin, ROE, TEV, employee count, and analyst/author counts for all tickers in one request.
   - `GET /api/v3/ticker_metric_grades?filter[fields][]=...&filter[slugs]=aapl,msft,nvda&filter[algos][]=main_quant` — Fetches quant rating grades (value, growth, profitability, momentum, EPS revisions) for all tickers in one request.
   - `GET /api/v3/tickers?filter[slugs]=aapl,msft,nvda&include[gics]=true&per_page=100` — Fetches company name, sector (via GICS), and exchange for all tickers in one request.

   Displays a formatted comparison table and outputs the full JSON result.

## Data storage

```
~/.local/share/showrun/data/seekingalpha-comparison/
  session.json                    # Auth cookies
  cache/
    compare-aapl-vs-msft.json     # Cached comparison results
    compare-aapl-vs-msft-vs-nvda.json
```

## Session expiry

Seeking Alpha sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-comparison.mjs auth
```

Make sure you have an active Seeking Alpha tab open in Chrome when running auth. The PerimeterX cookies are essential — without them, API calls will be blocked.
