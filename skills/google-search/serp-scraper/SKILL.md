# google-search-serp-scraper

Scrape Google Search results pages (SERPs) without an API key: organic results, People Also Ask, news results, image results, related searches, and result statistics.

## ⚠️ No Login Required

Google Search is publicly accessible — **no Google account or API key needed**. The skill handles the GDPR cookie consent page automatically.

## Prerequisites

- Node.js 22+
- `playwright` npm package (install below)
- Google Chrome or Chromium (`google-chrome-stable`)

## Installation

```bash
cd skills/google-search/serp-scraper
npm install playwright
```

> **Note:** `playwright` includes its own Chromium, but this skill **prefers your installed Chrome** at `/usr/bin/google-chrome-stable` to avoid bot detection. Set `CHROME_EXECUTABLE=/path/to/chrome` to override.

---

## Usage

### Web / Organic search results

```bash
node scripts/serp-scraper.mjs search <query> [options]
```

**Examples:**
```bash
# Basic search — 10 organic results
node scripts/serp-scraper.mjs search "python programming"

# Multiple pages — 30 results total
node scripts/serp-scraper.mjs search "best laptops 2024" --pages=3

# 20 results per page, filter to past month
node scripts/serp-scraper.mjs search "openai news" --num=20 --tbs=qdr:m

# Save to file
node scripts/serp-scraper.mjs search "site:example.com" --output=/tmp/results.json

# German results
node scripts/serp-scraper.mjs search "python programmierung" --hl=de --gl=de

# Use your existing Chrome (best fingerprint — avoids bot detection)
node scripts/serp-scraper.mjs search "query" --cdp-url=http://localhost:9222
```

### News search results

```bash
node scripts/serp-scraper.mjs news <query> [options]
```

**Examples:**
```bash
# Recent news
node scripts/serp-scraper.mjs news "artificial intelligence"

# Past week's news, 2 pages
node scripts/serp-scraper.mjs news "startup funding" --pages=2 --tbs=qdr:w

# Save news to file
node scripts/serp-scraper.mjs news "tech layoffs" --output=/tmp/news.json
```

### Image search results

```bash
node scripts/serp-scraper.mjs images <query> [options]
```

**Examples:**
```bash
# Get image URLs
node scripts/serp-scraper.mjs images "cats" --output=/tmp/cats.json
```

### Show help

```bash
node scripts/serp-scraper.mjs
```

---

## All options

| Option | Default | Description |
|--------|---------|-------------|
| `--pages=N` | 1 | Pages to fetch (max 20) |
| `--num=N` | 10 | Results per page (max 100) |
| `--hl=LANG` | en | Language code (`en`, `de`, `fr`, `es`, etc.) |
| `--gl=COUNTRY` | us | Country code (`us`, `gb`, `de`, `fr`, etc.) |
| `--tbs=FILTER` | — | Time filter: `qdr:d` (day), `qdr:w` (week), `qdr:m` (month), `qdr:y` (year) |
| `--output=FILE` | stdout | Save JSON output to file |
| `--headed` | off | Show browser window (useful for debugging) |
| `--cdp-url=URL` | — | Connect to existing Chrome via CDP |
| `--delay=MS` | 2000 | Delay between pages (ms) — increase if rate limited |
| `--timeout=MS` | 30000 | Page load timeout (ms) |

---

## How it works

1. **Browser launch** — Starts headless Chrome (or connects via CDP to an existing instance).
2. **Bot detection avoidance** — Disables `AutomationControlled` flag, uses realistic UA/headers.
3. **Consent bypass** — If Google's GDPR consent page appears, auto-clicks "Accept all".
4. **Pagination** — Uses the `start` URL parameter (increments by `num` per page).
5. **DOM extraction** — Parses rendered HTML using stable CSS selectors.
6. **CAPTCHA detection** — Checks HTML size + known CAPTCHA markers; exits with code 4.

---

## Output format

### Web/organic search

```json
{
  "source": "google-search",
  "fetchedAt": "2026-03-27T10:00:00.000Z",
  "query": "python programming",
  "type": "web",
  "stats": {
    "raw": "About 315,000,000 results (0.34 seconds)",
    "count": 315000000,
    "timeSeconds": 0.34
  },
  "pagination": {
    "pages": 1,
    "num": 10,
    "totalFetched": 10
  },
  "results": [
    {
      "position": 1,
      "type": "organic",
      "title": "Welcome to Python.org",
      "url": "https://www.python.org/",
      "displayUrl": "https://www.python.org",
      "description": "The official home of the Python Programming Language. Download the latest version...",
      "siteName": null,
      "publishedDate": null
    }
  ],
  "paa": [
    "Is Python the best programming language?",
    "What is Python used for?",
    "How do I start learning Python?",
    "Is Python hard to learn?"
  ],
  "relatedSearches": [
    "python tutorial",
    "python download",
    "python documentation"
  ]
}
```

### News search

```json
{
  "source": "google-search",
  "fetchedAt": "2026-03-27T10:00:00.000Z",
  "query": "artificial intelligence",
  "type": "nws",
  "results": [
    {
      "type": "news",
      "title": "OpenAI releases GPT-5",
      "url": "https://techcrunch.com/...",
      "source": "TechCrunch",
      "publishedTime": "5 hours ago",
      "thumbnail": "https://..."
    }
  ]
}
```

