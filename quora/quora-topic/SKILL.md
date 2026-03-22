# quora-topic

**Status: ❌ BLOCKED**

Quora is protected by Cloudflare **managed challenge** (cType: 'managed') — the most aggressive tier.  
All bypass strategies fail from datacenter/Turkish residential IPs.  
Set `SOCKS5_PROXY=host:port` with a **US/EU residential proxy** to unblock.

---

Get recent questions for a Quora topic.

## Usage

```bash
node quora-topic.mjs <topic> [options]

# With residential proxy (required to bypass Cloudflare):
SOCKS5_PROXY=proxy.host:1080 node quora-topic.mjs "Artificial-Intelligence" --max 20
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<topic>` | Topic slug or name. Spaces → hyphens. E.g. `"Artificial-Intelligence"`, `"Python programming language"` |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--max <N>` | Max questions to return | 20 |
| `--strategy rss\|browser\|auto` | Force strategy | auto |
| `--help` | Show help | |

## Strategy

1. **RSS feed** — `https://www.quora.com/topic/<Topic>/rss` (fastest)
2. **camoufox browser** — loads topic page, extracts React state
3. **DOM fallback** — extracts question links from rendered DOM

## Output

```json
{
  "topic": "Artificial-Intelligence",
  "topicUrl": "https://www.quora.com/topic/Artificial-Intelligence",
  "rssUrl": "https://www.quora.com/topic/Artificial-Intelligence/rss",
  "feedTitle": "Quora - Artificial Intelligence",
  "total": 20,
  "source": "rss",
  "questions": [
    {
      "questionId": null,
      "title": "What is the most advanced AI system?",
      "url": "https://www.quora.com/What-is-the-most-advanced-AI-system",
      "viewCount": null,
      "answerCount": null,
      "followCount": null,
      "askedAt": "2026-03-20T12:00:00.000Z",
      "topics": ["Artificial Intelligence", "Machine Learning"],
      "author": "John Doe",
      "description": "A brief excerpt of the question...",
      "source": "rss"
    }
  ],
  "scrapedAt": "2026-03-23T00:00:00.000Z"
}
```

Note: `viewCount`, `answerCount`, `followCount` are only available via browser strategy (not RSS).

## Error Codes

| Code | Description |
|------|-------------|
| `CF_BLOCKED` | Cloudflare managed challenge — needs residential proxy |
| `TOPIC_NOT_FOUND` | Topic slug doesn't exist on Quora |
| `MISSING_ARG` | No topic provided |

## Environment

| Variable | Description |
|----------|-------------|
| `SOCKS5_PROXY` | **Required** to bypass Cloudflare. E.g. `proxy.brightdata.com:22225` |

## Proxy Guidance

Quora uses Cloudflare **managed challenge** which requires:
- **Residential IP** (not datacenter/VPS)
- **US or EU geolocation** preferred
- Browser fingerprint that passes CF bot score

Recommended services: **Bright Data**, **Oxylabs**, **Smartproxy**

```bash
# Example with Bright Data residential proxy
SOCKS5_PROXY=brd-customer-XXX-zone-residential:22225@brd.superproxy.io:22225 \
  node quora-topic.mjs "Artificial-Intelligence" --max 20
```
