# Website Crawl Skill

Crawl any website and extract clean text content, Markdown, metadata, and links.
Uses camoufox-js (Firefox anti-detect browser) for JavaScript-rendered pages.

## Usage

```bash
cd website-content-crawler
node website-crawl/scripts/website-crawl.mjs <url> [maxPages] [maxDepth] [sameDomainOnly]
```

## Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `url` | string | required | Starting URL to crawl |
| `maxPages` | number | 1 | Maximum number of pages to crawl |
| `maxDepth` | number | 1 | Maximum link-follow depth (0 = single page, no link following) |
| `sameDomainOnly` | boolean | true | Only follow links on the same domain |

## Examples

```bash
# Single page scrape
node website-crawl/scripts/website-crawl.mjs https://example.com

# Crawl up to 10 pages, 2 levels deep, same domain only
node website-crawl/scripts/website-crawl.mjs https://docs.example.com 10 2 true

# Blog crawl — 5 pages, follow 1 level of links
node website-crawl/scripts/website-crawl.mjs https://blog.example.com 5 1 true

# Allow cross-domain links
node website-crawl/scripts/website-crawl.mjs https://example.com 5 2 false
```

## Output Format

Writes `RESULT:{json}` to stdout. Logs to stderr.

```json
{
  "startUrl": "https://example.com",
  "crawledCount": 3,
  "successCount": 3,
  "errorCount": 0,
  "pages": [
    {
      "url": "https://example.com/",
      "title": "Example Domain",
      "markdown": "# Example Domain\n\nThis domain is for use in...",
      "text": "Example Domain This domain is for use in...",
      "metadata": {
        "description": "...",
        "author": "...",
        "publishedDate": "2024-01-01T00:00:00.000Z",
        "keywords": "example, domain",
        "image": "https://example.com/og.jpg",
        "canonical": "https://example.com/",
        "language": "en"
      },
      "links": [
        { "href": "https://example.com/about", "text": "About us" }
      ],
      "depth": 0,
      "status": "ok",
      "error": null,
      "crawledAt": "2024-01-01T10:00:00.000Z"
    }
  ]
}
```

## What It Extracts

- **title** — Page title from `<title>` tag
- **markdown** — Cleaned Markdown-formatted content (headers, paragraphs, lists, tables, code blocks)
- **text** — Plain text (capped at 10,000 chars)
- **metadata** — Meta description, author, published date, keywords, OG image, canonical URL, language
- **links** — All `<a href>` links on the page (up to 200)
- **depth** — Crawl depth (0 = start page)
- **status** — `"ok"` or `"error"`
- **error** — Error message if status is `"error"`

## Content Cleaning

Automatically removes noise before extracting content:
- Navigation bars, menus, sidebars
- Headers, footers
- Cookie banners and consent dialogs
- Ads and promotional content
- Social share buttons
- Scripts, styles, iframes

Main content is detected via:
1. Multiple `<article>` elements (listing/index pages) → finds their common parent
2. `<main>`, `[role=main]` elements
3. Common content class names (`.post-content`, `.article-body`, `.content`, etc.)
4. Fallback: full body after noise removal

## Notes

- Uses camoufox-js for fingerprinting — handles JS-rendered pages
- Polite crawling: 1.5s delay between pages
- Blocks media and fonts to speed up loading
- Handles cookie/consent banners automatically
- Respects same-domain boundary by default
- Skips binary files (PDF, images, etc.) automatically
