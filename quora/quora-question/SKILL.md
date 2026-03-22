# quora-question

**Status:** ❌ BLOCKED — Cloudflare Managed Challenge (needs residential proxy)

Scrapes answers from a Quora question page.

## Usage

```bash
node scripts/quora-question.mjs <question-url> [--max-answers N]

# With residential proxy
SOCKS5_PROXY=host:port node scripts/quora-question.mjs <question-url> [--max-answers N]
```

## Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `<question-url>` | string | required | Full Quora URL or slug |
| `--max-answers N` | number | 10 | Max answers to return |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | SOCKS5 proxy `host:port` for residential IP routing |

## Input Formats

```bash
# Full URL
node scripts/quora-question.mjs "https://www.quora.com/What-is-artificial-intelligence"

# Slug only
node scripts/quora-question.mjs "What-is-machine-learning"
```

## Examples

```bash
node scripts/quora-question.mjs "https://www.quora.com/What-is-AI" --max-answers 5
SOCKS5_PROXY=127.0.0.1:11090 node scripts/quora-question.mjs "https://www.quora.com/What-is-AI" --max-answers 10
```

## Output Schema

```json
{
  "questionId": "What-is-artificial-intelligence",
  "title": "What is artificial intelligence?",
  "url": "https://www.quora.com/What-is-artificial-intelligence",
  "viewCount": "1.2M",
  "answerCount": 847,
  "askedAt": "2014-03-15T00:00:00.000Z",
  "answers": [
    {
      "authorName": "John Smith",
      "authorCredential": "PhD in Computer Science, MIT",
      "upvotes": "12.5K",
      "text": "Artificial intelligence (AI) is the simulation of human intelligence...",
      "createdAt": "2018-06-20T00:00:00.000Z",
      "isTopAnswer": true
    }
  ],
  "total": 10,
  "source": "browser",
  "blocked": false
}
```

## Blocked Response

When Cloudflare blocks all access:

```json
{
  "questionId": "What-is-artificial-intelligence",
  "title": null,
  "url": "https://www.quora.com/What-is-artificial-intelligence",
  "viewCount": null,
  "answerCount": null,
  "askedAt": null,
  "answers": [],
  "total": 0,
  "source": null,
  "blocked": true,
  "blockReason": "Cloudflare Managed Challenge (cType: managed)",
  "blockDetails": "Set SOCKS5_PROXY=host:port env var with a residential proxy to bypass Cloudflare.",
  "retryWith": "SOCKS5_PROXY=<proxy:port> node quora-question.mjs \"...\" --max-answers 10"
}
```

## Extraction Strategy

1. **Direct HTTP** — fast, checks JSON-LD `QAPage` schema for accepted/suggested answers
2. **Camoufox browser** — headless Firefox via SOCKS5 proxy, full JS rendering
3. **DOM extraction** — `[aria-label*="Upvote"]` buttons as answer container anchors, `a[href*="/profile/"]` for authors
