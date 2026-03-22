# seekingalpha-news

Market news, breaking news, trending articles, and ticker-specific news from Seeking Alpha.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- [chrome-cdp skill](../../chrome-cdp/scripts/cdp.mjs) (only for `auth`)
- A Seeking Alpha account (free or premium)

## Setup

Open Seeking Alpha in Chrome and log in, then run:

```bash
node seekingalpha-news.mjs auth
```

This extracts all cookies (including PerimeterX bot-protection cookies) from your Chrome session. No CSRF token is needed.

## Usage

```bash
# Latest market news (default 25 items)
node seekingalpha-news.mjs latest
node seekingalpha-news.mjs latest --count=10 --page=2

# Latest news filtered by category
node seekingalpha-news.mjs latest --category=crypto --count=10
node seekingalpha-news.mjs latest --category=earnings
node seekingalpha-news.mjs latest --category=technology
node seekingalpha-news.mjs latest --category=healthcare

# List all available news categories
node seekingalpha-news.mjs categories

# Trending articles
node seekingalpha-news.mjs trending
node seekingalpha-news.mjs trending --count=10

# Breaking news headlines
node seekingalpha-news.mjs breaking

# Top/leading news stories
node seekingalpha-news.mjs top-stories

# News for a specific ticker
node seekingalpha-news.mjs for-ticker AAPL
node seekingalpha-news.mjs for-ticker TSLA --count=20 --page=1
```

Ticker input accepts uppercase (`AAPL`), lowercase (`aapl`), or full URLs (`https://seekingalpha.com/symbol/AAPL`).

## How it works

1. **auth** -- Uses CDP to extract all cookies from a Chrome tab open to seekingalpha.com. Stores the full cookie string (including PerimeterX cookies required for API access) and the `user_cookie_key` for account endpoints.

2. **latest** -- Calls `/api/v3/news` with `filter[category]=market-news::<category>` and JSON:API includes for primary and secondary tickers. Supports `--category` flag to filter by news category (default: `all`). Returns title, publish date, content snippet, comment count, tickers, and image URL.

3. **categories** -- Lists all available news categories that can be used with `latest --category=<slug>`.

Available categories: `all`, `top-news`, `on-the-move`, `technology`, `crypto`, `earnings`, `commodities`, `politics`, `ipos`, `m-a`, `us-economy`, `healthcare`, `energy`, `spacs`, `reits`, `financials`, `consumer`, `gold`, `dividend-stocks`.

4. **trending** -- Calls `/api/v3/news/trending` with `include=author`. Returns title, author name, image URL, and full article URL. Note: this endpoint does not support ticker includes or content snippets.

5. **breaking** -- Calls `/api/v3/breaking_news` for the current "read now" headline. Returns title and URL. The API typically returns a single item (the current breaking/featured story).

6. **top-stories** -- Calls `/api/v3/leading_news_stories` for the leading news stories on the platform. Returns headline, story type, full URL, and the section title (e.g., "Sunday Need to Know").

7. **for-ticker** -- Calls `/api/v3/symbols/{slug}/news` with `filter[category]=news_card` and JSON:API includes for author, tickers, sentiments, and tags. Returns title, date, content snippet, author, comment count, and related tickers.

## Data storage

```
~/.local/share/showrun/data/seekingalpha-news/
  session.json              # Auth cookies + user_cookie_key
  cache/
    latest-p1.json          # Cached latest news (page 1)
    trending-p1.json        # Cached trending articles
    breaking.json           # Cached breaking news
    top-stories.json        # Cached top stories
    aapl-news-p1.json       # Cached ticker news
```

## Session expiry

Seeking Alpha sessions last days to weeks. If you get 401/403 errors, re-run:

```bash
node seekingalpha-news.mjs auth
```

Make sure you have an active Seeking Alpha tab open in Chrome when running auth. The PerimeterX cookies are essential -- without them, API calls will be blocked.
