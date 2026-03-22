# Medium Scraper

Scrape Medium (medium.com) for blog posts by tag, author, or publication.

## Skills

| Skill | Script | Description |
|-------|--------|-------------|
| `medium-feed` | `medium-feed/scripts/medium-feed.mjs` | List posts by tag, author, or publication |
| `medium-post` | `medium-post/scripts/medium-post.mjs` | Full metadata + content for a single post |

## Data Sources

| Source | Method | Used For |
|--------|--------|----------|
| RSS feed `/feed/tag/<tag>` | HTTP GET, XML parse | Tag post listing |
| RSS feed `/feed/@<username>` | HTTP GET, XML parse | Author post listing |
| RSS feed `<pub>.medium.com/feed` | HTTP GET, XML parse | Publication post listing |
| GraphQL `/_/graphql` (POST) | JSON API, no auth | Claps, voterCount, responses, tags, author details |

## Notes

- **No auth required** — all public posts work without login
- **Claps/responses** — only available via GraphQL enrichment (not in RSS)
- **Paywall detection** — `isLimitedState` or `isLockedPreviewOnly` from GraphQL = member-only post
- **Content** — full paragraph content available for free posts via GraphQL `PostContent` query
- **RSS limits** — Medium RSS feeds return the latest ~10 posts only; no pagination available
