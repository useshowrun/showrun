# similarweb-search

SimilarWeb search: find domains by name, keyword suggestions, favorites, and recently viewed domains.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup
```bash
node similarweb-search.mjs auth
```
Reuses session from `similarweb-website` if available.

## Usage

```bash
# Search for websites/domains
node similarweb-search.mjs search shopify
node similarweb-search.mjs search "artificial intelligence" --count=10

# Search for keyword suggestions
node similarweb-search.mjs keywords "ai chatbot"
node similarweb-search.mjs keywords ecommerce --count=50

# List favorited domains
node similarweb-search.mjs favorites

# List recently viewed domains
node similarweb-search.mjs recent
```

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise extracts cookies from Chrome.

2. **search** -- Calls `GET /autocomplete/websites?term=<query>`. Returns matching domain names with favicons. Useful for finding exact domain names before using other similarweb taskpacks.

3. **keywords** -- Calls `GET /autocomplete/keywords?term=<query>`. Returns keyword suggestions related to the search term.

4. **favorites** -- Calls `GET /api/userdata/favorites`. Returns the user's favorited domains.

5. **recent** -- Calls `GET /api/userdata/recent`. Returns recently viewed domains with comparison context, page visited, category, and date.

## Data storage
```
~/.local/share/showrun/data/similarweb-search/
  session.json                    # Auth cookies
  cache/
    search-shopify.json           # Cached search results
    keywords-ai_chatbot.json      # Cached keyword suggestions
    favorites.json                # Cached favorites
    recent.json                   # Cached recent views
```

## Session expiry
If API calls return 401/403, re-run:
```bash
node similarweb-search.mjs auth
```
