---
name: similarweb-keywords
description: "SEO keyword research from SimilarWeb: SEO overview, keyword rank distribution, top organic/paid pages, keyword gap analysis, and SEO trends."
---

# similarweb-keywords

SEO keyword research from SimilarWeb: SEO overview, keyword rank distribution, top organic/paid pages, keyword gap analysis, and SEO trends.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

```bash
node similarweb-keywords.mjs auth
```

Reuses session from `similarweb-website` if available.

## Usage

```bash
# SEO overview: keyword count, organic/paid split, branded split, intent distribution, SERP features
node similarweb-keywords.mjs overview chatgpt.com
node similarweb-keywords.mjs overview shopify.com --country=840

# Keyword rank distribution over time (positions 1-3, 4-10, 11-20, 21-50, 50+)
node similarweb-keywords.mjs ranks chatgpt.com

# Top organic or paid pages by search clicks
node similarweb-keywords.mjs pages chatgpt.com
node similarweb-keywords.mjs pages shopify.com --source=Paid

# Keyword gap analysis between 2-5 domains (unique vs shared keywords)
node similarweb-keywords.mjs gap chatgpt.com claude.ai
node similarweb-keywords.mjs gap chatgpt.com claude.ai grok.com

# SEO trends over time
node similarweb-keywords.mjs trends chatgpt.com
```

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise extracts cookies from Chrome.

2. **overview** -- Calls 3 APIs in parallel: `WebsiteAnalysis/Overview/Summary` for keyword counts and traffic splits, `SerpDistribution` for SERP type breakdown, and `KeywordsSerpDistribution` for detailed SERP feature counts (AI overviews, images, videos, related questions, etc.).

3. **ranks** -- Calls `WebsiteAnalysis/Overview/RankDistributionOverTime`. Returns monthly breakdown of keywords by SERP position (1-3, 4-10, 11-20, 21-50, 50+) with counts and shares.

4. **pages** -- Calls `WebsiteAnalysis/Overview/TopOrganicPages`. Returns top pages ranked by search clicks, with click share, change, and keyword count per page. Use `--source=Paid` for paid search pages.

5. **gap** -- Calls `WebsiteAnalysis/Overview/KeywordGap` with 2-5 domains. Returns keyword overlap analysis: how many keywords are unique to each domain, shared between pairs, or shared by all. Includes search volume for each segment.

6. **trends** -- Calls `WebsiteAnalysis/Overview/SummaryTrends`. Returns SEO metric trends over time.

## Data storage

```
~/.local/share/showrun/data/similarweb-keywords/
  session.json                                    # Auth cookies
  cache/
    chatgpt_com-overview-999.json
    chatgpt_com-ranks-999.json
    chatgpt_com-pages-organic-999.json
    gap-chatgpt_com-vs-claude_ai-999.json
    chatgpt_com-trends-999.json
```

## Session expiry

If API calls return 401/403, re-run:
```bash
node similarweb-keywords.mjs auth
```