### Image search

```json
{
  "results": [
    {
      "type": "image",
      "url": "https://example.com/page-with-image",
      "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/...",
      "alt": "A cute cat"
    }
  ]
}
```

---

## Pagination

Google Search uses `start` parameter for pagination:

| Parameter | Meaning |
|-----------|---------|
| `start=0` (or omit) | Page 1 |
| `start=10` | Page 2 |
| `start=20` | Page 3 |
| `start=N` | Page (N/num)+1 |

**Maximum:** Google limits organic results to ~100 (10 pages of 10). Past `start=100`, results become empty or loop.

```bash
# Get pages 1-5 (up to 50 results)
node scripts/serp-scraper.mjs search "python tutorial" --pages=5

# Get 20 per page, 3 pages = 60 results
node scripts/serp-scraper.mjs search "machine learning" --pages=3 --num=20
```

---

## Handling bot detection / CAPTCHA

### Signs of CAPTCHA
- Exit code 4
- Script output: `CAPTCHA / bot detection triggered!`
- `"error": "CAPTCHA"` in output JSON

### Resolution strategies (try in order)

**1. Headed mode** (see browser visually — helps identify issues):
```bash
node scripts/serp-scraper.mjs search "query" --headed
```

**2. Use your real Chrome browser** (best possible fingerprint):
```bash
# Launch Chrome with remote debugging
google-chrome-stable --remote-debugging-port=9222 --no-first-run
# Then run with CDP:
node scripts/serp-scraper.mjs search "query" --cdp-url=http://localhost:9222
```

**3. Increase delays** (avoid rate limiting):
```bash
node scripts/serp-scraper.mjs search "query" --pages=5 --delay=5000
```

**4. Change IP / use VPN** — Turkish IPs work fine in testing; some IPs may be rate-limited.

---

## Rate limiting

Google does not publish rate limits, but excessive scraping triggers CAPTCHA.

**Best practices:**
- Keep `--delay` at 2000ms+ between pages (default)
- Don't scrape more than ~50 pages per session
- For bulk scraping, use `--cdp-url` with your real Chrome

**If rate-limited:**
- Exit code 4 (CAPTCHA) or 5
- Wait 30-60 minutes before retrying
- Switch to headed mode with real Chrome (`--cdp-url`)

---

## Session expiry / Consent re-trigger

Google Search doesn't require login. However:

- **GDPR consent** (EU/TR IPs): Auto-accepted by the script. No action needed.
- **If consent loops**: Use `--headed` to debug visually.
- **Session state**: Each script invocation creates a fresh browser context.

---

## WAF / Bot blocks

Google uses JavaScript fingerprinting. Signals that trigger blocks:

| Signal | How this skill avoids it |
|--------|--------------------------|
| HeadlessChrome UA | Replaced with real UA string |
| `navigator.webdriver = true` | Disabled via launch args |
| Missing `Accept-Language` | Added to every request |
| No cookies | Playwright persists session cookies |
| Suspicious timing | Random delays between pages |

**If blocked despite all mitigations:** Use `--cdp-url` with your real Chrome browser (your existing Chrome has the best fingerprint).

---

## Data storage / caching

Results are cached automatically:

```
~/.local/share/showrun/data/google-search/
└── cache/
    ├── python_programming-web.json
    ├── artificial_intelligence-nws.json
    └── cats-isch.json
```

---

## Output handling (important for agents)

Search results can be large. **Always redirect output to a file** or use `--output`:

```bash
# Option 1: redirect stdout
node scripts/serp-scraper.mjs search "python" > /tmp/results.json 2>/dev/null

# Option 2: --output flag (also writes to stdout)
node scripts/serp-scraper.mjs search "python" --output=/tmp/results.json

# Read specific fields
cat /tmp/results.json | python3 -c "
import json,sys
data = json.load(sys.stdin)
for r in data['results'][:5]:
    print(r['position'], r['title'], r['url'])
"
```

---

## Error codes

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | — |
| 1 | Usage/config error | Check command syntax |
| 2 | No results found | Try `--headed`, check query |
| 4 | CAPTCHA / bot detection | Use `--headed` or `--cdp-url` |
| 5 | Rate limited | Wait, then retry with longer `--delay` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `playwright not installed` | `npm install playwright` in skill dir |
| `Chrome not found` | Set `CHROME_EXECUTABLE=/path/to/chrome` |
| Empty results (exit 2) | Try `--headed` to see what's happening |
| CAPTCHA (exit 4) | Use `--headed` or `--cdp-url=http://localhost:9222` |
| Partial results | Google may have fewer results; check `stats.count` |
| Slow / hanging | Increase `--timeout=60000` |
| Wrong language | Add `--hl=en --gl=us` flags |

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `CHROME_EXECUTABLE` | Path to Chrome binary (overrides auto-detection) |
| `CHROME_CDP_URL` | Default CDP URL (e.g. `http://localhost:9222`) |
| `QUIET` | Suppress debug output if set |
| `DEBUG` | Show full error stack traces if set |
