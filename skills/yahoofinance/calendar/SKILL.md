# yahoofinance-calendar

Fetch financial event calendars from Yahoo Finance — earnings, IPOs, stock splits, and economic events. All calendar types use Yahoo's visualization API (no HTML scraping).

## Prerequisites

- Node.js 22+
- Chrome with remote debugging enabled (only for `auth` step)
- chrome-cdp skill (only for `auth` step)
- Yahoo Finance accessible in Chrome

## Setup

```bash
node yahoofinance-calendar.mjs auth
```

## Usage

```bash
# Earnings calendar (US market, date range)
node yahoofinance-calendar.mjs earnings --start=2026-03-17 --end=2026-03-21
node yahoofinance-calendar.mjs earnings --start=2026-03-17 --end=2026-03-21 --count=100

# Earnings history for a specific ticker
node yahoofinance-calendar.mjs earnings-ticker AAPL --count=20
node yahoofinance-calendar.mjs earnings-ticker MSFT

# IPO calendar
node yahoofinance-calendar.mjs ipos --start=2026-03-01 --end=2026-03-31

# Stock splits calendar
node yahoofinance-calendar.mjs splits --start=2026-03-17 --end=2026-03-24

# Economic events calendar
node yahoofinance-calendar.mjs economic --start=2026-03-17 --end=2026-03-21
```

## How it works

1. `auth` — Extracts cookies from Chrome via CDP, fetches crumb from Yahoo API
2. All commands — POST to `https://query1.finance.yahoo.com/v1/finance/visualization` with calendar-type-specific query body
3. `earnings` — Uses `entityIdType: sp_earnings` with date range and US region filter. Returns: symbol, company, market cap, EPS estimate, EPS actual, surprise %
4. `earnings-ticker` — Uses `entityIdType: earnings` with ticker filter. Returns: date, EPS estimate, EPS actual, surprise %, event type
5. `ipos` — Uses `entityIdType: ipo_info`. Returns: symbol, company, exchange, filing date, price range, offer price, shares, deal type
6. `splits` — Uses `entityIdType: splits`. Returns: symbol, company, payable date, optionable, old/new share worth
7. `economic` — Uses `entityIdType: economic_event`. Returns: event, country, time, period, actual, estimate, prior, revised

## Data storage

```
~/.local/share/showrun/data/yahoofinance-calendar/
├── session.json     Auth cookies & crumb
└── cache/           Calendar JSON files
```

## Session expiry

Re-run `auth` on 401/403 errors.
