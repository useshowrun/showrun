# Substack Agent Skills

Scrape posts and search publications on Substack.

## Key Insights

Substack has a **fully public REST API** — no authentication required for public publications:

1. **Posts API**: `GET https://{pub}.substack.com/api/v1/posts?limit=25&offset=0`
   - Returns full JSON array of posts (title, subtitle, date, type, reactions, authors, etc.)
   - Works for both `.substack.com` domains and custom domains (e.g., `platformer.news`)
   - Free posts include `body_html`; paid posts have truncated body only
   - Paginate via `offset` param (max 25 per page)

2. **Publication Metadata**: `GET https://{pub}.substack.com/api/v1/publication`
   - Returns name, subdomain, custom_domain, language, subscriber info

3. **RSS Feed**: `https://{pub}.substack.com/feed` (fallback if API fails)
   - Standard RSS 2.0 XML with `content:encoded` for full text

4. **Publication Search**: `https://substack.com/api/v1/search?q=<query>` (may require browser session)
   - Global search across all Substack publications

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [substack-posts](substack-posts/SKILL.md) | `substack-posts/scripts/substack-posts.mjs` | Get posts from a specific Substack publication |
| [substack-search](substack-search/SKILL.md) | `substack-search/scripts/substack-search.mjs` | Search for publications or posts |

## Typical Workflow

```bash
cd /home/karacasoft/Documents/Work/showrun/agent-browser-skills/substack

# Get recent posts from a publication (by slug)
node substack-posts/scripts/substack-posts.mjs simonwillison --max 10

# Get posts from a custom domain
node substack-posts/scripts/substack-posts.mjs platformer.news --max 5

# Get only free newsletter posts
node substack-posts/scripts/substack-posts.mjs astralcodexten.substack.com --free-only --max 20

# Include publication metadata
node substack-posts/scripts/substack-posts.mjs simonwillison --max 10 --publication-info

# Search for publications
node substack-search/scripts/substack-search.mjs "technology newsletter" --mode publications

# Search for posts within a specific publication
node substack-search/scripts/substack-search.mjs "AI" --mode posts --publication simonwillison
```

## No Dependencies

Uses only Node.js built-in modules (`https`, `http`, `url`, `path`). No npm install needed.

## API Notes

- The `/api/v1/posts` endpoint is unauthenticated for public publications
- Paid posts show `audience: "only_paid"` and have truncated body
- Free posts show `audience: "everyone"` with full body HTML
- Custom domains redirect through Substack infrastructure — the API works on custom domains too
- The global Substack search API (`substack.com/search`) returns HTML (requires browser JS execution)
  — the skills handle this gracefully with appropriate fallbacks
