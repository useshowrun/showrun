# Product Hunt Agent Skills

Scrape products, daily lists, and search results from Product Hunt.

## Key Insights

Product Hunt has TWO access strategies depending on the use case:

1. **Public Atom Feed** (`producthunt.com/feed`) — No auth, no browser needed
   - Returns ~50 most recently voted products per category
   - Fields: title, tagline, author, URLs, published/updated timestamps
   - **No vote counts** in the feed
   - Supports category filtering (ai, developer-tools, productivity, etc.)

2. **Browser Automation** (camoufox-js) — For search and vote counts
   - Intercepts the site's internal GraphQL API responses
   - Returns full product data: votes, comments, ratings, makers, topics
   - Bypasses Cloudflare protection using fingerprinted browser

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Daily Products](producthunt-daily/SKILL.md) | `producthunt-daily/scripts/producthunt-daily.mjs` | Get today's (or a specific date's) top products via Atom feed |
| [Search](producthunt-search/SKILL.md) | `producthunt-search/scripts/producthunt-search.mjs` | Search products by keyword with vote counts via browser |

## Install Dependencies

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/product-hunt
npm install
```

## Typical Workflows

### Get today's products
```bash
node producthunt-daily/scripts/producthunt-daily.mjs
```

### Get products from a specific date
```bash
node producthunt-daily/scripts/producthunt-daily.mjs --date 2026-03-20
```

### Browse by category
```bash
node producthunt-daily/scripts/producthunt-daily.mjs --category ai --max 20
```

### Search for products
```bash
node producthunt-search/scripts/producthunt-search.mjs "AI writing tools"
node producthunt-search/scripts/producthunt-search.mjs "productivity app" --sort popular --max 10
```

## No Auth Required

Both skills access only public data. No Product Hunt API key or account needed.

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.
