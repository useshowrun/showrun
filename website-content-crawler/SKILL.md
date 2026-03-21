# Website Content Crawler — Agent Browser Skills

Crawl and extract content from any website using camoufox-js browser automation.
Handles JavaScript-rendered pages, cookie banners, and content noise.

## Prerequisites

### Node.js 22+
Required for ES modules. Check with `node --version`.

### Install Dependencies
```bash
cd website-content-crawler && npm install
```

Or use the pre-linked node_modules symlinks (already set up).

## Available Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [Crawl](website-crawl/SKILL.md) | `website-crawl/scripts/website-crawl.mjs` | Crawl any URL(s), extract text/markdown/metadata/links |
| [Contact Info](contact-info/SKILL.md) | `contact-info/scripts/contact-info.mjs` | Extract emails, phones, social links from any website |

## Typical Workflow

```
# Single page extraction
node website-crawl/scripts/website-crawl.mjs https://example.com

# Multi-page crawl (3 pages, 2 levels deep)
node website-crawl/scripts/website-crawl.mjs https://blog.example.com 3 2 true
```

## Output Format

All scripts write `RESULT:{json}` to stdout. Logs go to stderr.

```javascript
// Parse results from a script
const output = execSync("node website-crawl/scripts/website-crawl.mjs ...", { encoding: "utf-8" });
const resultLine = output.split("\n").find(l => l.startsWith("RESULT:"));
const data = JSON.parse(resultLine.slice(7));
```

## Data Available

Each crawled page includes:
- `url` — final URL after redirects
- `title` — page title
- `markdown` — cleaned Markdown content (headings, paragraphs, lists, code blocks, tables)
- `text` — plain text version (capped at 10k chars)
- `metadata` — `{description, author, publishedDate, keywords, image, canonical, language}`
- `links` — array of `{href, text}` up to 200 links
- `depth` — crawl depth (0 = start page)
- `status` — `"ok"` or `"error"`
- `crawledAt` — ISO8601 timestamp

## Use Cases

- **Documentation indexing** — Crawl docs sites for RAG/LLM pipelines
- **Blog extraction** — Extract all articles from a blog
- **Content monitoring** — Watch pages for changes
- **Knowledge base** — Build searchable content from websites
- **Competitive research** — Extract structured info from websites

## Anti-Bot Notes

camoufox-js (Firefox-based anti-detect browser) handles fingerprinting automatically.
Most websites do not aggressively block basic crawling.
For heavily protected sites (Cloudflare, etc.), the camoufox fingerprinting is usually sufficient.

Rate limiting: 1.5 seconds between pages by default (polite crawling).
