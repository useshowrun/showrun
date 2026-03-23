# similarweb-backlinks

Backlink analytics from SimilarWeb: backlink summary with TLD/country distribution, top referring domains, and individual backlinks with source URLs, anchors, and domain/page scores.

## Prerequisites
- Node.js 22+
- Chrome with remote debugging (only for `auth`)
- A SimilarWeb Pro account (logged in at pro.similarweb.com)

## Setup

```bash
node similarweb-backlinks.mjs auth
```

Reuses session from `similarweb-website` if available.

## Usage

```bash
# Backlink summary: total backlinks, TLD distribution, top countries
node similarweb-backlinks.mjs summary chatgpt.com

# Top referring domains by backlink count
node similarweb-backlinks.mjs domains chatgpt.com
node similarweb-backlinks.mjs domains shopify.com --count=50

# Individual backlinks with source URLs, anchors, domain/page scores
node similarweb-backlinks.mjs links chatgpt.com
node similarweb-backlinks.mjs links shopify.com --count=50 --sort=PageScore --duration=3m
```

## How it works

1. **auth** -- Reuses the `similarweb-website` session if available, otherwise extracts cookies from Chrome.

2. **summary** -- Calls `GET /api/backlinks/summary`. Returns total backlinks count, top TLD distribution (.com, .co.uk, .ai, etc. with counts and shares), and top referring countries.

3. **domains** -- Calls `POST /api/backlinks/refdomains`. Returns referring domains ranked by backlink count, with: domain name, global rank, backlinks count, referring pages, follow/nofollow breakdown, and first seen date. Sortable by `BacklinksCount` or `Rank`.

4. **links** -- Calls `POST /api/backlinks/backlinks`. Returns individual backlinks with: source URL, target URL, anchor text, page title, domain score (0-100), page score (0-100), source rank, first seen/last visited dates, and flags for new/lost/broken/image links. Sortable by `DomainScore`, `PageScore`, or `Rank`. Filterable by duration (`28d`, `3m`, `6m`, `13m`).

## Data storage

```
~/.local/share/showrun/data/similarweb-backlinks/
  session.json                          # Auth cookies
  cache/
    chatgpt_com-summary.json
    chatgpt_com-domains.json
    chatgpt_com-links-28d.json
```

## Session expiry

If API calls return 401/403, re-run:
```bash
node similarweb-backlinks.mjs auth
```
