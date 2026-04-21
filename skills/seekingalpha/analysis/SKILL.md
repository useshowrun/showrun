# seekingalpha-analysis

Expert analysis articles, top author metrics, and saved/bookmarked articles from Seeking Alpha.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/) (only for `auth`)
- A Seeking Alpha account (logged in via Chrome)

## Setup

Open seekingalpha.com in Chrome and log in, then run:

```bash
node seekingalpha-analysis.mjs auth
```

This extracts session cookies (including PerimeterX tokens) from your Chrome browser.

## Usage

```bash
# Latest analysis articles
node seekingalpha-analysis.mjs latest
node seekingalpha-analysis.mjs latest --count=20 --page=2

# Filter by category
node seekingalpha-analysis.mjs latest --category=dividends
node seekingalpha-analysis.mjs latest --category=top-ideas --count=5
node seekingalpha-analysis.mjs latest --category=etfs-and-funds --page=2

# List all available categories
node seekingalpha-analysis.mjs categories

# Analysis articles for a specific ticker
node seekingalpha-analysis.mjs for-ticker AAPL
node seekingalpha-analysis.mjs for-ticker TSLA --count=15 --page=1

# Top performing authors/analysts
node seekingalpha-analysis.mjs top-authors
node seekingalpha-analysis.mjs top-authors --count=25

# Your saved/bookmarked articles
node seekingalpha-analysis.mjs saved
node seekingalpha-analysis.mjs saved --count=20 --page=2
```

Ticker formats accepted: `AAPL`, `aapl`, `https://seekingalpha.com/symbol/AAPL`.

### Available categories

| Slug | Label | Description |
|------|-------|-------------|
| `latest-articles` | Latest Articles | All latest analysis articles (default) |
| `top-ideas` | Top Ideas | High-conviction long or short with asymmetric risk/reward profiles |
| `editors-picks` | Editors' Picks | The most compelling stock analysis hand-picked by editors |
| `stock-ideas` | Stock Ideas | Long and short stock investment ideas |
| `dividends` | Dividends | High dividend stock ideas, research and analysis |
| `etfs-and-funds` | ETFs & Funds | ETF evaluation, mutual and closed-end fund research |
| `market-outlook` | Market Outlook | Stock market outlook, forecasts and macro analysis |
| `investing-strategy` | Investing Strategy | Investing strategies and techniques for all market scenarios |
| `trending` | Trending | Currently trending analysis articles |

Short aliases are also supported: `top`, `editors`, `picks`, `stocks`, `etfs`, `etf`, `funds`, `macro`, `outlook`, `strategy`.

## Account tier

All commands work on the free (Basic) Seeking Alpha account. `top-authors` and `saved` typically return empty lists until the account rates/saves articles.

## How it works

1. **auth** — Uses CDP to extract cookies from a Seeking Alpha browser tab (including PerimeterX `_pxvid`/`pxcts` cookies required for API access). Saves session to disk.
2. **latest** — Calls `GET /api/v3/articles?filter[category]=<category>&include=author,primaryTickers,secondaryTickers,sentiments` with pagination. Supports `--category` to filter by topic (default: `latest-articles`). Returns title, author, publish date, summary, sentiment (bullish/bearish/neutral per ticker), tickers, comment count, and URL.
3. **categories** — Lists all available analysis categories with slugs, labels, descriptions, and aliases.
4. **for-ticker** — Calls `GET /api/v3/symbols/{slug}/analysis?include=author,primaryTickers,secondaryTickers,sentiments` with pagination. Returns analysis articles specific to the given ticker with sentiment data. Note: the per-ticker endpoint does not return article summaries (API limitation).
5. **top-authors** — Calls `GET /api/v3/author_metrics?per_page=N&include=author`. Returns author name, slug, average return, success rate, followers count, and detailed stock picks (ticker, rating, pick date, holding return, article title).
6. **saved** — Calls `GET /api/v3/saved_headlines?include=author,primaryTickers,secondaryTickers` with pagination. Returns the user's bookmarked articles. Requires `user_cookie_key` from auth.

## Data storage

```
~/.local/share/showrun/data/seekingalpha-analysis/
  session.json              # Auth cookies
  cache/
    latest-articles-p1.json # Latest articles (page 1)
    dividends-p1.json       # Dividends category (page 1)
    top-ideas-p1.json       # Top ideas category (page 1)
    aapl-analysis-p1.json   # Ticker-specific analysis
    top-authors.json        # Top authors
    saved-p1.json           # Saved articles
```

## Session expiry

Seeking Alpha sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-analysis.mjs auth
```

Make sure you are logged in to seekingalpha.com in Chrome before re-authenticating.
