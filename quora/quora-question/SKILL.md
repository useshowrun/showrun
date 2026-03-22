# quora-question

**Status: ❌ BLOCKED**

Quora is protected by Cloudflare **managed challenge** (cType: 'managed') — the most aggressive tier.  
All bypass strategies fail from datacenter/Turkish residential IPs.  
Set `SOCKS5_PROXY=host:port` with a **US/EU residential proxy** to unblock.

---

Get a Quora question's answers with author info, upvotes, and text.

## Usage

```bash
node quora-question.mjs <question-url-or-slug> [options]

# With residential proxy (required to bypass Cloudflare):
SOCKS5_PROXY=proxy.host:1080 node quora-question.mjs "What-is-Python" --max-answers 10
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<question-url-or-slug>` | Full Quora URL or slug. E.g. `"What-is-the-best-programming-language-to-learn"` or full URL |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--max-answers <N>` | Max answers to return | 10 |
| `--help` | Show help | |

## Strategy

1. **Direct HTTP** — fast, but CF will block without proxy
2. **camoufox browser** — loads page, extracts embedded React state
3. **DOM fallback** — extracts answers from rendered DOM structure

## Output

```json
{
  "question": {
    "text": "What is Python used for?",
    "url": "https://www.quora.com/What-is-Python-used-for",
    "viewCount": 1500000,
    "answerCount": 342,
    "askedAt": "2015-03-15T00:00:00.000Z"
  },
  "total": 10,
  "source": "browser",
  "answers": [
    {
      "authorName": "Jane Smith",
      "authorUrl": "https://www.quora.com/profile/Jane-Smith",
      "authorCredential": "Software Engineer at Google",
      "upvotes": 12500,
      "text": "Python is used for web development, data science, AI/ML...",
      "createdAt": "2020-06-10T00:00:00.000Z",
      "isTopAnswer": true
    }
  ],
  "scrapedAt": "2026-03-23T00:00:00.000Z"
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `CF_BLOCKED` | Cloudflare managed challenge — needs residential proxy |
| `QUESTION_NOT_FOUND` | Question URL returned 404 |
| `MISSING_ARG` | No question URL provided |
| `INVALID_INPUT` | Could not parse the question URL/slug |

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
# Example
SOCKS5_PROXY=proxy.host:1080 node quora-question.mjs \
  "https://www.quora.com/What-is-the-best-programming-language-to-learn" \
  --max-answers 10
```
