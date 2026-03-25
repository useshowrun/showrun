# seekingalpha-search

Search for stock symbols, authors, and pages on Seeking Alpha. Includes recent search history and ticker info lookup.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)
- Seeking Alpha account (logged in via Chrome)

## Setup
```bash
node seekingalpha-search.mjs auth
```
Extracts session cookies from an open Seeking Alpha tab in Chrome. Requires Chrome with remote debugging enabled and the chrome-cdp skill installed.

## Usage

### Search
```bash
# Search all types (symbols, authors, pages)
node seekingalpha-search.mjs search apple

# Search only symbols
node seekingalpha-search.mjs search MSFT --type=symbols

# Search only authors
node seekingalpha-search.mjs search "Warren Buffett" --type=people

# Search only pages
node seekingalpha-search.mjs search dividends --type=pages

# Control result count
node seekingalpha-search.mjs search energy --count=10
```

### Recent searches
```bash
# All recent searches
node seekingalpha-search.mjs recent

# Recent symbol searches only
node seekingalpha-search.mjs recent --type=symbol
```

### Ticker lookup
```bash
# Single ticker
node seekingalpha-search.mjs lookup AAPL

# Multiple tickers (comma-separated)
node seekingalpha-search.mjs lookup MSFT,NVDA,AAPL
```

## How it works

1. **auth** -- Uses CDP to extract cookies (including PerimeterX tokens) from a Seeking Alpha browser tab. Saves session to disk.
2. **search** -- Calls `GET /api/v3/searches` with query, type filter, and pagination. Returns results grouped by type (symbols, people, pages, shortcuts). Symbol results include ticker, company name, and URL. People results include name, slug, and profile URL. Page results include name and URL.
3. **recent** -- Calls `GET /api/v3/account/{userKey}/recent_searches` to retrieve the user's recent search history. Optionally filters by type (e.g., `symbol`).
4. **lookup** -- Calls `GET /api/v3/tickers` with comma-separated slugs. Returns detailed ticker info including company name, exchange, equity type, fund type, currency, GICS sector and sub-industry classification, and follower count.

## Data storage
```
~/.local/share/showrun/data/seekingalpha-search/
  session.json              # Auth cookies
  cache/
    search-<query>.json     # Cached search results
    recent.json             # Cached recent searches
    lookup-<slugs>.json     # Cached ticker lookups
```

## Session expiry
Sessions last days to weeks. If you get a 401/403 error, re-run:
```bash
node seekingalpha-search.mjs auth
```
