# seekingalpha-alerts

Price & rating alerts, inbox notifications, portfolio tickers, account info, and market status from Seeking Alpha.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp) (only for `auth`)
- Logged-in Seeking Alpha session in Chrome

## Setup

```bash
node seekingalpha-alerts.mjs auth
```

Opens your Chrome Seeking Alpha tab and extracts session cookies (including PerimeterX tokens and `user_cookie_key`).

## Usage

### List alerts for a ticker
```bash
node seekingalpha-alerts.mjs list AAPL                              # all alerts (price + rating)
node seekingalpha-alerts.mjs list TSLA --type=price                 # price alerts only
node seekingalpha-alerts.mjs list MSFT --type=rating                # rating change alerts only
node seekingalpha-alerts.mjs list AAPL --status=triggered           # triggered alerts
node seekingalpha-alerts.mjs list --all                             # all alerts across all tickers
node seekingalpha-alerts.mjs list --all --type=price --status=triggered  # combine filters
```

### Inbox notification counts
```bash
node seekingalpha-alerts.mjs notifications
```

Returns total unseen count plus breakdown by category (headlines, comments, direct messages).

### Portfolio tickers
```bash
node seekingalpha-alerts.mjs portfolio
```

Lists all portfolios with their tickers (name, exchange, company, followers count).

### Account info
```bash
node seekingalpha-alerts.mjs account
```

Returns account details (user ID, email, creation date, subscription status).

### Market status
```bash
node seekingalpha-alerts.mjs market
```

Returns whether the US market is currently open, plus next open/close times.

## Account tier

All commands work on the free (Basic) Seeking Alpha account.

## How it works

1. **auth** -- Uses CDP to extract cookies from a Seeking Alpha browser tab. Saves `cookie` string and `userCookieKey` to `session.json`.
2. **list \<ticker\>** -- First resolves the ticker slug (e.g., `aapl`) to its numeric ticker ID via `GET /api/v3/tickers?filter[slugs]=aapl`. Then queries `GET /api/v3/account/{userKey}/alerts?filter[status]={status}&filter[ticker_ids][]={id}&filter[type]={type}` for price and/or rating alerts. Supports `--all` flag to skip ticker filter. Returns alert details (target price, direction, status, timestamps).
3. **notifications** -- Calls `GET /api/v3/inbox_notifications/count` to return unseen notification counts with breakdown (headlines, comments, direct messages).
4. **portfolio** -- Calls `GET /api/v3/account/{userKey}/portfolios?include[]=tickers&include[]=holdings&include[]=views` to return portfolio contents with ticker details.
5. **account** -- Calls `GET /api/v3/account/{userKey}/info?include=proSubscription` to return account information.
6. **market** -- Calls `GET /api/v3/market_open` to return current market status and next open/close timestamps.

## Data storage

```
~/.local/share/showrun/data/seekingalpha-alerts/
  session.json                          # auth cookies + userCookieKey
  cache/
    {ticker}-alerts-{type}-{status}.json  # cached alert results
    all-alerts-{type}-{status}.json       # cached alerts (no ticker filter)
    notifications.json                    # cached notification counts
    portfolio.json                        # cached portfolio data
    account.json                          # cached account info
    market.json                           # cached market status
```

## Session expiry

Seeking Alpha sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-alerts.mjs auth
```
