# goodreads-search

Search for books on Goodreads by title, author name, or ISBN.

## Usage

```bash
node goodreads-search.mjs "<query>" [--max N] [--type books|author]
node goodreads-search.mjs '{"query":"dune","max":20}'
```

## Input

**Positional args:**
- `<query>` — Book title, author name, or ISBN

**Flags:**
- `--max N` — Maximum results to return (default: 10, max: 100)
- `--type books|author` — Search type (default: "books")

**JSON input (alternative):**
```json
{
  "query": "dune",
  "max": 20,
  "type": "books"
}
```

## Output

```json
RESULT:{
  "query": "dune",
  "searchType": "books",
  "totalResults": 3456,
  "books": [
    {
      "bookId": "44767458",
      "title": "Dune",
      "author": {
        "name": "Frank Herbert",
        "url": "https://www.goodreads.com/author/show/58/Frank_Herbert"
      },
      "rating": 4.25,
      "ratingsCount": 1250000,
      "url": "https://www.goodreads.com/book/show/44767458-dune",
      "coverUrl": "https://i.gr-assets.com/images/S/...",
      "year": 2019,
      "isbn": null
    }
  ]
}
```

## Environment Variables

- `SOCKS5_PROXY` — Optional SOCKS5 proxy (host:port)

## Anti-bot Notes

- Goodreads search pages respond with HTTP 200 to standard Firefox User-Agent
- **No browser required** — direct HTTPS fetch works
- Amazon-owned but no Cloudflare bot-protection on search pages
- 10 results per page; pagination supported up to page ~50

## Data Source

Goodreads search HTML (`/search?q=<query>&search_type=books&page=N`):
- Legacy Rails HTML with `schema.org/Book` microdata
- Per result: `itemscope`, `itemtype="http://schema.org/Book"`
  - `<div id="BOOKID" class="u-anchorTarget">` → bookId
  - `class="bookTitle" itemprop="url"` → bookUrl
  - `itemprop='name'` → title
  - `class="authorName" itemprop="url"` → authorUrl
  - `itemprop="name"` → authorName
  - `class="bookCover" itemprop="image"` → coverUrl
  - `class="minirating"` text → rating + ratingsCount
  - `published YYYY` → year
