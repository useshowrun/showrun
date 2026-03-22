# quora-topic

**Status:** ❌ BLOCKED — Cloudflare Managed Challenge (needs residential proxy)

Scrapes a list of questions from a Quora topic page.

## Usage

```bash
node scripts/quora-topic.mjs <topic> [--max N]

# With residential proxy
SOCKS5_PROXY=host:port node scripts/quora-topic.mjs <topic> [--max N]
```

## Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `<topic>` | string | required | Topic name (e.g. "Artificial Intelligence", "Python") |
| `--max N` | number | 20 | Max questions to return |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | SOCKS5 proxy `host:port` for residential IP routing |

## Examples

```bash
node scripts/quora-topic.mjs "Artificial Intelligence" --max 10
node scripts/quora-topic.mjs Python --max 5
node scripts/quora-topic.mjs "Machine Learning" --max 20
SOCKS5_PROXY=127.0.0.1:11090 node scripts/quora-topic.mjs "AI" --max 20
```

## Output Schema

```json
{
  "topic": "Artificial-Intelligence",
  "topicUrl": "https://www.quora.com/topic/Artificial-Intelligence",
  "questions": [
    {
      "questionId": "What-is-artificial-intelligence",
      "title": "What is artificial intelligence?",
      "url": "https://www.quora.com/What-is-artificial-intelligence",
      "viewCount": "1.2M",
      "answerCount": 847,
      "askedAt": "2014-03-15T00:00:00.000Z"
    }
  ],
  "total": 20,
  "source": "rss",
  "blocked": false
}
```

## Blocked Response

When Cloudflare blocks all access:

```json
{
  "topic": "Artificial-Intelligence",
  "topicUrl": "https://www.quora.com/topic/Artificial-Intelligence",
  "questions": [],
  "total": 0,
  "source": null,
  "blocked": true,
  "blockReason": "Cloudflare Managed Challenge (cType: managed)",
  "blockDetails": "Set SOCKS5_PROXY=host:port env var with a residential proxy to bypass Cloudflare.",
  "proxyInUse": null,
  "retryWith": "SOCKS5_PROXY=<residential-proxy-host:port> node quora-topic.mjs \"Artificial Intelligence\" --max 20"
}
```

## Extraction Strategy

1. **RSS feed** — `https://www.quora.com/topic/<Topic>/rss` (fastest, when accessible)
2. **Camoufox browser** — headless Firefox with fingerprinting + SOCKS5 proxy routing
3. **DOM extraction** — `a[href]` links matching question slug pattern, upvote counts from nearby text
