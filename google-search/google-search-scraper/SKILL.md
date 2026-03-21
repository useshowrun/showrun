# google-search-scraper

Scrapes Google Search results for a given query using camoufox-js (fingerprinted Firefox).

## Usage

```bash
node google-search-scraper.mjs <query> [options]
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--max <n>` | 10 | Max organic results to return |
| `--page <n>` | 1 | Page number (1-based) |
| `--lang <code>` | en | Language code (e.g. `tr`, `de`) |
| `--country <tld>` | com | Google domain TLD (e.g. `com.tr`, `co.uk`) |
| `--safe` | off | Enable SafeSearch |
| `--news` | — | Fetch News tab instead of Web |
| `--images` | — | Fetch Images tab instead of Web |
| `--verbatim` | — | Force exact query match |
| `--no-paa` | — | Exclude People Also Ask |
| `--no-related` | — | Exclude related searches |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | SOCKS5 proxy address (`host:port` or `socks5://host:port`) |

## Examples

```bash
# Basic search
node google-search-scraper.mjs "camoufox browser" --max 10

# With residential proxy (Turkey)
SOCKS5_PROXY=127.0.0.1:11090 node google-search-scraper.mjs "python tutorial" --max 10 --country com.tr

# News search
node google-search-scraper.mjs "AI news" --news --max 5

# Second page
node google-search-scraper.mjs "machine learning" --max 10 --page 2

# Exact match
node google-search-scraper.mjs "exact phrase here" --verbatim --max 10
```

## Output

Outputs `RESULT:{json}` on stdout, logs to stderr.

```json
{
  "query": "python tutorial",
  "totalResults": 4820000000,
  "timeTaken": "0.52 seconds",
  "page": 1,
  "resultCount": 10,
  "organic": [
    {
      "rank": 1,
      "title": "Python For Beginners",
      "url": "https://www.python.org/about/gettingstarted/",
      "displayUrl": "python.org",
      "description": "New to programming? ...",
      "date": null,
      "sitelinks": []
    }
  ],
  "featuredSnippet": {
    "title": "...",
    "description": "...",
    "url": "https://...",
    "type": "paragraph"
  },
  "paa": [
    { "question": "What is Python used for?", "answer": "..." }
  ],
  "localPack": [],
  "knowledgePanel": {
    "title": "...",
    "description": "...",
    "attributes": {}
  },
  "relatedSearches": ["python for beginners", "..."],
  "ads": []
}
```

## Anti-Bot Requirements

Google detects headless browsers aggressively. For reliable results:

1. **Residential proxy required** — Set `SOCKS5_PROXY` to a residential IP proxy
2. **Match country to proxy IP** — Use `--country com.tr` for Turkish IPs
3. **Fresh sessions** — Each run spawns a new browser profile (done automatically)
4. **IP rotation** — After ~3-5 requests, the IP gets flagged. Rotate proxies between searches.

## Selectors Strategy

All extraction uses stable selectors only:
- `#result-stats` — result count
- `[data-tts-speakable="true"]` — featured snippet
- `[data-attrid]` — knowledge panel attributes  
- `[data-ved]` on `<a>` + parent `<h3>` — organic result links
- `[aria-expanded]` buttons — People Also Ask
- `[data-q]` — related searches

**Never uses obfuscated CSS class names** (they change on every Google deploy).

## Known Limitations

- Google may block with CAPTCHA (`CAPTCHA_DETECTED` error code)
- Turkish residential IP needs `--country com.tr` (Google redirects TR→sorry on google.com)
- Image search requires additional parsing work (not fully implemented)
- Local pack only captures business name, address, phone, URL (no reviews count)
